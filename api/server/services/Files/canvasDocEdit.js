const { logger } = require('@librechat/data-schemas');
const { FileSources, FileContext } = require('librechat-data-provider');
const { getStrategyFunctions } = require('./strategies');
const { getFiles, updateFile } = require('~/models');

/**
 * Apply a `:::artifact-edit` directive to a stored document.
 *
 * Replaces the git-backed `applyDocEdit` (packages/api/src/canvas/docs.ts),
 * which kept documents in a working tree bind-mounted between LibreChat and the
 * canvas MCP server. That second store is the thing the canvas rebuild removes:
 * the file the user saw and the file the model edited were different objects.
 *
 * **This needs no signed reference, and that is not an oversight.** References
 * exist to delegate authority to a SEPARATE process — the MCP server, which has
 * no session and must not be trusted to name a user. This runs inside
 * LibreChat, after the model's reply, with the authenticated principal already
 * in hand. Minting a reference here to hand to ourselves would add a signature
 * check over a value we just produced, and would leave a write-capable token in
 * a message-processing path that has no use for one.
 *
 * Identity is enforced the same way regardless: every lookup is scoped to
 * `userId`, so a directive naming another user's document resolves to nothing.
 *
 * Contract preserved from the function it replaces, because BaseClient branches
 * on it: `applied` | `notfound` | `nomatch`.
 */

/** Ambiguity resolves to `notfound`, deliberately: see resolveDocument. */
const NOT_FOUND = { status: 'notfound' };

const stripExtension = (name) => String(name ?? '').replace(/\.[^./\\]+$/, '');

/**
 * Find the one document a directive's identifier names.
 *
 * The identifier is written by the model into its own reply, so it is a
 * filename-ish string rather than an id. Matching is deliberately narrow and
 * fails closed:
 *
 *  - scoped to the user, always;
 *  - exact filename first, then filename-without-extension;
 *  - MORE THAN ONE match is `notfound`, not "pick the newest". A directive that
 *    silently edited the wrong `notes.md` would be worse than one that did
 *    nothing, and there is no version history to recover from.
 */
const resolveDocument = async (userId, identifier) => {
  const wanted = String(identifier ?? '').trim();
  if (!userId || !wanted) {
    return null;
  }

  const files = (await getFiles({ user: userId }, null, { text: 0 })) ?? [];
  const editable = files.filter(
    (file) => file?.file_id && file.context !== FileContext.avatar,
  );

  const exact = editable.filter((file) => file.filename === wanted);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    logger.info(`[canvasDocEdit] identifier "${wanted}" matches ${exact.length} files; refusing`);
    return null;
  }

  const stem = stripExtension(wanted);
  const byStem = editable.filter((file) => stripExtension(file.filename) === stem);
  if (byStem.length === 1) {
    return byStem[0];
  }
  if (byStem.length > 1) {
    logger.info(`[canvasDocEdit] identifier "${wanted}" matches ${byStem.length} files by stem; refusing`);
  }
  return null;
};

const readText = async (file) => {
  const source = file.source || FileSources.local;
  const { getDownloadStream } = getStrategyFunctions(source);
  if (typeof getDownloadStream !== 'function') {
    return null;
  }
  const stream = await getDownloadStream(file.filepath ?? file.file_id, file);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Apply search/replace blocks to text.
 *
 * Every block must match exactly once. A block matching zero times is the
 * model describing content that is not there; a block matching several times is
 * ambiguous about which one it meant. Both are `nomatch` for the whole
 * directive, so a partly-applied edit is never written — that state is
 * unrecoverable without versions and invisible to the user.
 */
const applyBlocks = (text, blocks) => {
  let out = text;
  for (const block of blocks) {
    const { original, updated } = block ?? {};
    if (typeof original !== 'string' || typeof updated !== 'string' || original === '') {
      return null;
    }
    const first = out.indexOf(original);
    if (first === -1) {
      return null;
    }
    if (out.indexOf(original, first + original.length) !== -1) {
      return null;
    }
    out = out.slice(0, first) + updated + out.slice(first + original.length);
  }
  return out;
};

const applyCanvasDocEdit = async ({ userId, identifier, blocks }) => {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { status: 'nomatch' };
  }

  const file = await resolveDocument(userId, identifier);
  if (!file) {
    return NOT_FOUND;
  }

  let oldContent;
  try {
    oldContent = await readText(file);
  } catch (error) {
    logger.error('[canvasDocEdit] could not read the document', error);
    return NOT_FOUND;
  }
  if (typeof oldContent !== 'string') {
    return NOT_FOUND;
  }

  const newContent = applyBlocks(oldContent, blocks);
  if (newContent === null) {
    return { status: 'nomatch' };
  }
  if (newContent === oldContent) {
    return { status: 'nomatch' };
  }

  try {
    const source = file.source || FileSources.local;
    const { saveBuffer } = getStrategyFunctions(source);
    if (typeof saveBuffer !== 'function') {
      logger.error(`[canvasDocEdit] storage strategy ${source} cannot write`);
      return NOT_FOUND;
    }
    const buffer = Buffer.from(newContent, 'utf8');
    const filepath = await saveBuffer({
      userId,
      buffer,
      fileName: file.filename,
      basePath: 'documents',
    });
    await updateFile({ file_id: file.file_id, filepath, bytes: buffer.byteLength });
    return {
      status: 'applied',
      /* The old store versioned per document; the file store does not. Reported
         as 1 so the confirmation message BaseClient renders stays well-formed,
         and NOT presented anywhere as a recoverable history. */
      version: 1,
      oldContent,
      newContent,
      diff: null,
    };
  } catch (error) {
    logger.error('[canvasDocEdit] could not write the document', error);
    return NOT_FOUND;
  }
};

module.exports = { applyCanvasDocEdit, applyBlocks, resolveDocument };
