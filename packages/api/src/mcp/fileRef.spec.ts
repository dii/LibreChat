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
      });
    });

    it('carries tenantId when present', () => {
      const ref = mintFileRef({ ...payload, tenantId: 'tenant-7' }, { signingKey: KEY, now: NOW });
      expect(verifyFileRef(ref, { signingKey: KEY, now: NOW })).toEqual({
        fileId: payload.fileId,
        userId: payload.userId,
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
