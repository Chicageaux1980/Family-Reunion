// "Add family" form: you, your parents, grandparents, spouse and siblings.

import {
  app,
  api,
  esc,
  notice,
  todayIso,
  uploadFile,
  checkFile,
  lifeStatusFields,
  wireLifeStatus,
  OBITUARY_EXTENSIONS,
} from './core.js';

function field(name, label, { type = 'text', required = false, wide = false, autocomplete = '', hint = '', extra = '' } = {}) {
  return `<label class="${wide ? 'wide' : ''}">
      <span>${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}${hint ? ` <small class="muted">${esc(hint)}</small>` : ''}</span>
      <input type="${type}" name="${name}" ${required ? 'required' : ''} ${autocomplete ? `autocomplete="${autocomplete}"` : ''}
        ${type === 'date' ? `max="${todayIso()}"` : ''} ${extra} />
    </label>`;
}

function personBlock(title, prefix, fields, obituaryRole) {
  return `<div class="person-block">
      <h3>${esc(title)}</h3>
      <div class="grid">${fields}</div>
      ${lifeStatusFields(prefix, { obituaryRole })}
    </div>`;
}

let siblingCounter = 0;

function siblingRow() {
  const n = siblingCounter++;
  return `<div class="sibling-row person-block" data-sibling="${n}">
      <div class="section-head">
        <h3>Sibling</h3>
        <button type="button" class="btn small secondary" data-remove-sibling>Remove</button>
      </div>
      <div class="grid">
        ${field(`s${n}_first_name`, 'First name')}
        ${field(`s${n}_last_name`, 'Last name')}
        ${field(`s${n}_mother_maiden_name`, "Mother's maiden name", { hint: '(blank = same as yours)' })}
        ${field(`s${n}_father_name`, "Father's name", { hint: '(blank = same as yours)' })}
        ${field(`s${n}_birth_date`, 'Birth date', { type: 'date' })}
      </div>
      ${lifeStatusFields(`s${n}_`, { obituaryRole: `sibling-row:${n}` })}
    </div>`;
}

export function renderRegister() {
  document.title = 'Add family · Family Reunion';
  siblingCounter = 0;
  app.innerHTML = `
    <h1>Add your family</h1>
    <p class="lead">Fill in as much as you know. Fields marked <span class="req">*</span> are required.
      Relatives already in the tree are matched automatically.</p>
    <div id="form-msg"></div>
    <form id="register-form" novalidate>
      <fieldset>
        <legend>About you</legend>
        <div class="grid">
          ${field('first_name', 'First name', { required: true, autocomplete: 'given-name' })}
          ${field('last_name', 'Last name', { required: true, autocomplete: 'family-name' })}
          ${field('maiden_name', 'Maiden name', { hint: '(if different)' })}
          ${field('email', 'Email address', { type: 'email', autocomplete: 'email' })}
          ${field('phone', 'Phone number', { type: 'tel', autocomplete: 'tel' })}
          ${field('home_address', 'Home address', { wide: true, autocomplete: 'street-address' })}
          ${field('birth_date', 'Birthday', { type: 'date', autocomplete: 'bday' })}
          ${field('birth_city', 'Birth city')}
        </div>
        ${lifeStatusFields('', { obituaryRole: 'self' })}
      </fieldset>

      <fieldset>
        <legend>Your parents</legend>
        <p class="hint">Use full names. Adding your mother's maiden name helps link her to relatives who know her by it.</p>
        ${personBlock(
          'Mother',
          'mother_',
          field('mother_name', "Mother's name") + field('mother_maiden_name', "Mother's maiden name"),
          'mother'
        )}
        ${personBlock('Father', 'father_', field('father_name', "Father's name"), 'father')}
      </fieldset>

      <fieldset>
        <legend>Your grandparents</legend>
        <div class="radio-row" role="radiogroup" aria-label="Which side of the family are these grandparents from?">
          <span class="hint" style="margin:0">These grandparents are the parents of my:</span>
          <label><input type="radio" name="grandparent_side" value="mother" checked /> Mother</label>
          <label><input type="radio" name="grandparent_side" value="father" /> Father</label>
        </div>
        ${personBlock(
          'Grandmother',
          'grandmother_',
          field('grandmother_name', "Grandmother's name") +
            field('grandmother_birth_date', "Grandmother's birth date", { type: 'date' }) +
            field('grandmother_birth_city', "Grandmother's birth city"),
          'grandmother'
        )}
        ${personBlock(
          'Grandfather',
          'grandfather_',
          field('grandfather_name', "Grandfather's name") +
            field('grandfather_birth_date', "Grandfather's birth date", { type: 'date' }) +
            field('grandfather_birth_city', "Grandfather's birth city"),
          'grandfather'
        )}
      </fieldset>

      <fieldset>
        <legend>Your spouse</legend>
        ${personBlock(
          'Spouse',
          'spouse_',
          field('spouse_name', "Spouse's name") +
            field('spouse_maiden_name', "Spouse's maiden name") +
            field('marriage_year', 'Year married', { type: 'number', extra: `min="1800" max="${new Date().getFullYear()}" inputmode="numeric"` }) +
            field('marriage_date', 'Date married', { type: 'date' }) +
            field('marriage_city', 'City married'),
          'spouse'
        )}
      </fieldset>

      <fieldset>
        <legend>Your siblings</legend>
        <p class="hint">Leave a sibling's parents blank if they are the same as yours.</p>
        <div id="siblings">${siblingRow()}</div>
        <button type="button" class="btn secondary small" id="add-sibling">+ Add another sibling</button>
      </fieldset>

      <div class="actions">
        <button class="btn" type="submit">Add to the family tree</button>
        <a class="btn secondary" href="#/">Cancel</a>
        <span class="muted" id="submit-status" aria-live="polite"></span>
      </div>
    </form>`;

  const form = document.getElementById('register-form');
  const siblings = document.getElementById('siblings');
  wireLifeStatus(form);

  // Year married follows the date married.
  form.marriage_date.addEventListener('change', () => {
    if (form.marriage_date.value) form.marriage_year.value = form.marriage_date.value.slice(0, 4);
  });

  document.getElementById('add-sibling').addEventListener('click', () => {
    siblings.insertAdjacentHTML('beforeend', siblingRow());
    siblings.lastElementChild.querySelector('input').focus();
  });
  siblings.addEventListener('click', (event) => {
    if (event.target.closest('[data-remove-sibling]')) event.target.closest('.sibling-row').remove();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const msg = document.getElementById('form-msg');
    const status = document.getElementById('submit-status');
    const showError = (message) => {
      msg.innerHTML = notice('error', message);
      msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    if (!form.first_name.value.trim() || !form.last_name.value.trim()) {
      showError('Please enter your first and last name.');
      form.first_name.focus();
      return;
    }

    // Obituary files chosen for anyone marked deceased, keyed by form role.
    const obituaries = [];
    for (const input of form.querySelectorAll('input[data-obituary]')) {
      const file = input.files[0];
      if (!file || input.closest('.death-fields').hidden) continue;
      const problem = checkFile(file, OBITUARY_EXTENSIONS);
      if (problem) return showError(problem);
      obituaries.push({ role: input.dataset.obituary, file });
    }

    const body = {};
    for (const [key, value] of new FormData(form).entries()) {
      if (!/^s\d+_/.test(key) && typeof value === 'string') body[key] = value;
    }
    // Siblings go in a list; remember which list position each form row has.
    const rowIndex = {};
    body.siblings = [...siblings.querySelectorAll('.sibling-row')]
      .map((row) => {
        const n = row.dataset.sibling;
        const get = (name) => row.querySelector(`[name="s${n}_${name}"]`)?.value || '';
        return {
          n,
          first_name: get('first_name'),
          last_name: get('last_name'),
          mother_maiden_name: get('mother_maiden_name'),
          father_name: get('father_name'),
          birth_date: get('birth_date'),
          deceased: row.querySelector(`[name="s${n}_deceased"]`).checked,
          death_date: get('death_date'),
        };
      })
      .filter((s) => s.first_name || s.last_name || s.birth_date || s.mother_maiden_name || s.father_name)
      .map((s, index) => {
        rowIndex[s.n] = index;
        const { n, ...rest } = s;
        return rest;
      });

    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    status.textContent = 'Saving…';
    try {
      const result = await api('/api/register', { method: 'POST', body });
      const idFor = (role) => {
        const key = role.startsWith('sibling-row:') ? `sibling:${rowIndex[role.split(':')[1]]}` : role;
        return result.linked.find((l) => l.role === key)?.id;
      };
      const failures = [];
      for (const [i, { role, file }] of obituaries.entries()) {
        const personId = idFor(role);
        if (!personId) continue;
        status.textContent = `Uploading obituary ${i + 1} of ${obituaries.length}…`;
        try {
          await uploadFile(file, { kind: 'obituary', person_id: personId });
        } catch (err) {
          failures.push(err.message);
        }
      }
      sessionStorage.setItem('fr-linked', JSON.stringify(result.linked));
      if (failures.length) sessionStorage.setItem('fr-upload-errors', JSON.stringify(failures));
      location.hash = `#/person/${result.personId}?welcome=1`;
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
      status.textContent = '';
    }
  });
}
