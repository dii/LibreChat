import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed, principal-bound references to conversation images, handed to an MCP
 * server so it can fetch the bytes without the pixels entering model context.
 *
 * The reference is the security boundary. It travels through the model and back
 * via a process we do not control, so it follows the rules MCP `2026-07-28`
 * states for `requestState`: integrity-protected, bound to the authenticated
 * principal, and short-lived. Nothing about who the caller is acting for is
 * asserted by the caller; it is read from the verified payload.
 */

export const FILE_REF_PREFIX: string = 'lcimg_';
/**
 * Artefact-general prefix. `lcimg_` predates it and is still minted for the
 * conversation-image path, because the comfyui-image broker is DEPLOYED and
 * validates that exact prefix before presenting a reference back. Verification
 * accepts either, so the two can coexist and neither repo needs a coordinated
 * deploy; only new artefact kinds use `lcref_`.
 */
export const ARTEFACT_REF_PREFIX: string = 'lcref_';
export const DEFAULT_FILE_REF_TTL_MS: number = 30 * 60 * 1000;

/**
 * What a reference grants. Checked before anything else happens, so a read
 * reference that leaks cannot be replayed as a write.
 */
export const FileRefScope = {
  read: 'r',
  write: 'w',
  create: 'c',
} as const;

export type FileRefScopeValue = (typeof FileRefScope)[keyof typeof FileRefScope];

/** Truncated HMAC-SHA256. 128 bits is far beyond forgery reach here. */
const MAC_BYTES = 16;

export interface FileRefPayload {
  fileId: string;
  userId: string;
  tenantId?: string;
  /** Absent means read: every reference minted before scopes existed is a read. */
  scope?: FileRefScopeValue;
  /** Only meaningful for `create`, which has no file id yet. */
  conversationId?: string;
}

export interface MintFileRefOptions {
  signingKey: string;
  ttlMs?: number;
  /** Injectable clock. Tests only; production omits it. */
  now?: number;
}

export interface VerifyFileRefOptions {
  signingKey: string;
  now?: number;
}

/** Wire payload. Single-character keys because this is repeated per image, per turn. */
interface WirePayload {
  f: string;
  u: string;
  t?: string;
  /** Expiry, seconds since epoch. */
  x: number;
  /** Scope. Absent means read, so old references keep verifying unchanged. */
  s?: FileRefScopeValue;
  /** Conversation, for `create` references that name no file yet. */
  c?: string;
}

const sign = (body: string, signingKey: string): Buffer =>
  createHmac('sha256', signingKey).update(body).digest().subarray(0, MAC_BYTES);

/**
 * Mints a reference for one file, one principal, and a bounded lifetime.
 * Throws when misconfigured: a reference minted without a key would verify
 * against a caller who also has no key, so this must fail loudly rather than
 * produce something that looks like a credential.
 */
export function mintFileRef(payload: FileRefPayload, options: MintFileRefOptions): string {
  if (!options.signingKey) {
    throw new Error('mintFileRef: signingKey is required');
  }
  const scope = payload.scope ?? FileRefScope.read;
  if (!payload?.userId) {
    throw new Error('mintFileRef: userId is required');
  }
  /* A `create` reference names no file yet, by definition; every other scope
     must name exactly one, or the write route has nothing to act on. */
  if (scope === FileRefScope.create) {
    if (!payload.conversationId) {
      throw new Error('mintFileRef: conversationId is required for a create reference');
    }
  } else if (!payload.fileId) {
    throw new Error('mintFileRef: fileId is required');
  }

  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_FILE_REF_TTL_MS;
  const wire: WirePayload = {
    f: payload.fileId ?? '',
    u: payload.userId,
    x: Math.floor((now + ttlMs) / 1000),
  };
  if (payload.tenantId) {
    wire.t = payload.tenantId;
  }
  /* Read is the default and is left OFF the wire, so a read reference is
     byte-identical to one minted before scopes existed. */
  if (scope !== FileRefScope.read) {
    wire.s = scope;
  }
  if (payload.conversationId) {
    wire.c = payload.conversationId;
  }

  const prefix = scope === FileRefScope.read ? FILE_REF_PREFIX : ARTEFACT_REF_PREFIX;
  const body = Buffer.from(JSON.stringify(wire)).toString('base64url');
  return `${prefix}${body}.${sign(body, options.signingKey).toString('base64url')}`;
}

/**
 * Verifies a reference and returns what it names, or `null`.
 *
 * Total by contract: every malformed, tampered, expired or unverifiable input
 * returns `null` and nothing throws. The route handler that calls this does not
 * guard it, and a throw there would surface as a 500 that distinguishes failure
 * modes a caller should not be able to tell apart.
 *
 * Order matters: integrity is checked before the payload is parsed or trusted,
 * and expiry is checked only once integrity holds.
 */
export function verifyFileRef(ref: unknown, options: VerifyFileRefOptions): FileRefPayload | null {
  try {
    if (!options?.signingKey) {
      return null;
    }
    if (typeof ref !== 'string') {
      return null;
    }
    /* Either prefix verifies. The prefix is not a security boundary - the MAC
       is - so accepting both lets the deployed image path keep minting lcimg_
       while new artefact kinds use lcref_, with no coordinated deploy. */
    const prefix = [FILE_REF_PREFIX, ARTEFACT_REF_PREFIX].find((candidate) =>
      ref.startsWith(candidate),
    );
    if (prefix == null) {
      return null;
    }

    const parts = ref.slice(prefix.length).split('.');
    if (parts.length !== 2) {
      return null;
    }
    const [body, presentedMac] = parts;
    if (!body || !presentedMac) {
      return null;
    }

    const presented = Buffer.from(presentedMac, 'base64url');
    const expected = sign(body, options.signingKey);
    /* timingSafeEqual throws on a length mismatch, so length is checked first
     * rather than caught. A short mac is a rejection, not an error. */
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WirePayload;
    if (
      typeof decoded?.f !== 'string' ||
      typeof decoded?.u !== 'string' ||
      !decoded.u ||
      typeof decoded?.x !== 'number'
    ) {
      return null;
    }
    const scope = decoded.s ?? FileRefScope.read;
    if (
      scope !== FileRefScope.read &&
      scope !== FileRefScope.write &&
      scope !== FileRefScope.create
    ) {
      return null;
    }
    /* A create reference names no file; anything else must name one. An empty
       file id on a read or write would otherwise reach a lookup as a blank key. */
    if (scope === FileRefScope.create) {
      if (typeof decoded.c !== 'string' || !decoded.c) {
        return null;
      }
    } else if (!decoded.f) {
      return null;
    }

    const now = options.now ?? Date.now();
    if (decoded.x * 1000 <= now) {
      return null;
    }

    const result: FileRefPayload = { fileId: decoded.f, userId: decoded.u, scope };
    if (typeof decoded.c === 'string' && decoded.c) {
      result.conversationId = decoded.c;
    }
    if (typeof decoded.t === 'string' && decoded.t) {
      result.tenantId = decoded.t;
    }
    return result;
  } catch {
    return null;
  }
}
