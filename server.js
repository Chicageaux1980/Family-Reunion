'use strict';

// Family Reunion web server: serves the single-page app from ./public and a
// JSON API over the family database. Everything except the sign-in screens
// requires a family member who has passed both password and authenticator
// checks.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { FamilyStore } = require('./src/store');
const { AuthService } = require('./src/auth');
const { MediaService, LocalStorage } = require('./src/media');
const { CalendarService } = require('./src/calendar');
const { AuthError } = require('./src/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_JSON_BYTES = 128 * 1024;
const COOKIE = 'fr_session';
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'FamilyReunion';
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body === undefined ? { ok: true } : body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
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
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer({ store, auth, media, calendar, secureCookies = false, trustProxy = false }) {
  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

  const sessionCookie = (token, stage) => {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (stage === 'full') parts.push(`Max-Age=${14 * 24 * 60 * 60}`);
    if (secureCookies) parts.push('Secure');
    return parts.join('; ');
  };
  const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? '; Secure' : ''}`;

  // Starts a new session and returns the response for it.
  const beginSession = (ctx, token, stage, extra = {}) => {
    ctx.setCookie = sessionCookie(token, stage);
    return { stage, ...extra };
  };

  // Each route: [method, pattern, access, handler]. access is 'public',
  // 'mfa' (password ok, code pending), 'mfa_setup', or 'full'. Handlers get
  // a context object and return the JSON response body.
  const routes = [
    // ----- sign-in -----
    ['GET', /^\/api\/auth\/status$/, 'public', (ctx) => ({
      needsSetup: auth.needsSetup(),
      stage: ctx.auth ? ctx.auth.session.stage : null,
      user: ctx.auth && ctx.auth.session.stage === 'full' ? auth.publicUser(ctx.auth.user) : null,
      email: ctx.auth ? ctx.auth.user.email : null,
    })],
    ['POST', /^\/api\/auth\/signup$/, 'public', (ctx) => {
      const user = auth.signup(ctx.body, ctx.ip);
      return beginSession(ctx, auth.startLogin(user), 'mfa_setup');
    }],
    ['POST', /^\/api\/auth\/login$/, 'public', (ctx) => {
      const user = auth.checkCredentials(ctx.body.email, ctx.body.password, ctx.ip);
      if (ctx.auth) auth.logout(ctx.token);
      return beginSession(ctx, auth.startLogin(user), user.totp_enabled ? 'mfa' : 'mfa_setup');
    }],
    ['POST', /^\/api\/auth\/reset$/, 'public', (ctx) => {
      const user = auth.redeemReset(ctx.body, ctx.ip);
      return beginSession(ctx, auth.startLogin(user), 'mfa_setup');
    }],
    ['GET', /^\/api\/auth\/mfa\/setup$/, 'mfa_setup', async (ctx) => {
      const details = auth.mfaSetupDetails(ctx.auth.user);
      const qrSvg = await QRCode.toString(details.otpauthUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return { ...details, qrSvg, email: ctx.auth.user.email };
    }],
    ['POST', /^\/api\/auth\/mfa\/setup$/, 'mfa_setup', (ctx) => {
      const backupCodes = auth.confirmMfaSetup(ctx.auth, ctx.body.code);
      return beginSession(ctx, auth.promote(ctx.auth), 'full', { backupCodes });
    }],
    ['POST', /^\/api\/auth\/mfa\/verify$/, 'mfa', (ctx) => {
      const result = auth.verifyMfa(ctx.auth, ctx.body.code);
      return beginSession(ctx, auth.promote(ctx.auth), 'full', result);
    }],
    ['POST', /^\/api\/auth\/logout$/, 'public', (ctx) => {
      auth.logout(ctx.token);
      ctx.setCookie = clearCookie();
      return { ok: true };
    }],

    // ----- account & family access -----
    ['GET', /^\/api\/account$/, 'full', (ctx) => ({
      user: auth.publicUser(ctx.user),
      backupCodesLeft: auth.backupCodesLeft(ctx.user),
    })],
    ['POST', /^\/api\/account\/password$/, 'full', (ctx) => {
      auth.changePassword(ctx.user, ctx.body.current_password, ctx.body.new_password, ctx.auth.tokenHash);
      return { ok: true };
    }],
    ['POST', /^\/api\/account\/backup-codes$/, 'full', (ctx) => {
      auth.checkCredentials(ctx.user.email, ctx.body.password, ctx.ip);
      return { backupCodes: auth.regenerateBackupCodes(ctx.user) };
    }],
    ['GET', /^\/api\/invites$/, 'full', (ctx) => auth.listInvites(ctx.user)],
    ['POST', /^\/api\/invites$/, 'full', (ctx) => auth.createInvite(ctx.user, ctx.body), 201],
    ['DELETE', /^\/api\/invites\/(\d+)$/, 'full', (ctx) => auth.revokeInvite(ctx.user, ctx.match[1])],
    ['GET', /^\/api\/users$/, 'full', (ctx) => (auth.requireAdmin(ctx.user), auth.listUsers())],
    ['PATCH', /^\/api\/users\/(\d+)$/, 'full', (ctx) => auth.setAdmin(ctx.user, ctx.match[1], Boolean(ctx.body.is_admin))],
    ['DELETE', /^\/api\/users\/(\d+)$/, 'full', (ctx) => auth.removeUser(ctx.user, ctx.match[1])],
    ['POST', /^\/api\/users\/(\d+)\/reset$/, 'full', (ctx) => auth.createResetLink(ctx.user, ctx.match[1]), 201],

    // ----- family -----
    ['GET', /^\/api\/stats$/, 'full', () => store.stats()],
    ['GET', /^\/api\/people$/, 'full', (ctx) =>
      store.search({
        q: ctx.url.searchParams.get('q') || '',
        registeredOnly: ctx.url.searchParams.get('registered') === '1',
        limit: ctx.url.searchParams.get('limit'),
        offset: ctx.url.searchParams.get('offset'),
      })],
    ['POST', /^\/api\/register$/, 'full', (ctx) => {
      const result = store.register(ctx.body);
      const self = store.getPerson(result.personId);
      if (self.email && self.email === ctx.user.email.toLowerCase()) auth.linkPerson(ctx.user.id, self.id);
      return result;
    }, 201],
    ['GET', /^\/api\/people\/(\d+)$/, 'full', (ctx) => store.personDetails(ctx.match[1])],
    ['PATCH', /^\/api\/people\/(\d+)$/, 'full', (ctx) => store.updatePerson(ctx.match[1], ctx.body)],
    ['DELETE', /^\/api\/people\/(\d+)$/, 'full', (ctx) => store.deletePerson(ctx.match[1])],
    ['POST', /^\/api\/people\/(\d+)\/merge$/, 'full', (ctx) => store.mergePeople(ctx.match[1], ctx.body.merge_id)],
    ['POST', /^\/api\/people\/(\d+)\/spouses$/, 'full', (ctx) => store.addSpouse(ctx.match[1], ctx.body), 201],
    ['DELETE', /^\/api\/marriages\/(\d+)$/, 'full', (ctx) => store.removeMarriage(ctx.match[1])],
    ['GET', /^\/api\/people\/(\d+)\/tree$/, 'full', (ctx) => store.familyGraph(ctx.match[1])],
    ['GET', /^\/api\/relationship$/, 'full', (ctx) =>
      store.relationship(ctx.url.searchParams.get('a'), ctx.url.searchParams.get('b'))],

    // ----- photos & obituaries -----
    ['GET', /^\/api\/media$/, 'full', (ctx) =>
      media.search({
        q: ctx.url.searchParams.get('q') || '',
        kind: ctx.url.searchParams.get('kind') || 'photo',
        personId: ctx.url.searchParams.get('person_id'),
        limit: ctx.url.searchParams.get('limit'),
        offset: ctx.url.searchParams.get('offset'),
      })],
    ['POST', /^\/api\/media$/, 'full', async (ctx) => {
      const p = ctx.url.searchParams;
      return media.upload(
        ctx.req,
        {
          kind: p.get('kind'),
          filename: p.get('filename'),
          size: ctx.req.headers['content-length'],
          caption: p.get('caption'),
          taken_date: p.get('taken_date'),
          people: p.get('people'),
          person_id: p.get('person_id'),
        },
        ctx.user
      );
    }, 201, { rawBody: true }],
    ['GET', /^\/api\/media\/(\d+)$/, 'full', (ctx) => media.get(ctx.match[1])],
    ['PATCH', /^\/api\/media\/(\d+)$/, 'full', (ctx) => media.update(ctx.match[1], ctx.body)],
    ['DELETE', /^\/api\/media\/(\d+)$/, 'full', (ctx) => media.remove(ctx.match[1], ctx.user)],
    ['GET', /^\/api\/media\/(\d+)\/file$/, 'full', (ctx) => {
      const { record, stream } = media.open(ctx.match[1]);
      const disposition = ctx.url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      return new Promise((resolve, reject) => {
        stream.once('error', (err) => reject(err.code === 'ENOENT' ? Object.assign(new Error('The stored file is missing.'), { status: 404 }) : err));
        stream.once('open', () => {
          ctx.res.writeHead(200, {
            'Content-Type': record.mime_type,
            'Content-Length': record.size,
            'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(record.original_name)}`,
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
          });
          stream.pipe(ctx.res);
          stream.once('end', resolve);
        });
        ctx.streamed = true;
      });
    }],

    // ----- calendar -----
    ['GET', /^\/api\/calendar$/, 'full', (ctx) =>
      calendar.range(ctx.url.searchParams.get('from'), ctx.url.searchParams.get('to'))],
    ['GET', /^\/api\/calendar\/upcoming$/, 'full', (ctx) =>
      calendar.upcoming(Math.min(Math.max(Number(ctx.url.searchParams.get('days')) || 30, 1), 366))],
    ['POST', /^\/api\/events$/, 'full', (ctx) => calendar.createEvent(ctx.user, ctx.body), 201],
    ['GET', /^\/api\/events\/(\d+)$/, 'full', (ctx) => calendar.getEvent(ctx.match[1])],
    ['PATCH', /^\/api\/events\/(\d+)$/, 'full', (ctx) => calendar.updateEvent(ctx.user, ctx.match[1], ctx.body)],
    ['DELETE', /^\/api\/events\/(\d+)$/, 'full', (ctx) => calendar.deleteEvent(ctx.user, ctx.match[1])],
  ];

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
      return serveStatic(req, res, url.pathname);
    }

    const ctx = { req, res, url, ip: clientIp(req), setCookie: null, streamed: false };
    try {
      const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
      if (!route) {
        const pathKnown = routes.some(([, pattern]) => pattern.test(url.pathname));
        return sendJson(res, pathKnown ? 405 : 404, { error: pathKnown ? 'Method not allowed.' : 'Not found.' });
      }
      const [method, pattern, access, handler, status = 200, options = {}] = route;

      // Browsers can't add this header to cross-site form posts, so requiring
      // it on every change blocks cross-site request forgery.
      if (method !== 'GET' && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
        throw new AuthError('Missing request header.', 403);
      }

      ctx.token = parseCookies(req.headers.cookie)[COOKIE];
      ctx.auth = auth.getSession(ctx.token);
      if (access !== 'public') {
        const stage = ctx.auth ? ctx.auth.session.stage : null;
        if (stage !== access) {
          const message = stage && stage !== 'full' ? 'Please finish signing in.' : 'Please sign in.';
          throw Object.assign(new AuthError(message), { stage });
        }
        ctx.user = ctx.auth.user;
      }

      ctx.match = url.pathname.match(pattern);
      ctx.body = method === 'POST' || method === 'PATCH' ? (options.rawBody ? null : await readJson(req)) : {};
      const result = await handler(ctx);
      if (ctx.streamed) return;
      sendJson(res, status, result, ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {});
    } catch (err) {
      if (ctx.streamed && res.headersSent) {
        res.destroy(err);
        return;
      }
      const statusCode = err.status || 500;
      if (statusCode === 500) console.error(err);
      const body = { error: statusCode === 500 ? 'Something went wrong.' : err.message };
      if (err instanceof AuthError && err.status === 401) body.stage = err.stage || null;
      const headers = {};
      if (!req.complete) headers.Connection = 'close';
      // Drop a cookie whose session has expired or was just ended.
      if (ctx.token && (!ctx.auth || err.sessionEnded)) headers['Set-Cookie'] = clearCookie();
      sendJson(res, statusCode, body, headers);
      if (!req.complete) req.resume();
    }
  });
}

// Builds every service on one database and media storage location.
function createApp({ dbFile = ':memory:', mediaDir, setupCode } = {}) {
  const store = new FamilyStore(dbFile);
  const auth = new AuthService(store.db, { setupCode });
  const media = new MediaService(store.db, new LocalStorage(mediaDir));
  const calendar = new CalendarService(store.db);
  return { store, auth, media, calendar };
}

if (require.main === module) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const mediaDir = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, 'media'));
  fs.mkdirSync(dataDir, { recursive: true });
  const services = createApp({
    dbFile: process.env.DB_FILE || path.join(dataDir, 'family-reunion.db'),
    mediaDir,
    setupCode: process.env.SETUP_CODE,
  });
  const port = Number(process.env.PORT) || 3000;
  const server = createServer({
    ...services,
    secureCookies: process.env.COOKIE_SECURE === '1',
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  server.listen(port, () => {
    console.log(`Family Reunion is running at http://localhost:${port}`);
    console.log(`Photos and obituaries are stored in ${mediaDir}`);
    if (services.auth.needsSetup()) {
      console.log('');
      console.log('No accounts exist yet. Open the site and create the administrator account');
      console.log(`with this one-time setup code:  ${services.auth.setupCode}`);
      console.log('');
    }
  });
}

module.exports = { createServer, createApp };
