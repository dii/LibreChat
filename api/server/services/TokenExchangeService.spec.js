/**
 * Tests for the RFC 8693 resolver. Each `describe` names the need (R1-R9) it checks;
 * the needs are written out at the top of TokenExchangeService.js.
 */
jest.mock('~/strategies/openidStrategy');
jest.mock('~/cache/getLogStores');
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const client = require('openid-client');
const { resolveOboToken, OboTokenResolutionError } = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const getLogStores = require('~/cache/getLogStores');
const { exchangeOboToken } = require('./OboTokenService');
const { getGraphApiToken } = require('./GraphTokenService');
const {
  exchangeTokenRfc8693,
  getMcpOboTokenResolver,
  TOKEN_EXCHANGE_GRANT_TYPE,
  ACCESS_TOKEN_TYPE,
} = require('./TokenExchangeService');

const AUDIENCE = 'mcp-librechat-client-id';
const OTHER_AUDIENCE = 'mcp-other-client-id';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** A JWT-shaped string whose payload extractOpenIDTokenInfo can parse. */
function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

/** A cache that ignores TTLs entirely, so only the resolver's own expiry check protects reads. */
function createTtlBlindStore() {
  const entries = new Map();
  return {
    entries,
    get: jest.fn(async (key) => entries.get(key)),
    set: jest.fn(async (key, value) => {
      entries.set(key, value);
      return true;
    }),
  };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('TokenExchangeService (RFC 8693)', () => {
  const ORIGINAL_ENV = process.env;
  const NOW = 1_800_000_000_000;
  let store;
  let openIdConfig;
  let nowSpy;
  let idToken;
  let user;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, OPENID_MCP_EXCHANGE_AUDIENCE: AUDIENCE };
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);

    store = createTtlBlindStore();
    getLogStores.mockReturnValue(store);

    openIdConfig = { client_id: 'librechat-client-id', issuer: 'https://idp.example/app/' };
    getOpenIdConfig.mockReturnValue(openIdConfig);

    client.genericGrantRequest.mockResolvedValue({
      access_token: 'exchanged-token',
      token_type: 'bearer',
      issued_token_type: ACCESS_TOKEN_TYPE,
      scope: 'openid profile',
      expires_in: 600,
    });

    idToken = makeJwt({ sub: 'hashed-sub', exp: Math.floor(NOW / 1000) + 600 });
    user = {
      provider: 'openid',
      openidId: 'hashed-sub',
      email: 'person@example.com',
      federatedTokens: {
        access_token: 'user-access-token',
        id_token: idToken,
        refresh_token: 'refresh',
        expires_at: Math.floor(NOW / 1000) + 600,
      },
    };
  });

  afterEach(() => {
    nowSpy.mockRestore();
    process.env = ORIGINAL_ENV;
  });

  describe('R1 selection', () => {
    it('returns exchangeOboToken itself when OPENID_MCP_EXCHANGE_AUDIENCE is unset', () => {
      delete process.env.OPENID_MCP_EXCHANGE_AUDIENCE;
      expect(getMcpOboTokenResolver()).toBe(exchangeOboToken);
    });

    it('returns exchangeOboToken itself when OPENID_MCP_EXCHANGE_AUDIENCE is blank', () => {
      process.env.OPENID_MCP_EXCHANGE_AUDIENCE = '   ';
      expect(getMcpOboTokenResolver()).toBe(exchangeOboToken);
    });

    it('returns the RFC 8693 resolver when OPENID_MCP_EXCHANGE_AUDIENCE is set', () => {
      expect(getMcpOboTokenResolver()).toBe(exchangeTokenRfc8693);
    });

    it('env unset: the selected resolver still sends the shipped jwt-bearer grant', async () => {
      delete process.env.OPENID_MCP_EXCHANGE_AUDIENCE;
      await getMcpOboTokenResolver()(user, 'user-access-token', 'api://scope');
      expect(client.genericGrantRequest).toHaveBeenCalledWith(openIdConfig, JWT_BEARER_GRANT, {
        scope: 'api://scope',
        assertion: 'user-access-token',
        requested_token_use: 'on_behalf_of',
      });
    });

    it('the Graph path keeps the jwt-bearer grant even when the env is set', async () => {
      await getGraphApiToken(user, 'user-access-token', 'https://graph.microsoft.com/.default');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
      expect(client.genericGrantRequest.mock.calls[0][1]).toBe(JWT_BEARER_GRANT);
    });
  });

  describe('R2 request', () => {
    it('sends the token-exchange grant with exactly subject, type, audience and scope', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');

      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
      const [config, grantType, params] = client.genericGrantRequest.mock.calls[0];
      expect(config).toBe(openIdConfig);
      expect(grantType).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
      expect(grantType).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect(params).toEqual({
        subject_token: 'user-access-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: AUDIENCE,
        scope: 'openid profile',
      });
    });

    it('sends the configured audience, trimmed', async () => {
      process.env.OPENID_MCP_EXCHANGE_AUDIENCE = `  ${OTHER_AUDIENCE}  `;
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      expect(client.genericGrantRequest.mock.calls[0][2].audience).toBe(OTHER_AUDIENCE);
    });

    it('returns access_token and expires_in', async () => {
      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      expect(result).toEqual(
        expect.objectContaining({ access_token: 'exchanged-token', expires_in: 600 }),
      );
    });
  });

  describe('R3 never resource, never an actor', () => {
    it('sends no resource, actor_token or actor_token_type parameter', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      const params = client.genericGrantRequest.mock.calls[0][2];
      expect(Object.keys(params)).not.toContain('resource');
      expect(Object.keys(params)).not.toContain('actor_token');
      expect(Object.keys(params)).not.toContain('actor_token_type');
    });
  });

  describe('R4 the subject is the access token, never the ID token', () => {
    it('through resolveOboToken, sends the access token and the ID token appears nowhere', async () => {
      const tokens = await resolveOboToken(
        user,
        { scopes: 'openid profile' },
        exchangeTokenRfc8693,
      );

      expect(tokens.access_token).toBe('exchanged-token');
      const params = client.genericGrantRequest.mock.calls[0][2];
      expect(params.subject_token).toBe('user-access-token');
      expect(Object.values(params)).not.toContain(idToken);
    });

    it('refuses when the token handed in is the ID token', async () => {
      const promise = exchangeTokenRfc8693(user, idToken, 'openid profile');
      await expect(promise).rejects.toBeInstanceOf(OboTokenResolutionError);
      await expect(promise).rejects.toMatchObject({ reason: 'missing_upstream_access_token' });
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('refuses the raw-bearer fallback (federated tokens with no ID token beside them)', async () => {
      const bearer = makeJwt({ sub: 'hashed-sub', exp: Math.floor(NOW / 1000) + 600 });
      const fallbackUser = {
        ...user,
        federatedTokens: {
          access_token: bearer,
          id_token: undefined,
          refresh_token: undefined,
          expires_at: Math.floor(NOW / 1000) + 600,
        },
      };

      const promise = resolveOboToken(
        fallbackUser,
        { scopes: 'openid profile' },
        exchangeTokenRfc8693,
      );
      await expect(promise).rejects.toBeInstanceOf(OboTokenResolutionError);
      await expect(promise).rejects.toMatchObject({ reason: 'missing_upstream_access_token' });
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });
  });

  describe('R5 fail closed', () => {
    it('throws without calling the IdP when the user has no openidId', async () => {
      await expect(
        exchangeTokenRfc8693({ ...user, openidId: undefined }, 'user-access-token', 'openid'),
      ).rejects.toThrow('User must be authenticated via OpenID');
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('throws without calling the IdP when there is no access token', async () => {
      const promise = exchangeTokenRfc8693(user, '', 'openid');
      await expect(promise).rejects.toBeInstanceOf(OboTokenResolutionError);
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('through resolveOboToken, a user with no OpenID token gets missing_upstream_token', async () => {
      const localUser = { provider: 'local', email: 'person@example.com' };
      const promise = resolveOboToken(localUser, { scopes: 'openid' }, exchangeTokenRfc8693);
      await expect(promise).rejects.toBeInstanceOf(OboTokenResolutionError);
      await expect(promise).rejects.toMatchObject({ reason: 'missing_upstream_token' });
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('throws when OpenID is not initialised (getOpenIdConfig throws)', async () => {
      getOpenIdConfig.mockImplementation(() => {
        throw new Error('OpenID client is not initialized. Please call setupOpenId first.');
      });
      await expect(exchangeTokenRfc8693(user, 'user-access-token', 'openid')).rejects.toThrow(
        'OpenID configuration not available',
      );
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('throws when getOpenIdConfig returns nothing', async () => {
      getOpenIdConfig.mockReturnValue(null);
      await expect(exchangeTokenRfc8693(user, 'user-access-token', 'openid')).rejects.toThrow(
        'OpenID configuration not available',
      );
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('throws without calling the IdP when called with the audience unset', async () => {
      delete process.env.OPENID_MCP_EXCHANGE_AUDIENCE;
      await expect(exchangeTokenRfc8693(user, 'user-access-token', 'openid')).rejects.toThrow(
        'OPENID_MCP_EXCHANGE_AUDIENCE',
      );
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('propagates an IdP rejection, caches nothing, and resolveOboToken reports exchange_failed', async () => {
      client.genericGrantRequest.mockRejectedValue(
        Object.assign(new Error('invalid_grant'), { status: 400, error: 'invalid_grant' }),
      );

      const promise = resolveOboToken(user, { scopes: 'openid' }, exchangeTokenRfc8693);
      await expect(promise).rejects.toBeInstanceOf(OboTokenResolutionError);
      await expect(promise).rejects.toMatchObject({ reason: 'exchange_failed', retryable: false });
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
      expect(store.set).not.toHaveBeenCalled();
    });

    it('rejects a response without an access token and caches nothing', async () => {
      client.genericGrantRequest.mockResolvedValue({ token_type: 'bearer', expires_in: 600 });
      await expect(exchangeTokenRfc8693(user, 'user-access-token', 'openid')).rejects.toThrow(
        'no access token',
      );
      expect(store.set).not.toHaveBeenCalled();
    });
  });

  describe('R6 scope', () => {
    it('defaults a blank scope to "openid profile"', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', '   ');
      expect(client.genericGrantRequest.mock.calls[0][2].scope).toBe('openid profile');
    });

    it('defaults a missing scope to "openid profile"', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', undefined);
      expect(client.genericGrantRequest.mock.calls[0][2].scope).toBe('openid profile');
    });

    it('passes the configured scope, trimmed', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', '  openid  ');
      expect(client.genericGrantRequest.mock.calls[0][2].scope).toBe('openid');
    });
  });

  describe('R7 cache', () => {
    it('caches per user, audience and scope with a TTL shorter than the token lifetime', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');

      expect(store.set).toHaveBeenCalledTimes(1);
      const [key, entry, ttl] = store.set.mock.calls[0];
      expect(key).toBe(`rfc8693:hashed-sub:${AUDIENCE}:openid profile`);
      expect(key).not.toBe('hashed-sub:openid profile');
      expect(ttl).toBe((600 - 60) * 1000);
      expect(entry).toEqual(
        expect.objectContaining({
          access_token: 'exchanged-token',
          audience: AUDIENCE,
          expires_at: NOW + 600 * 1000,
        }),
      );
    });

    it('halves the skew for short lifetimes so the TTL stays positive', async () => {
      client.genericGrantRequest.mockResolvedValue({ access_token: 't', expires_in: 60 });
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      expect(store.set.mock.calls[0][2]).toBe(30 * 1000);
    });

    it('serves a cached token within its life, reporting the remaining lifetime', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      nowSpy.mockReturnValue(NOW + 200 * 1000);

      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');

      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
      expect(result.access_token).toBe('exchanged-token');
      expect(result.expires_in).toBe(400);
    });

    it('never serves a token at or past its expiry margin, even from a TTL-blind store', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      client.genericGrantRequest.mockResolvedValue({
        access_token: 'fresh-token',
        expires_in: 600,
      });

      nowSpy.mockReturnValue(NOW + 540 * 1000);
      const atMargin = await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      expect(atMargin.access_token).toBe('fresh-token');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);

      client.genericGrantRequest.mockResolvedValue({
        access_token: 'later-token',
        expires_in: 600,
      });
      nowSpy.mockReturnValue(NOW + 4 * 3600 * 1000);
      const longPast = await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      expect(longPast.access_token).toBe('later-token');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(3);
    });

    it('never serves a token across audiences', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      process.env.OPENID_MCP_EXCHANGE_AUDIENCE = OTHER_AUDIENCE;
      client.genericGrantRequest.mockResolvedValue({
        access_token: 'other-token',
        expires_in: 600,
      });

      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');

      expect(result.access_token).toBe('other-token');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
      expect(client.genericGrantRequest.mock.calls[1][2].audience).toBe(OTHER_AUDIENCE);
    });

    it('ignores a stored entry whose audience does not match, whatever its key', async () => {
      store.get.mockResolvedValue({
        access_token: 'foreign-token',
        audience: OTHER_AUDIENCE,
        expires_at: NOW + 600 * 1000,
      });
      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      expect(result.access_token).toBe('exchanged-token');
    });

    it('ignores a stored entry with no expiry (for example an exchangeOboToken-shaped one)', async () => {
      store.get.mockResolvedValue({
        access_token: 'legacy-token',
        audience: AUDIENCE,
        expires_in: 3600,
      });
      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid profile');
      expect(result.access_token).toBe('exchanged-token');
    });

    it('does not cache a response with no usable expires_in', async () => {
      client.genericGrantRequest.mockResolvedValue({ access_token: 'no-expiry-token' });
      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      expect(result.access_token).toBe('no-expiry-token');
      expect(store.set).not.toHaveBeenCalled();
    });

    it('keys different users apart', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      await exchangeTokenRfc8693({ ...user, openidId: 'other-sub' }, 'other-access', 'openid');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
      expect(store.set.mock.calls.map(([key]) => key)).toEqual([
        `rfc8693:hashed-sub:${AUDIENCE}:openid`,
        `rfc8693:other-sub:${AUDIENCE}:openid`,
      ]);
    });
  });

  describe('R8 coalescing', () => {
    it('coalesces concurrent exchanges for the same key into one IdP call', async () => {
      let resolveGrant;
      client.genericGrantRequest.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
      );

      const callA = exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      const callB = exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      await flushMicrotasks();
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);

      resolveGrant({ access_token: 'shared-token', expires_in: 600 });
      const [a, b] = await Promise.all([callA, callB]);
      expect(a.access_token).toBe('shared-token');
      expect(b.access_token).toBe('shared-token');
      expect(store.set).toHaveBeenCalledTimes(1);
    });

    it('does not coalesce different audiences', async () => {
      let resolveFirst;
      client.genericGrantRequest
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
        )
        .mockResolvedValueOnce({ access_token: 'token-b', expires_in: 600 });

      const callA = exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      await flushMicrotasks();
      process.env.OPENID_MCP_EXCHANGE_AUDIENCE = OTHER_AUDIENCE;
      const callB = exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      await flushMicrotasks();
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);

      resolveFirst({ access_token: 'token-a', expires_in: 600 });
      const [a, b] = await Promise.all([callA, callB]);
      expect(a.access_token).toBe('token-a');
      expect(b.access_token).toBe('token-b');
    });

    it('clears the in-flight slot after a failure', async () => {
      client.genericGrantRequest
        .mockRejectedValueOnce(Object.assign(new Error('invalid_grant'), { status: 400 }))
        .mockResolvedValueOnce({ access_token: 'after-failure', expires_in: 600 });

      await expect(exchangeTokenRfc8693(user, 'user-access-token', 'openid')).rejects.toThrow(
        'invalid_grant',
      );
      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      expect(result.access_token).toBe('after-failure');
    });

    it('fromCache=false bypasses the cache and the in-flight slot', async () => {
      await exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      client.genericGrantRequest.mockResolvedValue({ access_token: 'forced', expires_in: 600 });

      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid', false);

      expect(result.access_token).toBe('forced');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
      expect(store.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('R9 retry classification', () => {
    let setTimeoutSpy;

    beforeEach(() => {
      setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((callback) => {
        callback();
        return 0;
      });
    });

    afterEach(() => setTimeoutSpy.mockRestore());

    it('retries a 503 once and succeeds', async () => {
      client.genericGrantRequest
        .mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))
        .mockResolvedValueOnce({ access_token: 'retried', expires_in: 600 });

      const result = await exchangeTokenRfc8693(user, 'user-access-token', 'openid');
      expect(result.access_token).toBe('retried');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
    });

    it('tags a repeated transient failure retryable', async () => {
      client.genericGrantRequest.mockRejectedValue(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );
      await expect(exchangeTokenRfc8693(user, 'user-access-token', 'openid')).rejects.toMatchObject(
        { retryable: true },
      );
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
    });

    it('does not retry invalid_target and tags it non-retryable', async () => {
      client.genericGrantRequest.mockRejectedValue(
        Object.assign(new Error('invalid_target'), { status: 400, error: 'invalid_target' }),
      );
      await expect(exchangeTokenRfc8693(user, 'user-access-token', 'openid')).rejects.toMatchObject(
        { retryable: false },
      );
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
    });
  });
});
