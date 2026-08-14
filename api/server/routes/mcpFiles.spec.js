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
const mockUpdateFile = jest.fn();
const mockSaveBuffer = jest.fn();
const mockCreateFile = jest.fn();
const mockGetFiles = jest.fn();
const mockGetDownloadStream = jest.fn();
const mockGetAppConfig = jest.fn().mockResolvedValue({ paths: { uploads: '/tmp/uploads' } });

jest.mock('@librechat/api', () => ({
  verifyFileRef: (...args) => mockVerifyFileRef(...args),
  /* Mirrors the real vocabulary. A stub that omitted it would make every scope
     comparison undefined === undefined and quietly pass the route's guard. */
  FileRefScope: { read: 'r', write: 'w', create: 'c' },
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('~/models', () => ({
  getFiles: (...args) => mockGetFiles(...args),
  updateFile: (...args) => mockUpdateFile(...args),
  createFile: (...args) => mockCreateFile(...args),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: () => ({
    getDownloadStream: (...args) => mockGetDownloadStream(...args),
    saveBuffer: (...args) => mockSaveBuffer(...args),
  }),
}));
/* Stubbed at the boundary, like `@librechat/api` above: requiring the real
 * Config service drags in the violations cache and the whole app-config graph,
 * which this route spec has no business booting. What matters here is only that
 * the handler populates `req.config` before touching a storage strategy. */
jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

const { Readable } = require('stream');
const mcpFiles = require('./mcpFiles');

const TOKEN = 'service-token-for-tests';
const KEY = 'signing-key-for-tests';
/* A verified READ reference, which is what the real verifyFileRef returns when
   the wire payload carries no scope. Scopes were added 2026-08-14; read stayed
   the default and stayed off the wire, so this is the same reference it always
   was. */
const PRINCIPAL = { fileId: 'file-1', userId: 'user-a', scope: 'r' };
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

    it('a storage source with no stream method, which would otherwise 501', async () => {
      /* Reachable only after a lookup matched a real file owned by this
       * principal, so a distinguishable status here is an existence oracle. */
      mockGetDownloadStream.mockImplementation(() => {
        throw new Error('should not be called');
      });
      const strategies = require('~/server/services/Files/strategies');
      jest.spyOn(strategies, 'getStrategyFunctions').mockReturnValue({});
      expectBareNotFound(await get());
      strategies.getStrategyFunctions.mockRestore();
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

    /* Regression, production 2026-08-11. `configMiddleware` populates
     * `req.config` from `req.user`, and this route is mounted outside the JWT
     * chain so it has neither. `getLocalFileStream` reads `req.config.paths`,
     * so every fetch threw "Cannot read properties of undefined (reading
     * 'paths')" and — because the catch answers like every other refusal — came
     * back as a bare 404. The model held a valid reference, used it correctly,
     * and was told six times that its own photo did not exist. Nothing in the
     * suite caught it because the strategy is stubbed here, so this asserts the
     * request the strategy receives rather than the strategy's own behaviour. */
    it('populates req.config before a storage strategy is given the request', async () => {
      await get();
      const [passedReq] = mockGetDownloadStream.mock.calls[0];
      expect(passedReq.config).toEqual({ paths: { uploads: '/tmp/uploads' } });
    });

    it('scopes the app config to the tenant named in the verified reference', async () => {
      mockVerifyFileRef.mockReturnValue({
        fileId: IMAGE.file_id,
        userId: IMAGE.user,
        tenantId: 'tenant-a',
        scope: 'r',
      });
      await get();
      expect(mockGetAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
    });
  });
});

const put = (body = { content: 'new text' }, token = TOKEN) => {
  const req = request(buildApp()).put('/api/mcp/files/lcref_body.mac');
  return (token == null ? req : req.set('Authorization', `Bearer ${token}`)).send(body);
};

describe('PUT /api/mcp/files/:reference — the write scope', () => {
  beforeEach(() => {
    mockSaveBuffer.mockResolvedValue('/uploads/user-a/documents/doc.md');
  });

  it('refuses a READ reference', async () => {
    /* The point of the scope. A read reference is handed to an MCP server every
       turn; if it also wrote, an image tool could overwrite the photo it was
       asked to look at. */
    mockVerifyFileRef.mockReturnValue(PRINCIPAL);
    const res = await put();
    expect(res.status).toBe(404);
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('refuses a CREATE reference', async () => {
    mockVerifyFileRef.mockReturnValue({ userId: 'user-a', scope: 'c', conversationId: 'c1' });
    const res = await put();
    expect(res.status).toBe(404);
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('refuses an unverifiable reference with the same bare 404', async () => {
    mockVerifyFileRef.mockReturnValue(null);
    const res = await put();
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });

  it('refuses without the bearer token, before the reference is even read', async () => {
    const res = await put({ content: 'x' }, null);
    expect(res.status).toBe(401);
    expect(mockVerifyFileRef).not.toHaveBeenCalled();
  });

  it('is disabled with 501 when a secret is unset, never open', async () => {
    delete process.env.MCP_FILE_SIGNING_KEY;
    mockVerifyFileRef.mockReturnValue({ ...PRINCIPAL, scope: 'w' });
    expect((await put()).status).toBe(501);
  });

  it('refuses a body whose content is not a string', async () => {
    mockVerifyFileRef.mockReturnValue({ ...PRINCIPAL, scope: 'w' });
    const res = await put({ content: { not: 'a string' } });
    expect(res.status).toBe(404);
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('writes through the storage strategy and scopes the lookup to the reference', async () => {
    mockVerifyFileRef.mockReturnValue({ ...PRINCIPAL, scope: 'w' });
    const res = await put({ content: 'hello' });
    expect(res.status).toBe(200);
    expect(mockGetFiles).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: 'file-1', user: 'user-a' }),
      null,
      expect.anything(),
    );
    expect(mockSaveBuffer).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
    expect(res.body.bytes).toBe(Buffer.from('hello', 'utf8').byteLength);
  });

  it("answers a miss for a file the reference's principal does not own", async () => {
    mockVerifyFileRef.mockReturnValue({ ...PRINCIPAL, scope: 'w' });
    mockGetFiles.mockResolvedValue([]);
    expect((await put()).status).toBe(404);
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('records the byte length actually stored, not the string length', async () => {
    /* A multi-byte character makes these differ, and a wrong `bytes` shows the
       user the wrong size for their own document. */
    mockVerifyFileRef.mockReturnValue({ ...PRINCIPAL, scope: 'w' });
    const res = await put({ content: 'héllo' });
    expect(res.body.bytes).toBe(6);
    expect(mockUpdateFile).toHaveBeenCalledWith(expect.objectContaining({ bytes: 6 }));
  });
});

const post = (body = { content: 'doc', filename: 'notes.md' }, token = TOKEN) => {
  const req = request(buildApp()).post('/api/mcp/files/lcref_body.mac');
  return (token == null ? req : req.set('Authorization', `Bearer ${token}`)).send(body);
};

describe('POST /api/mcp/files/:reference — the create scope', () => {
  const CREATOR = { userId: 'user-a', scope: 'c', conversationId: 'convo-1' };

  beforeEach(() => {
    mockSaveBuffer.mockResolvedValue('/uploads/user-a/documents/notes.md');
    mockCreateFile.mockImplementation(async (data) => data);
  });

  it('refuses a READ reference', async () => {
    mockVerifyFileRef.mockReturnValue(PRINCIPAL);
    expect((await post()).status).toBe(404);
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('refuses a WRITE reference', async () => {
    mockVerifyFileRef.mockReturnValue({ ...PRINCIPAL, scope: 'w' });
    expect((await post()).status).toBe(404);
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('refuses a create reference carrying no conversation', async () => {
    mockVerifyFileRef.mockReturnValue({ userId: 'user-a', scope: 'c' });
    expect((await post()).status).toBe(404);
  });

  it('creates the file for the principal and conversation in the reference', async () => {
    mockVerifyFileRef.mockReturnValue(CREATOR);
    const res = await post({ content: 'hello', filename: 'notes.md' });
    expect(res.status).toBe(201);
    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-a',
        conversationId: 'convo-1',
        filename: 'notes.md',
        context: 'canvas_source',
        bytes: 5,
      }),
      true,
    );
  });

  it('never takes the owner or conversation from the request body', async () => {
    mockVerifyFileRef.mockReturnValue(CREATOR);
    await post({ content: 'x', filename: 'n.md', user: 'user-b', conversationId: 'other' });
    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user-a', conversationId: 'convo-1' }),
      true,
    );
  });

  it('cannot be aimed at an existing file, because it carries no file id', async () => {
    /* This is what makes create safe next to write: there is no id in the
       payload to overwrite, and the id is minted here, not accepted. */
    mockVerifyFileRef.mockReturnValue({ ...CREATOR, fileId: 'victim-file' });
    const res = await post();
    expect(res.status).toBe(201);
    const [created] = mockCreateFile.mock.calls[0];
    expect(created.file_id).not.toBe('victim-file');
  });

  it('strips path separators out of the filename', async () => {
    mockVerifyFileRef.mockReturnValue(CREATOR);
    await post({ content: 'x', filename: '../../etc/passwd' });
    const [created] = mockCreateFile.mock.calls[0];
    expect(created.filename).not.toMatch(/[/\\]/);
  });

  it('refuses a missing or empty filename', async () => {
    mockVerifyFileRef.mockReturnValue(CREATOR);
    expect((await post({ content: 'x' })).status).toBe(404);
    expect((await post({ content: 'x', filename: '   ' })).status).toBe(404);
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('disables the upload TTL, so a document is not reaped an hour later', async () => {
    mockVerifyFileRef.mockReturnValue(CREATOR);
    await post();
    expect(mockCreateFile.mock.calls[0][1]).toBe(true);
  });
});
