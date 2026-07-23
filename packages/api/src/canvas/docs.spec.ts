import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as git from 'isomorphic-git';
import {
  createOrVersionDoc,
  getDocMeta,
  listDocs,
  readDocVersion,
  applyDocEdit,
  deleteDoc,
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

describe('canvas doc store (git-backed)', () => {
  let baseDir: string;
  const userId = 'userAAAA';

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-docs-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const repoDir = (uid = userId): string => path.join(baseDir, uid, 'docs');
  const readIndex = (uid = userId): Record<string, { path: string } & Record<string, unknown>> =>
    JSON.parse(fs.readFileSync(path.join(repoDir(uid), '.canvas', 'index.json'), 'utf8'));
  const entryOf = (docKey: string, uid = userId): { path: string } & Record<string, unknown> =>
    readIndex(uid)[docKey];
  const workingFile = (docKey: string, uid = userId): string =>
    fs.readFileSync(path.join(repoDir(uid), entryOf(docKey, uid).path), 'utf8');
  const commitAuthors = async (docKey: string, uid = userId): Promise<string[]> => {
    const log = await git.log({ fs, dir: repoDir(uid), filepath: entryOf(docKey, uid).path });
    return log.map((entry) => entry.commit.author.name);
  };

  const seedDoc = async (filename: string, content: string, uid = userId): Promise<string> => {
    const { docKey } = await createOrVersionDoc({ baseDir, userId: uid, filename, content });
    return docKey;
  };

  test('createOrVersionDoc initializes a repo and commits v1 into the working tree', async () => {
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

    expect(fs.existsSync(path.join(repoDir(), '.git'))).toBe(true);
    expect(workingFile(result.docKey)).toBe('# Report\n\nbody');

    const entry = entryOf(result.docKey);
    expect(entry).toMatchObject({
      path: 'Big Report.md',
      title: 'Big Report.md',
      type: 'text/markdown',
      currentVersion: 1,
    });
    expect(entry.createdAt).toEqual(entry.updatedAt);

    expect(await commitAuthors(result.docKey)).toEqual(['canvas-upload']);
  });

  test('the index entry is self-sufficient (path, title, type, currentVersion, timestamps)', async () => {
    const docKey = await seedDoc('notes.md', 'hello');
    const entry = entryOf(docKey);

    expect(Object.keys(entry).sort()).toEqual(
      ['createdAt', 'currentVersion', 'path', 'title', 'type', 'updatedAt'].sort(),
    );
    expect(entry.currentVersion).toBe(1);
    expect(entry.type).toBe('text/markdown');
    expect(typeof entry.path).toBe('string');
  });

  test('re-uploading the same filename appends v2 as a second commit and preserves v1', async () => {
    const docKey = await seedDoc('Big Report.md', 'first draft');

    const result = await createOrVersionDoc({
      baseDir,
      userId,
      filename: 'Big Report.md',
      content: 'second draft',
    });

    expect(result).toEqual({ docKey, version: 2, created: false });
    expect(workingFile(docKey)).toBe('second draft');
    expect(await readDocVersion({ baseDir, userId, docKey, version: 1 })).toBe('first draft');
    expect(await readDocVersion({ baseDir, userId, docKey, version: 2 })).toBe('second draft');

    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(2);
    expect(meta?.updatedAt).not.toBe(meta?.createdAt);
    expect(await listDocs({ baseDir, userId })).toHaveLength(1);

    expect(await commitAuthors(docKey)).toEqual(['canvas-upload', 'canvas-upload']);
  });

  test('version numbers are derived from the count of commits touching the doc', async () => {
    const docKey = await seedDoc('doc.md', 'v1');
    await createOrVersionDoc({ baseDir, userId, filename: 'doc.md', content: 'v2' });
    await applyDocEdit({ baseDir, userId, docKey, blocks: [{ original: 'v2', updated: 'v3' }] });

    const log = await git.log({ fs, dir: repoDir(), filepath: entryOf(docKey).path });
    expect(log).toHaveLength(3);
    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(3);
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

  test('regenerates the key suffix on collision instead of reusing an identity', async () => {
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
    expect(workingFile(first)).toBe('alpha');
    expect(workingFile(second)).toBe('bravo');
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

  test('reads never create a repo for a user with no docs', async () => {
    expect(await listDocs({ baseDir, userId: 'nobody12' })).toEqual([]);
    expect(await getDocMeta({ baseDir, userId: 'nobody12', docKey: 'x-1234' })).toBeNull();
    expect(fs.existsSync(path.join(baseDir, 'nobody12'))).toBe(false);
  });

  test('listDocs returns all of a user’s docs and empty for an unknown user', async () => {
    const first = await seedDoc('a.md', 'a');
    const second = await seedDoc('b.md', 'b');

    const metas = await listDocs({ baseDir, userId });
    expect(metas.map((m) => m.identifier).sort()).toEqual([first, second].sort());
    expect(await listDocs({ baseDir, userId: 'nobody12' })).toEqual([]);
  });

  test('applyDocEdit bumps the version, rewrites content, and returns a git diff', async () => {
    const docKey = await seedDoc('doc.md', 'alpha\nbravo\ncharlie');

    const result = await applyDocEdit({
      baseDir,
      userId,
      docKey,
      blocks: [{ original: 'bravo', updated: 'BRAVO' }],
    });

    expect(result).toMatchObject({
      status: 'applied',
      version: 2,
      oldContent: 'alpha\nbravo\ncharlie',
      newContent: 'alpha\nBRAVO\ncharlie',
    });
    if (result.status === 'applied') {
      expect(result.diff).toContain('-bravo');
      expect(result.diff).toContain('+BRAVO');
    }
    expect(workingFile(docKey)).toBe('alpha\nBRAVO\ncharlie');
    expect(await readDocVersion({ baseDir, userId, docKey, version: 1 })).toBe(
      'alpha\nbravo\ncharlie',
    );
    expect(await commitAuthors(docKey)).toEqual(['canvas-model-edit', 'canvas-upload']);
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
    expect(workingFile(docKey)).toBe('1 two 3');
  });

  test('applyDocEdit is atomic: an unmatched block writes and commits nothing', async () => {
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
    expect(workingFile(docKey)).toBe('keep me');
    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(1);
    expect(await commitAuthors(docKey)).toEqual(['canvas-upload']);
  });

  test('applyDocEdit returns notfound for unknown or unsafe keys', async () => {
    await seedDoc('real.md', 'exists');
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

  test('applyDocEdit on a user with no repo is notfound and creates nothing', async () => {
    const result = await applyDocEdit({
      baseDir,
      userId: 'nobody12',
      docKey: 'ghost-1234',
      blocks: [{ original: 'a', updated: 'b' }],
    });
    expect(result.status).toBe('notfound');
    expect(fs.existsSync(path.join(baseDir, 'nobody12'))).toBe(false);
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
    expect(workingFile(docKey, 'userBBBB')).toBe('top secret');
  });

  test('serializes concurrent mutations for one user through the per-user lock', async () => {
    const [a, b] = await Promise.all([
      createOrVersionDoc({ baseDir, userId, filename: 'race.md', content: 'from-a' }),
      createOrVersionDoc({ baseDir, userId, filename: 'race.md', content: 'from-b' }),
    ]);

    expect([a.version, b.version].sort()).toEqual([1, 2]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.docKey).toBe(b.docKey);

    const meta = await getDocMeta({ baseDir, userId, docKey: a.docKey });
    expect(meta?.currentVersion).toBe(2);
    expect(await listDocs({ baseDir, userId })).toHaveLength(1);

    const log = await git.log({ fs, dir: repoDir(), filepath: entryOf(a.docKey).path });
    expect(log).toHaveLength(2);
    const v1 = await readDocVersion({ baseDir, userId, docKey: a.docKey, version: 1 });
    const v2 = await readDocVersion({ baseDir, userId, docKey: a.docKey, version: 2 });
    expect([v1, v2].sort()).toEqual(['from-a', 'from-b'].sort());
  });

  test('deleteDoc removes the index entry and working file and commits canvas-delete', async () => {
    const keep = await seedDoc('keep.md', 'keep me');
    const docKey = await seedDoc('gone.md', 'delete me');
    const relPath = entryOf(docKey).path;

    const result = await deleteDoc({ baseDir, userId, docKey });

    expect(result).toEqual({ status: 'deleted', docKey, title: 'gone.md' });
    expect(readIndex()[docKey]).toBeUndefined();
    expect(fs.existsSync(path.join(repoDir(), relPath as string))).toBe(false);
    expect(await getDocMeta({ baseDir, userId, docKey })).toBeNull();
    expect((await listDocs({ baseDir, userId })).map((m) => m.identifier)).toEqual([keep]);

    const log = await git.log({ fs, dir: repoDir() });
    expect(log[0].commit.author.name).toBe('canvas-delete');
    expect(log[0].commit.message).toContain(`delete: ${docKey}`);
  });

  test('deleteDoc keeps the deleted doc recoverable from git history', async () => {
    const docKey = await seedDoc('gone.md', 'v1 body');
    await createOrVersionDoc({ baseDir, userId, filename: 'gone.md', content: 'v2 body' });
    const relPath = entryOf(docKey).path as string;

    await deleteDoc({ baseDir, userId, docKey });

    const log = await git.log({ fs, dir: repoDir() });
    const parent = log[0].commit.parent[0];
    const { blob } = await git.readBlob({ fs, dir: repoDir(), oid: parent, filepath: relPath });
    expect(Buffer.from(blob).toString('utf8')).toBe('v2 body');
  });

  test('deleteDoc honors expectedTitle as an optimistic-concurrency guard', async () => {
    const docKey = await seedDoc('report.md', 'body');

    const mismatch = await deleteDoc({ baseDir, userId, docKey, expectedTitle: 'stale.md' });
    expect(mismatch).toEqual({ status: 'mismatch', actual: 'report.md' });
    expect(readIndex()[docKey]).toBeDefined();

    const ok = await deleteDoc({ baseDir, userId, docKey, expectedTitle: 'report.md' });
    expect(ok.status).toBe('deleted');
    expect(readIndex()[docKey]).toBeUndefined();
  });

  test('deleteDoc returns notfound for unknown/unsafe keys and users with no repo', async () => {
    await seedDoc('real.md', 'exists');
    expect((await deleteDoc({ baseDir, userId, docKey: 'missing' })).status).toBe('notfound');
    expect((await deleteDoc({ baseDir, userId, docKey: '../../etc' })).status).toBe('notfound');
    const ghost = await deleteDoc({ baseDir, userId: 'nobody12', docKey: 'ghost-1234' });
    expect(ghost.status).toBe('notfound');
    expect(fs.existsSync(path.join(baseDir, 'nobody12'))).toBe(false);
  });

  test('per-user isolation: one user cannot delete another user’s doc', async () => {
    const docKey = await seedDoc('secret.md', 'top secret', 'userBBBB');

    const result = await deleteDoc({ baseDir, userId: 'userAAAA', docKey });

    expect(result.status).toBe('notfound');
    expect(workingFile(docKey, 'userBBBB')).toBe('top secret');
  });
});

describe('legacy migration', () => {
  let baseDir: string;
  const userId = 'userAAAA';

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const repoDir = (): string => path.join(baseDir, userId, 'docs');

  const seedLegacyDoc = (
    docKey: string,
    title: string,
    versions: string[],
    createdAt: string,
    updatedAt: string,
  ): void => {
    const dir = path.join(repoDir(), docKey);
    fs.mkdirSync(dir, { recursive: true });
    versions.forEach((content, idx) => {
      fs.writeFileSync(path.join(dir, `v${idx + 1}.md`), content);
    });
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        identifier: docKey,
        title,
        type: 'text/markdown',
        currentVersion: versions.length,
        createdAt,
        updatedAt,
      }),
    );
  };

  test('replays legacy vN.md docs as commits, populates the index, and removes old dirs', async () => {
    seedLegacyDoc(
      'report-md-old1',
      'report.md',
      ['draft one', 'draft two', 'draft three'],
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    );
    seedLegacyDoc(
      'notes-md-old2',
      'notes.md',
      ['note v1'],
      '2026-01-15T00:00:00.000Z',
      '2026-01-15T00:00:00.000Z',
    );

    const meta = await getDocMeta({ baseDir, userId, docKey: 'report-md-old1' });
    expect(meta).toMatchObject({
      identifier: 'report-md-old1',
      title: 'report.md',
      type: 'text/markdown',
      currentVersion: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });

    expect(fs.existsSync(path.join(repoDir(), '.git'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir(), 'report-md-old1'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir(), 'notes-md-old2'))).toBe(false);

    const index = JSON.parse(
      fs.readFileSync(path.join(repoDir(), '.canvas', 'index.json'), 'utf8'),
    );
    expect(index['report-md-old1'].path).toBe('report.md');
    expect(index['notes-md-old2'].currentVersion).toBe(1);
    expect(fs.readFileSync(path.join(repoDir(), 'report.md'), 'utf8')).toBe('draft three');

    expect(await readDocVersion({ baseDir, userId, docKey: 'report-md-old1', version: 1 })).toBe(
      'draft one',
    );
    expect(await readDocVersion({ baseDir, userId, docKey: 'report-md-old1', version: 2 })).toBe(
      'draft two',
    );

    const log = await git.log({ fs, dir: repoDir(), filepath: 'report.md' });
    expect(log).toHaveLength(3);
    expect(log.every((c) => c.commit.author.name === 'canvas-migrate')).toBe(true);

    expect((await listDocs({ baseDir, userId })).map((m) => m.identifier).sort()).toEqual(
      ['notes-md-old2', 'report-md-old1'].sort(),
    );
  });

  test('a re-upload after migration versions the migrated doc rather than duplicating it', async () => {
    seedLegacyDoc(
      'report-md-old1',
      'report.md',
      ['legacy body'],
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const result = await createOrVersionDoc({
      baseDir,
      userId,
      filename: 'report.md',
      content: 'new body',
    });

    expect(result).toEqual({ docKey: 'report-md-old1', version: 2, created: false });
    expect(await listDocs({ baseDir, userId })).toHaveLength(1);
    expect(await readDocVersion({ baseDir, userId, docKey: 'report-md-old1', version: 1 })).toBe(
      'legacy body',
    );
  });
});
