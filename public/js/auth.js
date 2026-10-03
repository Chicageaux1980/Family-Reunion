// Sign-in screens: first-time setup, joining with an invitation, signing in,
// the authenticator code step, authenticator enrolment and access resets.

import { app, api, esc, notice, copyText } from './core.js';
import { refreshAuth, route } from './main.js';

const MIN_PASSWORD = 10;

function authCard(title, intro, body) {
  app.innerHTML = `
    <div class="auth-wrap">
      <section class="card auth-card">
        <h1>${title}</h1>
        ${intro ? `<p class="muted">${intro}</p>` : ''}
        <div id="auth-msg"></div>
        ${body}
      </section>
    </div>`;
  const first = app.querySelector('input:not([type=hidden])');
  if (first) first.focus();
}

function showError(err) {
  const msg = document.getElementById('auth-msg');
  if (msg) msg.innerHTML = notice('error', err.message);
}

// Wires a form whose submit calls `action(data)`; then refreshes the
// sign-in state and re-routes.
function onSubmit(form, action) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const keepGoing = await action(data);
      if (keepGoing === false) return;
      await refreshAuth();
      await route();
    } catch (err) {
      if (err.status === 401 && !err.data?.stage && form.dataset.stage) {
        // The sign-in attempt ended (too many wrong codes): start over.
        await refreshAuth();
        await route();
      }
      showError(err);
    } finally {
      button.disabled = false;
    }
  });
}

function passwordFields() {
  return `
    <label><span>Password <small class="muted">(at least ${MIN_PASSWORD} characters)</small></span>
      <input type="password" name="password" autocomplete="new-password" required minlength="${MIN_PASSWORD}" /></label>
    <label><span>Confirm password</span>
      <input type="password" name="confirm" autocomplete="new-password" required minlength="${MIN_PASSWORD}" /></label>`;
}

function checkPasswords(data) {
  if (data.password !== data.confirm) throw new Error('The two passwords do not match.');
}

export async function renderAuth(status, section, params) {
  document.title = 'Sign in · Family Reunion';
  if (status.stage === 'mfa') return renderMfaVerify(status);
  if (status.stage === 'mfa_setup') return renderMfaSetup();
  if (section === 'join' && params.get('code')) return renderJoin(params.get('code'));
  if (section === 'reset' && params.get('code')) return renderReset(params.get('code'));
  if (status.needsSetup) return renderFirstAccount();
  return renderLogin();
}

function renderLogin() {
  authCard(
    'Sign in',
    'Family Reunion is private to invited family members.',
    `<form id="login-form" class="stack-sm">
      <label><span>Email address</span><input type="email" name="email" autocomplete="username" required /></label>
      <label><span>Password</span><input type="password" name="password" autocomplete="current-password" required /></label>
      <button class="btn" type="submit">Continue</button>
    </form>
    <p class="hint auth-foot">New here? Ask a family member for an invitation link.
      Forgot your password or lost your phone? Ask a family administrator to reset your access.</p>`
  );
  if (location.hash !== '#/login') history.replaceState(null, '', '#/login');
  onSubmit(document.getElementById('login-form'), (data) => api('/api/auth/login', { method: 'POST', body: data }));
}

function renderFirstAccount() {
  authCard(
    'Set up Family Reunion',
    'Create the first account. It will be the family administrator, able to invite relatives and help them regain access.',
    `<form id="setup-form" class="stack-sm">
      <label><span>Setup code</span>
        <input name="code" required autocomplete="off" placeholder="XXXX-XXXX-XXXX" />
        <small class="muted">Printed in the server log when Family Reunion started.</small></label>
      <label><span>Your name</span><input name="display_name" autocomplete="name" required /></label>
      <label><span>Email address</span><input type="email" name="email" autocomplete="username" required /></label>
      ${passwordFields()}
      <button class="btn" type="submit">Create administrator account</button>
    </form>`
  );
  onSubmit(document.getElementById('setup-form'), (data) => {
    checkPasswords(data);
    return api('/api/auth/signup', { method: 'POST', body: data });
  });
}

function renderJoin(code) {
  authCard(
    'Join the family',
    "You've been invited to Family Reunion. Create your account, then set up an authenticator app to keep the family's information safe.",
    `<form id="join-form" class="stack-sm">
      <label><span>Your name</span><input name="display_name" autocomplete="name" required /></label>
      <label><span>Email address</span><input type="email" name="email" autocomplete="username" required /></label>
      ${passwordFields()}
      <button class="btn" type="submit">Create my account</button>
    </form>
    <p class="hint auth-foot">Already have an account? <a href="#/login">Sign in</a></p>`
  );
  onSubmit(document.getElementById('join-form'), async (data) => {
    checkPasswords(data);
    await api('/api/auth/signup', { method: 'POST', body: { ...data, code } });
    history.replaceState(null, '', '#/');
  });
}

function renderReset(code) {
  authCard(
    'Reset your access',
    'Choose a new password. You will then set up your authenticator app again.',
    `<form id="reset-form" class="stack-sm">
      ${passwordFields()}
      <button class="btn" type="submit">Save new password</button>
    </form>`
  );
  onSubmit(document.getElementById('reset-form'), async (data) => {
    checkPasswords(data);
    await api('/api/auth/reset', { method: 'POST', body: { code, password: data.password } });
    history.replaceState(null, '', '#/');
  });
}

function renderMfaVerify(status) {
  authCard(
    'Enter your code',
    `Open your authenticator app and enter the 6-digit code for Family Reunion (${esc(status.email || '')}).`,
    `<form id="mfa-form" class="stack-sm" data-stage="mfa">
      <label><span>Authentication code</span>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="11"
          class="code-input" placeholder="123456" /></label>
      <button class="btn" type="submit">Verify</button>
    </form>
    <p class="hint auth-foot">No phone? Enter one of your backup codes instead.
      <button type="button" class="link-button" id="cancel-login">Use a different account</button></p>`
  );
  document.getElementById('cancel-login').addEventListener('click', cancelSignIn);
  onSubmit(document.getElementById('mfa-form'), async (data) => {
    const result = await api('/api/auth/mfa/verify', { method: 'POST', body: data });
    if (result.usedBackupCode) {
      alert(
        `You used a backup code. You have ${result.backupCodesLeft} left. ` +
          'You can make new ones from the Account page.'
      );
    }
  });
}

async function cancelSignIn() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  await refreshAuth();
  location.hash = '#/login';
  route();
}

async function renderMfaSetup() {
  const setup = await api('/api/auth/mfa/setup');
  const grouped = setup.secret.match(/.{1,4}/g).join(' ');
  authCard(
    'Protect your account',
    'Family Reunion uses two-step sign-in. Each time you sign in you will enter your password and a code from an authenticator app on your phone.',
    `<ol class="setup-steps">
      <li><strong>Install an authenticator app</strong> such as Google Authenticator, Microsoft Authenticator, Authy or 1Password.</li>
      <li><strong>Scan this code</strong> with the app (or tap the link on your phone).
        <div class="qr">${setup.qrSvg}</div>
        <p class="hint">Can't scan? <a href="${esc(setup.otpauthUrl)}">Open in authenticator app</a>, or enter this key by hand:</p>
        <p><code class="secret">${esc(grouped)}</code> <button type="button" class="btn small secondary" id="copy-secret">Copy key</button></p>
      </li>
      <li><strong>Enter the 6-digit code</strong> the app shows:
        <form id="mfa-setup-form" class="stack-sm" data-stage="mfa_setup">
          <input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6" class="code-input" placeholder="123456" aria-label="6-digit code" />
          <button class="btn" type="submit">Turn on two-step sign-in</button>
        </form>
      </li>
    </ol>
    <p class="hint auth-foot"><button type="button" class="link-button" id="cancel-login">Cancel and sign out</button></p>`
  );
  document.getElementById('copy-secret').addEventListener('click', (e) => copyText(setup.secret, e.target));
  document.getElementById('cancel-login').addEventListener('click', cancelSignIn);
  onSubmit(document.getElementById('mfa-setup-form'), async (data) => {
    const result = await api('/api/auth/mfa/setup', { method: 'POST', body: data });
    showBackupCodes(result.backupCodes, async () => {
      await refreshAuth();
      await route();
    });
    return false;
  });
}

// Shows one-time backup codes with copy/download, then calls `done`.
export function showBackupCodes(codes, done) {
  const text = `Family Reunion backup codes\nEach code can be used once instead of an authenticator code.\n\n${codes.join('\n')}\n`;
  authCard(
    'Save your backup codes',
    "If you lose your phone, each of these codes lets you sign in once. Store them somewhere safe — they won't be shown again.",
    `<ul class="backup-codes">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>
    <div class="actions">
      <button type="button" class="btn secondary" id="copy-codes">Copy</button>
      <button type="button" class="btn secondary" id="download-codes">Download</button>
      <button type="button" class="btn" id="codes-done">I've saved them — continue</button>
    </div>`
  );
  document.getElementById('copy-codes').addEventListener('click', (e) => copyText(text, e.target));
  document.getElementById('download-codes').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'family-reunion-backup-codes.txt' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.getElementById('codes-done').addEventListener('click', done);
}
