'use strict';

// Time-based one-time passwords (RFC 6238), compatible with Google
// Authenticator, Microsoft Authenticator, 1Password, Authy, etc.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter, digits = DIGITS) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

function generateTotp(secret, now = Date.now()) {
  return hotp(secret, currentStep(now));
}

// Returns the matching time step, or null. Accepts one step of clock drift
// either way, and rejects steps at or before `lastStep` so a code can't be
// replayed.
function verifyTotp(secret, code, { now = Date.now(), lastStep = 0, window = 1 } = {}) {
  const digits = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const step = currentStep(now);
  for (let offset = -window; offset <= window; offset++) {
    const candidate = step + offset;
    if (candidate <= lastStep) continue;
    const expected = hotp(secret, candidate);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return candidate;
  }
  return null;
}

function otpauthUrl({ secret, account, issuer = 'Family Reunion' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, hotp, generateTotp, verifyTotp, otpauthUrl };
