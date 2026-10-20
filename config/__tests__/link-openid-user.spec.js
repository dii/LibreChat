jest.mock('../connect', () => jest.fn().mockResolvedValue(true));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createMethods } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const { findOpenIDUser, normalizeOpenIdIssuer } = jest.requireActual('@librechat/api');

const SUB = 'a'.repeat(64);
const OTHER_SUB = 'b'.repeat(64);
const ISSUER = 'https://avowed.candlekeep.dedyn.io/application/o/librechat/';
const EMAIL = 'owner@example.com';

describe('link-openid-user', () => {
  let mongoServer;
  let User;
  let methods;
  let linkOpenIdUser;
  let normalizeIssuer;
  const ORIGINAL_ISSUER = process.env.OPENID_ISSUER;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({ linkOpenIdUser, normalizeIssuer } = require('../link-openid-user'));
    User = mongoose.models.User;
    methods = createMethods(mongoose);
    process.env.OPENID_ISSUER = ISSUER;
  });

  afterAll(async () => {
    process.env.OPENID_ISSUER = ORIGINAL_ISSUER;
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
  });

  const createLocalOwner = (overrides = {}) =>
    User.create({
      email: EMAIL,
      username: 'owner',
      name: 'Owner',
      provider: 'local',
      password: 'hashed-password-value',
      role: 'ADMIN',
      emailVerified: true,
      ...overrides,
    });

  /** The lookup the OpenID sign-in performs, with the claims Authentik would send. */
  const signInLookup = () =>
    findOpenIDUser({
      findUser: methods.findUser,
      email: EMAIL,
      openidId: SUB,
      openidIssuer: normalizeOpenIdIssuer(ISSUER),
      strategyName: 'openidStrategy',
    });

  it('documents the problem: an unlinked local account is refused at OpenID sign-in', async () => {
    await createLocalOwner();
    const result = await signInLookup();
    expect(result).toMatchObject({ user: null, error: ErrorTypes.AUTH_FAILED });
  });

  it('dry run reports the plan and writes nothing', async () => {
    const owner = await createLocalOwner();
    const result = await linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: ISSUER });

    expect(result.status).toBe('planned');
    expect(result.applied).toBe(false);
    expect(result.after).toEqual({
      provider: 'openid',
      openidId: SUB,
      openidIssuer: 'https://avowed.candlekeep.dedyn.io/application/o/librechat',
    });
    const stored = await User.findById(owner._id).lean();
    expect(stored.provider).toBe('local');
    expect(stored.openidId).toBeUndefined();
  });

  it('--apply links the account so the real sign-in lookup finds it, and changes nothing else', async () => {
    const owner = await createLocalOwner();
    const before = await User.findById(owner._id).select('+password').lean();

    const result = await linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: ISSUER, apply: true });
    expect(result.status).toBe('linked');

    const after = await User.findById(owner._id).select('+password').lean();
    expect(after).toMatchObject({
      provider: 'openid',
      openidId: SUB,
      openidIssuer: 'https://avowed.candlekeep.dedyn.io/application/o/librechat',
    });
    const untouched = ['email', 'username', 'name', 'password', 'role', 'emailVerified'];
    untouched.forEach((field) => expect(after[field]).toEqual(before[field]));

    const lookup = await signInLookup();
    expect(lookup.error).toBeNull();
    expect(lookup.migration).toBe(false);
    expect(String(lookup.user._id)).toBe(String(owner._id));
  });

  it('is idempotent', async () => {
    await createLocalOwner();
    await linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: ISSUER, apply: true });
    const again = await linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: ISSUER, apply: true });
    expect(again.status).toBe('already-linked');
  });

  it('refuses an account already linked to a different subject', async () => {
    await createLocalOwner({ provider: 'openid', openidId: OTHER_SUB });
    const result = await linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: ISSUER, apply: true });
    expect(result).toMatchObject({ status: 'refused', reason: 'linked-to-other-subject' });
  });

  it('refuses when another account already holds the subject', async () => {
    await createLocalOwner();
    await User.create({ email: 'other@example.com', provider: 'openid', openidId: SUB });
    const result = await linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: ISSUER, apply: true });
    expect(result).toMatchObject({ status: 'refused', reason: 'subject-already-held' });
    const owner = await User.findOne({ email: EMAIL }).lean();
    expect(owner.openidId).toBeUndefined();
  });

  it('refuses an account from another social provider', async () => {
    await createLocalOwner({ provider: 'google' });
    const result = await linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: ISSUER, apply: true });
    expect(result).toMatchObject({ status: 'refused', reason: 'provider-not-linkable' });
  });

  it('refuses a subject that is not a hashed user id unless told otherwise', async () => {
    await createLocalOwner();
    const refused = await linkOpenIdUser({ email: EMAIL, sub: 'dii', issuer: ISSUER });
    expect(refused).toMatchObject({ status: 'refused', reason: 'sub-format' });
    const allowed = await linkOpenIdUser({
      email: EMAIL,
      sub: 'dii',
      issuer: ISSUER,
      anySubFormat: true,
    });
    expect(allowed.status).toBe('planned');
  });

  it('refuses a missing account and a non-https issuer', async () => {
    await expect(
      linkOpenIdUser({ email: 'nobody@example.com', sub: SUB, issuer: ISSUER }),
    ).resolves.toMatchObject({ reason: 'user-not-found' });
    await createLocalOwner();
    await expect(
      linkOpenIdUser({ email: EMAIL, sub: SUB, issuer: 'http://avowed/application/o/x/' }),
    ).resolves.toMatchObject({ reason: 'issuer-not-https' });
  });

  it('normalises the issuer exactly as the sign-in path does', () => {
    const inputs = [
      ISSUER,
      'https://avowed.candlekeep.dedyn.io/application/o/librechat',
      `${ISSUER}.well-known/openid-configuration`,
      '  https://idp.example/o/app///  ',
      '',
    ];
    inputs.forEach((input) => expect(normalizeIssuer(input)).toBe(normalizeOpenIdIssuer(input)));
  });
});
