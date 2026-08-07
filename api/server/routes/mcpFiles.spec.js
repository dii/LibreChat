const express = require('express');
const request = require('supertest');

/* `verifyFileRef` lives in packages/api and reaches this route through the
 * compiled `@librechat/api` bundle, which cannot be rebuilt in this checkout
 * (`packages/api/dist` is root-owned; it is rebuilt by the deploy image build).
 * So the boundary is stubbed here and the real implementation is covered
 * directly at source by packages/api/src/mcp/fileRef.spec.ts, which exercises
 * tampering, expiry, wrong keys and malformed input against the real crypto.
 * What this file tests is the route's own behaviour: the guards, the scoping of
 * the lookup, and that every refusal looks identical from outside. */
const mockVerifyFileRef = jest.fn();
const mockGetFiles = jest.fn();
const mockGetDownloadStream = jest.fn();

jest.mock('@librechat/api', () => ({ verifyFileRef: (...args) => mockVerifyFileRef(...args) }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('~/models', () => ({ getFiles: (...args) => mockGetFiles(...args) }));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: () => ({ getDownloadStream: (...args) => mockGetDownloadStream(...args) }),
}));

const { Readable } = require('stream');
const mcpFiles = require('./mcpFiles');

const TOKEN = 'service-token-for-tests';
const KEY = 'signing-key-for-tests';
const PRINCIPAL = { fileId: 'file-1', userId: 'user-a' };
const IMAGE = {
  file_id: 'file-1',
  user: 'user-a',
  type: 'image/png',
  filepath: '/images/user-a/file-1.png',
  source: 'local',
};

const buildApp = () => {
  const app = express();
  app.use('/api/mcp/files', mcpFiles);
  return app;
};

const get = (ref = 'lcimg_body.mac', token = TOKEN) => {
  const req = request(buildApp()).get(`/api/mcp/files/${ref}`);
  return token == null ? req : req.set('Authorization', `Bearer ${token}`);
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MCP_FILE_TOKEN = TOKEN;
  process.env.MCP_FILE_SIGNING_KEY = KEY;
  mockVerifyFileRef.mockReturnValue(PRINCIPAL);
  mockGetFiles.mockResolvedValue([IMAGE]);
  mockGetDownloadStream.mockResolvedValue(Readable.from([Buffer.from('PNGBYTES')]));
});

afterEach(() => {
  delete process.env.MCP_FILE_TOKEN;
  delete process.env.MCP_FILE_SIGNING_KEY;
});

describe('GET /api/mcp/files/:reference', () => {
  describe('guards fail closed', () => {
    it('is disabled with 501 when the token is unset, never open', async () => {
      delete process.env.MCP_FILE_TOKEN;
      const res = await get();
      expect(res.status).toBe(501);
      expect(mockGetFiles).not.toHaveBeenCalled();
    });

    it('is disabled with 501 when the signing key is unset', async () => {
      delete process.env.MCP_FILE_SIGNING_KEY;
      const res = await get();
      expect(res.status).toBe(501);
      expect(mockGetFiles).not.toHaveBeenCalled();
    });

    it('rejects a wrong bearer token with 401', async () => {
      const res = await get('lcimg_body.mac', 'not-the-token');
      expect(res.status).toBe(401);
      expect(mockVerifyFileRef).not.toHaveBeenCalled();
    });

    it('rejects a missing Authorization header with 401', async () => {
      const res = await get('lcimg_body.mac', null);
      expect(res.status).toBe(401);
      expect(mockVerifyFileRef).not.toHaveBeenCalled();
    });
  });

  describe('identity comes from the reference, not the caller', () => {
    it('scopes the lookup to the principal named in the verified reference', async () => {
      await get();
      expect(mockGetFiles).toHaveBeenCalledWith(
        expect.objectContaining({ file_id: 'file-1', user: 'user-a' }),
        null,
        expect.anything(),
      );
    });

    it('applies tenantId from the reference, since the JWT chain has not run', async () => {
      mockVerifyFileRef.mockReturnValue({ ...PRINCIPAL, tenantId: 'tenant-7' });
      await get();
      expect(mockGetFiles).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-7' }),
        null,
        expect.anything(),
      );
    });

    it('never reads a caller-supplied user header', async () => {
      await request(buildApp())
        .get('/api/mcp/files/lcimg_body.mac')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('X-LibreChat-User-Id', 'user-b');
      expect(mockGetFiles).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'user-a' }),
        null,
        expect.anything(),
      );
    });
  });

  /* U6/U7. A caller must not be able to tell "no such file" from "not yours"
   * from "expired", or the route becomes a way to enumerate other people's
   * images. Every refusal below must be byte-identical from outside. */
  /* eslint-disable jest/expect-expect --
   * Assertions live in the expectBareNotFound helper below, which is the point:
   * the whole value of this block is that every case asserts the *same* thing,
   * so inlining the assertions would let them drift apart silently. */
  describe('every refusal is indistinguishable', () => {
    const expectBareNotFound = (res) => {
      expect(res.status).toBe(404);
      expect(res.text).toBe('');
      expect(res.body).toEqual({});
    };

    it('an unverifiable reference', async () => {
      mockVerifyFileRef.mockReturnValue(null);
      expectBareNotFound(await get());
      expect(mockGetFiles).not.toHaveBeenCalled();
    });

    it('a file that does not exist', async () => {
      mockGetFiles.mockResolvedValue([]);
      expectBareNotFound(await get());
    });

    it('a file belonging to someone else (scoped query returns nothing)', async () => {
      mockGetFiles.mockResolvedValue([]);
      expectBareNotFound(await get());
    });

    it('a file that is not an image', async () => {
      mockGetFiles.mockResolvedValue([{ ...IMAGE, type: 'application/pdf' }]);
      expectBareNotFound(await get());
      expect(mockGetDownloadStream).not.toHaveBeenCalled();
    });

    it('a file document with no usable path', async () => {
      mockGetFiles.mockResolvedValue([{ ...IMAGE, filepath: '', storageKey: '' }]);
      expectBareNotFound(await get());
    });

    it('a storage lookup that throws, leaking nothing about why', async () => {
      mockGetFiles.mockRejectedValue(new Error('mongo is on fire'));
      const res = await get();
      expectBareNotFound(res);
      expect(res.text).not.toContain('fire');
    });
  });

  describe('serving', () => {
    it('streams the bytes with the stored content type', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.body.toString()).toBe('PNGBYTES');
    });

    it('sets nosniff and refuses to let the bytes be cached', async () => {
      const res = await get();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('strips a cache-busting query string before resolving the path', async () => {
      mockGetFiles.mockResolvedValue([{ ...IMAGE, filepath: '/images/user-a/file-1.png?v=2' }]);
      await get();
      expect(mockGetDownloadStream).toHaveBeenCalledWith(
        expect.anything(),
        '/images/user-a/file-1.png',
      );
    });
  });
});
