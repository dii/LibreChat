import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as git from 'isomorphic-git';
import { unifiedDiff } from './diff';
import { withUserLock } from './lock';

export const CANVAS_DOC_TYPE = 'text/markdown';

const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DOC_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const CANVAS_DIR = '.canvas';
const INDEX_FILE = `${CANVAS_DIR}/index.json`;
const AUTHOR_EMAIL = 'canvas@localhost';
const DEFAULT_BRANCH = 'main';

type Provenance = 'canvas-init' | 'canvas-upload' | 'canvas-model-edit' | 'canvas-migrate';

export type CanvasDocMeta = {
  identifier: string;
  title: string;
  type: typeof CANVAS_DOC_TYPE;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * A single doc's record in `.canvas/index.json`. `docKey` is the stable handle
 * (the object key); `path` is the working-tree location (display/organization
 * only, may become a subfolder in a later phase). `currentVersion` and `type`
 * are maintained on every mutation so an external read-only consumer can serve
 * a doc from this file plus the working-tree file alone, without git.
 */
type CanvasIndexEntry = {
  path: string;
  title: string;
  type: typeof CANVAS_DOC_TYPE;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
};

type CanvasIndex = Record<string, CanvasIndexEntry>;

type LegacyMeta = {
  identifier: string;
  title: string;
  type?: typeof CANVAS_DOC_TYPE;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CanvasDocEditBlock = {
  original: string;
  updated: string;
};

export type CanvasDocEditResult =
  | {
      status: 'applied';
      version: number;
      oldContent: string;
      newContent: string;
      diff: string | null;
    }
  | { status: 'notfound' }
  | { status: 'nomatch' };

export type CanvasDocUpsertResult = {
  docKey: string;
  version: number;
  created: boolean;
};

const isValidUserId = (userId: string): boolean => USER_ID_PATTERN.test(userId);

export const isValidDocKey = (docKey: string): boolean => DOC_KEY_PATTERN.test(docKey);

/**
 * Derives the storage/identifier slug for a canvas doc from a filename:
 * lowercased, non-alphanumeric runs collapsed to single hyphens, trimmed.
 * Returns `null` when nothing usable remains (e.g. a name of only symbols).
 */
export const slugifyDocKey = (filename: string): string | null => {
  if (typeof filename !== 'string') {
    return null;
  }
  const slug = filename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? null : slug;
};

const docsRoot = (baseDir: string, userId: string): string => path.join(baseDir, userId, 'docs');

const gitDirPath = (dir: string): string => path.join(dir, '.git');

const indexAbsPath = (dir: string): string => path.join(dir, CANVAS_DIR, 'index.json');

const author = (name: Provenance) => ({ name, email: AUTHOR_EMAIL });

const randomKeySuffix = (): string =>
  Array.from(crypto.randomBytes(4), (byte) => (byte % 36).toString(36)).join('');

const toMeta = (docKey: string, entry: CanvasIndexEntry): CanvasDocMeta => ({
  identifier: docKey,
  title: entry.title,
  type: entry.type,
  currentVersion: entry.currentVersion,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

/**
 * Reduces a title/filename to a filesystem-safe working-tree name: strips any
 * directory component and leading dots, replaces disallowed characters, and
 * falls back to `doc` when nothing usable remains.
 */
const sanitizeFilename = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned === '' ? 'doc' : cleaned;
};

/**
 * Claims a working-tree path for a new doc, suffixing the filename stem
 * (`report-2.md`) when the sanitized name is already taken by another doc.
 */
const uniquePath = (index: CanvasIndex, filename: string): string => {
  const used = new Set(Object.values(index).map((entry) => entry.path));
  const safe = sanitizeFilename(filename);
  if (!used.has(safe)) {
    return safe;
  }
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
};

/**
 * Generates a fresh docKey (`slug` plus a random 4-char base36 suffix) not
 * already present in the index; a colliding suffix is regenerated so identity
 * is stable and never reused.
 */
const uniqueDocKey = (index: CanvasIndex, slug: string): string => {
  for (;;) {
    const docKey = `${slug}-${randomKeySuffix()}`;
    if (!Object.prototype.hasOwnProperty.call(index, docKey)) {
      return docKey;
    }
  }
};

const readIndex = async (dir: string): Promise<CanvasIndex> => {
  try {
    const raw = await fs.promises.readFile(indexAbsPath(dir), 'utf8');
    const parsed = JSON.parse(raw) as CanvasIndex;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeIndex = async (dir: string, index: CanvasIndex): Promise<void> => {
  await fs.promises.mkdir(path.join(dir, CANVAS_DIR), { recursive: true });
  await fs.promises.writeFile(indexAbsPath(dir), JSON.stringify(index, null, 2));
};

const writeDocFile = async (
  dir: string,
  relPath: string,
  content: Buffer | string,
): Promise<void> => {
  const abs = path.join(dir, relPath);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content);
};

const readWorkingFile = async (dir: string, relPath: string): Promise<string | null> => {
  try {
    return await fs.promises.readFile(path.join(dir, relPath), 'utf8');
  } catch {
    return null;
  }
};

const commit = async (
  dir: string,
  filepaths: string[],
  message: string,
  name: Provenance,
  timestamp?: number,
): Promise<void> => {
  for (const filepath of filepaths) {
    await git.add({ fs, dir, filepath });
  }
  const base = author(name);
  await git.commit({
    fs,
    dir,
    message,
    author: timestamp ? { ...base, timestamp } : base,
  });
};

const repoExists = async (dir: string): Promise<boolean> => {
  try {
    await fs.promises.access(gitDirPath(dir));
    return true;
  } catch {
    return false;
  }
};

/** Finds legacy doc directories (`<docKey>/meta.json`) awaiting migration. */
const findLegacyDocs = async (dir: string): Promise<string[]> => {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const legacy: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === CANVAS_DIR || entry.name === '.git') {
      continue;
    }
    try {
      await fs.promises.access(path.join(dir, entry.name, 'meta.json'));
      legacy.push(entry.name);
    } catch {
      continue;
    }
  }
  return legacy;
};

const toTimestamp = (iso: string): number | undefined => {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
};

/**
 * Migrates a user's legacy `<docKey>/meta.json` + `vN.md` layout into the git
 * repo: replays each doc's `v1..vN` as sequential `canvas-migrate` commits at a
 * claimed working-tree path, populates the index, and removes the old dirs.
 * Must run under the user lock (via {@link ensureRepo}).
 */
const migrateLegacyDocs = async (dir: string, docKeys: string[]): Promise<void> => {
  const loaded = await Promise.all(
    docKeys.map(async (docKey) => {
      const raw = await fs.promises.readFile(path.join(dir, docKey, 'meta.json'), 'utf8');
      return { docKey, meta: JSON.parse(raw) as LegacyMeta };
    }),
  );
  loaded.sort(
    (a, b) =>
      (a.meta.createdAt ?? '').localeCompare(b.meta.createdAt ?? '') ||
      a.docKey.localeCompare(b.docKey),
  );

  const index = await readIndex(dir);
  for (const { docKey, meta } of loaded) {
    const docPath = uniquePath(index, meta.title);
    for (let version = 1; version <= meta.currentVersion; version++) {
      const content = await fs.promises.readFile(path.join(dir, docKey, `v${version}.md`), 'utf8');
      await writeDocFile(dir, docPath, content);
      const isLast = version === meta.currentVersion;
      const updatedAt = isLast ? meta.updatedAt : meta.createdAt;
      index[docKey] = {
        path: docPath,
        title: meta.title,
        type: meta.type ?? CANVAS_DOC_TYPE,
        currentVersion: version,
        createdAt: meta.createdAt,
        updatedAt,
      };
      await writeIndex(dir, index);
      await commit(
        dir,
        [docPath, INDEX_FILE],
        `migrate: ${docKey} v${version}`,
        'canvas-migrate',
        toTimestamp(updatedAt),
      );
    }
    await fs.promises.rm(path.join(dir, docKey), { recursive: true, force: true });
  }
};

/**
 * Lazily initializes a user's docs repo: `git init`, an empty index commit,
 * then (if a legacy layout is present) a migration. A no-op when the repo
 * already exists, so it is safe as a double-checked guard. Must run under the
 * user lock.
 */
const ensureRepo = async (dir: string): Promise<void> => {
  if (await repoExists(dir)) {
    return;
  }
  const legacy = await findLegacyDocs(dir);
  await fs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs, dir, defaultBranch: DEFAULT_BRANCH });
  await writeIndex(dir, {});
  await commit(dir, [INDEX_FILE], 'init', 'canvas-init');
  if (legacy.length > 0) {
    await migrateLegacyDocs(dir, legacy);
  }
};

/**
 * Prepares an existing user's repo for a read: returns `true` when a repo is
 * present (or was just migrated from a legacy layout), `false` when the user
 * has no docs at all — a read must never create an empty repo. Migration runs
 * under the user lock.
 */
const prepareForRead = async (dir: string, userId: string): Promise<boolean> => {
  if (await repoExists(dir)) {
    return true;
  }
  if ((await findLegacyDocs(dir)).length === 0) {
    return false;
  }
  await withUserLock(userId, () => ensureRepo(dir));
  return true;
};

const readBlobText = async (dir: string, oid: string, filepath: string): Promise<string | null> => {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    return Buffer.from(blob).toString('utf8');
  } catch {
    return null;
  }
};

/**
 * Extracts the real git diff of the most recent commit for `filepath` (parent
 * blob vs. HEAD blob). Returns `null` on any failure so the caller can fall
 * back to a coarser rendering.
 */
const extractCommitDiff = async (dir: string, filepath: string): Promise<string | null> => {
  try {
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const { commit: headCommit } = await git.readCommit({ fs, dir, oid: head });
    const parent = headCommit.parent[0];
    if (!parent) {
      return null;
    }
    const oldText = await readBlobText(dir, parent, filepath);
    const newText = await readBlobText(dir, head, filepath);
    if (oldText === null || newText === null) {
      return null;
    }
    return unifiedDiff(oldText, newText);
  } catch {
    return null;
  }
};

/** Reads a canvas doc's metadata, or `null` when the key is invalid or absent. */
export const getDocMeta = async ({
  baseDir,
  userId,
  docKey,
}: {
  baseDir: string;
  userId: string;
  docKey: string;
}): Promise<CanvasDocMeta | null> => {
  if (!isValidUserId(userId) || !isValidDocKey(docKey)) {
    return null;
  }
  const dir = docsRoot(baseDir, userId);
  if (!(await prepareForRead(dir, userId))) {
    return null;
  }
  const entry = (await readIndex(dir))[docKey];
  return entry ? toMeta(docKey, entry) : null;
};

/**
 * Reads a specific version's content, or `null` when the key/version is absent.
 * The current version comes from the working tree; earlier versions are read
 * from the git commit that produced them (the version-th commit touching the
 * doc's path, oldest first).
 */
export const readDocVersion = async ({
  baseDir,
  userId,
  docKey,
  version,
}: {
  baseDir: string;
  userId: string;
  docKey: string;
  version: number;
}): Promise<string | null> => {
  if (
    !isValidUserId(userId) ||
    !isValidDocKey(docKey) ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return null;
  }
  const dir = docsRoot(baseDir, userId);
  if (!(await prepareForRead(dir, userId))) {
    return null;
  }
  const entry = (await readIndex(dir))[docKey];
  if (!entry || version > entry.currentVersion) {
    return null;
  }
  if (version === entry.currentVersion) {
    return readWorkingFile(dir, entry.path);
  }
  try {
    const log = await git.log({ fs, dir, filepath: entry.path });
    const target = log[log.length - version];
    if (!target) {
      return null;
    }
    return readBlobText(dir, target.oid, entry.path);
  } catch {
    return null;
  }
};

/** Lists all of a user's canvas doc metadata (unordered). */
export const listDocs = async ({
  baseDir,
  userId,
}: {
  baseDir: string;
  userId: string;
}): Promise<CanvasDocMeta[]> => {
  if (!isValidUserId(userId)) {
    return [];
  }
  const dir = docsRoot(baseDir, userId);
  if (!(await prepareForRead(dir, userId))) {
    return [];
  }
  const index = await readIndex(dir);
  return Object.entries(index).map(([docKey, entry]) => toMeta(docKey, entry));
};

/**
 * Creates a canvas doc, or appends a new version to an existing one, as a
 * single `canvas-upload` commit touching the working-tree file and the index.
 * Docs whose `title` exactly matches the uploaded filename are versioned (the
 * most recently updated one is bumped, its prior versions preserved in history);
 * otherwise a new doc is created at v1 under a fresh unique docKey. The first
 * upload for a user lazily initializes the repo (migrating any legacy layout).
 */
export const createOrVersionDoc = async ({
  baseDir,
  userId,
  filename,
  content,
}: {
  baseDir: string;
  userId: string;
  filename: string;
  content: Buffer | string;
}): Promise<CanvasDocUpsertResult> => {
  if (!isValidUserId(userId)) {
    throw new Error('invalid user');
  }
  const slug = slugifyDocKey(filename);
  if (!slug) {
    throw new Error('invalid filename');
  }
  const dir = docsRoot(baseDir, userId);

  return withUserLock(userId, async () => {
    await ensureRepo(dir);
    const index = await readIndex(dir);
    const now = new Date().toISOString();

    const existing = Object.entries(index)
      .filter(([, entry]) => entry.title === filename)
      .sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt));
    const latest = existing[existing.length - 1];

    if (latest) {
      const [docKey, entry] = latest;
      const version = entry.currentVersion + 1;
      await writeDocFile(dir, entry.path, content);
      index[docKey] = { ...entry, currentVersion: version, updatedAt: now };
      await writeIndex(dir, index);
      await commit(
        dir,
        [entry.path, INDEX_FILE],
        `upload: ${docKey} (${filename})`,
        'canvas-upload',
      );
      return { docKey, version, created: false };
    }

    const docKey = uniqueDocKey(index, slug);
    const docPath = uniquePath(index, filename);
    await writeDocFile(dir, docPath, content);
    index[docKey] = {
      path: docPath,
      title: filename,
      type: CANVAS_DOC_TYPE,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await writeIndex(dir, index);
    await commit(dir, [docPath, INDEX_FILE], `upload: ${docKey} (${filename})`, 'canvas-upload');
    return { docKey, version: 1, created: true };
  });
};

const applyBlocks = (content: string, blocks: CanvasDocEditBlock[]): string | null => {
  let current = content;
  for (const block of blocks) {
    const original = block.original.replace(/\n$/, '');
    if (original === '') {
      return null;
    }
    const index = current.indexOf(original);
    if (index === -1) {
      return null;
    }
    current = current.slice(0, index) + block.updated + current.slice(index + original.length);
  }
  return current;
};

/**
 * Applies ORIGINAL/UPDATED search-replace blocks to a doc's current working-tree
 * content and commits the result as a `canvas-model-edit` commit, bumping the
 * version. All blocks apply together or not at all: an unmatched ORIGINAL
 * returns `nomatch` and writes nothing (the result is built in memory and
 * persisted once). Returns `notfound` when the doc does not exist for the user.
 * On success it also returns the real git diff of the edit commit (or `null`
 * when the diff could not be extracted).
 */
export const applyDocEdit = async ({
  baseDir,
  userId,
  docKey,
  blocks,
}: {
  baseDir: string;
  userId: string;
  docKey: string;
  blocks: CanvasDocEditBlock[];
}): Promise<CanvasDocEditResult> => {
  if (!isValidUserId(userId) || !isValidDocKey(docKey)) {
    return { status: 'notfound' };
  }
  const dir = docsRoot(baseDir, userId);

  return withUserLock(userId, async () => {
    if (!(await repoExists(dir))) {
      if ((await findLegacyDocs(dir)).length === 0) {
        return { status: 'notfound' };
      }
      await ensureRepo(dir);
    }

    const index = await readIndex(dir);
    const entry = index[docKey];
    if (!entry) {
      return { status: 'notfound' };
    }
    if (blocks.length === 0) {
      return { status: 'nomatch' };
    }

    const oldContent = await readWorkingFile(dir, entry.path);
    if (oldContent === null) {
      return { status: 'notfound' };
    }
    const newContent = applyBlocks(oldContent, blocks);
    if (newContent === null) {
      return { status: 'nomatch' };
    }

    const version = entry.currentVersion + 1;
    await writeDocFile(dir, entry.path, newContent);
    index[docKey] = { ...entry, currentVersion: version, updatedAt: new Date().toISOString() };
    await writeIndex(dir, index);
    await commit(dir, [entry.path, INDEX_FILE], `model-edit: ${docKey}`, 'canvas-model-edit');
    const diff = await extractCommitDiff(dir, entry.path);
    return { status: 'applied', version, oldContent, newContent, diff };
  });
};
