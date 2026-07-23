const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { deleteDoc, isValidDocKey } = require('@librechat/api');

const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Guards the canvas-admin routes with a shared service token. These routes are
 * called service-to-service by the canvas MCP server, which holds no user JWT —
 * only the `X-LibreChat-User-Id` it was handed — so they authenticate with a
 * bearer token instead of a session. Fail closed: an unset CANVAS_ADMIN_TOKEN
 * disables the route (501), it is never treated as "allow".
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const requireCanvasAdminToken = (req, res, next) => {
  const expected = process.env.CANVAS_ADMIN_TOKEN;
  if (!expected) {
    return res.status(501).json({ error: 'canvas admin token not configured' });
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
};

const requireCanvasSourcesDir = (req, res, next) => {
  if (!process.env.CANVAS_SOURCES_DIR) {
    return res.status(501).json({ error: 'canvas sources dir not configured' });
  }
  next();
};

/**
 * Hard-deletes one of a user's canvas docs (index entry + working-tree file,
 * committed as `canvas-delete`; recoverable from git history). The user is
 * named in the body (`userId`) rather than a session, since the caller is the
 * MCP server acting on the authenticated user's behalf. `expectedTitle` is an
 * optional optimistic-concurrency guard so a stale doc listing cannot delete
 * the wrong doc.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const handleCanvasDocDelete = async (req, res) => {
  const { userId, docKey, expectedTitle } = req.body || {};
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    return res.status(400).json({ error: 'invalid user' });
  }
  if (typeof docKey !== 'string' || !isValidDocKey(docKey)) {
    return res.status(400).json({ error: 'invalid docKey' });
  }
  if (expectedTitle != null && typeof expectedTitle !== 'string') {
    return res.status(400).json({ error: 'invalid expectedTitle' });
  }

  try {
    const result = await deleteDoc({
      baseDir: process.env.CANVAS_SOURCES_DIR,
      userId,
      docKey,
      expectedTitle: typeof expectedTitle === 'string' ? expectedTitle : undefined,
    });
    if (result.status === 'notfound') {
      return res.status(404).json({ error: 'doc not found', docKey });
    }
    if (result.status === 'mismatch') {
      return res.status(409).json({ error: 'title mismatch', docKey, actual: result.actual });
    }
    return res.status(200).json({ status: 'deleted', docKey: result.docKey, title: result.title });
  } catch (error) {
    logger.error('[/canvas-admin/delete] Failed to delete canvas doc', error);
    return res.status(500).json({ error: 'failed to delete canvas doc' });
  }
};

const router = express.Router();
router.post('/delete', requireCanvasAdminToken, requireCanvasSourcesDir, handleCanvasDocDelete);

module.exports = router;
