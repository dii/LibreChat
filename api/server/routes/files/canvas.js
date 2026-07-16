const fs = require('fs');
const path = require('path');
const multer = require('multer');
const express = require('express');
const { logger } = require('@librechat/data-schemas');

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

const requireCanvasSourcesDir = (req, res, next) => {
  if (!process.env.CANVAS_SOURCES_DIR) {
    return res.status(501).json({ error: 'canvas sources dir not configured' });
  }
  next();
};

const handleCanvasSourceUpload = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no file provided' });
  }

  const userId = req.user && req.user.id;
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    return res.status(400).json({ error: 'invalid user' });
  }

  const filename = sanitizeCanvasFilename(req.file.originalname);
  if (!filename) {
    return res.status(400).json({ error: 'invalid filename' });
  }

  try {
    const userDir = path.join(process.env.CANVAS_SOURCES_DIR, userId);
    await fs.promises.mkdir(userDir, { recursive: true });
    const destination = path.join(userDir, filename);
    await fs.promises.writeFile(destination, req.file.buffer);
    return res.status(200).json({ filename, bytes: req.file.size });
  } catch (error) {
    logger.error('[/files/canvas-source] Failed to write canvas source', error);
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
router.post(
  '/',
  requireCanvasSourcesDir,
  canvasUpload.single('file'),
  handleUploadError,
  handleCanvasSourceUpload,
);

module.exports = { router, sanitizeCanvasFilename };
