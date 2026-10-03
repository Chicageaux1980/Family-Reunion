'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, createApp } = require('../server');
const { generateTotp } = require('../src/totp');

const SETUP_CODE = 'TEST-SETUP-CODE';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-reunion-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Starts a server on a random port. Returns { base, services, client() }.
async function startServer(t) {
  const services = createApp({ mediaDir: tempDir(t), setupCode: SETUP_CODE });
  const server = createServer(services);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // A tiny cookie-keeping HTTP client.
  const client = () => {
    let cookie = '';
    const call = async (pathname, { method = 'GET', body, raw, headers = {}, csrf = true } = {}) => {
      const res = await fetch(base + pathname, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf && method !== 'GET' ? { 'X-Requested-With': 'FamilyReunion' } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const value = setCookie.split(';')[0];
        cookie = value.endsWith('=') ? '' : value;
      }
      const type = res.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: data, headers: res.headers };
    };
    return { call, hasCookie: () => Boolean(cookie) };
  };
  return { base, services, client };
}

// Creates an account (first one uses the setup code), enrols TOTP and
// returns a fully signed-in client plus the account's backup codes.
async function signedInClient(ctx, { email = 'admin@example.com', name = 'Admin', password = 'correct horse battery', code = SETUP_CODE } = {}) {
  const c = ctx.client();
  const signup = await c.call('/api/auth/signup', { method: 'POST', body: { email, display_name: name, password, code } });
  if (signup.status !== 200) throw new Error(`signup failed: ${JSON.stringify(signup.body)}`);
  const setup = await c.call('/api/auth/mfa/setup');
  const confirm = await c.call('/api/auth/mfa/setup', { method: 'POST', body: { code: generateTotp(setup.body.secret) } });
  if (confirm.status !== 200) throw new Error(`mfa setup failed: ${JSON.stringify(confirm.body)}`);
  return { ...c, secret: setup.body.secret, backupCodes: confirm.body.backupCodes, email, password };
}

// Minimal valid file headers for upload tests.
const FILES = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]),
  gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 3)]),
  tiff: Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(32, 4)]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 5)]),
  bmp: Buffer.concat([Buffer.from('BM'), Buffer.alloc(32, 6)]),
  pdf: Buffer.from('%PDF-1.4\n%fake test pdf\n'),
};

module.exports = { startServer, signedInClient, tempDir, FILES, SETUP_CODE };
