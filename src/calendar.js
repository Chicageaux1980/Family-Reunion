'use strict';

// The shared family calendar: everyone's birthdays, wedding anniversaries and
// events that members add. Every signed-in member sees the same calendar.

const { ValidationError, NotFoundError, AuthError, clean, cleanMultiline, cleanDate, cleanTime, truthy, isRealDate } = require('./util');

const MAX_RANGE_DAYS = 400;
const TYPE_ORDER = { event: 0, birthday: 1, anniversary: 2 };

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// The date a yearly occasion falls on in `year`; Feb 29 is observed on Feb 28
// in other years.
function occurrence(isoDate, year) {
  let monthDay = isoDate.slice(5);
  if (monthDay === '02-29' && !isLeap(year)) monthDay = '02-28';
  return `${year}-${monthDay}`;
}

function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

const possessive = (name) => `${name}'s`;
const personName = (p) => `${p.first_name || ''} ${p.last_name || ''}`.trim();

class CalendarService {
  constructor(db) {
    this.db = db;
  }

  // All occasions between `from` and `to` (inclusive, YYYY-MM-DD).
  range(from, to) {
    if (!from || !to || !isRealDate(from) || !isRealDate(to)) throw new ValidationError('Please give a valid date range.');
    if (to < from) throw new ValidationError('The end of the range is before the start.');
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days > MAX_RANGE_DAYS) throw new ValidationError(`Please ask for at most ${MAX_RANGE_DAYS} days at a time.`);

    const fromYear = Number(from.slice(0, 4));
    const toYear = Number(to.slice(0, 4));
    const inRange = (date) => date >= from && date <= to;
    const items = [];

    for (const p of this.db.prepare('SELECT * FROM people WHERE birth_date IS NOT NULL').all()) {
      const birthYear = Number(p.birth_date.slice(0, 4));
      for (let year = Math.max(fromYear, birthYear); year <= toYear; year++) {
        const date = occurrence(p.birth_date, year);
        if (!inRange(date)) continue;
        const age = year - birthYear;
        const name = personName(p);
        items.push({
          date,
          type: 'birthday',
          title: age === 0 ? `${name} was born` : `${possessive(name)} birthday`,
          detail: age === 0 ? '' : p.deceased ? `Would have been ${age}` : `Turns ${age}`,
          in_memory: Boolean(p.deceased),
          people: [{ id: p.id, name }],
        });
      }
    }

    const marriages = this.db
      .prepare(
        `SELECT m.*, a.first_name AS a_first, a.last_name AS a_last, a.deceased AS a_deceased,
                b.first_name AS b_first, b.last_name AS b_last, b.deceased AS b_deceased
           FROM marriages m
           JOIN people a ON a.id = m.person1_id
           JOIN people b ON b.id = m.person2_id
          WHERE m.marriage_date IS NOT NULL`
      )
      .all();
    for (const m of marriages) {
      const weddingYear = Number(m.marriage_date.slice(0, 4));
      const a = { id: m.person1_id, name: personName({ first_name: m.a_first, last_name: m.a_last }) };
      const b = { id: m.person2_id, name: personName({ first_name: m.b_first, last_name: m.b_last }) };
      for (let year = Math.max(fromYear, weddingYear); year <= toYear; year++) {
        const date = occurrence(m.marriage_date, year);
        if (!inRange(date)) continue;
        const years = year - weddingYear;
        items.push({
          date,
          type: 'anniversary',
          title: years === 0 ? `${a.name} & ${b.name} were married` : `${a.name} & ${b.name}'s ${ordinalSuffix(years)} anniversary`,
          detail: m.marriage_city ? `Married in ${m.marriage_city}` : '',
          in_memory: Boolean(m.a_deceased || m.b_deceased),
          people: [a, b],
        });
      }
    }

    const events = this.db
      .prepare(
        `SELECT e.*, u.display_name AS created_by_name FROM events e LEFT JOIN users u ON u.id = e.created_by
          WHERE (repeats_yearly = 0 AND event_date BETWEEN ? AND ?) OR (repeats_yearly = 1 AND event_date <= ?)`
      )
      .all(from, to, to);
    for (const e of events) {
      const dates = [];
      if (!e.repeats_yearly) dates.push(e.event_date);
      else {
        for (let year = Math.max(fromYear, Number(e.event_date.slice(0, 4))); year <= toYear; year++) {
          const date = occurrence(e.event_date, year);
          if (inRange(date)) dates.push(date);
        }
      }
      for (const date of dates) {
        items.push({
          date,
          type: 'event',
          title: e.title,
          detail: [e.event_time, e.location].filter(Boolean).join(' · '),
          event: this.publicEvent(e),
          people: [],
        });
      }
    }

    items.sort(
      (x, y) =>
        x.date.localeCompare(y.date) ||
        TYPE_ORDER[x.type] - TYPE_ORDER[y.type] ||
        (x.event?.event_time || '').localeCompare(y.event?.event_time || '') ||
        x.title.localeCompare(y.title)
    );
    return { from, to, items };
  }

  upcoming(days = 30, today = new Date().toISOString().slice(0, 10)) {
    const end = new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
    return this.range(today, end);
  }

  publicEvent(e) {
    return {
      id: e.id,
      title: e.title,
      event_date: e.event_date,
      event_time: e.event_time,
      location: e.location,
      description: e.description,
      repeats_yearly: Boolean(e.repeats_yearly),
      created_by: e.created_by,
      created_by_name: e.created_by_name || null,
    };
  }

  getEvent(id) {
    const row = this.db
      .prepare('SELECT e.*, u.display_name AS created_by_name FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?')
      .get(Number(id));
    if (!row) throw new NotFoundError('That event was not found.');
    return this.publicEvent(row);
  }

  parseEvent(data, existing = {}) {
    const merged = { ...existing, ...data };
    const title = clean(merged.title, 200);
    if (!title) throw new ValidationError('Please give the event a title.');
    const eventDate = cleanDate(merged.event_date, 'event date');
    if (!eventDate) throw new ValidationError('Please choose a date for the event.');
    return {
      title,
      event_date: eventDate,
      event_time: cleanTime(merged.event_time),
      location: clean(merged.location, 300),
      description: cleanMultiline(merged.description, 4000),
      repeats_yearly: truthy(merged.repeats_yearly) ? 1 : 0,
    };
  }

  createEvent(user, data) {
    const e = this.parseEvent(data);
    const result = this.db
      .prepare(
        `INSERT INTO events (title, event_date, event_time, location, description, repeats_yearly, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(e.title, e.event_date, e.event_time, e.location, e.description, e.repeats_yearly, user.id);
    return this.getEvent(Number(result.lastInsertRowid));
  }

  checkOwner(user, event) {
    if (!user.is_admin && event.created_by !== user.id) {
      throw new AuthError('Only the person who added this event, or an administrator, can change it.', 403);
    }
  }

  updateEvent(user, id, data) {
    const existing = this.getEvent(id);
    this.checkOwner(user, existing);
    const e = this.parseEvent(data, existing);
    this.db
      .prepare(
        `UPDATE events SET title = ?, event_date = ?, event_time = ?, location = ?, description = ?, repeats_yearly = ?,
                           updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
      .run(e.title, e.event_date, e.event_time, e.location, e.description, e.repeats_yearly, existing.id);
    return this.getEvent(existing.id);
  }

  deleteEvent(user, id) {
    const existing = this.getEvent(id);
    this.checkOwner(user, existing);
    this.db.prepare('DELETE FROM events WHERE id = ?').run(existing.id);
  }
}

module.exports = { CalendarService, occurrence, ordinalSuffix };
