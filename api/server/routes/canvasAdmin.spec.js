const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createOrVersionDoc } = require('@librechat/api');
const router = require('./canvasAdmin');

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

describe('POST /canvas-admin/delete route', () => {
  let app;
  let sourcesDir;
  const originalDir = process.env.CANVAS_SOURCES_DIR;
  const originalToken = process.env.CANVAS_ADMIN_TOKEN;
  const userId = 'a1b2c3d4e5f6';
  const TOKEN = 'test-admin-token';

  beforeEach(() => {
    sourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-admin-'));
    process.env.CANVAS_SOURCES_DIR = sourcesDir;
    process.env.CANVAS_ADMIN_TOKEN = TOKEN;
    app = express();
    app.use(express.json());
    app.use('/', router);
  });

  afterEach(() => {
    if (originalDir === undefined) {
      delete process.env.CANVAS_SOURCES_DIR;
    } else {
      process.env.CANVAS_SOURCES_DIR = originalDir;
    }
    if (originalToken === undefined) {
      delete process.env.CANVAS_ADMIN_TOKEN;
    } else {
      process.env.CANVAS_ADMIN_TOKEN = originalToken;
    }
    if (sourcesDir && fs.existsSync(sourcesDir)) {
      fs.rmSync(sourcesDir, { recursive: true, force: true });
    }
  });

  const readDocsIndex = () =>
    JSON.parse(
      fs.readFileSync(path.join(sourcesDir, userId, 'docs', '.canvas', 'index.json'), 'utf8'),
    );
  const seed = (filename, content) =>
    createOrVersionDoc({ baseDir: sourcesDir, userId, filename, content });
  const withAuth = (req) => req.set('Authorization', `Bearer ${TOKEN}`);

  it('deletes a doc for the authenticated service caller', async () => {
    const { docKey } = await seed('gone.md', 'delete me');
    const res = await withAuth(request(app).post('/delete')).send({ userId, docKey });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'deleted', docKey, title: 'gone.md' });
    expect(readDocsIndex()[docKey]).toBeUndefined();
  });

  it('returns 401 without a valid bearer token and leaves the doc intact', async () => {
    const { docKey } = await seed('gone.md', 'delete me');
    const res = await request(app).post('/delete').send({ userId, docKey });
    expect(res.status).toBe(401);
    expect(readDocsIndex()[docKey]).toBeDefined();
  });

  it('returns 501 when the admin token is not configured', async () => {
    delete process.env.CANVAS_ADMIN_TOKEN;
    const res = await request(app).post('/delete').send({ userId, docKey: 'x-1234' });
    expect(res.status).toBe(501);
  });

  it('returns 404 for a missing doc', async () => {
    const res = await withAuth(request(app).post('/delete')).send({ userId, docKey: 'missing-1234' });
    expect(res.status).toBe(404);
  });

  it('returns 409 on an expectedTitle mismatch and leaves the doc intact', async () => {
    const { docKey } = await seed('report.md', 'body');
    const res = await withAuth(request(app).post('/delete')).send({
      userId,
      docKey,
      expectedTitle: 'stale.md',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'title mismatch', actual: 'report.md' });
    expect(readDocsIndex()[docKey]).toBeDefined();
  });

  it('rejects an invalid docKey shape with 400', async () => {
    const res = await withAuth(request(app).post('/delete')).send({ userId, docKey: '../etc' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid user with 400', async () => {
    const res = await withAuth(request(app).post('/delete')).send({ userId: '../etc', docKey: 'x-1234' });
    expect(res.status).toBe(400);
  });
});
