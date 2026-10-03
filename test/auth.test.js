'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../src/totp');
const { AuthService, hashPassword, checkPassword } = require('../src/auth');
const { FamilyStore } = require('../src/store');

test('TOTP matches the RFC 6238 test vector', () => {
  const secret = Buffer.from('12345678901234567890');
  // RFC 6238 Appendix B (SHA-1): T = 59s -> 94287082 (last 6 digits).
  assert.equal(totp.hotp(secret, 1), '287082');
  assert.equal(totp.base32Decode(totp.base32Encode(secret)).toString(), '12345678901234567890');
});

test('TOTP accepts one step of drift and rejects replays', () => {
  const secret = totp.generateSecret();
  const now = 1_700_000_000_000;
  const code = totp.generateTotp(secret, now);
  const step = totp.verifyTotp(secret, code, { now });
  assert.ok(step);
  assert.equal(totp.verifyTotp(secret, code, { now: now + 30_000 }), step, 'previous step still accepted');
  assert.equal(totp.verifyTotp(secret, code, { now: now + 90_000 }), null, 'too old');
  assert.equal(totp.verifyTotp(secret, code, { now, lastStep: step }), null, 'replay rejected');
  assert.equal(totp.verifyTotp(secret, 'abcdef', { now }), null);
});

test('passwords are salted scrypt hashes', () => {
  const a = hashPassword('correct horse battery');
  const b = hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.ok(checkPassword('correct horse battery', a));
  assert.ok(!checkPassword('Correct horse battery', a));
});

test('repeated wrong passwords lock the account temporarily', () => {
  let clock = 1_700_000_000_000;
  const store = new FamilyStore(':memory:');
  const auth = new AuthService(store.db, { setupCode: 'CODE', now: () => clock });
  auth.signup({ email: 'a@example.com', display_name: 'A', password: 'long enough password', code: 'CODE' });
  for (let i = 0; i < 8; i++) {
    assert.throws(() => auth.checkCredentials('a@example.com', 'wrong', '1.2.3.4'), /do not match/);
  }
  assert.throws(() => auth.checkCredentials('a@example.com', 'long enough password', '1.2.3.4'), /Too many attempts/);
  clock += 16 * 60 * 1000;
  assert.equal(auth.checkCredentials('a@example.com', 'long enough password', '1.2.3.4').email, 'a@example.com');
});

test('too many wrong authenticator codes end the sign-in attempt', () => {
  const store = new FamilyStore(':memory:');
  const auth = new AuthService(store.db, { setupCode: 'CODE' });
  const user = auth.signup({ email: 'a@example.com', display_name: 'A', password: 'long enough password', code: 'CODE' });
  const token = auth.startLogin(user);
  auth.mfaSetupDetails(user);
  for (let i = 0; i < 4; i++) {
    assert.throws(() => auth.confirmMfaSetup(auth.getSession(token), '000000'), /attempts? left/);
  }
  assert.throws(() => auth.confirmMfaSetup(auth.getSession(token), '000000'), /sign in again/);
  assert.equal(auth.getSession(token), null);
});

test('weak passwords and duplicate accounts are refused', () => {
  const store = new FamilyStore(':memory:');
  const auth = new AuthService(store.db, { setupCode: 'CODE' });
  assert.throws(() => auth.signup({ email: 'a@example.com', display_name: 'A', password: 'short', code: 'CODE' }), /at least 10/);
  const admin = auth.signup({ email: 'a@example.com', display_name: 'A', password: 'long enough password', code: 'CODE' });
  const invite = auth.createInvite(admin);
  assert.throws(
    () => auth.signup({ email: 'A@example.com', display_name: 'B', password: 'long enough password', code: invite.code }),
    /already exists/
  );
});

test('wrong authenticator codes are also limited per account across sign-in attempts', () => {
  const store = new FamilyStore(':memory:');
  const auth = new AuthService(store.db, { setupCode: 'CODE' });
  const user = auth.signup({ email: 'a@example.com', display_name: 'A', password: 'long enough password', code: 'CODE' });
  const setupToken = auth.startLogin(user);
  const { secret } = auth.mfaSetupDetails(user);
  auth.confirmMfaSetup(auth.getSession(setupToken), totp.generateTotp(secret));

  let failures = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = auth.startLogin(auth.getUser(user.id));
    for (let i = 0; i < 3; i++) {
      try {
        auth.verifyMfa(auth.getSession(token), '000000');
      } catch (err) {
        if (/Too many attempts/.test(err.message)) {
          assert.ok(failures >= 8);
          return;
        }
        failures++;
      }
    }
  }
  assert.fail('per-account limit never kicked in');
});
