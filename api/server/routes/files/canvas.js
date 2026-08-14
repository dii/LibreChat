const path = require('path');
const multer = require('multer');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { createOrVersionDoc, slugifyDocKey } = require('@librechat/api');
const { FileSources, FileContext } = require('librechat-data-provider');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { v4: uuidv4 } = require('uuid');
const { createFile } = require('~/models');

const MAX_CANVAS_SOURCE_BYTES = 100 * 1024 * 1024;
const DISALLOWED_FILENAME_CHARS = /[^A-Za-z0-9._ -]/g;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Sanitize a user-supplied filename for a raw drop-folder write. Strips any
 * directory component, replaces disallowed characters, and rejects empty
 * results and dotfiles. Returns the safe basename, or `null` when the name
 * cannot be made safe.
 * @param {unknown} name
 * @returns {string | null}
 */
const sanitizeCanvasFilename = (name) => {
  if (typeof name !== 'string') {
    return null;
  }
  const base = path.basename(name).replace(DISALLOWED_FILENAME_CHARS, '_').trim();
  if (base === '' || base.startsWith('.')) {
    return null;
  }
  return base;
};

const canvasUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CANVAS_SOURCE_BYTES },
});

/**
 * A canvas source upload is now an ORDINARY file upload.
 *
 * It previously wrote bytes into a per-user directory and never called
 * `createFile`, which is the single reason a person could neither see nor delete
 * their own canvas documents while the model could list them through
 * `canvas_doc_list`. Every other artefact in the system inverts that. Creating a
 * `File` document with `context: canvas_source` is the whole fix: listing,
 * ownership, folder filing and deletion all become the file system everything
 * else already uses, rather than features canvas has to reimplement.
 *
 * The git-backed store is still written for now, so nothing that reads it breaks
 * while the canvas MCP server is migrated to fetch by reference. Its failure is
 * no longer fatal to the upload: the File document is the record that matters,
 * and losing the shadow copy must not lose the user's document.
 */
const handleCanvasSourceUpload = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no file provided' });
  }

  const userId = req.user && req.user.id;
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    return res.status(400).json({ error: 'invalid user' });
  }

  const filename = sanitizeCanvasFilename(req.file.originalname);
  if (!filename || !slugifyDocKey(filename)) {
    return res.status(400).json({ error: 'invalid filename' });
  }

  try {
    const source = req.config?.fileStrategy || FileSources.local;
    const { saveBuffer } = getStrategyFunctions(source);
    const fileId = uuidv4();
    const filepath = await saveBuffer({
      userId,
      buffer: req.file.buffer,
      fileName: `${fileId}-${filename}`,
      basePath: 'documents',
    });

    /* disableTTL: a document the user will come back to, not an upload waiting
       in a composer queue. The hour-long expiry would delete it. */
    await createFile(
      {
        file_id: fileId,
        user: userId,
        filename,
        filepath,
        type: req.file.mimetype || 'text/markdown',
        bytes: req.file.size,
        source,
        context: FileContext.canvas_source,
        ...(req.body?.conversationId ? { conversationId: req.body.conversationId } : {}),
      },
      true,
    );

    let docKey = null;
    let version = null;
    let created = null;
    if (process.env.CANVAS_SOURCES_DIR) {
      try {
        ({ docKey, version, created } = await createOrVersionDoc({
          baseDir: process.env.CANVAS_SOURCES_DIR,
          userId,
          filename,
          content: req.file.buffer,
        }));
      } catch (error) {
        /* Not fatal. The File document above is the record of the user's
           document; the git store is a shadow copy being retired. */
        logger.warn('[/files/canvas-source] git-backed shadow copy failed', error);
      }
    }

    return res
      .status(200)
      .json({ filename, bytes: req.file.size, file_id: fileId, docKey, version, created });
  } catch (error) {
    logger.error('[/files/canvas-source] Failed to create canvas doc', error);
    return res.status(500).json({ error: 'failed to write canvas source' });
  }
};

const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file too large' });
    }
    return res.status(400).json({ error: err.message });
  }
  return next(err);
};

const router = express.Router();
/* `requireCanvasSourcesDir` is gone from this chain deliberately. It returned
   501 when CANVAS_SOURCES_DIR was unset, which was right while that directory
   WAS the store. The store is now the File document, so gating the upload on a
   variable being retired would fail an upload that has everything it needs. */
router.post('/', canvasUpload.single('file'), handleUploadError, handleCanvasSourceUpload);

module.exports = { router, sanitizeCanvasFilename };
