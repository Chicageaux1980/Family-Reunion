// Family photos: upload, search, view, tag and delete. The gallery and
// upload dialog are also used on each person's profile.

import {
  app,
  api,
  esc,
  notice,
  session,
  formatDate,
  todayIso,
  uploadFile,
  checkFile,
  personPicker,
  openDialog,
  wireImageFallbacks,
  extensionOf,
  PHOTO_EXTENSIONS,
  PHOTO_ACCEPT,
  MAX_UPLOAD_MB,
} from './core.js';

const ALLOWED_LABEL = PHOTO_EXTENSIONS.filter((e) => e !== 'tif').map((e) => `.${e}`).join(', ');

export async function renderPhotos(params) {
  document.title = 'Photos · Family Reunion';
  const q = params.get('q') || '';
  app.innerHTML = `
    <div class="section-head">
      <h1>Family photos</h1>
      <button class="btn" type="button" id="upload-btn">Upload photos</button>
    </div>
    <form class="search-bar card" id="photo-search" role="search">
      <label class="visually-hidden" for="photo-q">Search photos</label>
      <input id="photo-q" type="search" name="q" value="${esc(q)}" placeholder="Search by caption, person, date, file name or who shared it…" />
      <button class="btn" type="submit">Search</button>
    </form>
    <p class="muted" id="photo-count" aria-live="polite"></p>
    <div id="photo-results"></div>`;

  const form = document.getElementById('photo-search');
  const results = document.getElementById('photo-results');
  const run = async () => {
    const query = form.q.value.trim();
    const data = await api(`/api/media?${new URLSearchParams({ kind: 'photo', q: query, limit: '200' })}`);
    document.getElementById('photo-count').textContent =
      `${data.total} photo${data.total === 1 ? '' : 's'}${query ? ' found' : ''}` + (data.total > data.results.length ? ` (showing ${data.results.length})` : '');
    results.innerHTML = data.results.length
      ? photoGrid(data.results)
      : `<p class="empty">${query ? 'No photos match that search.' : 'No photos yet. Be the first to share one!'}</p>`;
    wirePhotoGrid(results, data.results, run);
  };
  let timer;
  form.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    history.replaceState(null, '', `#/photos?${new URLSearchParams({ q: form.q.value.trim() })}`);
    run();
  });
  document.getElementById('upload-btn').addEventListener('click', () => openUploadDialog({ onDone: run }));
  await run();
}

export function photoGrid(photos) {
  return `<div class="photo-grid">${photos
    .map(
      (p) => `<button type="button" class="photo-tile" data-photo="${p.id}" aria-label="${esc(p.caption || p.original_name)}">
        ${
          p.is_image
            ? `<img src="${p.url}" alt="" loading="lazy" data-fallback="${esc(extensionOf(p.original_name))}" />`
            : '<div class="img-fallback">File</div>'
        }
        <span class="photo-caption">${esc(p.caption || p.original_name)}</span>
      </button>`
    )
    .join('')}</div>`;
}

export function wirePhotoGrid(root, photos, onChange) {
  wireImageFallbacks(root);
  root.querySelectorAll('[data-photo]').forEach((tile) =>
    tile.addEventListener('click', () => openPhoto(photos.find((p) => p.id === Number(tile.dataset.photo)), onChange))
  );
}

function openPhoto(photo, onChange) {
  const canDelete = session.user && (session.user.is_admin || photo.uploaded_by === session.user.id);
  const dialog = openDialog(
    `<div class="lightbox">
      <div class="lightbox-image">
        <img src="${photo.url}" alt="${esc(photo.caption || photo.original_name)}" data-fallback="${esc(extensionOf(photo.original_name))}" />
      </div>
      <div class="lightbox-info">
        <h2>${esc(photo.caption || photo.original_name)}</h2>
        <p class="meta">${photo.taken_date ? `Taken ${esc(formatDate(photo.taken_date))} · ` : ''}Shared by ${esc(photo.uploaded_by_name || 'a former member')}</p>
        <div class="chips">${photo.people.map((p) => `<a class="chip" href="#/person/${p.id}">${esc(p.name)}</a>`).join('') || '<span class="muted">Nobody tagged yet</span>'}</div>
        <div id="photo-msg"></div>
        <form id="photo-edit" class="stack-sm">
          <label><span>Caption</span><textarea name="caption" rows="2">${esc(photo.caption || '')}</textarea></label>
          <label><span>Date taken</span><input type="date" name="taken_date" value="${esc(photo.taken_date || '')}" max="${todayIso()}" /></label>
          <div id="photo-people"></div>
          <div class="actions">
            <button class="btn small" type="submit">Save</button>
            <a class="btn small secondary" href="${photo.url}?download=1">Download</a>
            ${canDelete ? '<button class="btn small danger" type="button" id="photo-delete">Delete</button>' : ''}
          </div>
        </form>
      </div>
    </div>`,
    { wide: true }
  );
  wireImageFallbacks(dialog);
  const picker = personPicker(dialog.querySelector('#photo-people'), {
    multiple: true,
    label: 'People in this photo',
    placeholder: 'Add a person…',
    initial: photo.people,
  });
  const msg = dialog.querySelector('#photo-msg');
  dialog.querySelector('#photo-edit').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await api(`/api/media/${photo.id}`, {
        method: 'PATCH',
        body: { caption: form.caption.value, taken_date: form.taken_date.value, people: picker.selected().map((p) => p.id) },
      });
      dialog.close();
      onChange && onChange();
    } catch (err) {
      msg.innerHTML = notice('error', err.message);
    }
  });
  dialog.querySelector('#photo-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this photo for everyone? This cannot be undone.')) return;
    try {
      await api(`/api/media/${photo.id}`, { method: 'DELETE' });
      dialog.close();
      onChange && onChange();
    } catch (err) {
      msg.innerHTML = notice('error', err.message);
    }
  });
}

// Upload one or more photos with an optional shared caption, date and tags.
export function openUploadDialog({ presetPeople = [], onDone } = {}) {
  const dialog = openDialog(`
    <h2>Upload photos</h2>
    <p class="hint">Allowed: ${ALLOWED_LABEL} · up to ${MAX_UPLOAD_MB} MB each.</p>
    <form id="upload-form" class="stack-sm">
      <label class="dropzone" id="dropzone">
        <input type="file" name="files" accept="${PHOTO_ACCEPT}" multiple class="visually-hidden" />
        <strong>Choose photos</strong> or drag them here
      </label>
      <ul class="upload-list" id="upload-list"></ul>
      <label><span>Caption <small class="muted">(applies to every photo in this upload)</small></span>
        <input name="caption" placeholder="e.g. Grandma's 80th birthday" /></label>
      <label><span>Date taken</span><input type="date" name="taken_date" max="${todayIso()}" /></label>
      <div id="upload-people"></div>
      <div id="upload-msg"></div>
      <div class="actions"><button class="btn" type="submit">Upload</button></div>
    </form>`);
  const form = dialog.querySelector('#upload-form');
  const list = dialog.querySelector('#upload-list');
  const msg = dialog.querySelector('#upload-msg');
  const picker = personPicker(dialog.querySelector('#upload-people'), {
    multiple: true,
    label: 'People in these photos',
    placeholder: 'Tag a person…',
    initial: presetPeople,
  });
  let files = [];
  const showFiles = () => {
    list.innerHTML = files
      .map((f, i) => {
        const problem = checkFile(f, PHOTO_EXTENSIONS);
        return `<li data-index="${i}" class="${problem ? 'bad' : ''}">
          <span class="file-name">${esc(f.name)}</span>
          <span class="file-status">${problem ? esc(problem) : `${(f.size / 1024 / 1024).toFixed(1)} MB`}</span>
          <progress max="1" value="0" ${problem ? 'hidden' : ''}></progress>
        </li>`;
      })
      .join('');
  };
  const addFiles = (fileList) => {
    files = [...files, ...fileList];
    showFiles();
  };
  form.files.addEventListener('change', () => addFiles(form.files.files));
  const zone = dialog.querySelector('#dropzone');
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const good = files.map((f, i) => ({ f, i })).filter(({ f }) => !checkFile(f, PHOTO_EXTENSIONS));
    if (!good.length) {
      msg.innerHTML = notice('error', files.length ? 'None of the chosen files can be uploaded.' : 'Please choose at least one photo.');
      return;
    }
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    const params = {
      kind: 'photo',
      caption: form.caption.value,
      taken_date: form.taken_date.value,
      people: picker.selected().map((p) => p.id).join(','),
    };
    let uploaded = 0;
    for (const { f, i } of good) {
      const row = list.querySelector(`[data-index="${i}"]`);
      const status = row.querySelector('.file-status');
      const bar = row.querySelector('progress');
      status.textContent = 'Uploading…';
      try {
        await uploadFile(f, params, (fraction) => (bar.value = fraction));
        bar.value = 1;
        status.textContent = 'Done';
        row.classList.add('ok');
        uploaded++;
      } catch (err) {
        status.textContent = err.message;
        row.classList.add('bad');
      }
    }
    button.disabled = false;
    if (uploaded === files.length) {
      dialog.close();
    } else {
      const skipped = files.length - uploaded;
      msg.innerHTML = notice(
        'error',
        `${uploaded} photo${uploaded === 1 ? '' : 's'} uploaded; ${skipped} file${skipped === 1 ? ' was' : 's were'} not. See the list above.`
      );
      files = [];
    }
    if (uploaded) onDone && onDone();
  });
}
