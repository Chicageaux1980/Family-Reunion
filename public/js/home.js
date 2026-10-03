import { app, api, esc, session, formatDate, todayIso } from './core.js';
import { itemHtml } from './calendar.js';

export async function renderHome() {
  const [stats, upcoming] = await Promise.all([api('/api/stats'), api('/api/calendar/upcoming?days=45')]);
  document.title = 'Family Reunion';
  const firstName = (session.user?.display_name || '').split(' ')[0];
  const today = todayIso();
  const soon = upcoming.items.slice(0, 6);
  app.innerHTML = `
    <div class="stack">
      <section class="hero">
        <div>
          <h1>Welcome${firstName ? `, ${esc(firstName)}` : ''}!</h1>
          <p class="lead">Add yourself and your relatives. Whenever two relatives name the same ancestor,
            their branches are joined, so the family tree grows with every entry.</p>
          <div class="actions">
            <a class="btn" href="#/register">Add your family</a>
            ${session.user?.person_id ? `<a class="btn secondary" href="#/tree/${session.user.person_id}">My family tree</a>` : ''}
            <a class="btn secondary" href="#/directory">Search the family</a>
          </div>
        </div>
        <div class="card">
          <div class="stats">
            <div class="stat"><strong>${stats.people}</strong><span>people in the tree</span></div>
            <div class="stat"><strong>${stats.registered}</strong><span>profiles entered</span></div>
            <div class="stat"><strong>${stats.photos}</strong><span>photos shared</span></div>
          </div>
        </div>
      </section>
      <section class="card">
        <div class="section-head">
          <h2>Coming up</h2>
          <a class="btn small secondary" href="#/calendar">Open calendar</a>
        </div>
        ${
          soon.length
            ? `<ul class="agenda">${soon
                .map(
                  (item) => `<li><span class="agenda-date">${item.date === today ? 'Today' : esc(formatDate(item.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</span>
                    ${itemHtml(item, { eventLinks: true })}</li>`
                )
                .join('')}</ul>`
            : '<p class="muted">No birthdays, anniversaries or events in the next few weeks.</p>'
        }
      </section>
      <section class="steps">
        <div class="card"><h3>Share your details</h3><p>Your contact details, birthday and birthplace,
          plus your parents, grandparents, spouse and siblings.</p></div>
        <div class="card"><h3>Remember together</h3><p>Upload family photos, add obituaries for loved ones
          who have passed, and keep every birthday and anniversary on the shared calendar.</p></div>
        <div class="card"><h3>Explore the tree</h3><p>Search everyone, browse the interactive tree, and
          find out exactly how any two relatives are connected.</p></div>
      </section>
    </div>`;
}
