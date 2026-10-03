// The shared family calendar: birthdays, wedding anniversaries and events.

import { app, api, esc, notice, session, formatDate, todayIso, openDialog } from './core.js';

const TYPE_LABEL = { birthday: 'Birthday', anniversary: 'Anniversary', event: 'Event' };
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// One calendar entry as a small inline label (also used on the home page).
// With `eventLinks`, events link to their calendar month instead of opening
// in place.
export function itemHtml(item, { eventLinks = false } = {}) {
  const link =
    item.type === 'event' ? `#/calendar?month=${item.date.slice(0, 7)}` : item.people[0] ? `#/person/${item.people[0].id}` : '';
  const text = `<span class="cal-dot ${item.type}" aria-hidden="true"></span>
    <span class="cal-title">${esc(item.title)}</span>${item.detail ? ` <span class="muted">· ${esc(item.detail)}</span>` : ''}${
      item.in_memory ? ' <span class="badge memory">In memory</span>' : ''
    }`;
  if (item.type === 'event' && !eventLinks) return `<button type="button" class="cal-item event link-like" data-event="${item.event.id}">${text}</button>`;
  return `<a class="cal-item ${item.type}${item.in_memory ? ' in-memory' : ''}" href="${link}">${text}</a>`;
}

export async function renderCalendar(params) {
  document.title = 'Calendar · Family Reunion';
  const today = todayIso();
  const monthParam = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : today.slice(0, 7);
  const [year, month] = monthParam.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const gridStart = new Date(year, month - 1, 1 - first.getDay());
  const lastOfMonth = new Date(year, month, 0);
  const gridEnd = new Date(year, month - 1, lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));
  const data = await api(`/api/calendar?${new URLSearchParams({ from: iso(gridStart), to: iso(gridEnd) })}`);

  const byDate = new Map();
  for (const item of data.items) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date).push(item);
  }
  const shift = (delta) => {
    const d = new Date(year, month - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };
  const monthTitle = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const weekdays = [...Array(7)].map((_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));

  const cells = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    const date = iso(d);
    const items = byDate.get(date) || [];
    const outside = d.getMonth() !== month - 1;
    cells.push(`<div class="cal-cell${outside ? ' outside' : ''}${date === today ? ' today' : ''}" data-date="${date}">
        <button type="button" class="cal-daynum" data-add="${date}" aria-label="Add an event on ${esc(formatDate(date))}">${d.getDate()}</button>
        <div class="cal-items">${items.slice(0, 3).map(itemHtml).join('')}${items.length > 3 ? `<span class="muted cal-more">+${items.length - 3} more</span>` : ''}</div>
        <div class="cal-dots" aria-hidden="true">${items.map((i) => `<span class="cal-dot ${i.type}"></span>`).join('')}</div>
      </div>`);
  }

  const monthItems = data.items.filter((i) => i.date.slice(0, 7) === monthParam);
  app.innerHTML = `
    <div id="cal-root">
    <div class="section-head">
      <h1>Family calendar</h1>
      <button class="btn" type="button" id="add-event">Add event</button>
    </div>
    <div class="cal-toolbar">
      <div class="actions">
        <a class="btn small secondary" href="#/calendar?month=${shift(-1)}" aria-label="Previous month">‹ Prev</a>
        <a class="btn small secondary" href="#/calendar">Today</a>
        <a class="btn small secondary" href="#/calendar?month=${shift(1)}" aria-label="Next month">Next ›</a>
      </div>
      <h2 class="cal-month">${esc(monthTitle)}</h2>
      <div class="legend">
        <span><span class="cal-dot birthday"></span> Birthday</span>
        <span><span class="cal-dot anniversary"></span> Anniversary</span>
        <span><span class="cal-dot event"></span> Event</span>
      </div>
    </div>
    <div class="cal-grid card" role="grid" aria-label="${esc(monthTitle)}">
      ${weekdays.map((w) => `<div class="cal-weekday" role="columnheader">${esc(w)}</div>`).join('')}
      ${cells.join('')}
    </div>
    <section class="card" style="margin-top:20px">
      <h2>${esc(monthTitle)} at a glance</h2>
      ${
        monthItems.length
          ? `<ul class="agenda">${monthItems
              .map(
                (item) => `<li><span class="agenda-date">${esc(formatDate(item.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</span>
                  ${itemHtml(item)}</li>`
              )
              .join('')}</ul>`
          : '<p class="muted">Nothing on the calendar this month yet. Add birthdays from the family form, or add an event.</p>'
      }
    </section>
    </div>`;

  const reload = () => renderCalendar(params);
  document.getElementById('add-event').addEventListener('click', () => openEventDialog({ event_date: today }, reload));
  document.getElementById('cal-root').addEventListener('click', (event) => {
    const add = event.target.closest('[data-add]');
    if (add) return openEventDialog({ event_date: add.dataset.add }, reload);
    const ev = event.target.closest('[data-event]');
    if (ev) {
      const item = data.items.find((i) => i.type === 'event' && i.event.id === Number(ev.dataset.event));
      if (item) showEvent(item.event, reload);
    }
  });
}

function canEdit(event) {
  return session.user && (session.user.is_admin || event.created_by === session.user.id);
}

function showEvent(event, reload) {
  const dialog = openDialog(`
    <h2>${esc(event.title)}</h2>
    <p class="meta">${esc(formatDate(event.event_date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))}${
      event.event_time ? ` at ${esc(event.event_time)}` : ''
    }${event.repeats_yearly ? ' · repeats every year' : ''}</p>
    ${event.location ? `<p><strong>Where:</strong> ${esc(event.location)}</p>` : ''}
    ${event.description ? `<p class="pre-line">${esc(event.description)}</p>` : ''}
    <p class="hint">Added by ${esc(event.created_by_name || 'a former member')}</p>
    <div id="event-msg"></div>
    ${
      canEdit(event)
        ? `<div class="actions"><button class="btn small" type="button" id="edit-event">Edit</button>
           <button class="btn small danger" type="button" id="delete-event">Delete</button></div>`
        : ''
    }`);
  dialog.querySelector('#edit-event')?.addEventListener('click', () => {
    dialog.close();
    openEventDialog(event, reload);
  });
  dialog.querySelector('#delete-event')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${event.title}" from the family calendar?`)) return;
    try {
      await api(`/api/events/${event.id}`, { method: 'DELETE' });
      dialog.close();
      reload();
    } catch (err) {
      dialog.querySelector('#event-msg').innerHTML = notice('error', err.message);
    }
  });
}

function openEventDialog(event, reload) {
  const editing = Boolean(event.id);
  const dialog = openDialog(`
    <h2>${editing ? 'Edit event' : 'Add an event'}</h2>
    <form id="event-form" class="stack-sm">
      <label><span>Title <span class="req">*</span></span><input name="title" required maxlength="200" value="${esc(event.title || '')}" placeholder="e.g. Family reunion picnic" /></label>
      <div class="grid">
        <label><span>Date <span class="req">*</span></span><input type="date" name="event_date" required value="${esc(event.event_date || '')}" /></label>
        <label><span>Time</span><input type="time" name="event_time" value="${esc(event.event_time || '')}" /></label>
      </div>
      <label><span>Location</span><input name="location" maxlength="300" value="${esc(event.location || '')}" /></label>
      <label><span>Details</span><textarea name="description" rows="3">${esc(event.description || '')}</textarea></label>
      <label class="check"><input type="checkbox" name="repeats_yearly" ${event.repeats_yearly ? 'checked' : ''} /> Repeats every year</label>
      <div id="event-msg"></div>
      <div class="actions"><button class="btn" type="submit">${editing ? 'Save changes' : 'Add to calendar'}</button></div>
    </form>`);
  dialog.querySelector('#event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      title: form.title.value,
      event_date: form.event_date.value,
      event_time: form.event_time.value,
      location: form.location.value,
      description: form.description.value,
      repeats_yearly: form.repeats_yearly.checked,
    };
    try {
      await api(editing ? `/api/events/${event.id}` : '/api/events', { method: editing ? 'PATCH' : 'POST', body });
      dialog.close();
      if (!editing && body.event_date.slice(0, 7) !== (location.hash.match(/month=(\d{4}-\d{2})/)?.[1] || todayIso().slice(0, 7))) {
        location.hash = `#/calendar?month=${body.event_date.slice(0, 7)}`;
      } else reload();
    } catch (err) {
      dialog.querySelector('#event-msg').innerHTML = notice('error', err.message);
    }
  });
}
