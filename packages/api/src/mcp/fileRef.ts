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
export const DEFAULT_FILE_REF_TTL_MS: number = 30 * 60 * 1000;

/** Truncated HMAC-SHA256. 128 bits is far beyond forgery reach here. */
const MAC_BYTES = 16;

export interface FileRefPayload {
  fileId: string;
  userId: string;
  tenantId?: string;
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
  if (!payload?.fileId || !payload?.userId) {
    throw new Error('mintFileRef: fileId and userId are required');
  }

  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_FILE_REF_TTL_MS;
  const wire: WirePayload = {
    f: payload.fileId,
    u: payload.userId,
    x: Math.floor((now + ttlMs) / 1000),
  };
  if (payload.tenantId) {
    wire.t = payload.tenantId;
  }

  const body = Buffer.from(JSON.stringify(wire)).toString('base64url');
  return `${FILE_REF_PREFIX}${body}.${sign(body, options.signingKey).toString('base64url')}`;
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
    if (typeof ref !== 'string' || !ref.startsWith(FILE_REF_PREFIX)) {
      return null;
    }

    const parts = ref.slice(FILE_REF_PREFIX.length).split('.');
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
      !decoded.f ||
      typeof decoded?.u !== 'string' ||
      !decoded.u ||
      typeof decoded?.x !== 'number'
    ) {
      return null;
    }

    const now = options.now ?? Date.now();
    if (decoded.x * 1000 <= now) {
      return null;
    }

    const result: FileRefPayload = { fileId: decoded.f, userId: decoded.u };
    if (typeof decoded.t === 'string' && decoded.t) {
      result.tenantId = decoded.t;
    }
    return result;
  } catch {
    return null;
  }
}
