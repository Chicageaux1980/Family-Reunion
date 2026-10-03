// A person's profile: details, relatives, spouses, obituary, photos, and
// tools to edit, add a spouse, combine duplicates or remove them.

import {
  app,
  api,
  esc,
  notice,
  session,
  formatDate,
  fullName,
  lifeLine,
  lifeSpan,
  marriageLine,
  personChip,
  statusBadges,
  todayIso,
  uploadFile,
  checkFile,
  openDialog,
  lifeStatusFields,
  wireLifeStatus,
  OBITUARY_EXTENSIONS,
  OBITUARY_ACCEPT,
} from './core.js';
import { photoGrid, wirePhotoGrid, openUploadDialog } from './photos.js';

const ROLE_LABELS = { self: 'You', mother: 'Mother', father: 'Father', grandmother: 'Grandmother', grandfather: 'Grandfather', spouse: 'Spouse' };

export async function renderPerson(id, params) {
  const [p, photos, obituaries] = await Promise.all([
    api(`/api/people/${id}`),
    api(`/api/media?${new URLSearchParams({ kind: 'photo', person_id: id, limit: '60' })}`),
    api(`/api/media?${new URLSearchParams({ kind: 'obituary', person_id: id })}`),
  ]);
  document.title = `${fullName(p)} · Family Reunion`;
  const reload = async (message) => {
    await renderPerson(p.id, new URLSearchParams());
    if (message) document.getElementById('person-msg').innerHTML = notice('success', message);
  };

  const detailRows = [
    ['Maiden name', p.maiden_name && esc(p.maiden_name)],
    ['Email', p.email && `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`],
    ['Phone', p.phone && `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>`],
    ['Home address', p.home_address && esc(p.home_address)],
    ['Birthday', p.birth_date && esc(formatDate(p.birth_date))],
    ['Birth city', p.birth_city && esc(p.birth_city)],
    ['Status', p.deceased ? 'Deceased' : 'Living'],
    ['Date of death', p.death_date && esc(formatDate(p.death_date))],
  ].filter(([, v]) => v);

  app.innerHTML = `
    ${welcomeNotice(params)}
    <div class="stack">
      <div>
        <h1>${esc(fullName(p))} ${statusBadges(p)}</h1>
        ${lifeSpan(p) ? `<p class="muted life-span">${esc(lifeSpan(p))}</p>` : ''}
        <div class="actions">
          <a class="btn" href="#/tree/${p.id}">View family tree</a>
          <a class="btn secondary" href="#/relationship?a=${p.id}">How are we related?</a>
          <button class="btn secondary" id="edit-toggle" type="button">Edit details</button>
        </div>
      </div>
      <div id="person-msg"></div>
      <div class="person-layout">
        <section class="card">
          <h2>Details</h2>
          <dl class="details">${detailRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        </section>
        <section class="card relatives">
          <h3>Parents</h3>
          <div class="chips">${personChip(p.mother)} ${personChip(p.father)}</div>
          <h3>Spouse</h3>
          ${
            p.spouses.length
              ? `<ul class="spouse-list">${p.spouses
                  .map(
                    (s) => `<li>${personChip(s)} <span class="muted">${esc(marriageLine(s))}</span>
                      <button type="button" class="link-button small" data-unmarry="${s.marriage_id}" aria-label="Remove marriage to ${esc(s.name)}">Remove</button></li>`
                  )
                  .join('')}</ul>`
              : '<span class="muted">None recorded</span>'
          }
          <div><button type="button" class="btn small secondary" id="add-spouse" style="margin-top:8px">+ Add spouse</button></div>
          <h3>Siblings</h3>
          <div class="chips">${p.siblings.length ? p.siblings.map(personChip).join('') : '<span class="muted">None recorded</span>'}</div>
          <h3>Children</h3>
          <div class="chips">${p.children.length ? p.children.map(personChip).join('') : '<span class="muted">None recorded</span>'}</div>
        </section>
      </div>
      ${p.deceased ? obituarySection(obituaries.results) : ''}
      <section class="card">
        <div class="section-head">
          <h2>Photos</h2>
          <button type="button" class="btn small" id="person-upload">Upload photos</button>
        </div>
        <div id="person-photos">${
          photos.results.length ? photoGrid(photos.results) : `<p class="muted">No photos of ${esc(p.first_name || fullName(p))} yet.</p>`
        }</div>
      </section>
      <section class="card" id="edit-section" hidden>
        <h2>Edit details</h2>
        <form id="edit-form">
          <div class="grid">
            ${editField('first_name', 'First name', p)}
            ${editField('last_name', 'Last name', p)}
            ${editField('maiden_name', 'Maiden name', p)}
            ${editField('email', 'Email address', p, 'email')}
            ${editField('phone', 'Phone number', p, 'tel')}
            ${editField('home_address', 'Home address', p, 'text', true)}
            ${editField('birth_date', 'Birthday', p, 'date')}
            ${editField('birth_city', 'Birth city', p)}
          </div>
          ${lifeStatusFields('', { person: p })}
          <div class="actions" style="margin-top:16px">
            <button class="btn" type="submit">Save changes</button>
            <button class="btn danger" type="button" id="delete-btn">Remove from tree</button>
          </div>
        </form>
      </section>
      ${duplicatesSection(p)}
    </div>`;

  const msg = document.getElementById('person-msg');
  const showError = (err) => {
    msg.innerHTML = notice('error', err.message);
    msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  wirePhotoGrid(document.getElementById('person-photos'), photos.results, () => reload());
  document.getElementById('person-upload').addEventListener('click', () =>
    openUploadDialog({ presetPeople: [{ id: p.id, name: fullName(p) }], onDone: () => reload('Photos uploaded.') })
  );

  const editForm = document.getElementById('edit-form');
  wireLifeStatus(editForm);
  document.getElementById('edit-toggle').addEventListener('click', () => {
    const section = document.getElementById('edit-section');
    section.hidden = !section.hidden;
    if (!section.hidden) section.scrollIntoView({ behavior: 'smooth' });
  });
  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(editForm).entries());
    body.deceased = editForm.deceased.checked;
    try {
      await api(`/api/people/${p.id}`, { method: 'PATCH', body });
      await reload(body.deceased && !p.deceased ? 'Details saved. You can now upload an obituary below.' : 'Details saved.');
    } catch (err) {
      showError(err);
    }
  });
  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!confirm(`Remove ${fullName(p)} from the family tree? Their children will stay but lose this parent link.`)) return;
    try {
      await api(`/api/people/${p.id}`, { method: 'DELETE' });
      location.hash = '#/directory';
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('add-spouse').addEventListener('click', () => openSpouseDialog(p, () => reload('Spouse added.')));
  document.querySelectorAll('[data-unmarry]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm('Remove this marriage record? Both people stay in the tree.')) return;
      try {
        await api(`/api/marriages/${button.dataset.unmarry}`, { method: 'DELETE' });
        await reload('Marriage removed.');
      } catch (err) {
        showError(err);
      }
    })
  );

  if (p.deceased) wireObituaries(p, obituaries.results, reload, showError);

  document.querySelectorAll('[data-merge]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm('Combine these two records into one? This cannot be undone.')) return;
      try {
        await api(`/api/people/${p.id}/merge`, { method: 'POST', body: { merge_id: Number(button.dataset.merge) } });
        await reload('Records combined.');
      } catch (err) {
        showError(err);
      }
    })
  );
}

function welcomeNotice(params) {
  if (!params.get('welcome')) return '';
  let linked = [];
  let uploadErrors = [];
  try {
    linked = JSON.parse(sessionStorage.getItem('fr-linked') || '[]');
    uploadErrors = JSON.parse(sessionStorage.getItem('fr-upload-errors') || '[]');
    sessionStorage.removeItem('fr-upload-errors');
  } catch {}
  const label = (role) => (role.startsWith('sibling') ? 'Sibling' : ROLE_LABELS[role] || role);
  const others = linked.filter((l) => l.role !== 'self');
  return `<div class="notice success" role="status"><strong>Saved to the family tree!</strong>
      ${others.length ? `Linked: ${others.map((l) => `${esc(label(l.role))} – <a href="#/person/${l.id}">${esc(l.name)}</a>`).join(', ')}.` : ''}</div>
    ${uploadErrors.length ? notice('error', `Some obituaries could not be uploaded: ${uploadErrors.join(' ')}`) : ''}`;
}

function obituarySection(obituaries) {
  return `<section class="card" id="obituary-section">
      <div class="section-head">
        <h2>Obituary</h2>
        <label class="btn small" id="obituary-label">Upload obituary
          <input type="file" id="obituary-file" accept="${OBITUARY_ACCEPT}" class="visually-hidden" /></label>
      </div>
      <p class="hint">PDF, Word (.doc, .docx), .rtf, .txt or a photo/scan (${'.jpeg, .jpg, .gif, .tiff, .webp, .bmp, .png'}).</p>
      <div id="obituary-status" aria-live="polite"></div>
      ${
        obituaries.length
          ? `<ul class="file-list">${obituaries
              .map((o) => {
                const canDelete = session.user && (session.user.is_admin || o.uploaded_by === session.user.id);
                return `<li>
                  <a href="${o.url}" target="_blank" rel="noopener">${esc(o.caption || o.original_name)}</a>
                  <span class="muted">· shared by ${esc(o.uploaded_by_name || 'a former member')} on ${esc(formatDate(o.created_at.slice(0, 10)))}</span>
                  <a class="link-button small" href="${o.url}?download=1">Download</a>
                  ${canDelete ? `<button type="button" class="link-button small danger-text" data-delete-obituary="${o.id}">Delete</button>` : ''}
                </li>`;
              })
              .join('')}</ul>`
          : '<p class="muted">No obituary has been uploaded yet.</p>'
      }
    </section>`;
}

function wireObituaries(p, obituaries, reload, showError) {
  const input = document.getElementById('obituary-file');
  const status = document.getElementById('obituary-status');
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const problem = checkFile(file, OBITUARY_EXTENSIONS);
    if (problem) {
      status.innerHTML = notice('error', problem);
      return;
    }
    status.innerHTML = '<p class="muted">Uploading… <progress max="1" value="0"></progress></p>';
    try {
      await uploadFile(file, { kind: 'obituary', person_id: p.id }, (f) => (status.querySelector('progress').value = f));
      await reload('Obituary uploaded.');
    } catch (err) {
      status.innerHTML = notice('error', err.message);
    }
  });
  document.querySelectorAll('[data-delete-obituary]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm('Delete this obituary file?')) return;
      try {
        await api(`/api/media/${button.dataset.deleteObituary}`, { method: 'DELETE' });
        await reload('Obituary deleted.');
      } catch (err) {
        showError(err);
      }
    })
  );
}

function openSpouseDialog(p, done) {
  const dialog = openDialog(`
    <h2>Add a spouse for ${esc(fullName(p))}</h2>
    <form id="spouse-form" class="stack-sm">
      <div class="grid">
        <label><span>Spouse's name <span class="req">*</span></span><input name="spouse_name" required /></label>
        <label><span>Spouse's maiden name</span><input name="spouse_maiden_name" /></label>
        <label><span>Year married</span><input type="number" name="marriage_year" min="1800" max="${new Date().getFullYear()}" inputmode="numeric" /></label>
        <label><span>Date married</span><input type="date" name="marriage_date" max="${todayIso()}" /></label>
        <label><span>City married</span><input name="marriage_city" /></label>
      </div>
      ${lifeStatusFields('spouse_')}
      <div id="spouse-msg"></div>
      <div class="actions"><button class="btn" type="submit">Add spouse</button></div>
    </form>`);
  const form = dialog.querySelector('#spouse-form');
  wireLifeStatus(form);
  form.marriage_date.addEventListener('change', () => {
    if (form.marriage_date.value) form.marriage_year.value = form.marriage_date.value.slice(0, 4);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    body.spouse_deceased = form.spouse_deceased.checked;
    try {
      await api(`/api/people/${p.id}/spouses`, { method: 'POST', body });
      dialog.close();
      done();
    } catch (err) {
      dialog.querySelector('#spouse-msg').innerHTML = notice('error', err.message);
    }
  });
}

function editField(name, label, p, type = 'text', wide = false) {
  return `<label class="${wide ? 'wide' : ''}"><span>${esc(label)}</span>
    <input type="${type}" name="${name}" value="${esc(p[name] || '')}" ${type === 'date' ? `max="${todayIso()}"` : ''} /></label>`;
}

function duplicatesSection(p) {
  if (!p.possibleDuplicates.length) return '';
  return `<section class="card">
      <h2>Possible duplicates</h2>
      <p class="hint">These records share this person's name or maiden name but could not be linked automatically because
        some details were missing or different. If one is the same person, combine it with this record.</p>
      ${p.possibleDuplicates
        .map(
          (d) => `<div class="actions" style="margin-bottom:8px">
            ${personChip(d)} <span class="muted">${esc(lifeLine(d) || 'No birth details')}</span>
            <button class="btn small secondary" type="button" data-merge="${d.id}">Same person: combine</button>
          </div>`
        )
        .join('')}
    </section>`;
}
