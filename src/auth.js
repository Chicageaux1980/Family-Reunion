'use strict';

// Accounts and sign-in. Family members join with an invite link from someone
// already in, choose a password, and must enrol an authenticator app (TOTP).
// Every sign-in then needs both the password and a six-digit code (or a
// one-time backup code). The very first account becomes the administrator
// and needs the setup code the server prints when it starts.

const crypto = require('node:crypto');
const totp = require('./totp');
const { ValidationError, NotFoundError, AuthError, clean, cleanEmail } = require('./util');

const FULL_SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const PENDING_SESSION_MS = 15 * 60 * 1000;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_MFA_FAILURES = 5;
const BACKUP_CODE_COUNT = 10;
const MIN_PASSWORD_LENGTH = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Human-friendly code such as "K7QM-2XPA-9DTR" (no 0/O/1/I confusion).
function readableCode(groups = 3, size = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts = [];
  for (let g = 0; g < groups; g++) {
    let part = '';
    for (let i = 0; i < size; i++) part += alphabet[crypto.randomInt(alphabet.length)];
    parts.push(part);
  }
  return parts.join('-');
}

const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when an email is unknown, so failed sign-ins take the
// same time whether or not the account exists.
const DUMMY_HASH = hashPassword(randomToken());

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Please choose a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 200) throw new ValidationError('That password is too long.');
}

// Simple fixed-window limiter kept in memory.
class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  check(key) {
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > this.now() && entry.count >= this.limit) {
      const minutes = Math.ceil((entry.resetAt - this.now()) / 60000);
      throw new AuthError(`Too many attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`, 429);
    }
  }

  fail(key) {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
  }

  reset(key) {
    this.hits.delete(key);
  }
}

class AuthService {
  constructor(db, { setupCode = null, now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.setupCode = setupCode || readableCode();
    this.limiter = new RateLimiter({ limit: 8, windowMs: 15 * 60 * 1000, now });
  }

  // ----- users -------------------------------------------------------------

  needsSetup() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
  }

  publicUser(user) {
    return (
      user && {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        is_admin: Boolean(user.is_admin),
        mfa_enabled: Boolean(user.totp_enabled),
        person_id: user.person_id,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      }
    );
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all().map((u) => this.publicUser(u));
  }

  // Creates an account from an invite code, or the first (administrator)
  // account from the server's setup code. Returns the new user.
  signup({ email, display_name, password, code }, clientKey = '') {
    const limitKey = `code:${clientKey}`;
    this.limiter.check(limitKey);
    const cleanAddress = cleanEmail(email);
    const name = clean(display_name, 100);
    if (!cleanAddress) throw new ValidationError('Please enter your email address.');
    if (!name) throw new ValidationError('Please enter your name.');
    validatePassword(password);

    const run = () => {
      const firstUser = this.needsSetup();
      let invite = null;
      if (firstUser) {
        if (normalizeCode(code) !== normalizeCode(this.setupCode)) {
          this.limiter.fail(limitKey);
          throw new AuthError('That setup code is not correct. Use the code printed when the server started.', 403);
        }
      } else {
        invite = this.findUsableInvite(code, 'invite');
        if (!invite) {
          this.limiter.fail(limitKey);
          throw new AuthError('That invitation is not valid. It may have expired or already been used.', 403);
        }
      }
      if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanAddress)) {
        throw new ValidationError('An account with that email already exists. Please sign in instead.');
      }
      const result = this.db
        .prepare('INSERT INTO users (email, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)')
        .run(cleanAddress, name, hashPassword(password), firstUser ? 1 : 0);
      const userId = Number(result.lastInsertRowid);
      if (invite) {
        this.db.prepare('UPDATE invites SET used_at = CURRENT_TIMESTAMP, used_by = ? WHERE id = ?').run(userId, invite.id);
      }
      return this.getUser(userId);
    };
    return this.transaction(run);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Checks an email and password. Returns the user or throws.
  checkCredentials(email, password, clientKey = '') {
    const address = String(email || '').trim().toLowerCase();
    const keys = [`login-ip:${clientKey}`, `login:${address}`];
    keys.forEach((k) => this.limiter.check(k));
    const user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(address);
    const ok = checkPassword(String(password || ''), user ? user.password_hash : DUMMY_HASH) && Boolean(user);
    if (!ok) {
      keys.forEach((k) => this.limiter.fail(k));
      throw new AuthError('That email and password do not match.');
    }
    keys.forEach((k) => this.limiter.reset(k));
    return user;
  }

  changePassword(user, currentPassword, newPassword, keepTokenHash) {
    if (!checkPassword(String(currentPassword || ''), user.password_hash)) {
      throw new AuthError('Your current password is not correct.', 403);
    }
    validatePassword(newPassword);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
    // Sign out every other device.
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, keepTokenHash || '');
  }

  removeUser(admin, userId) {
    this.requireAdmin(admin);
    const user = this.getUser(userId);
    if (!user) throw new NotFoundError('That account was not found.');
    if (user.id === admin.id) throw new ValidationError('You cannot remove your own account.');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  }

  setAdmin(admin, userId, isAdmin) {
    this.requireAdmin(admin);
    const user = this.getUser(userId);
    if (!user) throw new NotFoundError('That account was not found.');
    if (!isAdmin && user.id === admin.id) throw new ValidationError('You cannot remove your own administrator role.');
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, user.id);
    return this.publicUser(this.getUser(user.id));
  }

  requireAdmin(user) {
    if (!user || !user.is_admin) throw new AuthError('Only an administrator can do that.', 403);
  }

  linkPerson(userId, personId) {
    this.db.prepare('UPDATE users SET person_id = ? WHERE id = ? AND person_id IS NULL').run(personId, userId);
  }

  // ----- sessions ----------------------------------------------------------

  createSession(userId, stage) {
    const token = randomToken();
    const ttl = stage === 'full' ? FULL_SESSION_MS : PENDING_SESSION_MS;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(this.now());
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, stage, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, stage, this.now() + ttl);
    return token;
  }

  // Starts a session after a correct password: an authenticator code is
  // still needed (or must be set up first).
  startLogin(user) {
    return this.createSession(user.id, user.totp_enabled ? 'mfa' : 'mfa_setup');
  }

  getSession(token) {
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!session) return null;
    if (session.expires_at < this.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    const user = this.getUser(session.user_id);
    if (!user) return null;
    return { session, user, tokenHash };
  }

  // Upgrades a session to fully signed in. A new token is issued so a token
  // seen before MFA can't be reused afterwards.
  promote(ctx) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ctx.tokenHash);
    this.db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(ctx.user.id);
    return this.createSession(ctx.user.id, 'full');
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  // Wrong codes are limited per sign-in attempt and per account, so someone
  // who knows a password can't keep starting new attempts to guess codes.
  checkMfaAllowed(ctx) {
    this.limiter.check(`mfa:${ctx.user.id}`);
  }

  recordMfaFailure(ctx) {
    this.limiter.fail(`mfa:${ctx.user.id}`);
    const failures = ctx.session.mfa_failures + 1;
    if (failures >= MAX_MFA_FAILURES) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ctx.tokenHash);
      throw Object.assign(new AuthError('Too many incorrect codes. Please sign in again.', 401), { sessionEnded: true });
    }
    this.db.prepare('UPDATE sessions SET mfa_failures = ? WHERE token_hash = ?').run(failures, ctx.tokenHash);
    const left = MAX_MFA_FAILURES - failures;
    throw Object.assign(new AuthError(`That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`, 401), {
      stage: ctx.session.stage,
    });
  }

  // ----- multi-factor ------------------------------------------------------

  // Returns the secret (and otpauth:// URL) to show while enrolling.
  mfaSetupDetails(user) {
    let secret = user.totp_pending_secret;
    if (!secret) {
      secret = totp.generateSecret();
      this.db.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?').run(secret, user.id);
    }
    return { secret, otpauthUrl: totp.otpauthUrl({ secret, account: user.email }) };
  }

  // Confirms enrolment with a code from the new authenticator. Returns fresh
  // backup codes (shown to the user once).
  confirmMfaSetup(ctx, code) {
    const { user } = ctx;
    this.checkMfaAllowed(ctx);
    if (!user.totp_pending_secret) throw new ValidationError('Please start the authenticator setup again.');
    const step = totp.verifyTotp(user.totp_pending_secret, code, { now: this.now() });
    if (step === null) this.recordMfaFailure(ctx);
    this.db
      .prepare('UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?')
      .run(step, user.id);
    return this.regenerateBackupCodes(user);
  }

  // Checks a sign-in code: a six-digit authenticator code or a backup code.
  verifyMfa(ctx, code) {
    const { user } = ctx;
    this.checkMfaAllowed(ctx);
    const step = totp.verifyTotp(user.totp_secret, code, { now: this.now(), lastStep: user.totp_last_step });
    if (step !== null) {
      this.limiter.reset(`mfa:${user.id}`);
      this.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
      return { usedBackupCode: false };
    }
    const normalized = normalizeCode(code);
    if (normalized.length === 10) {
      const match = this.db
        .prepare('SELECT id FROM backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .get(user.id, sha256(normalized));
      if (match) {
        this.db.prepare('UPDATE backup_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(match.id);
        const left = this.db.prepare('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL').get(user.id).n;
        return { usedBackupCode: true, backupCodesLeft: left };
      }
    }
    this.recordMfaFailure(ctx);
  }

  regenerateBackupCodes(user) {
    this.db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(user.id);
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => readableCode(2, 5));
    const insert = this.db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)');
    for (const code of codes) insert.run(user.id, sha256(normalizeCode(code)));
    return codes;
  }

  backupCodesLeft(user) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL').get(user.id).n;
  }

  // ----- invitations & access resets --------------------------------------

  findUsableInvite(code, kind) {
    const token = String(code || '').trim();
    if (!token) return null;
    const invite = this.db.prepare('SELECT * FROM invites WHERE code_hash = ? AND kind = ?').get(sha256(token), kind);
    if (!invite || invite.used_at || invite.expires_at < this.now()) return null;
    return invite;
  }

  createInvite(user, { note } = {}) {
    const code = randomToken(18);
    const expiresAt = this.now() + INVITE_MS;
    const result = this.db
      .prepare("INSERT INTO invites (code_hash, kind, note, created_by, expires_at) VALUES (?, 'invite', ?, ?, ?)")
      .run(sha256(code), clean(note, 200), user.id, expiresAt);
    return { id: Number(result.lastInsertRowid), code, note: clean(note, 200), expires_at: expiresAt };
  }

  listInvites(user) {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.kind, i.note, i.expires_at, i.used_at, i.created_at,
                c.display_name AS created_by_name, u.display_name AS used_by_name, t.display_name AS for_user_name
           FROM invites i
           LEFT JOIN users c ON c.id = i.created_by
           LEFT JOIN users u ON u.id = i.used_by
           LEFT JOIN users t ON t.id = i.user_id
          WHERE (? = 1 OR i.created_by = ?)
          ORDER BY i.id DESC
          LIMIT 100`
      )
      .all(user.is_admin ? 1 : 0, user.id);
    return rows.map((r) => ({ ...r, expired: !r.used_at && r.expires_at < this.now() }));
  }

  revokeInvite(user, inviteId) {
    const invite = this.db.prepare('SELECT * FROM invites WHERE id = ?').get(Number(inviteId));
    if (!invite) throw new NotFoundError('That invitation was not found.');
    if (!user.is_admin && invite.created_by !== user.id) throw new AuthError('You can only cancel invitations you created.', 403);
    this.db.prepare('DELETE FROM invites WHERE id = ?').run(invite.id);
  }

  // Admin: issue a one-time link that lets a member choose a new password
  // and enrol a new authenticator (for a forgotten password or lost phone).
  createResetLink(admin, userId) {
    this.requireAdmin(admin);
    const user = this.getUser(userId);
    if (!user) throw new NotFoundError('That account was not found.');
    const code = randomToken(18);
    const expiresAt = this.now() + RESET_MS;
    this.db.prepare("DELETE FROM invites WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL").run(user.id);
    this.db
      .prepare("INSERT INTO invites (code_hash, kind, user_id, note, created_by, expires_at) VALUES (?, 'reset', ?, ?, ?, ?)")
      .run(sha256(code), user.id, `Access reset for ${user.display_name}`, admin.id, expiresAt);
    return { code, expires_at: expiresAt, user: this.publicUser(user) };
  }

  // Uses a reset link: sets the new password, clears the old authenticator
  // and backup codes, and signs out every device. Returns the user.
  redeemReset({ code, password }, clientKey = '') {
    const limitKey = `code:${clientKey}`;
    this.limiter.check(limitKey);
    validatePassword(password);
    return this.transaction(() => {
      const invite = this.findUsableInvite(code, 'reset');
      if (!invite) {
        this.limiter.fail(limitKey);
        throw new AuthError('That reset link is not valid. It may have expired or already been used.', 403);
      }
      this.db
        .prepare(
          `UPDATE users SET password_hash = ?, totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0,
                            totp_last_step = 0 WHERE id = ?`
        )
        .run(hashPassword(password), invite.user_id);
      this.db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(invite.user_id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(invite.user_id);
      this.db.prepare('UPDATE invites SET used_at = CURRENT_TIMESTAMP, used_by = ? WHERE id = ?').run(invite.user_id, invite.id);
      return this.getUser(invite.user_id);
    });
  }
}

module.exports = { AuthService, RateLimiter, hashPassword, checkPassword, MIN_PASSWORD_LENGTH };
