import { app, api, esc, fullName, lifeLine, lifeSpan, statusBadges } from './core.js';

export async function renderDirectory(params) {
  document.title = 'Search · Family Reunion';
  const q = params.get('q') || '';
  const membersOnly = params.get('registered') === '1';
  app.innerHTML = `
    <h1>Search the family</h1>
    <form class="search-bar card" id="search-form" role="search">
      <label class="visually-hidden" for="q">Search</label>
      <input id="q" type="search" name="q" value="${esc(q)}" placeholder="Name, maiden name, city, email, phone, address or year…" />
      <label class="check"><input type="checkbox" name="registered" ${membersOnly ? 'checked' : ''} /> Profiles entered by members</label>
      <button class="btn" type="submit">Search</button>
    </form>
    <p class="muted" id="result-count" aria-live="polite"></p>
    <div class="results" id="results"></div>`;

  const form = document.getElementById('search-form');
  form.q.focus();
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
      <h3>${esc(fullName(p))} ${statusBadges(p)}</h3>
      ${p.maiden_name ? `<p class="meta">Maiden name: ${esc(p.maiden_name)}</p>` : ''}
      ${lifeLine(p) ? `<p class="meta">${esc(lifeLine(p))}</p>` : ''}
      ${p.deceased ? `<p class="meta">${esc(lifeSpan(p))}</p>` : ''}
      ${p.email ? `<p class="meta">${esc(p.email)}</p>` : ''}
      ${p.phone ? `<p class="meta">${esc(p.phone)}</p>` : ''}
      ${parents.length ? `<p class="meta">${esc(parents.join(' · '))}</p>` : ''}
    </a>`;
}
