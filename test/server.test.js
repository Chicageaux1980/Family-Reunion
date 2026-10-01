'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { FamilyStore } = require('../src/store');

test('HTTP API end to end', async (t) => {
  const server = createServer(new FamilyStore(':memory:'));
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, options = {}) => {
    const res = await fetch(base + path, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
      body: options.body && JSON.stringify(options.body),
    });
    return { status: res.status, body: await res.json() };
  };

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Family Reunion<\/title>/);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 403);

  const bad = await call('/api/register', { method: 'POST', body: { first_name: 'Ava' } });
  assert.equal(bad.status, 400);

  const created = await call('/api/register', {
    method: 'POST',
    body: { first_name: 'Ava', last_name: 'Jones', mother_name: 'Linda Baker', father_name: 'Mark Jones' },
  });
  assert.equal(created.status, 201);
  const id = created.body.personId;

  const sibling = await call('/api/register', {
    method: 'POST',
    body: { first_name: 'Ben', last_name: 'Jones', mother_name: 'Linda Baker', father_name: 'Mark Jones' },
  });

  assert.equal((await call('/api/stats')).body.people, 4);
  assert.equal((await call('/api/people?q=jones')).body.total, 3);
  assert.equal((await call(`/api/people/${id}`)).body.siblings[0].name, 'Ben Jones');
  assert.equal((await call(`/api/people/${id}/tree`)).body.people.length, 4);

  const rel = await call(`/api/relationship?a=${id}&b=${sibling.body.personId}`);
  assert.match(rel.body.description, /siblings/);

  const patched = await call(`/api/people/${id}`, { method: 'PATCH', body: { birth_city: 'Chicago' } });
  assert.equal(patched.body.birth_city, 'Chicago');

  assert.equal((await call('/api/people/9999')).status, 404);
  assert.equal((await call('/api/nope')).status, 404);
});
