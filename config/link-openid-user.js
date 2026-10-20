/**
 * Link an existing LibreChat account to an OpenID subject, so that the person's
 * first OpenID sign-in finds that account (Candlekeep ADR-0032, point 12).
 *
 * Why it is needed: at an OpenID sign-in, findOpenIDUser
 * (packages/api/src/auth/openid.ts) first looks the person up by subject and issuer,
 * then by email. An account found by email that was registered with another provider
 * ("local" for an email sign-up) is REFUSED with AUTH_FAILED: LibreChat neither links
 * it nor creates a duplicate, and no environment setting changes that. Linking on the
 * stable subject, not on the email, is also what makes the first sign-in safe: an
 * account is never captured by whoever first presents a matching email claim.
 *
 * What it changes, on one `users` document, and only with --apply:
 *   provider      "local"    -> "openid"
 *   openidId      (absent)   -> <sub>
 *   openidIssuer  (absent)   -> <issuer, normalised the way the sign-in path normalises it>
 * Nothing else. Password, role, email, username, name, avatar and every other field
 * are left as they are, so email sign-in keeps working until ALLOW_EMAIL_LOGIN=false.
 * At the first OpenID sign-in LibreChat itself then rewrites username, name, avatar
 * and (when it differs) email from the identity provider's claims.
 *
 * <sub> is the `sub` the LibreChat OIDC provider puts in the person's ID token. With
 * Authentik's default subject mode (hashed user id) it is 64 lowercase hex
 * characters; any other form is refused unless --any-sub-format is given. A refused
 * OpenID sign-in logs it: "[openidStrategy] user found with email: <email> for
 * openidId: <sub>".
 *
 * Usage (inside the librechat container, from /app):
 *   node config/link-openid-user.js --email <email> --sub <sub> [--issuer <url>] [--apply]
 * --issuer defaults to OPENID_ISSUER. Without --apply it is a dry run.
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const mongoose = require('mongoose');
const { User } = require('@librechat/data-schemas').createModels(mongoose);

const HASHED_SUB_PATTERN = /^[0-9a-f]{64}$/;
const LINKABLE_PROVIDERS = new Set(['local', 'openid']);
const DISCOVERY_SUFFIX = '/.well-known/openid-configuration';

/** Mirrors normalizeOpenIdIssuer in packages/api/src/auth/openid.ts; the spec checks they agree. */
function normalizeIssuer(issuer) {
  const normalized = typeof issuer === 'string' ? issuer.trim().replace(/\/+$/, '') : '';
  if (!normalized) {
    return undefined;
  }
  if (!normalized.endsWith(DISCOVERY_SUFFIX)) {
    return normalized;
  }
  return normalized.slice(0, -DISCOVERY_SUFFIX.length) || undefined;
}

function refuse(reason, detail) {
  return { status: 'refused', reason, detail, applied: false };
}

function linkFields(user) {
  return {
    provider: user.provider,
    openidId: user.openidId,
    openidIssuer: user.openidIssuer,
  };
}

/**
 * @param {Object} params
 * @param {string} params.email - Email of the existing LibreChat account
 * @param {string} params.sub - The OpenID subject to link it to
 * @param {string} params.issuer - The OpenID issuer URL
 * @param {boolean} [params.apply=false] - Write the change; otherwise report the plan only
 * @param {boolean} [params.anySubFormat=false] - Accept a subject that is not 64 hex characters
 */
async function linkOpenIdUser({ email, sub, issuer, apply = false, anySubFormat = false }) {
  if (typeof email !== 'string' || !email.trim()) {
    return refuse('missing-email', 'Give the account email with --email.');
  }
  if (typeof sub !== 'string' || !sub.trim()) {
    return refuse('missing-sub', 'Give the OpenID subject with --sub.');
  }
  const subject = sub.trim();
  if (!anySubFormat && !HASHED_SUB_PATTERN.test(subject)) {
    return refuse(
      'sub-format',
      'The subject is not 64 lowercase hex characters (Authentik hashed user id). Use --any-sub-format only if the provider uses another subject mode.',
    );
  }

  const openidIssuer = normalizeIssuer(issuer);
  if (!openidIssuer) {
    return refuse('missing-issuer', 'Give --issuer or set OPENID_ISSUER.');
  }
  let issuerUrl;
  try {
    issuerUrl = new URL(openidIssuer);
  } catch {
    return refuse('issuer-not-url', `The issuer is not a URL: ${openidIssuer}`);
  }
  if (issuerUrl.protocol !== 'https:') {
    return refuse('issuer-not-https', `The issuer must be https: ${openidIssuer}`);
  }

  const matches = await User.find(
    { email: email.trim() },
    '_id email provider openidId openidIssuer role',
  ).lean();
  if (matches.length === 0) {
    return refuse('user-not-found', `No account has the email ${email.trim()}.`);
  }
  if (matches.length > 1) {
    return refuse(
      'email-ambiguous',
      `${matches.length} accounts share that email (one per tenant).`,
    );
  }
  const [user] = matches;
  const before = linkFields(user);

  if (
    user.provider === 'openid' &&
    user.openidId === subject &&
    normalizeIssuer(user.openidIssuer) === openidIssuer
  ) {
    return {
      status: 'already-linked',
      userId: String(user._id),
      before,
      after: before,
      applied: false,
    };
  }
  if (user.openidId && user.openidId !== subject) {
    return refuse(
      'linked-to-other-subject',
      'The account is already linked to a different subject.',
    );
  }
  if (user.provider && !LINKABLE_PROVIDERS.has(user.provider)) {
    return refuse('provider-not-linkable', `The account was registered with "${user.provider}".`);
  }

  const holder = await User.findOne(
    { openidId: subject, _id: { $ne: user._id } },
    '_id email',
  ).lean();
  if (holder) {
    return refuse('subject-already-held', `Another account (${holder.email}) holds that subject.`);
  }

  const after = { provider: 'openid', openidId: subject, openidIssuer };
  if (!apply) {
    return { status: 'planned', userId: String(user._id), before, after, applied: false };
  }

  const result = await User.updateOne(
    { _id: user._id, openidId: user.openidId ?? { $exists: false } },
    { $set: after },
  );
  if (result.matchedCount !== 1) {
    return refuse('changed-underneath', 'The account changed while linking; nothing was written.');
  }
  const written = await User.findById(user._id, 'provider openidId openidIssuer').lean();
  return {
    status: 'linked',
    userId: String(user._id),
    before,
    after: linkFields(written),
    applied: true,
  };
}

function parseArgs(argv) {
  const args = { apply: false, anySubFormat: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--any-sub-format') {
      args.anySubFormat = true;
    } else if (arg === '--email' || arg === '--sub' || arg === '--issuer') {
      args[arg.slice(2)] = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

if (require.main === module) {
  (async () => {
    const connect = require('./connect');
    try {
      const args = parseArgs(process.argv.slice(2));
      await connect();
      const result = await linkOpenIdUser({
        ...args,
        issuer: args.issuer ?? process.env.OPENID_ISSUER,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'planned') {
        console.log('Dry run: nothing was written. Re-run with --apply to link.');
      }
      process.exit(result.status === 'refused' ? 1 : 0);
    } catch (err) {
      console.error('Linking failed:', err);
      process.exit(1);
    }
  })();
}

module.exports = { linkOpenIdUser, normalizeIssuer, parseArgs };
