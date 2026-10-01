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
  assert.throws(() => store.register({ first_name: 'Ava', last_name: 'J', birth_date: '1990-13-45' }), /valid date/);
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
