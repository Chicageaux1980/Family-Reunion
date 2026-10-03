// Family Reunion single-page app. Hash routes:
//   #/                     home
//   #/register             add yourself and your relatives
//   #/directory?q=...      searchable family directory
//   #/person/:id           a person's details, relatives, photos and obituary
//   #/tree/:id             interactive family tree centred on a person
//   #/relationship?a=&b=   "how are we related?" finder
//   #/calendar?month=      shared family calendar
//   #/photos?q=            searchable family photos
//   #/account              password, backup codes, invitations, members
// Signed-out routes: #/login, #/join?code=, #/reset?code=

import { app, api, notice, session } from './core.js';
import { renderAuth } from './auth.js';
import { renderHome } from './home.js';
import { renderRegister } from './register.js';
import { renderDirectory } from './directory.js';
import { renderPerson } from './person.js';
import { renderTree } from './tree.js';
import { renderRelationship } from './relationship.js';
import { renderCalendar } from './calendar.js';
import { renderPhotos } from './photos.js';
import { renderAccount } from './account.js';

const nav = document.getElementById('site-nav');

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, query = ''] = raw.split('?');
  return { parts: pathPart.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}

let authStatus = null;

export async function refreshAuth() {
  authStatus = await api('/api/auth/status');
  session.user = authStatus.user;
  nav.hidden = authStatus.stage !== 'full';
  return authStatus;
}

export async function route() {
  const { parts, params } = parseHash();
  const [section, id] = parts;
  document.querySelectorAll('dialog.modal').forEach((d) => d.close());
  try {
    if (!authStatus) await refreshAuth();
    if (authStatus.stage !== 'full') {
      setActiveNav('');
      await renderAuth(authStatus, section, params);
      return;
    }
    if (['login', 'join', 'reset'].includes(section)) {
      location.replace('#/');
      return;
    }
    setActiveNav(section || 'home');
    app.innerHTML = '<p class="muted">Loading…</p>';
    if (!section) await renderHome();
    else if (section === 'register') renderRegister();
    else if (section === 'directory') await renderDirectory(params);
    else if (section === 'person' && id) await renderPerson(id, params);
    else if (section === 'tree' && id) await renderTree(id);
    else if (section === 'relationship') await renderRelationship(params);
    else if (section === 'calendar') await renderCalendar(params);
    else if (section === 'photos') await renderPhotos(params);
    else if (section === 'account') await renderAccount();
    else app.innerHTML = `<h1>Page not found</h1><p><a href="#/">Go home</a></p>`;
  } catch (err) {
    if (err.status === 401) {
      // Signed out (or the session expired): show the sign-in screens.
      authStatus = null;
      return route();
    }
    app.innerHTML = notice('error', err.message) + '<p><a href="#/">Go home</a></p>';
  }
  window.scrollTo(0, 0);
}

document.getElementById('sign-out').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  authStatus = null;
  location.hash = '#/login';
  route();
});

window.addEventListener('hashchange', route);
route();
