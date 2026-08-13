const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { processDeleteRequest } = require('~/server/services/Files/process');
const db = require('~/models');

const router = express.Router();

/**
 * Folder errors carry a code and a message written for the user. Anything else
 * is a bug and must not leak its message to the client.
 */
const STATUS_BY_CODE = {
  invalid_name: 400,
  duplicate: 409,
  cycle: 400,
  not_found: 404,
};

function fail(res, error, where) {
  const status = STATUS_BY_CODE[error?.code];
  if (status) {
    return res.status(status).json({ message: error.message, code: error.code });
  }
  logger.error(`[${where}]`, error);
  return res.status(500).json({ message: 'Error in request' });
}

/** GET /api/files/folders?parentId=<id> — children of a folder, or the root. */
router.get('/', async (req, res) => {
  try {
    const { parentId } = req.query;
    const folders = await db.listFolders(
      req.user.id,
      parentId === undefined ? undefined : parentId || null,
    );
    res.status(200).json(folders);
  } catch (error) {
    fail(res, error, 'GET /files/folders');
  }
});

/** POST /api/files/folders — create. */
router.post('/', async (req, res) => {
  try {
    const { name, parentId } = req.body ?? {};
    const folder = await db.createFolder({ user: req.user.id, name, parentId: parentId ?? null });
    res.status(201).json(folder);
  } catch (error) {
    fail(res, error, 'POST /files/folders');
  }
});

/** PATCH /api/files/folders/:folderId — rename and/or move. */
router.patch('/:folderId', async (req, res) => {
  try {
    const { name, parentId } = req.body ?? {};
    const folder = await db.moveFolder({
      user: req.user.id,
      folderId: req.params.folderId,
      ...(name !== undefined ? { name } : {}),
      ...(parentId !== undefined ? { parentId: parentId ?? null } : {}),
    });
    res.status(200).json(folder);
  } catch (error) {
    fail(res, error, 'PATCH /files/folders');
  }
});

/** GET /api/files/folders/:folderId/contents — counts, for the delete warning. */
router.get('/:folderId/contents', async (req, res) => {
  try {
    const counts = await db.countFolderContents(req.user.id, req.params.folderId);
    res.status(200).json(counts);
  } catch (error) {
    fail(res, error, 'GET /files/folders/:folderId/contents');
  }
});

/**
 * DELETE /api/files/folders/:folderId — the folder and everything in it.
 *
 * Contents first, folder last. If the folder row went first and a file deletion
 * then failed, the surviving files would point at a folder that no longer
 * exists. Files go through `processDeleteRequest` so the bytes are actually
 * reclaimed rather than the records merely unlinked.
 *
 * On partial failure the folder is LEFT IN PLACE and the failure reported.
 * Removing it while its contents survive is exactly how things become invisible.
 */
router.delete('/:folderId', async (req, res) => {
  try {
    const user = req.user.id;
    const folderId = req.params.folderId;
    const filter = await db.fileFilter({ user, folderId, subtree: true });
    const files = (await db.getFiles(filter)) ?? [];

    if (files.length) {
      try {
        await processDeleteRequest({ req, files });
      } catch (error) {
        logger.error('[DELETE /files/folders] contents not fully deleted', error);
        return res.status(500).json({
          message:
            'Some files could not be deleted, so the folder was kept. Nothing is hidden; try again.',
          filesRemaining: files.length,
        });
      }
    }

    const removed = await db.deleteFolderRecords(user, folderId);
    res.status(200).json({ folders: removed.length, files: files.length });
  } catch (error) {
    fail(res, error, 'DELETE /files/folders');
  }
});

module.exports = router;
