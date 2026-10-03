// Shared helpers for every page of the Family Reunion app.

export const app = document.getElementById('app');

// The signed-in account (set by main.js once sign-in is complete).
export const session = { user: null };

export const PHOTO_EXTENSIONS = ['jpeg', 'jpg', 'gif', 'tiff', 'tif', 'webp', 'bmp', 'png'];
export const OBITUARY_EXTENSIONS = ['pdf', 'doc', 'docx', 'rtf', 'txt', ...PHOTO_EXTENSIONS];
export const PHOTO_ACCEPT = PHOTO_EXTENSIONS.map((e) => `.${e}`).join(',');
export const OBITUARY_ACCEPT = OBITUARY_EXTENSIONS.map((e) => `.${e}`).join(',');
export const MAX_UPLOAD_MB = 30;

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = {};
  if (method !== 'GET') headers['X-Requested-With'] = 'FamilyReunion';
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

// Checks a file before uploading; returns an error message or ''.
export function checkFile(file, allowed) {
  if (!allowed.includes(extensionOf(file.name))) {
    return `"${file.name}" is not an allowed file type. Allowed: ${allowed.filter((e) => e !== 'tif').map((e) => `.${e}`).join(', ')}.`;
  }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `"${file.name}" is larger than ${MAX_UPLOAD_MB} MB.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  return '';
}

// Uploads one file to the media store, reporting progress (0-1).
export function uploadFile(file, params, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/media?${new URLSearchParams({ ...params, filename: file.name })}`);
    xhr.setRequestHeader('X-Requested-With', 'FamilyReunion');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status})`, xhr.status, data));
    };
    xhr.onerror = () => reject(new Error(`Uploading "${file.name}" failed. Check your connection and try again.`));
    xhr.send(file);
  });
}

export function formatDate(iso, options = { year: 'numeric', month: 'long', day: 'numeric' }) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

export function fullName(p) {
  return p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unnamed';
}

export function lifeLine(p) {
  if (!p.birth_date && !p.birth_city) return '';
  return ['Born', p.birth_date && formatDate(p.birth_date), p.birth_city && `in ${p.birth_city}`].filter(Boolean).join(' ');
}

// "1930 – 2015", "b. 1990", or "" when nothing is known.
export function lifeSpan(p) {
  const born = p.birth_date ? p.birth_date.slice(0, 4) : '';
  if (p.deceased) return `${born || '?'} – ${p.death_date ? p.death_date.slice(0, 4) : '?'}`;
  return born ? `b. ${born}` : '';
}

export function marriageLine(m) {
  const when = m.marriage_date ? formatDate(m.marriage_date) : m.marriage_year ? String(m.marriage_year) : '';
  const parts = [when && `Married ${when}`, m.marriage_city && `in ${m.marriage_city}`].filter(Boolean);
  return parts.join(' ');
}

export function notice(type, message) {
  return `<div class="notice ${type}" role="${type === 'error' ? 'alert' : 'status'}">${esc(message)}</div>`;
}

export function personChip(p) {
  if (!p) return '<span class="muted">Not recorded</span>';
  return `<a class="chip${p.deceased ? ' in-memory' : ''}" href="#/person/${p.id}">${esc(fullName(p))}</a>`;
}

export function statusBadges(p) {
  return [
    p.registered ? '<span class="badge member">Member</span>' : '<span class="badge">Relative</span>',
    p.deceased ? '<span class="badge memory">In memory</span>' : '',
  ].join(' ');
}

export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function copyText(text, button) {
  navigator.clipboard?.writeText(text).then(
    () => {
      if (!button) return;
      const label = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(() => (button.textContent = label), 1500);
    },
    () => window.prompt('Copy this:', text)
  );
}

// Makes images that a browser can't display (such as TIFF in most browsers)
// fall back to a labelled placeholder.
export function wireImageFallbacks(root = document) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const box = document.createElement('div');
        box.className = 'img-fallback';
        box.textContent = `${img.dataset.fallback.toUpperCase()} file — preview not supported in this browser`;
        img.replaceWith(box);
      },
      { once: true }
    );
  });
}

// Search-as-you-type person picker. With `multiple`, chosen people show as
// removable chips. Returns { selected() }.
export function personPicker(root, { multiple = false, initial = [], placeholder = 'Start typing a name…', label = '', onChange } = {}) {
  const id = `picker-${Math.random().toString(36).slice(2, 9)}`;
  let chosen = [...initial];
  root.classList.add('picker');
  root.innerHTML = `
    <label><span>${esc(label)}</span>
      <input type="search" autocomplete="off" placeholder="${esc(placeholder)}" role="combobox"
        aria-expanded="false" aria-controls="${id}" />
    </label>
    <ul class="picker-list" id="${id}" role="listbox" hidden></ul>
    ${multiple ? '<div class="chips picker-chips"></div>' : ''}`;
  const input = root.querySelector('input');
  const list = root.querySelector('.picker-list');
  const chips = root.querySelector('.picker-chips');

  const changed = () => onChange && onChange(chosen);
  const renderChips = () => {
    if (!chips) return;
    chips.innerHTML = chosen
      .map((p) => `<span class="chip removable">${esc(p.name)} <button type="button" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></span>`)
      .join('');
  };
  if (!multiple && chosen[0]) input.value = chosen[0].name;
  renderChips();

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  let timer;
  input.addEventListener('input', () => {
    if (!multiple) {
      chosen = [];
      changed();
    }
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return close();
    timer = setTimeout(async () => {
      const { results } = await api(`/api/people?${new URLSearchParams({ q, limit: '8' })}`);
      const options = results.filter((p) => !chosen.some((c) => c.id === p.id));
      list.innerHTML = options.length
        ? options
            .map(
              (p) => `<li role="option"><button type="button" data-id="${p.id}" data-name="${esc(fullName(p))}">
                ${esc(fullName(p))}<small>${esc(lifeLine(p) || (p.registered ? 'Member' : 'Relative'))}</small></button></li>`
            )
            .join('')
        : '<li class="muted" style="padding:8px 10px">No matches</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }, 200);
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const person = { id: Number(button.dataset.id), name: button.dataset.name };
    if (multiple) {
      chosen.push(person);
      input.value = '';
      renderChips();
    } else {
      chosen = [person];
      input.value = person.name;
    }
    close();
    changed();
    input.focus();
  });
  chips?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-remove]');
    if (!button) return;
    chosen = chosen.filter((p) => p.id !== Number(button.dataset.remove));
    renderChips();
    changed();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowDown' && !list.hidden) {
      event.preventDefault();
      list.querySelector('button')?.focus();
    }
  });
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget)) setTimeout(close, 150);
  });
  return { selected: () => [...chosen] };
}

// Opens a modal dialog with the given HTML; returns the <dialog> element.
// The dialog is removed from the page when closed.
export function openDialog(html, { wide = false } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = `modal${wide ? ' wide' : ''}`;
  dialog.innerHTML = `<button type="button" class="modal-close" aria-label="Close">×</button>${html}`;
  document.body.appendChild(dialog);
  dialog.querySelector('.modal-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  return dialog;
}

// Deceased checkbox + date of death (+ optional obituary file) block used on
// forms. Field names are `${prefix}deceased` / `${prefix}death_date`.
export function lifeStatusFields(prefix, { obituaryRole = '', person = {} } = {}) {
  return `<div class="life-status">
      <label class="check"><input type="checkbox" name="${prefix}deceased" ${person.deceased ? 'checked' : ''} /> Deceased</label>
      <div class="death-fields grid" ${person.deceased ? '' : 'hidden'}>
        <label><span>Date of death</span><input type="date" name="${prefix}death_date" value="${esc(person.death_date || '')}" max="${todayIso()}" /></label>
        ${
          obituaryRole
            ? `<label><span>Upload obituary <small class="muted">(optional)</small></span>
                 <input type="file" data-obituary="${esc(obituaryRole)}" accept="${OBITUARY_ACCEPT}" /></label>`
            : ''
        }
      </div>
    </div>`;
}

export function wireLifeStatus(root) {
  root.addEventListener('change', (event) => {
    const box = event.target.closest('.life-status input[type=checkbox]');
    if (!box) return;
    const fields = box.closest('.life-status').querySelector('.death-fields');
    fields.hidden = !box.checked;
    if (!box.checked) fields.querySelectorAll('input').forEach((i) => (i.value = ''));
  });
}
