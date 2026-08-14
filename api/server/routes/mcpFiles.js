const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { verifyFileRef, FileRefScope } = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getAppConfig } = require('~/server/services/Config');
const { getFiles, updateFile } = require('~/models');

/**
 * Serves the bytes of one conversation image to an MCP server that holds a
 * signed reference for it.
 *
 * Why this route exists: MCP tools receive text arguments, so a server can be
 * told about an image but has no way to obtain it, and the only mechanism
 * LibreChat has for carrying a file across turns re-sends the bytes into model
 * context — which a text-only model cannot accept at all.
 *
 * Two things carry the security of this route, and neither is the bearer token
 * alone. The reference is integrity-protected and names exactly one file for
 * exactly one principal, so the caller cannot ask for anything it was not
 * given. And every refusal is the same 404 with no body, so the route cannot be
 * used to learn whether a file exists or whom it belongs to.
 */

/** Every not-served case answers identically. Distinguishing them is an oracle. */
const notFound = (res) => res.status(404).end();

/**
 * Fail closed on both secrets. An unset token or key disables the route (501);
 * neither is ever treated as "allow".
 */
const requireMcpFileSecrets = (req, res, next) => {
  const expected = process.env.MCP_FILE_TOKEN;
  if (!expected || !process.env.MCP_FILE_SIGNING_KEY) {
    return res.status(501).json({ error: 'mcp file access not configured' });
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
};

/**
 * The caller is a tool server, not a person, so it can loop. Bound by IP; the
 * reference itself bounds what any single call can reach.
 */
const mcpFileLimiter = rateLimit({
  windowMs: (parseInt(process.env.MCP_FILE_WINDOW, 10) || 1) * 60 * 1000,
  max: parseInt(process.env.MCP_FILE_IP_MAX, 10) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'too many requests' }),
});

const handleMcpFileGet = async (req, res) => {
  /* Total by contract: returns null for tampered, expired, malformed or
   * unverifiable input, and never throws. */
  const ref = verifyFileRef(req.params.reference, {
    signingKey: process.env.MCP_FILE_SIGNING_KEY,
  });
  if (!ref) {
    return notFound(res);
  }
  /* Least privilege, and deliberately not "write implies read": a scope is
     checked before anything else happens, and a caller that needs both is given
     both rather than granted a second capability by implication. */
  if (ref.scope !== FileRefScope.read) {
    return notFound(res);
  }

  try {
    /* `configMiddleware` derives `req.config` from `req.user`, and this route is
     * mounted outside the JWT chain precisely so that it has no `req.user`. The
     * storage strategies read it: `getLocalFileStream` opens with
     * `const appConfig = req.config` and then `appConfig.paths.uploads`, so
     * without this every fetch throws "Cannot read properties of undefined
     * (reading 'paths')" and answers as a miss. That is what it did in
     * production on 2026-08-11 — the model held a valid reference, used it
     * correctly, and got a bare 404 six times over.
     *
     * Scoped from the VERIFIED reference, never from anything the caller sent,
     * for the same reason the query below is. This is the second thing the
     * out-of-chain mount silently dropped; tenant scoping was the first. */
    req.config = await getAppConfig({ tenantId: ref.tenantId });

    /* Scoped to the principal named in the verified reference, never to
     * anything the caller asserted. `tenantId` is applied here because this
     * route is mounted outside the JWT chain, so tenantContextMiddleware has
     * not run and will not scope the query for us. */
    const filter = { file_id: ref.fileId, user: ref.userId };
    if (ref.tenantId) {
      filter.tenantId = ref.tenantId;
    }

    const [file] = (await getFiles(filter, null, { text: 0 })) ?? [];
    if (!file) {
      return notFound(res);
    }

    /* This route exists to serve conversation images. A reference should never
     * name anything else, so a non-image here means either a bug or an attempt,
     * and both get the same answer as everything else. */
    if (typeof file.type !== 'string' || !file.type.startsWith('image/')) {
      return notFound(res);
    }

    const source = file.source || FileSources.local;
    const { getDownloadStream } = getStrategyFunctions(source);
    if (!getDownloadStream) {
      /* Answered as a miss, not a 501. Both of these are reachable only AFTER a
       * lookup matched a real file owned by the reference's principal, so any
       * distinguishable response here is exactly the existence oracle the rest
       * of this handler is built to avoid. The detail goes to the log instead. */
      logger.warn(`[/api/mcp/files] no stream method for source ${source}`);
      return notFound(res);
    }

    /* Strip any cache-busting query string so a local path resolves to the real
     * filename rather than a literal `*.png?v=...`. Mirrors share.js. */
    const streamPath = (file.storageKey || file.filepath || '').split('?')[0];
    if (!streamPath) {
      return notFound(res);
    }

    const fileStream = await getDownloadStream(req, streamPath);
    fileStream.on('error', (error) => {
      logger.error('[/api/mcp/files] stream error', error);
      if (!res.headersSent) {
        notFound(res);
      }
    });

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', file.type);
    res.setHeader('Cache-Control', 'no-store');
    return fileStream.pipe(res);
  } catch (error) {
    /* A lookup or storage failure must not tell the caller more than a miss
     * would. Log it here; answer the same as everything else. */
    logger.error('[/api/mcp/files] failed to serve file', error);
    return notFound(res);
  }
};

/**
 * Replace the content of the file a write reference names.
 *
 * Same guard shape as the read route and the same uniform 404, for the same
 * reason: a distinguishable refusal tells a caller whether a file exists and
 * whose it is. The principal comes from the verified reference and never from
 * the caller, and the update is scoped to that principal, so a write reference
 * for one file cannot be pointed at another.
 *
 * Bytes go through the storage strategy rather than being written directly, so
 * whatever the deployment uses (local, S3, Azure) keeps working, and the file
 * document's `bytes` is corrected to match what was actually stored.
 */
const handleMcpFilePut = async (req, res) => {
  const ref = verifyFileRef(req.params.reference, {
    signingKey: process.env.MCP_FILE_SIGNING_KEY,
  });
  if (!ref || ref.scope !== FileRefScope.write) {
    return notFound(res);
  }

  const content = req.body?.content;
  if (typeof content !== 'string') {
    /* Answered as a miss like everything else: a caller holding a valid write
       reference still learns nothing about the file from a malformed body. */
    return notFound(res);
  }

  try {
    req.config = await getAppConfig({ tenantId: ref.tenantId });

    const filter = { file_id: ref.fileId, user: ref.userId };
    if (ref.tenantId) {
      filter.tenantId = ref.tenantId;
    }
    const [file] = (await getFiles(filter, null, { text: 0 })) ?? [];
    if (!file) {
      return notFound(res);
    }

    const source = file.source || FileSources.local;
    const { saveBuffer } = getStrategyFunctions(source);
    if (typeof saveBuffer !== 'function') {
      logger.error(`[/api/mcp/files] storage strategy ${source} cannot write`);
      return notFound(res);
    }

    const buffer = Buffer.from(content, 'utf8');
    const filepath = await saveBuffer({
      userId: ref.userId,
      buffer,
      fileName: file.filename,
      basePath: 'documents',
    });

    await updateFile({ file_id: ref.fileId, filepath, bytes: buffer.byteLength });
    return res.status(200).json({ file_id: ref.fileId, bytes: buffer.byteLength });
  } catch (error) {
    logger.error('[/api/mcp/files] failed to write file', error);
    return notFound(res);
  }
};

const router = express.Router();
router.get('/:reference', mcpFileLimiter, requireMcpFileSecrets, handleMcpFileGet);
router.put(
  '/:reference',
  mcpFileLimiter,
  requireMcpFileSecrets,
  express.json({ limit: '10mb' }),
  handleMcpFilePut,
);

module.exports = router;
