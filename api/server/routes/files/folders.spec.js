const express = require('express');
const request = require('supertest');

/**
 * Route-level contract for folders. The methods are covered against a real
 * mongod in packages/data-schemas; what matters here is the translation layer:
 * a typed folder error must become the right status, an unexpected error must
 * NOT leak its message, and a delete must not remove the folder row when its
 * contents survived.
 */
const mockDb = {
  listFolders: jest.fn(),
  createFolder: jest.fn(),
  moveFolder: jest.fn(),
  countFolderContents: jest.fn(),
  fileFilter: jest.fn(),
  getFiles: jest.fn(),
  deleteFolderRecords: jest.fn(),
};
const mockProcessDeleteRequest = jest.fn();

jest.mock('~/models', () => mockDb);
jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: (...args) => mockProcessDeleteRequest(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const folders = require('./folders');

function app() {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    req.user = { id: 'alice' };
    next();
  });
  application.use('/api/files/folders', folders);
  return application;
}

function folderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

beforeEach(() => jest.clearAllMocks());

describe('folder CRUD routes', () => {
  it('creates a folder', async () => {
    mockDb.createFolder.mockResolvedValue({ _id: 'f1', name: 'tattoo', path: '/tattoo' });
    const res = await request(app()).post('/api/files/folders').send({ name: 'tattoo' });
    expect(res.status).toBe(201);
    expect(mockDb.createFolder).toHaveBeenCalledWith({
      user: 'alice',
      name: 'tattoo',
      parentId: null,
    });
  });

  it('passes the authenticated user, never a user from the body', async () => {
    mockDb.createFolder.mockResolvedValue({ _id: 'f1' });
    await request(app()).post('/api/files/folders').send({ name: 'x', user: 'bob' });
    expect(mockDb.createFolder).toHaveBeenCalledWith(expect.objectContaining({ user: 'alice' }));
  });

  it.each([
    ['invalid_name', 400],
    ['duplicate', 409],
    ['cycle', 400],
    ['not_found', 404],
  ])('maps a %s error to %i', async (code, status) => {
    mockDb.createFolder.mockRejectedValue(folderError(code, 'nope'));
    const res = await request(app()).post('/api/files/folders').send({ name: 'x' });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it('does not leak an unexpected error message to the client', async () => {
    mockDb.createFolder.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:27017'));
    const res = await request(app()).post('/api/files/folders').send({ name: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|27017/);
  });

  it('renames and moves through one route', async () => {
    mockDb.moveFolder.mockResolvedValue({ _id: 'f1', name: 'ink' });
    await request(app()).patch('/api/files/folders/f1').send({ name: 'ink', parentId: null });
    expect(mockDb.moveFolder).toHaveBeenCalledWith({
      user: 'alice',
      folderId: 'f1',
      name: 'ink',
      parentId: null,
    });
  });

  it('omits absent fields rather than sending undefined as an intent to clear', async () => {
    mockDb.moveFolder.mockResolvedValue({ _id: 'f1' });
    await request(app()).patch('/api/files/folders/f1').send({ name: 'ink' });
    /* If parentId were forwarded as undefined the method could not tell "leave
       the parent alone" from "move to root". */
    expect(mockDb.moveFolder).toHaveBeenCalledWith({
      user: 'alice',
      folderId: 'f1',
      name: 'ink',
    });
  });

  it('returns counts so the delete warning can be a decision', async () => {
    mockDb.countFolderContents.mockResolvedValue({ folders: 3, files: 12 });
    const res = await request(app()).get('/api/files/folders/f1/contents');
    expect(res.body).toEqual({ folders: 3, files: 12 });
  });
});

describe('deleting a folder and its contents', () => {
  it('deletes contents through the file funnel BEFORE the folder rows', async () => {
    const order = [];
    mockDb.fileFilter.mockResolvedValue({ user: 'alice' });
    mockDb.getFiles.mockResolvedValue([{ file_id: 'a' }, { file_id: 'b' }]);
    mockProcessDeleteRequest.mockImplementation(async () => order.push('files'));
    mockDb.deleteFolderRecords.mockImplementation(async () => {
      order.push('folders');
      return ['f1'];
    });

    const res = await request(app()).delete('/api/files/folders/f1');

    expect(res.status).toBe(200);
    expect(order).toEqual(['files', 'folders']);
    expect(res.body).toEqual({ folders: 1, files: 2 });
  });

  it('uses the subtree filter, so a nested folder is not left behind', async () => {
    mockDb.fileFilter.mockResolvedValue({ user: 'alice' });
    mockDb.getFiles.mockResolvedValue([]);
    mockDb.deleteFolderRecords.mockResolvedValue(['f1']);
    await request(app()).delete('/api/files/folders/f1');
    expect(mockDb.fileFilter).toHaveBeenCalledWith({
      user: 'alice',
      folderId: 'f1',
      subtree: true,
    });
  });

  it('KEEPS the folder when its contents could not all be deleted', async () => {
    /* Removing the folder while files survive is exactly how things become
       invisible: the files would list as unfiled at best, orphaned at worst. */
    mockDb.fileFilter.mockResolvedValue({ user: 'alice' });
    mockDb.getFiles.mockResolvedValue([{ file_id: 'a' }]);
    mockProcessDeleteRequest.mockRejectedValue(new Error('storage unavailable'));

    const res = await request(app()).delete('/api/files/folders/f1');

    expect(res.status).toBe(500);
    expect(mockDb.deleteFolderRecords).not.toHaveBeenCalled();
    expect(res.body.message).toMatch(/kept/i);
  });

  it('deletes an empty folder without calling the file funnel', async () => {
    mockDb.fileFilter.mockResolvedValue({ user: 'alice' });
    mockDb.getFiles.mockResolvedValue([]);
    mockDb.deleteFolderRecords.mockResolvedValue(['f1']);
    const res = await request(app()).delete('/api/files/folders/f1');
    expect(mockProcessDeleteRequest).not.toHaveBeenCalled();
    expect(res.body).toEqual({ folders: 1, files: 0 });
  });

  it("refuses to delete another user's folder with a 404", async () => {
    mockDb.fileFilter.mockRejectedValue(folderError('not_found', 'No such folder.'));
    const res = await request(app()).delete('/api/files/folders/bobs');
    expect(res.status).toBe(404);
    expect(mockDb.deleteFolderRecords).not.toHaveBeenCalled();
  });
});
