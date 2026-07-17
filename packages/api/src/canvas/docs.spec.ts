import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  createOrVersionDoc,
  getDocMeta,
  listDocs,
  readDocVersion,
  applyDocEdit,
  slugifyDocKey,
  isValidDocKey,
} from './docs';

const KEY_SUFFIX = /-[a-z0-9]{4}$/;

describe('slugifyDocKey', () => {
  test('lowercases and collapses non-alphanumeric runs to single hyphens', () => {
    expect(slugifyDocKey('Big Report.md')).toBe('big-report-md');
    expect(slugifyDocKey('My   Notes___2026.txt')).toBe('my-notes-2026-txt');
    expect(slugifyDocKey('ALLCAPS')).toBe('allcaps');
  });

  test('trims leading and trailing hyphens', () => {
    expect(slugifyDocKey('  spaced  ')).toBe('spaced');
    expect(slugifyDocKey('.dotfile.md')).toBe('dotfile-md');
  });

  test('returns null when nothing usable remains', () => {
    expect(slugifyDocKey('___')).toBeNull();
    expect(slugifyDocKey('.-.')).toBeNull();
    expect(slugifyDocKey('')).toBeNull();
  });
});

describe('isValidDocKey', () => {
  test('accepts slug-shaped keys and rejects traversal', () => {
    expect(isValidDocKey('big-report-md')).toBe(true);
    expect(isValidDocKey('big-report-md-1a2b')).toBe(true);
    expect(isValidDocKey('a1')).toBe(true);
    expect(isValidDocKey('../other')).toBe(false);
    expect(isValidDocKey('with/slash')).toBe(false);
    expect(isValidDocKey('UpperCase')).toBe(false);
    expect(isValidDocKey('-leading')).toBe(false);
    expect(isValidDocKey('')).toBe(false);
  });
});

describe('canvas doc store', () => {
  let baseDir: string;
  const userId = 'userAAAA';

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-docs-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const docPath = (uid: string, docKey: string, file: string): string =>
    path.join(baseDir, uid, 'docs', docKey, file);

  const seedDoc = async (filename: string, content: string, uid = userId): Promise<string> => {
    const { docKey } = await createOrVersionDoc({ baseDir, userId: uid, filename, content });
    return docKey;
  };

  test('createOrVersionDoc creates v1 + meta under a suffixed unique key', async () => {
    const result = await createOrVersionDoc({
      baseDir,
      userId,
      filename: 'Big Report.md',
      content: '# Report\n\nbody',
    });

    expect(result.created).toBe(true);
    expect(result.version).toBe(1);
    expect(result.docKey).toMatch(/^big-report-md-[a-z0-9]{4}$/);
    expect(isValidDocKey(result.docKey)).toBe(true);
    expect(fs.readFileSync(docPath(userId, result.docKey, 'v1.md'), 'utf8')).toBe(
      '# Report\n\nbody',
    );
    const meta = JSON.parse(fs.readFileSync(docPath(userId, result.docKey, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      identifier: result.docKey,
      title: 'Big Report.md',
      type: 'text/markdown',
      currentVersion: 1,
    });
    expect(meta.createdAt).toEqual(meta.updatedAt);
  });

  test('re-uploading the same filename appends v2 and preserves v1', async () => {
    const docKey = await seedDoc('Big Report.md', 'first draft');

    const result = await createOrVersionDoc({
      baseDir,
      userId,
      filename: 'Big Report.md',
      content: 'second draft',
    });

    expect(result).toEqual({ docKey, version: 2, created: false });
    expect(fs.readFileSync(docPath(userId, docKey, 'v1.md'), 'utf8')).toBe('first draft');
    expect(fs.readFileSync(docPath(userId, docKey, 'v2.md'), 'utf8')).toBe('second draft');
    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(2);
    expect(meta?.updatedAt).not.toBe(meta?.createdAt);
    expect(await listDocs({ baseDir, userId })).toHaveLength(1);
  });

  test('a different filename creates a distinct doc with a distinct key', async () => {
    const first = await seedDoc('Report.md', 'alpha');
    const second = await seedDoc('Other.md', 'bravo');

    expect(second).not.toBe(first);
    expect(second).toMatch(/^other-md-[a-z0-9]{4}$/);
    expect((await listDocs({ baseDir, userId })).map((m) => m.identifier).sort()).toEqual(
      [first, second].sort(),
    );
  });

  test('regenerates the key suffix on collision instead of reusing a directory', async () => {
    jest
      .spyOn(crypto, 'randomBytes')
      .mockReturnValueOnce(Buffer.from([1, 2, 3, 4]) as never)
      .mockReturnValueOnce(Buffer.from([1, 2, 3, 4]) as never)
      .mockReturnValueOnce(Buffer.from([5, 6, 7, 8]) as never);

    const first = await seedDoc('Report.md', 'alpha');
    const second = await seedDoc('report.md', 'bravo');

    expect(first).toBe('report-md-1234');
    expect(second).toBe('report-md-5678');
    expect(crypto.randomBytes).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(docPath(userId, first, 'v1.md'), 'utf8')).toBe('alpha');
    expect(fs.readFileSync(docPath(userId, second, 'v1.md'), 'utf8')).toBe('bravo');
  });

  test('createOrVersionDoc rejects invalid user and unusable filename', async () => {
    await expect(
      createOrVersionDoc({ baseDir, userId: '../etc', filename: 'ok.md', content: 'x' }),
    ).rejects.toThrow('invalid user');
    await expect(
      createOrVersionDoc({ baseDir, userId, filename: '___', content: 'x' }),
    ).rejects.toThrow('invalid filename');
  });

  test('getDocMeta / readDocVersion return null for unknown or unsafe keys', async () => {
    const docKey = await seedDoc('notes.md', 'hello');

    expect(await getDocMeta({ baseDir, userId, docKey })).not.toBeNull();
    expect(await readDocVersion({ baseDir, userId, docKey, version: 1 })).toBe('hello');
    expect(await getDocMeta({ baseDir, userId, docKey: 'missing' })).toBeNull();
    expect(await readDocVersion({ baseDir, userId, docKey, version: 2 })).toBeNull();
    expect(await getDocMeta({ baseDir, userId, docKey: '../../etc' })).toBeNull();
    expect(await readDocVersion({ baseDir, userId, docKey: '../secret', version: 1 })).toBeNull();
  });

  test('listDocs returns all of a user’s docs and empty for an unknown user', async () => {
    const first = await seedDoc('a.md', 'a');
    const second = await seedDoc('b.md', 'b');

    const metas = await listDocs({ baseDir, userId });
    expect(metas.map((m) => m.identifier).sort()).toEqual([first, second].sort());
    expect(await listDocs({ baseDir, userId: 'nobody' })).toEqual([]);
  });

  test('applyDocEdit bumps the version and rewrites content', async () => {
    const docKey = await seedDoc('doc.md', 'alpha\nbravo\ncharlie');

    const result = await applyDocEdit({
      baseDir,
      userId,
      docKey,
      blocks: [{ original: 'bravo', updated: 'BRAVO' }],
    });

    expect(result).toEqual({
      status: 'applied',
      version: 2,
      oldContent: 'alpha\nbravo\ncharlie',
      newContent: 'alpha\nBRAVO\ncharlie',
    });
    expect(fs.readFileSync(docPath(userId, docKey, 'v2.md'), 'utf8')).toBe('alpha\nBRAVO\ncharlie');
    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(2);
    expect(meta?.updatedAt).not.toBe(meta?.createdAt);
  });

  test('applyDocEdit applies multiple blocks in order against one version', async () => {
    const docKey = await seedDoc('doc.md', 'one two three');

    const result = await applyDocEdit({
      baseDir,
      userId,
      docKey,
      blocks: [
        { original: 'one', updated: '1' },
        { original: 'three', updated: '3' },
      ],
    });

    expect(result.status).toBe('applied');
    expect(fs.readFileSync(docPath(userId, docKey, 'v2.md'), 'utf8')).toBe('1 two 3');
  });

  test('applyDocEdit is atomic: an unmatched block writes nothing', async () => {
    const docKey = await seedDoc('doc.md', 'keep me');

    const result = await applyDocEdit({
      baseDir,
      userId,
      docKey,
      blocks: [
        { original: 'keep', updated: 'KEEP' },
        { original: 'absent', updated: 'x' },
      ],
    });

    expect(result.status).toBe('nomatch');
    expect(fs.existsSync(docPath(userId, docKey, 'v2.md'))).toBe(false);
    expect(fs.readFileSync(docPath(userId, docKey, 'v1.md'), 'utf8')).toBe('keep me');
    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(1);
  });

  test('applyDocEdit returns notfound for unknown or unsafe keys', async () => {
    expect(
      (
        await applyDocEdit({
          baseDir,
          userId,
          docKey: 'missing',
          blocks: [{ original: 'a', updated: 'b' }],
        })
      ).status,
    ).toBe('notfound');
    expect(
      (
        await applyDocEdit({
          baseDir,
          userId,
          docKey: '../../etc/passwd',
          blocks: [{ original: 'a', updated: 'b' }],
        })
      ).status,
    ).toBe('notfound');
  });

  test('per-user isolation: one user cannot edit another user’s doc', async () => {
    const docKey = await seedDoc('secret.md', 'top secret', 'userBBBB');
    expect(docKey).toMatch(KEY_SUFFIX);

    const result = await applyDocEdit({
      baseDir,
      userId: 'userAAAA',
      docKey,
      blocks: [{ original: 'top secret', updated: 'leaked' }],
    });

    expect(result.status).toBe('notfound');
    expect(fs.readFileSync(docPath('userBBBB', docKey, 'v1.md'), 'utf8')).toBe('top secret');
    expect(fs.existsSync(docPath('userBBBB', docKey, 'v2.md'))).toBe(false);
  });
});
