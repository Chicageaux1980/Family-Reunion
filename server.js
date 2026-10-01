'use strict';

// Family Reunion web server: serves the single-page app from ./public and a
// JSON API over the SQLite family database. No third-party dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { FamilyStore } = require('./src/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Unknown paths fall back to the app shell so client-side routes work.
      if (!path.extname(relative)) return serveStatic(req, res, '/');
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// Each route: [method, pattern, handler(store, match, url, body)].
const ROUTES = [
  ['GET', /^\/api\/stats$/, (store) => store.stats()],
  [
    'GET',
    /^\/api\/people$/,
    (store, _m, url) =>
      store.search({
        q: url.searchParams.get('q') || '',
        registeredOnly: url.searchParams.get('registered') === '1',
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      }),
  ],
  ['POST', /^\/api\/register$/, (store, _m, _u, body) => store.register(body), 201],
  ['GET', /^\/api\/people\/(\d+)$/, (store, m) => store.personDetails(m[1])],
  ['PATCH', /^\/api\/people\/(\d+)$/, (store, m, _u, body) => store.updatePerson(m[1], body)],
  ['DELETE', /^\/api\/people\/(\d+)$/, (store, m) => (store.deletePerson(m[1]), { deleted: true })],
  ['POST', /^\/api\/people\/(\d+)\/merge$/, (store, m, _u, body) => store.mergePeople(m[1], body.merge_id)],
  ['GET', /^\/api\/people\/(\d+)\/tree$/, (store, m) => store.familyGraph(m[1])],
  [
    'GET',
    /^\/api\/relationship$/,
    (store, _m, url) => store.relationship(url.searchParams.get('a'), url.searchParams.get('b')),
  ],
];

function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
      return serveStatic(req, res, url.pathname);
    }
    try {
      for (const [method, pattern, handler, status = 200] of ROUTES) {
        const match = url.pathname.match(pattern);
        if (!match || method !== req.method) continue;
        const body = method === 'POST' || method === 'PATCH' ? await readJson(req) : {};
        return sendJson(res, status, handler(store, match, url, body));
      }
      sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Something went wrong.' : err.message });
    }
  });
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new FamilyStore(process.env.DB_FILE || path.join(dataDir, 'family-reunion.db'));
  const port = Number(process.env.PORT) || 3000;
  createServer(store).listen(port, () => {
    console.log(`Family Reunion is running at http://localhost:${port}`);
  });
}

module.exports = { createServer };
