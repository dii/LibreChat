import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const CANVAS_DOC_TYPE = 'text/markdown';

const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DOC_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CanvasDocMeta = {
  identifier: string;
  title: string;
  type: typeof CANVAS_DOC_TYPE;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CanvasDocEditBlock = {
  original: string;
  updated: string;
};

export type CanvasDocEditResult =
  | { status: 'applied'; version: number; oldContent: string; newContent: string }
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

const docDir = (baseDir: string, userId: string, docKey: string): string =>
  path.join(docsRoot(baseDir, userId), docKey);

const metaPath = (dir: string): string => path.join(dir, 'meta.json');

const versionPath = (dir: string, version: number): string => path.join(dir, `v${version}.md`);

const parseMeta = (raw: string): CanvasDocMeta => JSON.parse(raw) as CanvasDocMeta;

const randomKeySuffix = (): string =>
  Array.from(crypto.randomBytes(4), (byte) => (byte % 36).toString(36)).join('');

const writeVersionAndMeta = async (
  dir: string,
  version: number,
  content: Buffer | string,
  meta: CanvasDocMeta,
): Promise<void> => {
  await fs.promises.writeFile(versionPath(dir, version), content);
  await fs.promises.writeFile(metaPath(dir), JSON.stringify(meta, null, 2));
};

/**
 * Claims a fresh, unique doc directory under the user's docs root. The docKey
 * is the filename slug plus a random 4-char base36 suffix, so identity is
 * independent of the filename and never reused; a colliding suffix is
 * regenerated (the non-recursive mkdir doubles as the atomic collision check).
 */
const claimDocDir = async (baseDir: string, userId: string, slug: string): Promise<string> => {
  await fs.promises.mkdir(docsRoot(baseDir, userId), { recursive: true });
  for (;;) {
    const docKey = `${slug}-${randomKeySuffix()}`;
    try {
      await fs.promises.mkdir(docDir(baseDir, userId, docKey));
      return docKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
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
  try {
    const raw = await fs.promises.readFile(metaPath(docDir(baseDir, userId, docKey)), 'utf8');
    return parseMeta(raw);
  } catch {
    return null;
  }
};

/** Reads a specific version's content, or `null` when the key/version is absent. */
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
  try {
    return await fs.promises.readFile(
      versionPath(docDir(baseDir, userId, docKey), version),
      'utf8',
    );
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
  let entries: string[];
  try {
    entries = await fs.promises.readdir(docsRoot(baseDir, userId));
  } catch {
    return [];
  }
  const metas = await Promise.all(entries.map((docKey) => getDocMeta({ baseDir, userId, docKey })));
  return metas.filter((meta): meta is CanvasDocMeta => meta !== null);
};

/**
 * Creates a canvas doc, or appends a new version to an existing one. Docs whose
 * `meta.title` exactly matches the uploaded filename are versioned (the most
 * recently updated one receives `v(currentVersion+1).md` — never a downward
 * reset, prior versions stay intact); otherwise a new doc is created at v1
 * under a fresh unique docKey.
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

  const existing = (await listDocs({ baseDir, userId }))
    .filter((meta) => meta.title === filename)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const latest = existing[existing.length - 1];

  if (latest) {
    const dir = docDir(baseDir, userId, latest.identifier);
    const nextVersion = latest.currentVersion + 1;
    const updatedMeta: CanvasDocMeta = {
      ...latest,
      currentVersion: nextVersion,
      updatedAt: new Date().toISOString(),
    };
    await writeVersionAndMeta(dir, nextVersion, content, updatedMeta);
    return { docKey: latest.identifier, version: nextVersion, created: false };
  }

  const docKey = await claimDocDir(baseDir, userId, slug);
  const now = new Date().toISOString();
  const meta: CanvasDocMeta = {
    identifier: docKey,
    title: filename,
    type: CANVAS_DOC_TYPE,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  await writeVersionAndMeta(docDir(baseDir, userId, docKey), 1, content, meta);
  return { docKey, version: 1, created: true };
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
 * Applies ORIGINAL/UPDATED search-replace blocks to a doc's current version and
 * writes the result as the next version, bumping `currentVersion`. All blocks
 * apply together or not at all: an unmatched ORIGINAL returns `nomatch` and
 * writes nothing. Returns `notfound` when the doc does not exist for the user.
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
  const meta = await getDocMeta({ baseDir, userId, docKey });
  if (!meta) {
    return { status: 'notfound' };
  }
  if (blocks.length === 0) {
    return { status: 'nomatch' };
  }
  const oldContent = await readDocVersion({
    baseDir,
    userId,
    docKey,
    version: meta.currentVersion,
  });
  if (oldContent === null) {
    return { status: 'notfound' };
  }
  const newContent = applyBlocks(oldContent, blocks);
  if (newContent === null) {
    return { status: 'nomatch' };
  }
  const nextVersion = meta.currentVersion + 1;
  const dir = docDir(baseDir, userId, docKey);
  await fs.promises.writeFile(versionPath(dir, nextVersion), newContent);
  const updatedMeta: CanvasDocMeta = {
    ...meta,
    currentVersion: nextVersion,
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(metaPath(dir), JSON.stringify(updatedMeta, null, 2));
  return { status: 'applied', version: nextVersion, oldContent, newContent };
};
