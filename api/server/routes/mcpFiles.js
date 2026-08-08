const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { verifyFileRef } = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFiles } = require('~/models');

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

  try {
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

const router = express.Router();
router.get('/:reference', mcpFileLimiter, requireMcpFileSecrets, handleMcpFileGet);

module.exports = router;
