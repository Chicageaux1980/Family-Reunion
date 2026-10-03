'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FamilyStore } = require('../src/store');
const { CalendarService, occurrence, ordinalSuffix } = require('../src/calendar');

function setup() {
  const store = new FamilyStore(':memory:');
  const calendar = new CalendarService(store.db);
  const admin = { id: 1, is_admin: 1 };
  const member = { id: 2, is_admin: 0 };
  store.db.exec(`INSERT INTO users (id, email, display_name, password_hash, is_admin) VALUES
    (1, 'a@example.com', 'Admin', 'x', 1), (2, 'b@example.com', 'Ben', 'x', 0), (3, 'c@example.com', 'Cara', 'x', 0)`);
  return { store, calendar, admin, member };
}

test('leap-day birthdays fall on Feb 28 in other years', () => {
  assert.equal(occurrence('2000-02-29', 2026), '2026-02-28');
  assert.equal(occurrence('2000-02-29', 2028), '2028-02-29');
  assert.equal(ordinalSuffix(1), '1st');
  assert.equal(ordinalSuffix(12), '12th');
  assert.equal(ordinalSuffix(23), '23rd');
});

test('birthdays and anniversaries appear every year, with deceased relatives remembered', () => {
  const { store, calendar } = setup();
  store.register({
    first_name: 'Ava',
    last_name: 'Jones',
    birth_date: '1990-06-01',
    spouse_name: 'Sam Lee',
    spouse_deceased: true,
    spouse_death_date: '2024-01-01',
    marriage_date: '2015-06-20',
  });
  store.register({ first_name: 'Rose', last_name: 'Baker', birth_date: '1930-06-05', deceased: true, death_date: '2015-03-01' });

  const june = calendar.range('2026-06-01', '2026-06-30').items;
  assert.deepEqual(
    june.map((i) => [i.date, i.title, i.detail]),
    [
      ['2026-06-01', "Ava Jones's birthday", 'Turns 36'],
      ['2026-06-05', "Rose Baker's birthday", 'Would have been 96'],
      ['2026-06-20', "Ava Jones & Sam Lee's 11th anniversary", ''],
    ]
  );
  assert.equal(june[1].in_memory, true);
  assert.equal(june[2].in_memory, true);
  // Nothing before someone was born.
  assert.equal(calendar.range('1925-06-01', '1925-06-30').items.length, 0);
  assert.throws(() => calendar.range('2026-01-01', '2028-01-01'), /at most/);
});

test('events can be one-off or yearly, and only their creator or an admin can change them', () => {
  const { calendar, admin, member } = setup();
  const picnic = calendar.createEvent(member, { title: 'Reunion picnic', event_date: '2026-07-04', event_time: '12:30', location: 'Lake Park' });
  calendar.createEvent(admin, { title: 'Founders day', event_date: '2020-03-10', repeats_yearly: true });

  assert.deepEqual(calendar.range('2026-07-01', '2026-07-31').items.map((i) => i.title), ['Reunion picnic']);
  assert.deepEqual(calendar.range('2027-07-01', '2027-07-31').items.map((i) => i.title), []);
  assert.deepEqual(calendar.range('2031-03-01', '2031-03-31').items.map((i) => [i.date, i.title]), [['2031-03-10', 'Founders day']]);
  assert.deepEqual(calendar.range('2019-03-01', '2019-03-31').items, []);

  assert.throws(() => calendar.updateEvent({ id: 3, is_admin: 0 }, picnic.id, { title: 'Hijacked' }), /Only the person/);
  assert.equal(calendar.updateEvent(admin, picnic.id, { title: 'Reunion BBQ' }).title, 'Reunion BBQ');
  assert.equal(calendar.updateEvent(member, picnic.id, { event_time: '13:00' }).event_time, '13:00');
  assert.throws(() => calendar.createEvent(member, { title: '', event_date: '2026-01-01' }), /title/);
  assert.throws(() => calendar.createEvent(member, { title: 'X', event_date: '2026-02-30' }), /valid event date/);
  assert.throws(() => calendar.createEvent(member, { title: 'X', event_date: '2026-02-01', event_time: '25:00' }), /valid time/);
  calendar.deleteEvent(member, picnic.id);
  assert.equal(calendar.range('2026-07-01', '2026-07-31').items.length, 0);
});
