/**
 * RFC 8693 token exchange for MCP servers that verify an identity-provider token
 * naming the person (Candlekeep ADR-0032, points 2-4).
 *
 * A second resolver behind the existing `OboTokenResolver` seam
 * (`packages/api/src/mcp/oauth/obo.ts`). `exchangeOboToken` (OboTokenService.js) is
 * left exactly as shipped, because the Microsoft Graph path shares it.
 *
 * NEEDS (written before the code; each test in TokenExchangeService.spec.js names
 * the need it checks):
 *
 * R1  Selection. The three MCP call sites (MCP.js createMCPTool -> callTool,
 *     Tools/mcp.js getConnection and discoverServerTools) get this resolver only when
 *     OPENID_MCP_EXCHANGE_AUDIENCE is set to a non-blank value. Unset or blank, they
 *     get `exchangeOboToken` itself, so behaviour is identical to before. Nothing here
 *     changes the Graph path (GraphTokenService -> exchangeOboToken).
 * R2  Request. One POST to the OIDC token endpoint through openid-client's
 *     `genericGrantRequest`, authenticated as LibreChat's own OIDC client
 *     (`getOpenIdConfig()`), with grant_type
 *     urn:ietf:params:oauth:grant-type:token-exchange and exactly these parameters:
 *     subject_token, subject_token_type = urn:ietf:params:oauth:token-type:access_token,
 *     audience = OPENID_MCP_EXCHANGE_AUDIENCE, scope.
 * R3  Never `resource` (Authentik answers invalid_target), never `actor_token` or
 *     `actor_token_type` (no Actor accounts on the free edition).
 * R4  The subject is the person's OpenID ACCESS token, as resolveOboToken passes it
 *     (extractOpenIDTokenInfo().accessToken). Never the ID token, which Authentik
 *     refuses as a subject: refuse (fail closed) when the token handed in equals the
 *     user's ID token, or when the federated token set carries no ID token beside it.
 *     The second case is the openIdJwt strategy's fallback after the session lost its
 *     tokens (`access_token: accessToken || rawToken`), whose raw bearer is the ID
 *     token (AuthService.setOpenIDAuthTokens prefers id_token as the app token).
 * R5  Fail closed. No openidId, no access token, OpenID not configured, an identity
 *     provider error, or a response without an access token all throw; the existing
 *     error classes carry it (OboTokenResolutionError, or a plain Error that
 *     resolveOboToken wraps as `exchange_failed`). There is no fallback to a static
 *     header, to the cache past expiry, or to `exchangeOboToken`.
 * R6  Scope. From the server's `obo.scopes`, trimmed; blank means "openid profile".
 * R7  Cache. The shipped OPENID_EXCHANGED_TOKENS store, keyed per user, audience and
 *     scope, in a namespace that can never collide with exchangeOboToken's
 *     `${openidId}:${scopes}` keys. The entry expires before the token does
 *     (expires_in minus 60 s, or minus half the lifetime when that is shorter) and
 *     carries its absolute expiry, which is checked on read, so a store that ignores
 *     TTLs still never serves an expired token. A cache hit returns the REMAINING
 *     lifetime as expires_in. A response with no usable expires_in is not cached.
 * R8  Coalescing. Concurrent callers for the same key on a cache miss share one
 *     exchange; different keys never share one; the slot is cleared after success
 *     and after failure; fromCache=false bypasses both cache and in-flight slot.
 * R9  Transient failures (429, 5xx, timeouts, connection resets) are retried once
 *     after a short delay and then tagged retryable; permanent ones (400
 *     invalid_grant, invalid_target, invalid_request) are not retried and are tagged
 *     non-retryable, so resolveOboToken reports them as a rejection.
 *
 * Tokens are never logged.
 */
const client = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { OboTokenResolutionError } = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const getLogStores = require('~/cache/getLogStores');
const { exchangeOboToken } = require('./OboTokenService');

const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const MCP_EXCHANGE_AUDIENCE_ENV = 'OPENID_MCP_EXCHANGE_AUDIENCE';
const DEFAULT_EXCHANGE_SCOPE = 'openid profile';
const CACHE_KEY_PREFIX = 'rfc8693';
const MAX_EXPIRY_SKEW_SECONDS = 60;
const RETRY_DELAY_MS = 300;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND']);

/** In-flight exchanges keyed like the cache (R8). */
const inFlightExchanges = new Map();

function getErrorStatus(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status;
}

function getErrorCode(error) {
  return typeof error?.code === 'string' ? error.code.toUpperCase() : undefined;
}

/** R9: the same classification exchangeOboToken uses for the jwt-bearer grant. */
function isRetryableExchangeError(error) {
  const status = getErrorStatus(error);
  if (status != null && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  const code = getErrorCode(error);
  if (code != null && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = String(error?.message ?? '').toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable') ||
    message.includes('too many requests') ||
    message.includes('service unavailable')
  );
}

function tagExchangeError(error, retryable) {
  if (error && typeof error === 'object') {
    error.retryable = retryable;
    error.oboFailureReason = 'exchange_failed';
  }
  return error;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** R1: the configured target client id, or undefined when unset or blank. */
function getMcpExchangeAudience() {
  const audience = process.env[MCP_EXCHANGE_AUDIENCE_ENV];
  return typeof audience === 'string' && audience.trim() ? audience.trim() : undefined;
}

/** R6 */
function resolveExchangeScope(scopes) {
  return typeof scopes === 'string' && scopes.trim() ? scopes.trim() : DEFAULT_EXCHANGE_SCOPE;
}

/** R7: never collides with exchangeOboToken's `${openidId}:${scopes}` keys. */
function buildCacheKey(openidId, audience, scope) {
  return `${CACHE_KEY_PREFIX}:${openidId}:${audience}:${scope}`;
}

/** R7: 60 s before expiry, or halfway through a lifetime shorter than two minutes. */
function getExpirySkewSeconds(expiresIn) {
  return Math.min(MAX_EXPIRY_SKEW_SECONDS, expiresIn / 2);
}

function isTokenSet(candidate) {
  return (
    candidate != null &&
    typeof candidate === 'object' &&
    ('access_token' in candidate || 'id_token' in candidate || 'expires_at' in candidate)
  );
}

function refuseSubject(message) {
  return new OboTokenResolutionError('missing_upstream_access_token', message);
}

/**
 * R4: the token handed in must be the person's access token. The token set is
 * chosen the way extractOpenIDTokenInfo chooses it (federatedTokens first).
 */
function assertSubjectIsAccessToken(user, accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) {
    throw refuseSubject('The upstream OpenID access token is missing for the token exchange.');
  }

  const tokenSet = [user.federatedTokens, user.openidTokens].find(isTokenSet);
  if (!tokenSet) {
    throw refuseSubject(
      'No OpenID token set is attached to the user, so the subject cannot be shown to be an access token.',
    );
  }

  if (tokenSet.id_token && accessToken === tokenSet.id_token) {
    logger.warn(
      `[TokenExchangeService] Refusing to exchange an ID token as the subject for user: ${user.openidId}`,
    );
    throw refuseSubject('The OpenID access token is not available (only the ID token is).');
  }

  if (!tokenSet.id_token) {
    logger.warn(
      `[TokenExchangeService] OpenID session holds no ID token beside the access token for user: ${user.openidId}; the access token may be the app bearer (an ID token). Refusing.`,
    );
    throw refuseSubject(
      'The OpenID session lost its tokens, so no access token is available. Sign in again.',
    );
  }
}

/** R7: a cached entry is served only for its own audience and only before its stale time. */
function readCachedToken(entry, audience, now) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (typeof entry.access_token !== 'string' || !entry.access_token) {
    return null;
  }
  if (entry.audience !== audience) {
    return null;
  }
  const expiresAt = Number(entry.expires_at);
  const staleAt = Number(entry.stale_at);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(staleAt)) {
    return null;
  }
  if (now >= staleAt || now >= expiresAt) {
    return null;
  }
  return {
    access_token: entry.access_token,
    token_type: 'Bearer',
    expires_in: Math.floor((expiresAt - now) / 1000),
    scope: entry.scope,
  };
}

async function performExchange({
  user,
  accessToken,
  audience,
  scope,
  config,
  tokensCache,
  cacheKey,
}) {
  /** R2 and R3: exactly these four parameters; no resource, no actor. */
  const params = {
    subject_token: accessToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    audience,
    scope,
  };
  const requestGrant = async () =>
    client.genericGrantRequest(config, TOKEN_EXCHANGE_GRANT_TYPE, params);

  let grantResponse;
  try {
    grantResponse = await requestGrant();
  } catch (error) {
    const retryable = isRetryableExchangeError(error);
    if (!retryable) {
      throw tagExchangeError(error, false);
    }

    logger.warn(
      `[TokenExchangeService] Transient token-exchange failure for user: ${user.openidId}, retrying once`,
      error,
    );
    await delay(RETRY_DELAY_MS);

    try {
      grantResponse = await requestGrant();
    } catch (retryError) {
      throw tagExchangeError(retryError, isRetryableExchangeError(retryError));
    }
  }

  if (typeof grantResponse?.access_token !== 'string' || !grantResponse.access_token) {
    throw tagExchangeError(new Error('The token exchange returned no access token'), false);
  }

  const tokenResponse = {
    access_token: grantResponse.access_token,
    token_type: 'Bearer',
    scope: typeof grantResponse.scope === 'string' ? grantResponse.scope : scope,
  };

  const expiresIn = Number(grantResponse.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    logger.warn(
      `[TokenExchangeService] Token exchange for user: ${user.openidId} returned no usable expires_in; not caching`,
    );
    return tokenResponse;
  }

  tokenResponse.expires_in = expiresIn;
  const now = Date.now();
  const ttlMs = Math.floor((expiresIn - getExpirySkewSeconds(expiresIn)) * 1000);
  if (ttlMs > 0) {
    try {
      await tokensCache.set(
        cacheKey,
        {
          ...tokenResponse,
          audience,
          expires_at: now + expiresIn * 1000,
          stale_at: now + ttlMs,
        },
        ttlMs,
      );
    } catch (cacheError) {
      logger.warn('[TokenExchangeService] Could not cache the exchanged token', cacheError);
    }
  }

  logger.debug(
    `[TokenExchangeService] Exchanged token for user: ${user.openidId}, audience: ${audience}, scope: ${tokenResponse.scope}, expires_in: ${expiresIn}`,
  );
  return tokenResponse;
}

/**
 * RFC 8693 token exchange, matching the `OboTokenResolver` signature. See R1-R9 above.
 *
 * @param {Object} user - User with OpenID identity and its federated token set
 * @param {string} accessToken - The person's OpenID access token (the subject)
 * @param {string} scopes - The server's `obo.scopes`; blank means "openid profile"
 * @param {boolean} [fromCache=true] - false forces a fresh exchange
 * @returns {Promise<{access_token: string, token_type: string, expires_in?: number, scope?: string}>}
 */
async function exchangeTokenRfc8693(user, accessToken, scopes, fromCache = true) {
  const audience = getMcpExchangeAudience();
  if (!audience) {
    throw new Error(
      `${MCP_EXCHANGE_AUDIENCE_ENV} is not set; refusing an RFC 8693 token exchange without an audience`,
    );
  }

  if (!user?.openidId) {
    throw new Error('User must be authenticated via OpenID to perform an RFC 8693 token exchange');
  }

  assertSubjectIsAccessToken(user, accessToken);

  let config = null;
  try {
    config = getOpenIdConfig();
  } catch (error) {
    logger.warn('[TokenExchangeService] OpenID client is not initialised', error);
  }
  if (!config) {
    throw new Error('OpenID configuration not available');
  }

  const scope = resolveExchangeScope(scopes);
  const cacheKey = buildCacheKey(user.openidId, audience, scope);
  const tokensCache = getLogStores(CacheKeys.OPENID_EXCHANGED_TOKENS);

  if (fromCache) {
    let entry;
    try {
      entry = await tokensCache.get(cacheKey);
    } catch (cacheError) {
      logger.warn('[TokenExchangeService] Token cache read failed; exchanging afresh', cacheError);
    }
    const cached = readCachedToken(entry, audience, Date.now());
    if (cached) {
      logger.debug(`[TokenExchangeService] Using cached token for user: ${user.openidId}`);
      return cached;
    }

    const inFlight = inFlightExchanges.get(cacheKey);
    if (inFlight) {
      logger.debug(`[TokenExchangeService] Joining in-flight exchange for user: ${user.openidId}`);
      return inFlight;
    }
  }

  const exchangePromise = performExchange({
    user,
    accessToken,
    audience,
    scope,
    config,
    tokensCache,
    cacheKey,
  });

  if (fromCache) {
    inFlightExchanges.set(cacheKey, exchangePromise);
    exchangePromise
      .finally(() => {
        if (inFlightExchanges.get(cacheKey) === exchangePromise) {
          inFlightExchanges.delete(cacheKey);
        }
      })
      .catch(() => {
        /* The rejection reaches the awaiting caller; this chain only cleans up. */
      });
  }

  return exchangePromise;
}

/**
 * R1: the resolver the three MCP call sites inject. Read at call time, so the env
 * decides per request and an unset env yields exchangeOboToken itself.
 */
function getMcpOboTokenResolver() {
  return getMcpExchangeAudience() ? exchangeTokenRfc8693 : exchangeOboToken;
}

module.exports = {
  exchangeTokenRfc8693,
  getMcpOboTokenResolver,
  getMcpExchangeAudience,
  TOKEN_EXCHANGE_GRANT_TYPE,
  ACCESS_TOKEN_TYPE,
  DEFAULT_EXCHANGE_SCOPE,
  MCP_EXCHANGE_AUDIENCE_ENV,
};
