'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FamilyStore, describeRelationship, splitFullName } = require('../src/store');

const grandparents = {
  grandparent_side: 'mother',
  grandmother_name: 'Rose Baker',
  grandmother_birth_date: '1930-04-02',
  grandmother_birth_city: 'Atlanta',
  grandfather_name: 'Henry Baker',
  grandfather_birth_date: '1928-11-19',
  grandfather_birth_city: 'Macon',
};

function freshStore() {
  return new FamilyStore(':memory:');
}

test('registration creates the person and every named ancestor, linked together', () => {
  const store = freshStore();
  const { personId, linked } = store.register({
    first_name: 'Ava',
    last_name: 'Jones',
    email: 'Ava@Example.com',
    phone: '555-0100',
    home_address: '1 Main St',
    birth_date: '1990-06-01',
    birth_city: 'Chicago',
    mother_name: 'Linda Baker',
    father_name: 'Mark Jones',
    ...grandparents,
  });
  assert.equal(store.stats().people, 5);
  assert.deepEqual(linked.map((l) => l.role).sort(), ['father', 'grandfather', 'grandmother', 'mother', 'self']);

  const ava = store.personDetails(personId);
  assert.equal(ava.email, 'ava@example.com');
  assert.equal(ava.registered, 1);
  assert.equal(ava.mother.name, 'Linda Baker');
  assert.equal(ava.father.name, 'Mark Jones');

  const mother = store.getPerson(ava.mother_id);
  assert.equal(store.getPerson(mother.mother_id).birth_city, 'Atlanta');
  assert.equal(store.getPerson(mother.father_id).first_name, 'Henry');
  // Grandparents were attached to the mother's side, not the father's.
  assert.equal(store.getPerson(ava.father_id).mother_id, null);
});

test('siblings share parent records instead of duplicating them', () => {
  const store = freshStore();
  const ava = store.register({ first_name: 'Ava', last_name: 'Jones', mother_name: 'Linda Baker', father_name: 'Mark Jones', ...grandparents });
  const ben = store.register({ first_name: 'Ben', last_name: 'Jones', mother_name: 'linda  baker', father_name: 'Mark Jones', ...grandparents });
  assert.equal(store.stats().people, 6);
  const a = store.getPerson(ava.personId);
  const b = store.getPerson(ben.personId);
  assert.equal(a.mother_id, b.mother_id);
  assert.equal(a.father_id, b.father_id);
  assert.match(store.relationship(a.id, b.id).description, /are siblings/);
});

test('cousins are linked through shared grandparents', () => {
  const store = freshStore();
  const ava = store.register({ first_name: 'Ava', last_name: 'Jones', mother_name: 'Linda Baker', father_name: 'Mark Jones', ...grandparents });
  // Cara's father is Linda's brother; the same grandparents are on her father's side.
  const cara = store.register({
    first_name: 'Cara',
    last_name: 'Baker',
    mother_name: 'Joan Smith',
    father_name: 'Tom Baker',
    ...grandparents,
    grandparent_side: 'father',
  });
  assert.equal(store.stats().people, 8);
  const rel = store.relationship(ava.personId, cara.personId);
  assert.equal(rel.related, true);
  assert.equal(rel.description, 'Ava Jones and Cara Baker are first cousins.');
  assert.deepEqual(rel.commonAncestors.map((p) => p.name).sort(), ['Henry Baker', 'Rose Baker']);

  const tree = store.familyGraph(ava.personId);
  assert.equal(tree.people.length, 8);
});

test('ancestors with the same name but different birth details stay separate', () => {
  const store = freshStore();
  store.register({ first_name: 'Ava', last_name: 'Jones', mother_name: 'Linda Baker', ...grandparents });
  store.register({
    first_name: 'Dan',
    last_name: 'Lee',
    mother_name: 'Sue Baker',
    grandmother_name: 'Rose Baker',
    grandmother_birth_date: '1950-01-01',
  });
  const roses = store.search({ q: 'rose baker' }).results;
  assert.equal(roses.length, 2);
  assert.equal(store.relationship(roses[0].id, roses[1].id).related, false);
});

test('a parent who registers later is merged with the record their child created', () => {
  const store = freshStore();
  const ava = store.register({ first_name: 'Ava', last_name: 'Jones', mother_name: 'Linda Baker', ...grandparents });
  const linda = store.register({
    first_name: 'Linda',
    last_name: 'Baker',
    email: 'linda@example.com',
    birth_city: 'Atlanta',
    mother_name: 'Rose Baker',
    father_name: 'Henry Baker',
    grandparent_side: 'mother',
  });
  assert.equal(store.getPerson(ava.personId).mother_id, linda.personId);
  const record = store.getPerson(linda.personId);
  assert.equal(record.registered, 1);
  assert.equal(record.email, 'linda@example.com');
  assert.equal(store.stats().people, 4);
});

test('registering again with the same email updates the existing member', () => {
  const store = freshStore();
  const first = store.register({ first_name: 'Ava', last_name: 'Jones', email: 'ava@example.com', phone: '1' });
  const second = store.register({ first_name: 'Ava', last_name: 'Jones-Smith', email: 'AVA@example.com', phone: '2' });
  assert.equal(first.personId, second.personId);
  const ava = store.getPerson(first.personId);
  assert.equal(ava.last_name, 'Jones-Smith');
  assert.equal(ava.phone, '2');
});

test('a person is never matched to their own ancestor', () => {
  const store = freshStore();
  const junior = store.register({ first_name: 'John', last_name: 'Smith', father_name: 'John Smith' });
  const person = store.getPerson(junior.personId);
  assert.notEqual(person.father_id, person.id);
  assert.equal(store.stats().people, 2);
});

test('search matches names, cities, emails and phone numbers', () => {
  const store = freshStore();
  store.register({ first_name: 'Ava', last_name: 'Jones', email: 'ava@example.com', phone: '555-0100', birth_city: 'Chicago', mother_name: 'Linda Baker' });
  assert.equal(store.search({ q: 'ava jones' }).total, 1);
  assert.equal(store.search({ q: 'chicago' }).total, 1);
  assert.equal(store.search({ q: 'example.com' }).total, 1);
  assert.equal(store.search({ q: '555' }).total, 1);
  assert.equal(store.search({ q: 'baker' }).results[0].first_name, 'Linda');
  assert.equal(store.search({ q: '' }).total, 2);
  assert.equal(store.search({ q: '', registeredOnly: true }).total, 1);
  assert.equal(store.search({ q: 'nobody' }).total, 0);
});

test('merging duplicates moves children and fills in missing facts', () => {
  const store = freshStore();
  const ava = store.register({ first_name: 'Ava', last_name: 'Jones', mother_name: 'Linda Baker' });
  const ben = store.register({ first_name: 'Ben', last_name: 'Jones', mother_name: 'Linda Jones' });
  const lindaA = store.getPerson(ava.personId).mother_id;
  const lindaB = store.getPerson(ben.personId).mother_id;
  assert.notEqual(lindaA, lindaB);
  store.updatePerson(lindaB, { birth_city: 'Atlanta' });

  store.mergePeople(lindaA, lindaB);
  assert.equal(store.getPerson(lindaB), null);
  assert.equal(store.getPerson(ben.personId).mother_id, lindaA);
  assert.equal(store.getPerson(lindaA).birth_city, 'Atlanta');
  assert.match(store.relationship(ava.personId, ben.personId).description, /half-siblings/);
  assert.throws(() => store.mergePeople(lindaA, ava.personId), /ancestor and descendant/);
});

test('invalid registrations are rejected', () => {
  const store = freshStore();
  assert.throws(() => store.register({ first_name: 'Ava' }), /First name and last name/);
  assert.throws(() => store.register({ first_name: 'Ava', last_name: 'J', email: 'nope' }), /valid email/);
  assert.throws(() => store.register({ first_name: 'Ava', last_name: 'J', birth_date: '1990-13-45' }), /not a valid birthday/);
  assert.throws(
    () => store.register({ first_name: 'Ava', last_name: 'J', grandmother_name: 'Rose Baker' }),
    /enter your mother's name/
  );
  assert.equal(store.stats().people, 0);
});

test('relationship descriptions', () => {
  assert.equal(describeRelationship('A', 'B', 0, 1, 1), "A is B's parent.");
  assert.equal(describeRelationship('A', 'B', 3, 0, 1), "B is A's great-grandparent.");
  assert.equal(describeRelationship('A', 'B', 1, 2, 2), "A is B's aunt/uncle.");
  assert.equal(describeRelationship('A', 'B', 3, 1, 2), "B is A's great-aunt/uncle.");
  assert.equal(describeRelationship('A', 'B', 3, 3, 2), 'A and B are second cousins.');
  assert.equal(describeRelationship('A', 'B', 2, 3, 2), 'A and B are first cousins, once removed.');
});

test('splitFullName', () => {
  assert.deepEqual(splitFullName('  Mary  Ann Smith '), { first_name: 'Mary Ann', last_name: 'Smith' });
  assert.deepEqual(splitFullName('Cher'), { first_name: 'Cher', last_name: '' });
  assert.equal(splitFullName('   '), null);
});

test('spouses are linked with marriage details; year must agree with the date', () => {
  const store = freshStore();
  const { personId, linked } = store.register({
    first_name: 'Ava',
    last_name: 'Lee',
    maiden_name: 'Jones',
    spouse_name: 'Sam Lee',
    marriage_year: '2015',
    marriage_city: 'Chicago',
    marriage_date: '2015-06-20',
  });
  const spouseId = linked.find((l) => l.role === 'spouse').id;
  const ava = store.personDetails(personId);
  assert.equal(ava.maiden_name, 'Jones');
  assert.deepEqual(
    { name: ava.spouses[0].name, year: ava.spouses[0].marriage_year, city: ava.spouses[0].marriage_city },
    { name: 'Sam Lee', year: 2015, city: 'Chicago' }
  );
  assert.equal(store.personDetails(spouseId).spouses[0].id, personId);
  assert.match(store.relationship(personId, spouseId).description, /are married/);
  assert.throws(
    () => store.register({ first_name: 'X', last_name: 'Y', spouse_name: 'Z Y', marriage_year: '2014', marriage_date: '2015-06-20' }),
    /does not match/
  );
  assert.throws(() => store.register({ first_name: 'X', last_name: 'Y', marriage_city: 'Paris' }), /spouse's name/);
});

test('a spouse entered with a maiden name links to the record known by that maiden name', () => {
  const store = freshStore();
  // Linda's child knows her by her maiden name...
  const child = store.register({ first_name: 'Ava', last_name: 'Jones', mother_name: 'Linda Baker' });
  // ...and her husband enters her married name plus maiden name.
  const husband = store.register({ first_name: 'Mark', last_name: 'Jones', spouse_name: 'Linda Jones', spouse_maiden_name: 'Baker' });
  const motherId = store.getPerson(child.personId).mother_id;
  const spouseId = husband.linked.find((l) => l.role === 'spouse').id;
  assert.equal(spouseId, motherId);
  const linda = store.getPerson(motherId);
  assert.equal(linda.last_name, 'Jones');
  assert.equal(linda.maiden_name, 'Baker');
  assert.equal(store.search({ q: 'linda baker' }).total, 1);
});

test('siblings share the registrant parents unless different ones are given', () => {
  const store = freshStore();
  const { personId, linked } = store.register({
    first_name: 'Ava',
    last_name: 'Jones',
    mother_name: 'Linda Jones',
    mother_maiden_name: 'Baker',
    father_name: 'Mark Jones',
    siblings: [
      { first_name: 'Ben', birth_date: '1993-02-11' },
      { first_name: 'Cal', last_name: 'Jones', mother_maiden_name: 'Baker', father_name: 'Mark Jones' },
      { first_name: 'Dee', last_name: 'Smith', mother_maiden_name: 'Joan Smith', father_name: 'Mark Jones', deceased: 'on', death_date: '2001-05-05' },
      { first_name: '', last_name: '' },
    ],
  });
  const siblings = store.personDetails(personId).siblings;
  assert.deepEqual(siblings.map((s) => s.name).sort(), ['Ben Jones', 'Cal Jones', 'Dee Smith']);
  const dee = store.getPerson(linked.find((l) => l.role === 'sibling:2').id);
  assert.equal(dee.deceased, 1);
  assert.equal(dee.death_date, '2001-05-05');
  assert.match(store.relationship(personId, linked.find((l) => l.role === 'sibling:0').id).description, /are siblings/);
  assert.match(store.relationship(personId, dee.id).description, /half-siblings/);
  assert.equal(store.stats().people, 7);

  assert.throws(() => store.register({ first_name: 'Z', last_name: 'Q', siblings: [{ first_name: 'Y' }] }), /enter your mother's or father's name/);
  assert.throws(() => store.register({ first_name: 'Z', last_name: 'Q', siblings: [{ last_name: 'Q' }] }), /first name/);
  assert.throws(
    () => store.register({ first_name: 'Z', last_name: 'Q', mother_name: 'Amy Q', siblings: [{ first_name: 'Y', mother_maiden_name: 'Other' }] }),
    /full name/
  );
});

test('living or deceased, with a date of death that must make sense', () => {
  const store = freshStore();
  const { personId, linked } = store.register({
    first_name: 'Ava',
    last_name: 'Jones',
    birth_date: '1990-01-01',
    mother_name: 'Linda Baker',
    mother_deceased: true,
    mother_death_date: '2019-04-04',
    father_name: 'Mark Jones',
    father_death_date: '2010-01-01',
  });
  assert.equal(store.getPerson(personId).deceased, 0);
  const mother = store.getPerson(linked.find((l) => l.role === 'mother').id);
  assert.deepEqual([mother.deceased, mother.death_date], [1, '2019-04-04']);
  assert.equal(store.getPerson(linked.find((l) => l.role === 'father').id).deceased, 1, 'a death date implies deceased');

  assert.throws(() => store.updatePerson(personId, { deceased: true, death_date: '1980-01-01' }), /before their birth date/);
  assert.throws(() => store.updatePerson(personId, { death_date: '2999-01-01' }), /in the future/);
  const updated = store.updatePerson(mother.id, { deceased: false });
  assert.deepEqual([updated.deceased, updated.death_date], [0, null]);
});

test('merging moves marriages too', () => {
  const store = freshStore();
  const a = store.register({ first_name: 'Ava', last_name: 'Jones', spouse_name: 'Sam Lee', marriage_date: '2015-06-20' });
  const samA = a.linked.find((l) => l.role === 'spouse').id;
  // Sam registers under his full first name, so he isn't matched automatically.
  const samB = store.register({ first_name: 'Samuel', last_name: 'Lee', birth_date: '1988-01-01' }).personId;
  assert.notEqual(samA, samB);
  store.mergePeople(samB, samA);
  const sam = store.personDetails(samB);
  assert.equal(sam.spouses[0].id, a.personId);
  assert.equal(sam.spouses[0].marriage_date, '2015-06-20');
});
