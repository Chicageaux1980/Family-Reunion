'use strict';

// Family data store backed by SQLite (Node's built-in node:sqlite module).
//
// Everyone - registered family members and the ancestors they name - lives in
// one `people` table. Each person points at their mother and father, so the
// family tree is simply the graph formed by those links. When a new
// registration names a parent or grandparent who is already in the database,
// the existing record is reused instead of creating a duplicate; that is how
// relatives who share ancestors end up connected in one tree.

const { DatabaseSync } = require('node:sqlite');

const PERSON_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'home_address',
  'phone',
  'birth_date',
  'birth_city',
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
    id           INTEGER PRIMARY KEY,
    first_name   TEXT NOT NULL DEFAULT '',
    last_name    TEXT NOT NULL DEFAULT '',
    name_key     TEXT NOT NULL,
    email        TEXT,
    home_address TEXT,
    phone        TEXT,
    birth_date   TEXT,
    birth_city   TEXT,
    mother_id    INTEGER REFERENCES people(id) ON DELETE SET NULL,
    father_id    INTEGER REFERENCES people(id) ON DELETE SET NULL,
    registered   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_people_name_key ON people(name_key);
  CREATE INDEX IF NOT EXISTS idx_people_mother ON people(mother_id);
  CREATE INDEX IF NOT EXISTS idx_people_father ON people(father_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email ON people(lower(email)) WHERE email IS NOT NULL;
`;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text.slice(0, 500);
}

function normalizeKey(value) {
  return (value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(first, last) {
  return normalizeKey(`${first || ''} ${last || ''}`);
}

// "Mary Ann Smith" -> { first_name: "Mary Ann", last_name: "Smith" }
function splitFullName(fullName) {
  const text = clean(fullName);
  if (!text) return null;
  const parts = text.split(' ');
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] };
}

function cleanDate(value) {
  const text = clean(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new ValidationError(`"${text}" is not a valid date (expected YYYY-MM-DD).`);
  }
  return text;
}

function cleanEmail(value) {
  const text = clean(value);
  if (!text) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new ValidationError(`"${text}" is not a valid email address.`);
  }
  return text.toLowerCase();
}

function fullName(person) {
  return `${person.first_name || ''} ${person.last_name || ''}`.trim();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class FamilyStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ----- basic reads -------------------------------------------------------

  getPerson(id) {
    return this.db.prepare('SELECT * FROM people WHERE id = ?').get(Number(id)) || null;
  }

  requirePerson(id) {
    const person = this.getPerson(id);
    if (!person) throw new NotFoundError(`Person ${id} was not found.`);
    return person;
  }

  childrenOf(id) {
    return this.db
      .prepare('SELECT * FROM people WHERE mother_id = ? OR father_id = ? ORDER BY birth_date, first_name')
      .all(id, id);
  }

  siblingsOf(person) {
    if (!person.mother_id && !person.father_id) return [];
    return this.db
      .prepare(
        `SELECT * FROM people
          WHERE id != ?
            AND ((mother_id IS NOT NULL AND mother_id = ?) OR (father_id IS NOT NULL AND father_id = ?))
          ORDER BY birth_date, first_name`
      )
      .all(person.id, person.mother_id, person.father_id);
  }

  // Returns Map(id -> generations above `id`), including the person at depth 0.
  ancestorDepths(id) {
    const depths = new Map();
    if (!id) return depths;
    const stmt = this.db.prepare('SELECT mother_id, father_id FROM people WHERE id = ?');
    let frontier = [Number(id)];
    depths.set(Number(id), 0);
    for (let depth = 1; frontier.length; depth++) {
      const next = [];
      for (const current of frontier) {
        const row = stmt.get(current);
        if (!row) continue;
        for (const parentId of [row.mother_id, row.father_id]) {
          if (parentId && !depths.has(parentId)) {
            depths.set(parentId, depth);
            next.push(parentId);
          }
        }
      }
      frontier = next;
    }
    return depths;
  }

  stats() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS people,
                SUM(registered) AS registered,
                COUNT(DISTINCT lower(last_name)) AS surnames
           FROM people`
      )
      .get();
    return { people: row.people, registered: row.registered || 0, surnames: row.surnames };
  }

  // ----- search ------------------------------------------------------------

  search({ q = '', registeredOnly = false, limit = 50, offset = 0 } = {}) {
    const terms = normalizeKey(q).split(' ').filter(Boolean).slice(0, 8);
    const where = [];
    const params = [];
    const haystack = `lower(p.first_name || ' ' || p.last_name || ' ' || coalesce(p.email, '') || ' ' ||
      coalesce(p.home_address, '') || ' ' || coalesce(p.phone, '') || ' ' || coalesce(p.birth_city, '') || ' ' ||
      coalesce(p.birth_date, ''))`;
    for (const term of terms) {
      where.push(`(${haystack} LIKE ? OR p.name_key LIKE ?)`);
      params.push(`%${term}%`, `%${term}%`);
    }
    if (registeredOnly) where.push('p.registered = 1');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM people p ${clause}`).get(...params).n;
    const rows = this.db
      .prepare(
        `SELECT p.*,
                trim(m.first_name || ' ' || m.last_name) AS mother_name,
                trim(f.first_name || ' ' || f.last_name) AS father_name
           FROM people p
           LEFT JOIN people m ON m.id = p.mother_id
           LEFT JOIN people f ON f.id = p.father_id
           ${clause}
          ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE, p.id
          LIMIT ? OFFSET ?`
      )
      .all(...params, Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
    return { total, results: rows };
  }

  // ----- matching & linking ------------------------------------------------

  // Finds an existing person who is plausibly the same as `candidate`, or null.
  // A record is ruled out when any known fact contradicts the candidate
  // (different birth date, birth city, email or parent), or when linking it
  // would make someone their own ancestor. Among the rest, the one sharing the
  // most facts wins.
  findMatch(candidate, { exclude = new Set() } = {}) {
    if (candidate.email) {
      const byEmail = this.db.prepare('SELECT * FROM people WHERE lower(email) = ?').get(candidate.email);
      if (byEmail) return byEmail;
    }
    const key = nameKey(candidate.first_name, candidate.last_name);
    if (!key) return null;

    const forbidden = new Set();
    for (const parentId of [candidate.mother_id, candidate.father_id]) {
      for (const ancestorId of this.ancestorDepths(parentId).keys()) forbidden.add(ancestorId);
    }

    let best = null;
    let bestScore = -1;
    for (const row of this.db.prepare('SELECT * FROM people WHERE name_key = ? ORDER BY id').all(key)) {
      if (exclude.has(row.id) || forbidden.has(row.id)) continue;
      const score = matchScore(row, candidate);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    return best;
  }

  // Inserts `candidate` or merges it into its matching record; returns the id.
  upsertPerson(candidate, options = {}) {
    const existing = this.findMatch(candidate, options);
    if (!existing) {
      const result = this.db
        .prepare(
          `INSERT INTO people (first_name, last_name, name_key, email, home_address, phone,
                               birth_date, birth_city, mother_id, father_id, registered)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          candidate.first_name || '',
          candidate.last_name || '',
          nameKey(candidate.first_name, candidate.last_name),
          candidate.email || null,
          candidate.home_address || null,
          candidate.phone || null,
          candidate.birth_date || null,
          candidate.birth_city || null,
          candidate.mother_id || null,
          candidate.father_id || null,
          candidate.registered ? 1 : 0
        );
      return Number(result.lastInsertRowid);
    }

    // A registration always refreshes the registrant's own contact details;
    // facts supplied about an ancestor only fill in gaps.
    const overwrite = Boolean(candidate.registered);
    const merged = { ...existing };
    for (const field of ['email', 'home_address', 'phone', 'birth_date', 'birth_city', 'mother_id', 'father_id']) {
      const value = candidate[field];
      if (value && (overwrite || !merged[field])) merged[field] = value;
    }
    if (overwrite) {
      merged.first_name = candidate.first_name || merged.first_name;
      merged.last_name = candidate.last_name || merged.last_name;
    }
    merged.registered = existing.registered || candidate.registered ? 1 : 0;
    this.writePerson(merged);
    return existing.id;
  }

  writePerson(person) {
    this.db
      .prepare(
        `UPDATE people SET first_name = ?, last_name = ?, name_key = ?, email = ?, home_address = ?, phone = ?,
                           birth_date = ?, birth_city = ?, mother_id = ?, father_id = ?, registered = ?,
                           updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      )
      .run(
        person.first_name || '',
        person.last_name || '',
        nameKey(person.first_name, person.last_name),
        person.email || null,
        person.home_address || null,
        person.phone || null,
        person.birth_date || null,
        person.birth_city || null,
        person.mother_id || null,
        person.father_id || null,
        person.registered ? 1 : 0,
        person.id
      );
  }

  // ----- registration ------------------------------------------------------

  // Records one family member's registration form and links everyone named in
  // it into the tree. Returns { personId, linked } where `linked` lists the
  // records created or reused for each role.
  register(form) {
    const input = parseRegistration(form);
    return this.transaction(() => {
      const used = new Set();
      const resolve = (role, candidate) => {
        if (!candidate) return null;
        const id = this.upsertPerson(candidate, { exclude: used });
        used.add(id);
        roles[role] = id;
        return id;
      };
      const roles = {};

      // Resolve from the oldest generation down, so each parent is already
      // known when matching their child. That lets records with the same name
      // be told apart by who their parents are.
      const grandmotherId = resolve('grandmother', input.grandmother);
      const grandfatherId = resolve('grandfather', input.grandfather);

      const sideParent = input.grandparentSide === 'father' ? 'father' : 'mother';
      const otherParent = sideParent === 'mother' ? 'father' : 'mother';
      if (input[sideParent]) {
        input[sideParent].mother_id = grandmotherId;
        input[sideParent].father_id = grandfatherId;
      }
      const parentIds = {};
      parentIds[sideParent] = resolve(sideParent, input[sideParent]);
      parentIds[otherParent] = resolve(otherParent, input[otherParent]);

      input.self.mother_id = parentIds.mother;
      input.self.father_id = parentIds.father;
      const personId = resolve('self', input.self);

      const linked = Object.entries(roles).map(([role, id]) => {
        const person = this.getPerson(id);
        return { role, id, name: fullName(person) };
      });
      return { personId, linked };
    });
  }

  // ----- editing -----------------------------------------------------------

  updatePerson(id, changes) {
    return this.transaction(() => {
      const person = this.requirePerson(id);
      const updated = { ...person };
      for (const field of PERSON_FIELDS) {
        if (!(field in changes)) continue;
        if (field === 'birth_date') updated[field] = cleanDate(changes[field]);
        else if (field === 'email') updated[field] = cleanEmail(changes[field]);
        else updated[field] = clean(changes[field]);
      }
      if (!updated.first_name && !updated.last_name) throw new ValidationError('A name is required.');
      if (updated.email) {
        const clash = this.db
          .prepare('SELECT id FROM people WHERE lower(email) = ? AND id != ?')
          .get(updated.email, person.id);
        if (clash) throw new ValidationError('Another person already uses that email address.');
      }
      this.writePerson(updated);
      return this.getPerson(person.id);
    });
  }

  // Combines two records that describe the same person. `keepId` survives,
  // gains any facts only `removeId` had, and adopts its children.
  mergePeople(keepId, removeId) {
    keepId = Number(keepId);
    removeId = Number(removeId);
    if (keepId === removeId) throw new ValidationError('Cannot merge a person with themselves.');
    return this.transaction(() => {
      const keep = this.requirePerson(keepId);
      const remove = this.requirePerson(removeId);
      if (this.ancestorDepths(keepId).has(removeId) || this.ancestorDepths(removeId).has(keepId)) {
        throw new ValidationError('These records are ancestor and descendant of each other, so they cannot be the same person.');
      }
      for (const field of ['mother_id', 'father_id']) {
        if (keep[field] && remove[field] && keep[field] !== remove[field]) {
          throw new ValidationError(
            `These records list different ${field === 'mother_id' ? 'mothers' : 'fathers'}. Merge the parents first.`
          );
        }
      }
      const merged = { ...keep };
      for (const field of ['first_name', 'last_name', 'email', 'home_address', 'phone', 'birth_date', 'birth_city', 'mother_id', 'father_id']) {
        if (!merged[field] && remove[field]) merged[field] = remove[field];
      }
      merged.registered = keep.registered || remove.registered ? 1 : 0;

      this.db.prepare('UPDATE people SET mother_id = ? WHERE mother_id = ?').run(keepId, removeId);
      this.db.prepare('UPDATE people SET father_id = ? WHERE father_id = ?').run(keepId, removeId);
      this.db.prepare('DELETE FROM people WHERE id = ?').run(removeId);
      this.writePerson(merged);
      return this.getPerson(keepId);
    });
  }

  deletePerson(id) {
    this.requirePerson(id);
    this.db.prepare('DELETE FROM people WHERE id = ?').run(Number(id));
  }

  // ----- family views ------------------------------------------------------

  personDetails(id) {
    const person = this.requirePerson(id);
    const brief = (p) => p && { id: p.id, name: fullName(p), birth_date: p.birth_date, birth_city: p.birth_city };
    return {
      ...person,
      mother: brief(this.getPerson(person.mother_id)),
      father: brief(this.getPerson(person.father_id)),
      children: this.childrenOf(person.id).map(brief),
      siblings: this.siblingsOf(person).map(brief),
      possibleDuplicates: this.db
        .prepare('SELECT * FROM people WHERE name_key = ? AND id != ? ORDER BY id')
        .all(person.name_key, person.id)
        .map(brief),
    };
  }

  // Everyone connected to `id` through parent/child links (capped at `limit`).
  familyGraph(id, limit = 400) {
    this.requirePerson(id);
    const byId = this.db.prepare('SELECT * FROM people WHERE id = ?');
    const kids = this.db.prepare('SELECT id FROM people WHERE mother_id = ? OR father_id = ?');
    const seen = new Map();
    const queue = [Number(id)];
    while (queue.length && seen.size < limit) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      const person = byId.get(current);
      if (!person) continue;
      seen.set(current, person);
      for (const next of [person.mother_id, person.father_id, ...kids.all(current, current).map((r) => r.id)]) {
        if (next && !seen.has(next)) queue.push(next);
      }
    }
    const people = [...seen.values()].map((p) => ({
      id: p.id,
      name: fullName(p),
      birth_date: p.birth_date,
      birth_city: p.birth_city,
      registered: p.registered,
      mother_id: seen.has(p.mother_id) ? p.mother_id : null,
      father_id: seen.has(p.father_id) ? p.father_id : null,
    }));
    return { focusId: Number(id), people, truncated: queue.some((q) => !seen.has(q)) };
  }

  // Works out how two people are related through their closest common ancestors.
  relationship(aId, bId) {
    const a = this.requirePerson(aId);
    const b = this.requirePerson(bId);
    const brief = (p) => ({ id: p.id, name: fullName(p) });
    if (a.id === b.id) {
      return { a: brief(a), b: brief(b), related: true, description: 'These are the same person.', commonAncestors: [] };
    }
    const depthsA = this.ancestorDepths(a.id);
    const depthsB = this.ancestorDepths(b.id);
    let bestSum = Infinity;
    let common = [];
    for (const [ancestorId, da] of depthsA) {
      if (!depthsB.has(ancestorId)) continue;
      const sum = da + depthsB.get(ancestorId);
      if (sum < bestSum) {
        bestSum = sum;
        common = [ancestorId];
      } else if (sum === bestSum) {
        common.push(ancestorId);
      }
    }
    if (!common.length) {
      return {
        a: brief(a),
        b: brief(b),
        related: false,
        description: `No common ancestor has been recorded yet for ${fullName(a)} and ${fullName(b)}.`,
        commonAncestors: [],
      };
    }
    const da = depthsA.get(common[0]);
    const db = depthsB.get(common[0]);
    return {
      a: brief(a),
      b: brief(b),
      related: true,
      generationsFromA: da,
      generationsFromB: db,
      description: describeRelationship(fullName(a), fullName(b), da, db, common.length),
      commonAncestors: common.map((cid) => brief(this.getPerson(cid))),
    };
  }
}

function matchScore(row, candidate) {
  const sameText = (x, y) => normalizeKey(x) === normalizeKey(y);
  // Hard conflicts rule a record out completely.
  if (row.birth_date && candidate.birth_date && row.birth_date !== candidate.birth_date) return -1;
  if (row.birth_city && candidate.birth_city && !sameText(row.birth_city, candidate.birth_city)) return -1;
  if (row.email && candidate.email && row.email.toLowerCase() !== candidate.email) return -1;
  if (row.mother_id && candidate.mother_id && row.mother_id !== candidate.mother_id) return -1;
  if (row.father_id && candidate.father_id && row.father_id !== candidate.father_id) return -1;
  let score = 0;
  if (row.birth_date && row.birth_date === candidate.birth_date) score += 4;
  if (row.mother_id && row.mother_id === candidate.mother_id) score += 3;
  if (row.father_id && row.father_id === candidate.father_id) score += 3;
  if (row.birth_city && candidate.birth_city) score += 1;
  return score;
}

function parseRegistration(form = {}) {
  const first = clean(form.first_name);
  const last = clean(form.last_name);
  if (!first || !last) throw new ValidationError('First name and last name are required.');

  const self = {
    first_name: first,
    last_name: last,
    email: cleanEmail(form.email),
    home_address: clean(form.home_address),
    phone: clean(form.phone),
    birth_date: cleanDate(form.birth_date),
    birth_city: clean(form.birth_city),
    registered: true,
  };
  const mother = splitFullName(form.mother_name);
  const father = splitFullName(form.father_name);

  const ancestor = (name, birthDate, birthCity) => {
    const person = splitFullName(name);
    if (!person) {
      if (clean(birthDate) || clean(birthCity)) {
        throw new ValidationError('Please enter a name for each grandparent whose birth details you provide.');
      }
      return null;
    }
    return { ...person, birth_date: cleanDate(birthDate), birth_city: clean(birthCity) };
  };
  const grandmother = ancestor(form.grandmother_name, form.grandmother_birth_date, form.grandmother_birth_city);
  const grandfather = ancestor(form.grandfather_name, form.grandfather_birth_date, form.grandfather_birth_city);

  const grandparentSide = form.grandparent_side === 'father' ? 'father' : 'mother';
  if ((grandmother || grandfather) && !(grandparentSide === 'father' ? father : mother)) {
    throw new ValidationError(
      `Please enter your ${grandparentSide}'s name so the grandparents on that side can be linked to them.`
    );
  }
  return { self, mother, father, grandmother, grandfather, grandparentSide };
}

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n) => ORDINALS[n] || `${n}th`;
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

// 1 -> "great-", 2 -> "great-great-", 4 -> "4x-great-"
function greats(n) {
  if (n <= 0) return '';
  return n <= 3 ? 'great-'.repeat(n) : `${n}x-great-`;
}

// da / db: generations from A / B up to the closest common ancestor.
function describeRelationship(aName, bName, da, db, sharedCount) {
  if (da === 0) return `${aName} is ${bName}'s ${ancestorTitle(db)}.`;
  if (db === 0) return `${bName} is ${aName}'s ${ancestorTitle(da)}.`;
  if (da === 1 && db === 1) {
    return sharedCount >= 2 ? `${aName} and ${bName} are siblings.` : `${aName} and ${bName} are half-siblings.`;
  }
  if (da === 1) return `${aName} is ${bName}'s ${greats(db - 2)}aunt/uncle.`;
  if (db === 1) return `${bName} is ${aName}'s ${greats(da - 2)}aunt/uncle.`;
  const degree = Math.min(da, db) - 1;
  const removed = Math.abs(da - db);
  const half = sharedCount >= 2 ? '' : 'half-';
  return `${aName} and ${bName} are ${half}${ordinal(degree)} cousins${removed ? `, ${times(removed)} removed` : ''}.`;
}

function ancestorTitle(generations) {
  if (generations === 1) return 'parent';
  if (generations === 2) return 'grandparent';
  return `${greats(generations - 2)}grandparent`;
}

module.exports = {
  FamilyStore,
  ValidationError,
  NotFoundError,
  describeRelationship,
  splitFullName,
  normalizeKey,
};
