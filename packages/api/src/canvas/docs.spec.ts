import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  createDoc,
  getDocMeta,
  listDocs,
  readDocVersion,
  applyDocEdit,
  slugifyDocKey,
  isValidDocKey,
} from './docs';

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
  });

  const docPath = (uid: string, docKey: string, file: string): string =>
    path.join(baseDir, uid, 'docs', docKey, file);

  test('createDoc writes v1 + meta under the per-user docs dir', async () => {
    const meta = await createDoc({
      baseDir,
      userId,
      filename: 'Big Report.md',
      content: '# Report\n\nbody',
    });

    expect(meta).toMatchObject({
      identifier: 'big-report-md',
      title: 'Big Report.md',
      type: 'text/markdown',
      currentVersion: 1,
    });
    expect(meta.createdAt).toEqual(meta.updatedAt);
    expect(fs.readFileSync(docPath(userId, 'big-report-md', 'v1.md'), 'utf8')).toBe(
      '# Report\n\nbody',
    );
    const persisted = JSON.parse(
      fs.readFileSync(docPath(userId, 'big-report-md', 'meta.json'), 'utf8'),
    );
    expect(persisted.identifier).toBe('big-report-md');
  });

  test('createDoc rejects invalid user and unusable filename', async () => {
    await expect(
      createDoc({ baseDir, userId: '../etc', filename: 'ok.md', content: 'x' }),
    ).rejects.toThrow('invalid user');
    await expect(createDoc({ baseDir, userId, filename: '___', content: 'x' })).rejects.toThrow(
      'invalid filename',
    );
  });

  test('getDocMeta / readDocVersion return null for unknown or unsafe keys', async () => {
    await createDoc({ baseDir, userId, filename: 'notes.md', content: 'hello' });

    expect(await getDocMeta({ baseDir, userId, docKey: 'notes-md' })).not.toBeNull();
    expect(await readDocVersion({ baseDir, userId, docKey: 'notes-md', version: 1 })).toBe('hello');
    expect(await getDocMeta({ baseDir, userId, docKey: 'missing' })).toBeNull();
    expect(await readDocVersion({ baseDir, userId, docKey: 'notes-md', version: 2 })).toBeNull();
    expect(await getDocMeta({ baseDir, userId, docKey: '../../etc' })).toBeNull();
    expect(await readDocVersion({ baseDir, userId, docKey: '../secret', version: 1 })).toBeNull();
  });

  test('listDocs returns all of a user’s docs and empty for an unknown user', async () => {
    await createDoc({ baseDir, userId, filename: 'a.md', content: 'a' });
    await createDoc({ baseDir, userId, filename: 'b.md', content: 'b' });

    const metas = await listDocs({ baseDir, userId });
    expect(metas.map((m) => m.identifier).sort()).toEqual(['a-md', 'b-md']);
    expect(await listDocs({ baseDir, userId: 'nobody' })).toEqual([]);
  });

  test('applyDocEdit bumps the version and rewrites content', async () => {
    await createDoc({ baseDir, userId, filename: 'doc.md', content: 'alpha\nbravo\ncharlie' });

    const result = await applyDocEdit({
      baseDir,
      userId,
      docKey: 'doc-md',
      blocks: [{ original: 'bravo', updated: 'BRAVO' }],
    });

    expect(result).toEqual({
      status: 'applied',
      version: 2,
      oldContent: 'alpha\nbravo\ncharlie',
      newContent: 'alpha\nBRAVO\ncharlie',
    });
    expect(fs.readFileSync(docPath(userId, 'doc-md', 'v2.md'), 'utf8')).toBe(
      'alpha\nBRAVO\ncharlie',
    );
    const meta = await getDocMeta({ baseDir, userId, docKey: 'doc-md' });
    expect(meta?.currentVersion).toBe(2);
    expect(meta?.updatedAt).not.toBe(meta?.createdAt);
  });

  test('applyDocEdit applies multiple blocks in order against one version', async () => {
    await createDoc({ baseDir, userId, filename: 'doc.md', content: 'one two three' });

    const result = await applyDocEdit({
      baseDir,
      userId,
      docKey: 'doc-md',
      blocks: [
        { original: 'one', updated: '1' },
        { original: 'three', updated: '3' },
      ],
    });

    expect(result.status).toBe('applied');
    expect(fs.readFileSync(docPath(userId, 'doc-md', 'v2.md'), 'utf8')).toBe('1 two 3');
  });

  test('applyDocEdit is atomic: an unmatched block writes nothing', async () => {
    await createDoc({ baseDir, userId, filename: 'doc.md', content: 'keep me' });

    const result = await applyDocEdit({
      baseDir,
      userId,
      docKey: 'doc-md',
      blocks: [
        { original: 'keep', updated: 'KEEP' },
        { original: 'absent', updated: 'x' },
      ],
    });

    expect(result.status).toBe('nomatch');
    expect(fs.existsSync(docPath(userId, 'doc-md', 'v2.md'))).toBe(false);
    expect(fs.readFileSync(docPath(userId, 'doc-md', 'v1.md'), 'utf8')).toBe('keep me');
    const meta = await getDocMeta({ baseDir, userId, docKey: 'doc-md' });
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
    await createDoc({ baseDir, userId: 'userBBBB', filename: 'secret.md', content: 'top secret' });

    const result = await applyDocEdit({
      baseDir,
      userId: 'userAAAA',
      docKey: 'secret-md',
      blocks: [{ original: 'top secret', updated: 'leaked' }],
    });

    expect(result.status).toBe('notfound');
    expect(fs.readFileSync(docPath('userBBBB', 'secret-md', 'v1.md'), 'utf8')).toBe('top secret');
    expect(fs.existsSync(docPath('userBBBB', 'secret-md', 'v2.md'))).toBe(false);
  });
});
