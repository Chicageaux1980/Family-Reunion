'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, signedInClient, FILES, SETUP_CODE } = require('./helpers');

test('family data is only available after password and authenticator checks', async (t) => {
  const ctx = await startServer(t);
  const anon = ctx.client();

  const page = await anon.call('/');
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /<title>Family Reunion<\/title>/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  assert.equal((await anon.call('/api/auth/status')).body.needsSetup, true);
  assert.equal((await anon.call('/api/stats')).status, 401);
  assert.equal((await anon.call('/api/people?q=a')).status, 401);
  assert.equal((await anon.call('/api/calendar/upcoming')).status, 401);

  // Changes need the anti-forgery header.
  const forged = await anon.call('/api/auth/login', { method: 'POST', body: {}, csrf: false });
  assert.equal(forged.status, 403);

  // The first account needs the server's setup code.
  const wrongCode = await anon.call('/api/auth/signup', {
    method: 'POST',
    body: { email: 'a@example.com', display_name: 'A', password: 'long enough password', code: 'NOPE' },
  });
  assert.equal(wrongCode.status, 403);

  const c = ctx.client();
  const signup = await c.call('/api/auth/signup', {
    method: 'POST',
    body: { email: 'admin@example.com', display_name: 'Admin', password: 'correct horse battery', code: SETUP_CODE },
  });
  assert.equal(signup.body.stage, 'mfa_setup');
  // Password alone is not enough.
  const pending = await c.call('/api/stats');
  assert.equal(pending.status, 401);
  assert.equal(pending.body.stage, 'mfa_setup');

  const setup = await c.call('/api/auth/mfa/setup');
  assert.match(setup.body.qrSvg, /<svg/);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const bad = await c.call('/api/auth/mfa/setup', { method: 'POST', body: { code: '000000' } });
  assert.equal(bad.status, 401);
  const { generateTotp } = require('../src/totp');
  const ok = await c.call('/api/auth/mfa/setup', { method: 'POST', body: { code: generateTotp(setup.body.secret) } });
  assert.equal(ok.body.stage, 'full');
  assert.equal(ok.body.backupCodes.length, 10);
  assert.equal((await c.call('/api/stats')).status, 200);
  const status = await c.call('/api/auth/status');
  assert.equal(status.body.user.is_admin, true);

  // Sign out, then back in with password + backup code.
  await c.call('/api/auth/logout', { method: 'POST' });
  assert.equal((await c.call('/api/stats')).status, 401);
  const badLogin = await c.call('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'wrong password!' } });
  assert.equal(badLogin.status, 401);
  const login = await c.call('/api/auth/login', { method: 'POST', body: { email: 'ADMIN@example.com', password: 'correct horse battery' } });
  assert.equal(login.body.stage, 'mfa');
  assert.equal((await c.call('/api/stats')).status, 401);
  const verified = await c.call('/api/auth/mfa/verify', { method: 'POST', body: { code: ok.body.backupCodes[0] } });
  assert.equal(verified.body.stage, 'full');
  assert.equal(verified.body.backupCodesLeft, 9);
  assert.equal((await c.call('/api/stats')).status, 200);

  // A backup code works only once.
  const other = ctx.client();
  await other.call('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'correct horse battery' } });
  const reused = await other.call('/api/auth/mfa/verify', { method: 'POST', body: { code: ok.body.backupCodes[0] } });
  assert.equal(reused.status, 401);
});

test('family members join with single-use invitations; admins can reset access', async (t) => {
  const ctx = await startServer(t);
  const admin = await signedInClient(ctx);

  const invite = await admin.call('/api/invites', { method: 'POST', body: { note: 'For cousin Ben' } });
  assert.equal(invite.status, 201);

  const noInvite = await ctx.client().call('/api/auth/signup', {
    method: 'POST',
    body: { email: 'ben@example.com', display_name: 'Ben', password: 'another long password', code: 'made-up' },
  });
  assert.equal(noInvite.status, 403);

  const ben = await signedInClient(ctx, { email: 'ben@example.com', name: 'Ben', code: invite.body.code });
  assert.equal((await ben.call('/api/stats')).status, 200);
  assert.equal((await ben.call('/api/users')).status, 403, 'members are not admins');

  const reuse = await ctx.client().call('/api/auth/signup', {
    method: 'POST',
    body: { email: 'eve@example.com', display_name: 'Eve', password: 'another long password', code: invite.body.code },
  });
  assert.equal(reuse.status, 403);

  // Ben loses his phone: the admin issues a reset link.
  const users = await admin.call('/api/users');
  const benUser = users.body.find((u) => u.email === 'ben@example.com');
  const reset = await admin.call(`/api/users/${benUser.id}/reset`, { method: 'POST' });
  const fresh = ctx.client();
  const redeemed = await fresh.call('/api/auth/reset', { method: 'POST', body: { code: reset.body.code, password: 'brand new password' } });
  assert.equal(redeemed.body.stage, 'mfa_setup');
  assert.equal((await ben.call('/api/stats')).status, 401, 'old sessions are signed out');
  const login = await ctx.client().call('/api/auth/login', { method: 'POST', body: { email: 'ben@example.com', password: 'brand new password' } });
  assert.equal(login.body.stage, 'mfa_setup', 'must enrol a new authenticator');
});

test('family API end to end', async (t) => {
  const ctx = await startServer(t);
  const c = await signedInClient(ctx);
  const call = c.call;

  const bad = await call('/api/register', { method: 'POST', body: { first_name: 'Ava' } });
  assert.equal(bad.status, 400);

  const created = await call('/api/register', {
    method: 'POST',
    body: {
      first_name: 'Ava',
      last_name: 'Jones',
      email: 'admin@example.com',
      birth_date: '1990-06-01',
      mother_name: 'Linda Baker',
      father_name: 'Mark Jones',
      spouse_name: 'Sam Lee',
      marriage_date: '2018-09-15',
      marriage_city: 'Chicago',
      siblings: [{ first_name: 'Ben', last_name: 'Jones', birth_date: '1993-02-11' }],
    },
  });
  assert.equal(created.status, 201);
  const id = created.body.personId;
  const status = await call('/api/auth/status');
  assert.equal(status.body.user.person_id, id, 'account is linked to the registrant');

  const person = (await call(`/api/people/${id}`)).body;
  assert.equal(person.siblings[0].name, 'Ben Jones');
  assert.equal(person.spouses[0].name, 'Sam Lee');
  assert.equal(person.spouses[0].marriage_year, 2018);
  assert.equal((await call('/api/stats')).body.people, 5);
  assert.equal((await call('/api/people?q=jones')).body.total, 3);
  const tree = (await call(`/api/people/${id}/tree`)).body;
  assert.equal(tree.people.length, 5);
  assert.equal(tree.marriages.length, 1);

  const rel = await call(`/api/relationship?a=${id}&b=${person.siblings[0].id}`);
  assert.match(rel.body.description, /siblings/);

  const patched = await call(`/api/people/${person.mother.id}`, { method: 'PATCH', body: { deceased: true, death_date: '2020-01-02' } });
  assert.equal(patched.body.deceased, 1);

  const calendar = await call('/api/calendar?from=2026-01-01&to=2026-12-31');
  const titles = calendar.body.items.map((i) => i.title);
  assert.ok(titles.includes("Ava Jones's birthday"));
  assert.ok(titles.some((title) => /Ava Jones & Sam Lee's 8th anniversary/.test(title)));

  const event = await call('/api/events', { method: 'POST', body: { title: 'Reunion picnic', event_date: '2026-07-04', event_time: '12:00', location: 'Lake Park' } });
  assert.equal(event.status, 201);
  const july = await call('/api/calendar?from=2026-07-01&to=2026-07-31');
  assert.equal(july.body.items.find((i) => i.type === 'event').title, 'Reunion picnic');

  assert.equal((await call('/api/people/9999')).status, 404);
  assert.equal((await call('/api/nope')).status, 404);
});

test('photo and obituary uploads are type-checked, stored and searchable', async (t) => {
  const ctx = await startServer(t);
  const c = await signedInClient(ctx);
  const reg = await c.call('/api/register', { method: 'POST', body: { first_name: 'Rose', last_name: 'Baker', deceased: true, death_date: '2015-03-01' } });
  const roseId = reg.body.personId;

  const upload = (ext, data, params = {}) =>
    c.call(`/api/media?${new URLSearchParams({ kind: 'photo', filename: `picture.${ext}`, ...params })}`, {
      method: 'POST',
      raw: data,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

  for (const ext of ['png', 'jpg', 'gif', 'tiff', 'webp', 'bmp']) {
    const res = await upload(ext, FILES[ext]);
    assert.equal(res.status, 201, `${ext}: ${JSON.stringify(res.body)}`);
  }
  const jpeg = await c.call(`/api/media?kind=photo&filename=${encodeURIComponent('Beach Day.JPEG')}&caption=${encodeURIComponent('Summer at the lake')}&people=${roseId}`, {
    method: 'POST',
    raw: FILES.jpg,
  });
  assert.equal(jpeg.status, 201);
  assert.deepEqual(jpeg.body.people.map((p) => p.name), ['Rose Baker']);

  assert.equal((await upload('exe', Buffer.from('MZ...'))).status, 400, 'disallowed type');
  assert.equal((await upload('png', Buffer.from('not really a png'))).status, 400, 'content must match extension');
  assert.equal((await upload('pdf', FILES.pdf)).status, 400, 'pdf is not a photo type');

  const byCaption = await c.call('/api/media?q=lake');
  assert.equal(byCaption.body.total, 1);
  const byPerson = await c.call('/api/media?q=rose%20baker');
  assert.equal(byPerson.body.results[0].id, jpeg.body.id);
  assert.equal((await c.call('/api/media')).body.total, 7);

  const file = await c.call(`/api/media/${jpeg.body.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(file.body, FILES.jpg);

  const obituary = await c.call(`/api/media?kind=obituary&filename=obituary.pdf&person_id=${roseId}`, { method: 'POST', raw: FILES.pdf });
  assert.equal(obituary.status, 201);
  const obits = await c.call(`/api/media?kind=obituary&person_id=${roseId}`);
  assert.equal(obits.body.total, 1);

  assert.equal((await c.call(`/api/media/${jpeg.body.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await c.call(`/api/media/${jpeg.body.id}/file`)).status, 404);
});
