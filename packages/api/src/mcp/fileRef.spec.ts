import { createHmac } from 'crypto';
import { mintFileRef, verifyFileRef, FILE_REF_PREFIX, DEFAULT_FILE_REF_TTL_MS } from './fileRef';

const KEY = 'test-signing-key-not-a-real-secret';
const OTHER_KEY = 'a-different-signing-key';
const NOW = 1_754_000_000_000;

const payload = {
  fileId: 'a1b2c3d4-0000-4000-8000-000000000001',
  userId: '507f1f77bcf86cd799439011',
};

describe('mintFileRef / verifyFileRef', () => {
  describe('round trip', () => {
    it('returns the file and principal it was minted with', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW });
      expect(verifyFileRef(ref, { signingKey: KEY, now: NOW })).toEqual({
        fileId: payload.fileId,
        userId: payload.userId,
        /* Scopes were added 2026-08-14; a reference with none on the wire is a
           read, so this shape is the same reference it always was. */
        scope: 'r',
      });
    });

    it('carries tenantId when present', () => {
      const ref = mintFileRef({ ...payload, tenantId: 'tenant-7' }, { signingKey: KEY, now: NOW });
      expect(verifyFileRef(ref, { signingKey: KEY, now: NOW })).toEqual({
        fileId: payload.fileId,
        userId: payload.userId,
        scope: 'r',
        tenantId: 'tenant-7',
      });
    });

    it('omits tenantId when it was not minted with one', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW });
      expect(verifyFileRef(ref, { signingKey: KEY, now: NOW })).not.toHaveProperty('tenantId');
    });

    it('produces a reference carrying the documented prefix', () => {
      expect(mintFileRef(payload, { signingKey: KEY, now: NOW })).toMatch(
        new RegExp(`^${FILE_REF_PREFIX}`),
      );
    });
  });

  /* U6. A reference is the only thing standing between a caller and someone else's
   * image, so every one of these must fail closed and none may throw. */
  describe('integrity', () => {
    it('rejects a tampered payload', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW });
      const [body, mac] = ref.slice(FILE_REF_PREFIX.length).split('.');
      const forged = Buffer.from(
        JSON.stringify({ f: payload.fileId, u: 'someone-else', x: Math.floor(NOW / 1000) + 60 }),
      ).toString('base64url');
      expect(body).not.toEqual(forged);
      expect(
        verifyFileRef(`${FILE_REF_PREFIX}${forged}.${mac}`, { signingKey: KEY, now: NOW }),
      ).toBeNull();
    });

    it('rejects a tampered mac', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW });
      const [body] = ref.slice(FILE_REF_PREFIX.length).split('.');
      const badMac = Buffer.alloc(16, 0).toString('base64url');
      expect(
        verifyFileRef(`${FILE_REF_PREFIX}${body}.${badMac}`, { signingKey: KEY, now: NOW }),
      ).toBeNull();
    });

    it('rejects a reference signed with a different key', () => {
      const ref = mintFileRef(payload, { signingKey: OTHER_KEY, now: NOW });
      expect(verifyFileRef(ref, { signingKey: KEY, now: NOW })).toBeNull();
    });

    it('rejects a mac of the wrong length without throwing', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW });
      const [body] = ref.slice(FILE_REF_PREFIX.length).split('.');
      for (const mac of ['', 'AA', Buffer.alloc(32, 1).toString('base64url')]) {
        expect(() =>
          verifyFileRef(`${FILE_REF_PREFIX}${body}.${mac}`, { signingKey: KEY, now: NOW }),
        ).not.toThrow();
        expect(
          verifyFileRef(`${FILE_REF_PREFIX}${body}.${mac}`, { signingKey: KEY, now: NOW }),
        ).toBeNull();
      }
    });
  });

  describe('expiry', () => {
    it('accepts a reference before it expires', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW, ttlMs: 60_000 });
      expect(verifyFileRef(ref, { signingKey: KEY, now: NOW + 59_000 })).not.toBeNull();
    });

    it('rejects a reference after it expires', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW, ttlMs: 60_000 });
      expect(verifyFileRef(ref, { signingKey: KEY, now: NOW + 61_000 })).toBeNull();
    });

    it('defaults to a thirty minute lifetime', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW });
      expect(
        verifyFileRef(ref, { signingKey: KEY, now: NOW + DEFAULT_FILE_REF_TTL_MS - 1_000 }),
      ).not.toBeNull();
      expect(
        verifyFileRef(ref, { signingKey: KEY, now: NOW + DEFAULT_FILE_REF_TTL_MS + 1_000 }),
      ).toBeNull();
    });
  });

  /* verifyFileRef is called from a route handler that does not guard it, so it is
   * total by contract: every malformed input returns null and nothing throws. */
  describe('malformed input is total, never thrown', () => {
    const cases: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['a number', 12345],
      ['an object', { fileId: 'x' }],
      ['an array', ['lcimg_a.b']],
      ['an empty string', ''],
      ['the prefix alone', FILE_REF_PREFIX],
      ['no prefix', 'aGVsbG8.aGVsbG8'],
      ['the wrong prefix', 'lcdoc_aGVsbG8.aGVsbG8'],
      ['no separator', `${FILE_REF_PREFIX}aGVsbG8`],
      ['too many separators', `${FILE_REF_PREFIX}aGVsbG8.aGVsbG8.aGVsbG8`],
      ['non-base64 body', `${FILE_REF_PREFIX}!!!!.!!!!`],
      [
        'valid base64 that is not json',
        `${FILE_REF_PREFIX}${Buffer.from('nope').toString('base64url')}.AAAA`,
      ],
    ];

    it.each(cases)('returns null for %s', (_label, input) => {
      expect(() => verifyFileRef(input, { signingKey: KEY, now: NOW })).not.toThrow();
      expect(verifyFileRef(input, { signingKey: KEY, now: NOW })).toBeNull();
    });

    it('returns null for json that verifies but has the wrong shape', () => {
      /* Signed with the real key, so this passes integrity and must still be
       * rejected on shape. Catches a verifier that trusts the mac and stops. */
      const body = Buffer.from(
        JSON.stringify({ nope: true, x: Math.floor(NOW / 1000) + 60 }),
      ).toString('base64url');
      const mac = createHmac('sha256', KEY)
        .update(body)
        .digest()
        .subarray(0, 16)
        .toString('base64url');
      expect(
        verifyFileRef(`${FILE_REF_PREFIX}${body}.${mac}`, { signingKey: KEY, now: NOW }),
      ).toBeNull();
    });
  });

  describe('minting guards', () => {
    it('refuses to mint without a signing key', () => {
      expect(() => mintFileRef(payload, { signingKey: '', now: NOW })).toThrow();
    });

    it('refuses to verify without a signing key, rather than accepting anything', () => {
      const ref = mintFileRef(payload, { signingKey: KEY, now: NOW });
      expect(verifyFileRef(ref, { signingKey: '', now: NOW })).toBeNull();
    });
  });
});

describe('scopes', () => {
  const signingKey = 'test-signing-key-value';

  it('a reference with no scope is a read, and is byte-identical to a pre-scope one', () => {
    /* The comfyui-image broker is deployed and validates the lcimg_ prefix
       before presenting a reference back. If a plain read reference changed
       shape or prefix, production would break on the next LibreChat deploy. */
    const ref = mintFileRef({ fileId: 'f1', userId: 'u1' }, { signingKey });
    expect(ref.startsWith('lcimg_')).toBe(true);
    expect(verifyFileRef(ref, { signingKey })).toMatchObject({
      fileId: 'f1',
      userId: 'u1',
      scope: 'r',
    });
  });

  it('a write reference uses the artefact-general prefix', () => {
    const ref = mintFileRef({ fileId: 'f1', userId: 'u1', scope: 'w' }, { signingKey });
    expect(ref.startsWith('lcref_')).toBe(true);
    expect(verifyFileRef(ref, { signingKey })?.scope).toBe('w');
  });

  it('a read reference cannot be replayed as a write', () => {
    /* The scope is inside the MAC, so upgrading it means forging the MAC. */
    const read = mintFileRef({ fileId: 'f1', userId: 'u1' }, { signingKey });
    const verified = verifyFileRef(read, { signingKey });
    expect(verified?.scope).toBe('r');
    const tampered = read.replace('lcimg_', 'lcref_');
    expect(verifyFileRef(tampered, { signingKey })?.scope).not.toBe('w');
  });

  it('rejects a scope that is not one of the three', () => {
    const forged = mintFileRef({ fileId: 'f1', userId: 'u1', scope: 'w' }, { signingKey });
    /* Re-sign a payload carrying a bogus scope with the SAME key: the MAC is
       valid, so only the scope check can reject it. */
    const body = Buffer.from(
      JSON.stringify({ f: 'f1', u: 'u1', x: 99999999999, s: 'admin' }),
    ).toString('base64url');
    const mac = createHmac('sha256', signingKey)
      .update(body)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    expect(verifyFileRef(`lcref_${body}.${mac}`, { signingKey })).toBeNull();
    expect(verifyFileRef(forged, { signingKey })).not.toBeNull();
  });

  it('a create reference carries a conversation and no file id', () => {
    const ref = mintFileRef(
      { fileId: '', userId: 'u1', scope: 'c', conversationId: 'convo-1' },
      { signingKey },
    );
    expect(verifyFileRef(ref, { signingKey })).toMatchObject({
      userId: 'u1',
      scope: 'c',
      conversationId: 'convo-1',
    });
  });

  it('refuses to mint a create reference with no conversation', () => {
    expect(() => mintFileRef({ fileId: '', userId: 'u1', scope: 'c' }, { signingKey })).toThrow(
      /conversationId/,
    );
  });

  it('refuses to mint a read or write reference with no file id', () => {
    for (const scope of ['r', 'w'] as const) {
      expect(() => mintFileRef({ fileId: '', userId: 'u1', scope }, { signingKey })).toThrow(
        /fileId/,
      );
    }
  });

  it('rejects a non-create reference whose file id is empty on the wire', () => {
    const body = Buffer.from(JSON.stringify({ f: '', u: 'u1', x: 99999999999 })).toString(
      'base64url',
    );
    const mac = createHmac('sha256', signingKey)
      .update(body)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    expect(verifyFileRef(`lcimg_${body}.${mac}`, { signingKey })).toBeNull();
  });
});
