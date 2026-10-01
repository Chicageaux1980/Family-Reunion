'use strict';

// Family Reunion single-page app. Hash routes:
//   #/                     home
//   #/register             registration form
//   #/directory?q=...      searchable family directory
//   #/person/:id           a person's details, relatives and edit/merge tools
//   #/tree/:id             interactive family tree centred on a person
//   #/relationship?a=&b=   "how are we related?" finder

const app = document.getElementById('app');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function fullName(p) {
  return p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unnamed';
}

function lifeLine(p) {
  if (!p.birth_date && !p.birth_city) return '';
  return ['Born', p.birth_date && formatDate(p.birth_date), p.birth_city && `in ${p.birth_city}`].filter(Boolean).join(' ');
}

function notice(type, message) {
  return `<div class="notice ${type}" role="${type === 'error' ? 'alert' : 'status'}">${esc(message)}</div>`;
}

function personChip(p) {
  return p ? `<a class="chip" href="#/person/${p.id}">${esc(fullName(p))}</a>` : '<span class="muted">Not recorded</span>';
}

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, query = ''] = raw.split('?');
  return { parts: pathPart.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route() {
  const { parts, params } = parseHash();
  const [section, id] = parts;
  setActiveNav(section || 'home');
  app.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (!section) await renderHome();
    else if (section === 'register') renderRegister();
    else if (section === 'directory') await renderDirectory(params);
    else if (section === 'person' && id) await renderPerson(id, params);
    else if (section === 'tree' && id) await renderTree(id);
    else if (section === 'relationship') await renderRelationship(params);
    else app.innerHTML = `<h1>Page not found</h1><p><a href="#/">Go home</a></p>`;
  } catch (err) {
    app.innerHTML = notice('error', err.message) + '<p><a href="#/">Go home</a></p>';
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

async function renderHome() {
  const stats = await api('/api/stats');
  document.title = 'Family Reunion';
  app.innerHTML = `
    <div class="stack">
      <section class="hero">
        <div>
          <h1>Welcome to the Family Reunion</h1>
          <p class="lead">Add yourself, your parents and your grandparents. Whenever two relatives name the
            same ancestor, their branches are joined, so the family tree grows with every entry.</p>
          <div class="actions">
            <a class="btn" href="#/register">Join the family</a>
            <a class="btn secondary" href="#/directory">Search the family</a>
          </div>
        </div>
        <div class="card">
          <div class="stats">
            <div class="stat"><strong>${stats.people}</strong><span>people in the tree</span></div>
            <div class="stat"><strong>${stats.registered}</strong><span>members joined</span></div>
            <div class="stat"><strong>${stats.surnames}</strong><span>family names</span></div>
          </div>
        </div>
      </section>
      <section class="steps">
        <div class="card"><h3>1. Share your details</h3><p>Your contact details, birthday and birthplace,
          plus the names of your mother, father and grandparents.</p></div>
        <div class="card"><h3>2. Ancestors are linked</h3><p>A grandparent with the same name, birth date and
          birthplace as one already recorded is joined to the existing record instead of being added twice.</p></div>
        <div class="card"><h3>3. Explore the tree</h3><p>Search everyone, browse the interactive tree, and
          find out exactly how any two relatives are connected.</p></div>
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function field(name, label, { type = 'text', required = false, wide = false, autocomplete = '' } = {}) {
  return `<label class="${wide ? 'wide' : ''}">
      <span>${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</span>
      <input type="${type}" name="${name}" ${required ? 'required' : ''} ${autocomplete ? `autocomplete="${autocomplete}"` : ''} />
    </label>`;
}

function renderRegister() {
  document.title = 'Join the family · Family Reunion';
  app.innerHTML = `
    <h1>Join the family</h1>
    <p class="lead">Fill in as much as you know. Fields marked <span class="req">*</span> are required.</p>
    <div id="form-msg"></div>
    <form id="register-form" novalidate>
      <fieldset>
        <legend>About you</legend>
        <div class="grid">
          ${field('first_name', 'First name', { required: true, autocomplete: 'given-name' })}
          ${field('last_name', 'Last name', { required: true, autocomplete: 'family-name' })}
          ${field('email', 'Email address', { type: 'email', autocomplete: 'email' })}
          ${field('phone', 'Phone number', { type: 'tel', autocomplete: 'tel' })}
          ${field('home_address', 'Home address', { wide: true, autocomplete: 'street-address' })}
          ${field('birth_date', 'Birthday', { type: 'date', autocomplete: 'bday' })}
          ${field('birth_city', 'Birth city')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Your parents</legend>
        <p class="hint">Use full names. Mothers are easiest to match when everyone uses the same name, such as her maiden name.</p>
        <div class="grid">
          ${field('mother_name', "Mother's name")}
          ${field('father_name', "Father's name")}
        </div>
      </fieldset>
      <fieldset>
        <legend>Your grandparents</legend>
        <div class="radio-row" role="radiogroup" aria-label="Which side of the family are these grandparents from?">
          <span class="hint" style="margin:0">These grandparents are the parents of my:</span>
          <label><input type="radio" name="grandparent_side" value="mother" checked /> Mother</label>
          <label><input type="radio" name="grandparent_side" value="father" /> Father</label>
        </div>
        <div class="grid">
          ${field('grandmother_name', "Grandmother's name")}
          ${field('grandmother_birth_date', "Grandmother's birth date", { type: 'date' })}
          ${field('grandmother_birth_city', "Grandmother's birth city")}
        </div>
        <div class="grid" style="margin-top:14px">
          ${field('grandfather_name', "Grandfather's name")}
          ${field('grandfather_birth_date', "Grandfather's birth date", { type: 'date' })}
          ${field('grandfather_birth_city', "Grandfather's birth city")}
        </div>
      </fieldset>
      <div class="actions">
        <button class="btn" type="submit">Add me to the family tree</button>
        <a class="btn secondary" href="#/">Cancel</a>
      </div>
    </form>`;

  const form = document.getElementById('register-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const msg = document.getElementById('form-msg');
    if (!form.first_name.value.trim() || !form.last_name.value.trim()) {
      msg.innerHTML = notice('error', 'Please enter your first and last name.');
      form.first_name.focus();
      return;
    }
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      const result = await api('/api/register', { method: 'POST', body });
      sessionStorage.setItem('fr-linked', JSON.stringify(result.linked));
      location.hash = `#/person/${result.personId}?welcome=1`;
    } catch (err) {
      msg.innerHTML = notice('error', err.message);
      msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Directory / search
// ---------------------------------------------------------------------------

async function renderDirectory(params) {
  document.title = 'Search · Family Reunion';
  const q = params.get('q') || '';
  const membersOnly = params.get('registered') === '1';
  app.innerHTML = `
    <h1>Search the family</h1>
    <form class="search-bar card" id="search-form" role="search">
      <label class="visually-hidden" for="q">Search</label>
      <input id="q" type="search" name="q" value="${esc(q)}" placeholder="Name, city, email, phone, address or year…" autofocus />
      <label class="check"><input type="checkbox" name="registered" ${membersOnly ? 'checked' : ''} /> Members only</label>
      <button class="btn" type="submit">Search</button>
    </form>
    <p class="muted" id="result-count" aria-live="polite"></p>
    <div class="results" id="results"></div>`;

  const form = document.getElementById('search-form');
  const runSearch = async () => {
    const query = new URLSearchParams({ q: form.q.value.trim(), limit: '200' });
    if (form.registered.checked) query.set('registered', '1');
    const { total, results } = await api(`/api/people?${query}`);
    document.getElementById('result-count').textContent =
      `${total} ${total === 1 ? 'person' : 'people'} found` + (total > results.length ? ` (showing ${results.length})` : '');
    document.getElementById('results').innerHTML = results.length
      ? results.map(resultCard).join('')
      : '<p class="empty">Nobody matches that search yet.</p>';
  };
  let timer;
  form.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 250);
  });
  form.registered.addEventListener('change', runSearch);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = new URLSearchParams({ q: form.q.value.trim() });
    if (form.registered.checked) query.set('registered', '1');
    history.replaceState(null, '', `#/directory?${query}`);
    runSearch();
  });
  await runSearch();
}

function resultCard(p) {
  const parents = [p.mother_name && `Mother: ${p.mother_name}`, p.father_name && `Father: ${p.father_name}`].filter(Boolean);
  return `<a class="card person-card" href="#/person/${p.id}">
      <h3>${esc(fullName(p))} ${p.registered ? '<span class="badge member">Member</span>' : '<span class="badge">Ancestor</span>'}</h3>
      ${lifeLine(p) ? `<p class="meta">${esc(lifeLine(p))}</p>` : ''}
      ${p.email ? `<p class="meta">${esc(p.email)}</p>` : ''}
      ${p.phone ? `<p class="meta">${esc(p.phone)}</p>` : ''}
      ${parents.length ? `<p class="meta">${esc(parents.join(' · '))}</p>` : ''}
    </a>`;
}

// ---------------------------------------------------------------------------
// Person page
// ---------------------------------------------------------------------------

async function renderPerson(id, params) {
  const p = await api(`/api/people/${id}`);
  document.title = `${fullName(p)} · Family Reunion`;

  let welcome = '';
  if (params.get('welcome')) {
    let linked = [];
    try {
      linked = JSON.parse(sessionStorage.getItem('fr-linked') || '[]');
    } catch {}
    const roles = { self: 'You', mother: 'Mother', father: 'Father', grandmother: 'Grandmother', grandfather: 'Grandfather' };
    welcome = `<div class="notice success" role="status"><strong>Welcome to the family!</strong> You have been added to the tree.
      ${linked.length > 1 ? `Linked: ${linked.filter((l) => l.role !== 'self').map((l) => `${esc(roles[l.role] || l.role)} – <a href="#/person/${l.id}">${esc(l.name)}</a>`).join(', ')}.` : ''}</div>`;
  }

  const detailRows = [
    ['Email', p.email && `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`],
    ['Phone', p.phone && `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>`],
    ['Home address', p.home_address && esc(p.home_address)],
    ['Birthday', p.birth_date && esc(formatDate(p.birth_date))],
    ['Birth city', p.birth_city && esc(p.birth_city)],
  ].filter(([, v]) => v);

  app.innerHTML = `
    ${welcome}
    <div class="stack">
      <div>
        <h1>${esc(fullName(p))} ${p.registered ? '<span class="badge member">Member</span>' : '<span class="badge">Ancestor</span>'}</h1>
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
          ${detailRows.length ? `<dl class="details">${detailRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '<p class="muted">No details recorded yet.</p>'}
        </section>
        <section class="card relatives">
          <h3>Parents</h3>
          <div class="chips">${personChip(p.mother)} ${personChip(p.father)}</div>
          <h3>Siblings</h3>
          <div class="chips">${p.siblings.length ? p.siblings.map(personChip).join('') : '<span class="muted">None recorded</span>'}</div>
          <h3>Children</h3>
          <div class="chips">${p.children.length ? p.children.map(personChip).join('') : '<span class="muted">None recorded</span>'}</div>
        </section>
      </div>
      <section class="card" id="edit-section" hidden>
        <h2>Edit details</h2>
        <form id="edit-form">
          <div class="grid">
            ${editField('first_name', 'First name', p)}
            ${editField('last_name', 'Last name', p)}
            ${editField('email', 'Email address', p, 'email')}
            ${editField('phone', 'Phone number', p, 'tel')}
            ${editField('home_address', 'Home address', p, 'text', true)}
            ${editField('birth_date', 'Birthday', p, 'date')}
            ${editField('birth_city', 'Birth city', p)}
          </div>
          <div class="actions" style="margin-top:16px">
            <button class="btn" type="submit">Save changes</button>
            <button class="btn danger" type="button" id="delete-btn">Remove from tree</button>
          </div>
        </form>
      </section>
      ${duplicatesSection(p)}
    </div>`;

  document.getElementById('edit-toggle').addEventListener('click', () => {
    const section = document.getElementById('edit-section');
    section.hidden = !section.hidden;
    if (!section.hidden) section.scrollIntoView({ behavior: 'smooth' });
  });

  const msg = document.getElementById('person-msg');
  document.getElementById('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/people/${p.id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(event.target).entries()) });
      await renderPerson(p.id, new URLSearchParams());
      document.getElementById('person-msg').innerHTML = notice('success', 'Details saved.');
    } catch (err) {
      msg.innerHTML = notice('error', err.message);
      window.scrollTo(0, 0);
    }
  });

  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!confirm(`Remove ${fullName(p)} from the family tree? Their children will stay but lose this parent link.`)) return;
    try {
      await api(`/api/people/${p.id}`, { method: 'DELETE' });
      location.hash = '#/directory';
    } catch (err) {
      msg.innerHTML = notice('error', err.message);
    }
  });

  document.querySelectorAll('[data-merge]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm('Combine these two records into one? This cannot be undone.')) return;
      try {
        await api(`/api/people/${p.id}/merge`, { method: 'POST', body: { merge_id: Number(button.dataset.merge) } });
        await renderPerson(p.id, new URLSearchParams());
        document.getElementById('person-msg').innerHTML = notice('success', 'Records combined.');
      } catch (err) {
        msg.innerHTML = notice('error', err.message);
        window.scrollTo(0, 0);
      }
    })
  );
}

function editField(name, label, p, type = 'text', wide = false) {
  return `<label class="${wide ? 'wide' : ''}"><span>${esc(label)}</span>
    <input type="${type}" name="${name}" value="${esc(p[name] || '')}" /></label>`;
}

function duplicatesSection(p) {
  if (!p.possibleDuplicates.length) return '';
  return `<section class="card">
      <h2>Possible duplicates</h2>
      <p class="hint">These records have the same name but could not be linked automatically because some details
        were missing or different. If one is the same person, combine it with this record.</p>
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

// ---------------------------------------------------------------------------
// Family tree
// ---------------------------------------------------------------------------

const NODE_W = 176;
const NODE_H = 58;
const GAP_X = 24;
const GAP_Y = 70;
const PAD = 40;
const LABEL_W = 90;

async function renderTree(id) {
  const graph = await api(`/api/people/${id}/tree`);
  const focus = graph.people.find((p) => p.id === graph.focusId);
  document.title = `${fullName(focus)}'s family tree · Family Reunion`;

  app.innerHTML = `
    <div class="tree-toolbar">
      <div>
        <h1 style="margin-bottom:4px">${esc(fullName(focus))}'s family tree</h1>
        <p class="muted" style="margin:0">${graph.people.length} connected ${graph.people.length === 1 ? 'person' : 'people'}${graph.truncated ? ' (showing the closest relatives)' : ''}.
          Select anyone to centre the tree on them.</p>
      </div>
      <div class="actions">
        <span class="legend"><span><i></i>Member</span><span><i class="ancestor"></i>Ancestor</span></span>
        <a class="btn secondary small" href="#/person/${focus.id}">Back to profile</a>
      </div>
    </div>
    <div class="tree-wrap" id="tree-wrap">${treeSvg(graph)}</div>`;

  const wrap = document.getElementById('tree-wrap');
  wrap.querySelectorAll('.tree-node').forEach((node) => {
    const go = () => (location.hash = `#/tree/${node.dataset.id}`);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    node.addEventListener('dblclick', () => (location.hash = `#/person/${node.dataset.id}`));
  });
  const focusNode = wrap.querySelector('.tree-node.focus');
  if (focusNode) {
    const box = focusNode.getBBox();
    wrap.scrollLeft = box.x + box.width / 2 - wrap.clientWidth / 2;
    wrap.scrollTop = box.y + box.height / 2 - wrap.clientHeight / 2;
  }
}

// Lays out everyone in generation rows (parents above children) and orders
// each row to keep parents near their children, then draws it as SVG.
function treeSvg(graph) {
  const byId = new Map(graph.people.map((p) => [p.id, { ...p, children: [] }]));
  for (const p of byId.values()) {
    for (const parentId of [p.mother_id, p.father_id]) if (parentId) byId.get(parentId).children.push(p.id);
  }

  // Generation numbers relative to the focus person (parents are -1).
  const gen = new Map([[graph.focusId, 0]]);
  const queue = [graph.focusId];
  while (queue.length) {
    const p = byId.get(queue.shift());
    const g = gen.get(p.id);
    const neighbours = [
      [p.mother_id, g - 1],
      [p.father_id, g - 1],
      ...p.children.map((c) => [c, g + 1]),
    ];
    for (const [nid, ng] of neighbours) {
      if (nid && !gen.has(nid)) {
        gen.set(nid, ng);
        queue.push(nid);
      }
    }
  }

  const gens = [...new Set(gen.values())].sort((a, b) => a - b);
  const rows = new Map(gens.map((g) => [g, []]));
  for (const [pid, g] of gen) rows.get(g).push(pid);

  // Initial ordering: siblings grouped by parents, then by birth date.
  const sortKey = (pid) => {
    const p = byId.get(pid);
    return `${p.mother_id || p.father_id || 0}`.padStart(9, '0') + (p.birth_date || '9999');
  };
  for (const row of rows.values()) row.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // Barycentre sweeps: order each row by the average position of its
  // neighbours in the adjacent row, alternating downward and upward passes.
  const position = new Map();
  const index = () => rows.forEach((row) => row.forEach((pid, i) => position.set(pid, i - row.length / 2)));
  index();
  const reorder = (g, neighboursOf) => {
    const row = rows.get(g);
    const score = new Map(
      row.map((pid, i) => {
        const ns = neighboursOf(byId.get(pid)).filter((n) => n && gen.get(n) !== g && position.has(n));
        return [pid, ns.length ? ns.reduce((s, n) => s + position.get(n), 0) / ns.length : i - row.length / 2];
      })
    );
    row.sort((a, b) => score.get(a) - score.get(b));
    row.forEach((pid, i) => position.set(pid, i - row.length / 2));
  };
  for (let pass = 0; pass < 6; pass++) {
    for (const g of gens) reorder(g, (p) => [p.mother_id, p.father_id]);
    for (const g of [...gens].reverse()) reorder(g, (p) => p.children);
  }

  // Assign coordinates; each row is centred in the widest row.
  const widest = Math.max(...[...rows.values()].map((r) => r.length));
  const width = PAD * 2 + LABEL_W + widest * NODE_W + (widest - 1) * GAP_X;
  const height = PAD * 2 + gens.length * NODE_H + (gens.length - 1) * GAP_Y;
  const xy = new Map();
  gens.forEach((g, rowIndex) => {
    const row = rows.get(g);
    const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X;
    const startX = PAD + LABEL_W + (width - PAD * 2 - LABEL_W - rowWidth) / 2;
    row.forEach((pid, i) => xy.set(pid, { x: startX + i * (NODE_W + GAP_X), y: PAD + rowIndex * (NODE_H + GAP_Y) }));
  });

  const edges = [];
  for (const p of byId.values()) {
    for (const [parentId, kind] of [
      [p.mother_id, 'mother'],
      [p.father_id, 'father'],
    ]) {
      if (!parentId) continue;
      const from = xy.get(parentId);
      const to = xy.get(p.id);
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y;
      const mid = (y1 + y2) / 2;
      edges.push(`<path class="tree-edge ${kind}" d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}" />`);
    }
  }

  const labels = gens.map((g, rowIndex) => {
    const y = PAD + rowIndex * (NODE_H + GAP_Y) + NODE_H / 2 + 4;
    return `<text class="gen-label" x="${PAD}" y="${y}">${esc(generationLabel(g))}</text>`;
  });

  const nodes = [...byId.values()].map((p) => {
    const { x, y } = xy.get(p.id);
    const name = truncate(fullName(p), 22);
    const sub = truncate([p.birth_date && p.birth_date.slice(0, 4), p.birth_city].filter(Boolean).join(' · '), 28);
    const cls = ['tree-node', p.registered ? 'member' : '', p.id === graph.focusId ? 'focus' : ''].join(' ');
    return `<g class="${cls}" data-id="${p.id}" tabindex="0" role="link" aria-label="${esc(fullName(p))}">
        <title>${esc(fullName(p))}${lifeLine(p) ? ` — ${esc(lifeLine(p))}` : ''} (double-click for profile)</title>
        <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" />
        <text class="name" x="${x + NODE_W / 2}" y="${y + (sub ? 24 : 33)}" text-anchor="middle">${esc(name)}</text>
        ${sub ? `<text class="sub" x="${x + NODE_W / 2}" y="${y + 42}" text-anchor="middle">${esc(sub)}</text>` : ''}
      </g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Family tree">
      ${labels.join('')}${edges.join('')}${nodes.join('')}
    </svg>`;
}

function generationLabel(g) {
  if (g === 0) return 'This gen.';
  const up = ['', 'Parents', 'Grandparents', 'Great-GP'];
  const down = ['', 'Children', 'Grandchildren', 'Great-GC'];
  if (g < 0) return up[-g] || `${-g - 2}x Great-GP`;
  return down[g] || `${g - 2}x Great-GC`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Relationship finder
// ---------------------------------------------------------------------------

async function renderRelationship(params) {
  document.title = 'How are we related? · Family Reunion';
  const preset = {};
  for (const key of ['a', 'b']) {
    if (params.get(key)) {
      try {
        const p = await api(`/api/people/${params.get(key)}`);
        preset[key] = { id: p.id, name: fullName(p) };
      } catch {}
    }
  }
  app.innerHTML = `
    <h1>How are we related?</h1>
    <p class="lead">Choose two people to find their closest common ancestors and what that makes them to each other.</p>
    <form class="card stack" id="rel-form">
      <div class="grid">
        ${pickerField('a', 'First person', preset.a)}
        ${pickerField('b', 'Second person', preset.b)}
      </div>
      <div class="actions"><button class="btn" type="submit">Find relationship</button></div>
    </form>
    <div id="rel-result" style="margin-top:20px" aria-live="polite"></div>`;

  const selected = { a: preset.a || null, b: preset.b || null };
  for (const key of ['a', 'b']) setupPicker(key, selected);

  const show = async () => {
    const out = document.getElementById('rel-result');
    if (!selected.a || !selected.b) {
      out.innerHTML = notice('error', 'Please choose two people from the suggestions.');
      return;
    }
    history.replaceState(null, '', `#/relationship?a=${selected.a.id}&b=${selected.b.id}`);
    const r = await api(`/api/relationship?a=${selected.a.id}&b=${selected.b.id}`);
    out.innerHTML = `<section class="card">
        <p class="result-big">${esc(r.description)}</p>
        ${
          r.commonAncestors.length
            ? `<p class="muted">Closest common ${r.commonAncestors.length === 1 ? 'ancestor' : 'ancestors'}:</p>
               <div class="chips">${r.commonAncestors.map(personChip).join('')}</div>
               <p class="muted">${esc(r.a.name)} is ${generationsText(r.generationsFromA)} below them;
                 ${esc(r.b.name)} is ${generationsText(r.generationsFromB)} below them.</p>`
            : '<p class="muted">Adding more parents and grandparents may connect these branches.</p>'
        }
        <div class="actions"><a class="btn secondary small" href="#/tree/${r.a.id}">View tree</a></div>
      </section>`;
  };
  document.getElementById('rel-form').addEventListener('submit', (event) => {
    event.preventDefault();
    show().catch((err) => (document.getElementById('rel-result').innerHTML = notice('error', err.message)));
  });
  if (selected.a && selected.b) await show();
}

function generationsText(n) {
  if (n === 0) return 'the ancestor';
  return `${n} generation${n === 1 ? '' : 's'}`;
}

function pickerField(key, label, preset) {
  return `<div class="picker">
      <label><span>${esc(label)}</span>
        <input type="search" id="pick-${key}" autocomplete="off" placeholder="Start typing a name…"
          value="${esc(preset ? preset.name : '')}" role="combobox" aria-expanded="false" aria-controls="pick-${key}-list" />
      </label>
      <ul class="picker-list" id="pick-${key}-list" role="listbox" hidden></ul>
    </div>`;
}

function setupPicker(key, selected) {
  const input = document.getElementById(`pick-${key}`);
  const list = document.getElementById(`pick-${key}-list`);
  let timer;
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  input.addEventListener('input', () => {
    selected[key] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return close();
    timer = setTimeout(async () => {
      const { results } = await api(`/api/people?${new URLSearchParams({ q, limit: '8' })}`);
      list.innerHTML = results.length
        ? results
            .map(
              (p) => `<li role="option"><button type="button" data-id="${p.id}" data-name="${esc(fullName(p))}">
                ${esc(fullName(p))}<small>${esc(lifeLine(p) || (p.registered ? 'Member' : 'Ancestor'))}</small></button></li>`
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
    selected[key] = { id: Number(button.dataset.id), name: button.dataset.name };
    input.value = button.dataset.name;
    close();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowDown' && !list.hidden) {
      event.preventDefault();
      list.querySelector('button')?.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.picker') || !list.parentElement.contains(event.target)) close();
  });
}
