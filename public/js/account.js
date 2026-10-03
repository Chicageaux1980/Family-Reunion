// Account & family access: password, backup codes, invitations and (for
// administrators) member management.

import { app, api, esc, notice, session, formatDate, copyText, openDialog } from './core.js';
import { refreshAuth } from './main.js';

const when = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const linkFor = (kind, code) => `${location.origin}/#/${kind}?code=${encodeURIComponent(code)}`;

export async function renderAccount() {
  document.title = 'Account · Family Reunion';
  const [account, invites, users] = await Promise.all([
    api('/api/account'),
    api('/api/invites'),
    session.user?.is_admin ? api('/api/users') : Promise.resolve(null),
  ]);
  const user = account.user;

  app.innerHTML = `
    <h1>Account &amp; family access</h1>
    <div id="account-msg"></div>
    <div class="person-layout">
      <section class="card">
        <h2>${esc(user.display_name)} ${user.is_admin ? '<span class="badge member">Administrator</span>' : ''}</h2>
        <dl class="details">
          <dt>Email</dt><dd>${esc(user.email)}</dd>
          <dt>Two-step sign-in</dt><dd>${user.mfa_enabled ? 'On (authenticator app)' : 'Not set up'}</dd>
          <dt>Backup codes left</dt><dd>${account.backupCodesLeft}${account.backupCodesLeft < 3 ? ' <span class="badge memory">Running low</span>' : ''}</dd>
          <dt>Your profile</dt><dd>${
            user.person_id
              ? `<a href="#/person/${user.person_id}">View my profile</a>`
              : `<span class="muted">Not linked yet. <a href="#/register">Add your family</a> using ${esc(user.email)} to link it.</span>`
          }</dd>
        </dl>
        <h3 class="sub-head">New backup codes</h3>
        <form id="codes-form" class="inline-form">
          <input type="password" name="password" placeholder="Your password" autocomplete="current-password" required aria-label="Your password" />
          <button class="btn small secondary" type="submit">Make new codes</button>
        </form>
      </section>
      <section class="card">
        <h2>Change password</h2>
        <form id="password-form" class="stack-sm">
          <label><span>Current password</span><input type="password" name="current_password" autocomplete="current-password" required /></label>
          <label><span>New password <small class="muted">(at least 10 characters)</small></span><input type="password" name="new_password" autocomplete="new-password" required minlength="10" /></label>
          <label><span>Confirm new password</span><input type="password" name="confirm" autocomplete="new-password" required minlength="10" /></label>
          <div><button class="btn small" type="submit">Change password</button></div>
        </form>
      </section>
    </div>

    <section class="card" style="margin-top:20px">
      <h2>Invite family</h2>
      <p class="hint">Only people with an invitation can join. Each link works once and expires after 7 days.
        Send it privately, for example by text or email.</p>
      <form id="invite-form" class="inline-form">
        <input name="note" placeholder="Who is it for? (optional, e.g. Cousin Ben)" maxlength="200" aria-label="Who is the invitation for?" />
        <button class="btn small" type="submit">Create invitation link</button>
      </form>
      <div id="new-invite"></div>
      ${invitesTable(invites)}
    </section>

    ${users ? membersSection(users, user) : ''}`;

  const msg = document.getElementById('account-msg');
  const showError = (err) => {
    msg.innerHTML = notice('error', err.message);
    window.scrollTo(0, 0);
  };

  document.getElementById('codes-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const { backupCodes } = await api('/api/account/backup-codes', { method: 'POST', body: { password: event.target.password.value } });
      showCodesDialog(backupCodes);
      event.target.reset();
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.new_password.value !== form.confirm.value) return showError(new Error('The new passwords do not match.'));
    try {
      await api('/api/account/password', {
        method: 'POST',
        body: { current_password: form.current_password.value, new_password: form.new_password.value },
      });
      form.reset();
      msg.innerHTML = notice('success', 'Password changed. Other devices have been signed out.');
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const invite = await api('/api/invites', { method: 'POST', body: { note: event.target.note.value } });
      await renderAccount();
      showLink('new-invite', 'Invitation link', linkFor('join', invite.code), invite.expires_at);
    } catch (err) {
      showError(err);
    }
  });

  app.querySelectorAll('[data-revoke]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm('Cancel this invitation? The link will stop working.')) return;
      try {
        await api(`/api/invites/${button.dataset.revoke}`, { method: 'DELETE' });
        await renderAccount();
      } catch (err) {
        showError(err);
      }
    })
  );

  app.querySelectorAll('[data-reset]').forEach((button) =>
    button.addEventListener('click', async () => {
      const name = button.dataset.name;
      if (!confirm(`Create a reset link for ${name}? They will choose a new password and set up their authenticator again.`)) return;
      try {
        const reset = await api(`/api/users/${button.dataset.reset}/reset`, { method: 'POST' });
        await renderAccount();
        showLink('new-reset', `Reset link for ${name}`, linkFor('reset', reset.code), reset.expires_at);
        document.getElementById('new-reset').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        showError(err);
      }
    })
  );

  app.querySelectorAll('[data-admin]').forEach((box) =>
    box.addEventListener('change', async () => {
      try {
        await api(`/api/users/${box.dataset.admin}`, { method: 'PATCH', body: { is_admin: box.checked } });
        await refreshAuth();
      } catch (err) {
        box.checked = !box.checked;
        showError(err);
      }
    })
  );

  app.querySelectorAll('[data-remove-user]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm(`Remove ${button.dataset.name}'s account? They will no longer be able to sign in. Family tree entries stay.`)) return;
      try {
        await api(`/api/users/${button.dataset.removeUser}`, { method: 'DELETE' });
        await renderAccount();
      } catch (err) {
        showError(err);
      }
    })
  );
}

function showLink(targetId, title, url, expiresAt) {
  const target = document.getElementById(targetId);
  target.innerHTML = `<div class="notice success link-box">
      <strong>${esc(title)}</strong> (expires ${esc(when(expiresAt))}) — this is the only time it is shown:
      <div class="inline-form"><input readonly value="${esc(url)}" aria-label="${esc(title)}" />
      <button type="button" class="btn small" data-copy>Copy link</button></div>
    </div>`;
  target.querySelector('[data-copy]').addEventListener('click', (e) => copyText(url, e.target));
  target.querySelector('input').select();
}

function invitesTable(invites) {
  if (!invites.length) return '';
  const status = (i) =>
    i.used_at
      ? `Used by ${esc(i.used_by_name || 'a member')}`
      : i.expired
        ? 'Expired'
        : `Open until ${esc(when(i.expires_at))}`;
  return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Invitation</th><th>Created by</th><th>Status</th><th></th></tr></thead>
      <tbody>${invites
        .map(
          (i) => `<tr>
            <td>${i.kind === 'reset' ? `Access reset — ${esc(i.for_user_name || '')}` : esc(i.note || 'Invitation')}</td>
            <td>${esc(i.created_by_name || '')}<br><small class="muted">${esc(formatDate(i.created_at.slice(0, 10)))}</small></td>
            <td>${status(i)}</td>
            <td>${!i.used_at && !i.expired ? `<button type="button" class="link-button small danger-text" data-revoke="${i.id}">Cancel</button>` : ''}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`;
}

function membersSection(users, me) {
  return `<section class="card" style="margin-top:20px">
      <h2>Family members</h2>
      <p class="hint">As an administrator you can give someone a reset link if they forget their password or lose
        their phone, make other members administrators, or remove accounts.</p>
      <div id="new-reset"></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Name</th><th>Two-step</th><th>Last sign-in</th><th>Admin</th><th></th></tr></thead>
        <tbody>${users
          .map(
            (u) => `<tr>
              <td><strong>${esc(u.display_name)}</strong><br><small class="muted">${esc(u.email)}</small></td>
              <td>${u.mfa_enabled ? 'On' : '<span class="badge memory">Not set up</span>'}</td>
              <td>${u.last_login_at ? esc(formatDate(u.last_login_at.slice(0, 10))) : '<span class="muted">Never</span>'}</td>
              <td><input type="checkbox" data-admin="${u.id}" ${u.is_admin ? 'checked' : ''} ${u.id === me.id ? 'disabled' : ''} aria-label="Administrator" /></td>
              <td class="row-actions">${
                u.id === me.id
                  ? '<span class="muted">You</span>'
                  : `<button type="button" class="link-button small" data-reset="${u.id}" data-name="${esc(u.display_name)}">Reset access</button>
                     <button type="button" class="link-button small danger-text" data-remove-user="${u.id}" data-name="${esc(u.display_name)}">Remove</button>`
              }</td>
            </tr>`
          )
          .join('')}</tbody></table></div>
    </section>`;
}

function showCodesDialog(codes) {
  const text = `Family Reunion backup codes\n\n${codes.join('\n')}\n`;
  const dialog = openDialog(`
    <h2>Your new backup codes</h2>
    <p class="hint">Your old codes no longer work. Each of these lets you sign in once without your phone. Keep them somewhere safe.</p>
    <ul class="backup-codes">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>
    <div class="actions"><button type="button" class="btn secondary" id="copy-new-codes">Copy</button></div>`);
  dialog.querySelector('#copy-new-codes').addEventListener('click', (e) => copyText(text, e.target));
}
