'use strict';

// Family data store backed by SQLite (Node's built-in node:sqlite module).
//
// Everyone - registered family members and the relatives they name - lives in
// one `people` table. Each person points at their mother and father, and
// couples are recorded in `marriages`, so the family tree is simply the graph
// formed by those links. When a new registration names a relative who is
// already in the database, the existing record is reused instead of creating
// a duplicate; that is how relatives who share ancestors end up connected in
// one tree.

const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('./schema');
const {
  ValidationError,
  NotFoundError,
  clean,
  normalizeKey,
  nameKey,
  splitFullName,
  cleanDate,
  cleanYear,
  cleanEmail,
  truthy,
  fullName,
} = require('./util');

const EDITABLE_FIELDS = [
  'first_name',
  'last_name',
  'maiden_name',
  'email',
  'home_address',
  'phone',
  'birth_date',
  'birth_city',
  'deceased',
  'death_date',
];

// Fields copied between records when matching or merging.
const FACT_FIELDS = [
  'maiden_name',
  'email',
  'home_address',
  'phone',
  'birth_date',
  'birth_city',
  'death_date',
  'mother_id',
  'father_id',
];

const MAX_SIBLINGS = 20;

// A maiden name is normally just a surname ("Baker"), but people sometimes
// type the full maiden name ("Linda Baker"); keep only the surname part.
function cleanMaiden(firstName, maiden) {
  const text = clean(maiden);
  if (!text) return null;
  const first = clean(firstName);
  if (first && text.toLowerCase().startsWith(first.toLowerCase() + ' ')) return text.slice(first.length + 1);
  return text;
}

function maidenKey(person) {
  return person.maiden_name ? nameKey(person.first_name, person.maiden_name) : null;
}

class FamilyStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    migrate(this.db);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // ----- basic reads -------------------------------------------------------

  getPerson(id) {
    if (!id) return null;
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

  marriagesOf(id) {
    return this.db
      .prepare(
        `SELECT m.*, p.id AS spouse_id
           FROM marriages m
           JOIN people p ON p.id = CASE WHEN m.person1_id = ? THEN m.person2_id ELSE m.person1_id END
          WHERE m.person1_id = ? OR m.person2_id = ?
          ORDER BY coalesce(m.marriage_date, m.marriage_year), m.id`
      )
      .all(id, id, id);
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
    const photos = this.db.prepare("SELECT COUNT(*) AS n FROM media WHERE kind = 'photo'").get().n;
    return { people: row.people, registered: row.registered || 0, surnames: row.surnames, photos };
  }

  // ----- search ------------------------------------------------------------

  search({ q = '', registeredOnly = false, limit = 50, offset = 0 } = {}) {
    const terms = normalizeKey(q).split(' ').filter(Boolean).slice(0, 8);
    const where = [];
    const params = [];
    const haystack = `lower(p.first_name || ' ' || p.last_name || ' ' || coalesce(p.maiden_name, '') || ' ' ||
      coalesce(p.email, '') || ' ' || coalesce(p.home_address, '') || ' ' || coalesce(p.phone, '') || ' ' ||
      coalesce(p.birth_city, '') || ' ' || coalesce(p.birth_date, '') || ' ' || coalesce(p.death_date, ''))`;
    for (const term of terms) {
      where.push(`(${haystack} LIKE ? OR p.name_key LIKE ? OR coalesce(p.maiden_key, '') LIKE ?)`);
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
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
  // Names match on either the current name or the maiden name. A record is
  // ruled out when any known fact contradicts the candidate (different birth
  // date, birth city, maiden name, email or parent), or when linking it would
  // make someone their own ancestor. Among the rest, the one sharing the most
  // facts wins.
  findMatch(candidate, { exclude = new Set() } = {}) {
    if (candidate.email) {
      const byEmail = this.db.prepare('SELECT * FROM people WHERE lower(email) = ?').get(candidate.email);
      if (byEmail) return byEmail;
    }
    const keys = [...new Set([nameKey(candidate.first_name, candidate.last_name), maidenKey(candidate)].filter(Boolean))];
    if (!keys.length) return null;

    const forbidden = new Set();
    for (const parentId of [candidate.mother_id, candidate.father_id]) {
      for (const ancestorId of this.ancestorDepths(parentId).keys()) forbidden.add(ancestorId);
    }

    const marks = keys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM people WHERE name_key IN (${marks}) OR maiden_key IN (${marks}) ORDER BY id`)
      .all(...keys, ...keys);
    let best = null;
    let bestScore = -1;
    for (const row of rows) {
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
          `INSERT INTO people (first_name, last_name, name_key, maiden_name, maiden_key, email, home_address, phone,
                               birth_date, birth_city, deceased, death_date, mother_id, father_id, registered)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          candidate.first_name || '',
          candidate.last_name || '',
          nameKey(candidate.first_name, candidate.last_name),
          candidate.maiden_name || null,
          maidenKey(candidate),
          candidate.email || null,
          candidate.home_address || null,
          candidate.phone || null,
          candidate.birth_date || null,
          candidate.birth_city || null,
          candidate.deceased ? 1 : 0,
          candidate.death_date || null,
          candidate.mother_id || null,
          candidate.father_id || null,
          candidate.registered ? 1 : 0
        );
      return Number(result.lastInsertRowid);
    }

    // A registration always refreshes the registrant's own details; facts
    // supplied about a relative only fill in gaps.
    const overwrite = Boolean(candidate.registered);
    const merged = { ...existing };
    for (const field of FACT_FIELDS) {
      const value = candidate[field];
      if (value && (overwrite || !merged[field])) merged[field] = value;
    }
    if (overwrite) {
      merged.first_name = candidate.first_name || merged.first_name;
      merged.last_name = candidate.last_name || merged.last_name;
      merged.deceased = candidate.deceased ? 1 : 0;
      if (!merged.deceased) merged.death_date = null;
    } else {
      if (candidate.deceased) merged.deceased = 1;
      // The record was created under a maiden name and this entry supplies the
      // married name too: adopt the married name and keep the maiden name.
      if (
        candidate.maiden_name &&
        normalizeKey(candidate.maiden_name) === normalizeKey(existing.last_name) &&
        candidate.last_name &&
        normalizeKey(candidate.last_name) !== normalizeKey(existing.last_name)
      ) {
        merged.last_name = candidate.last_name;
        merged.maiden_name = existing.last_name;
      }
    }
    merged.registered = existing.registered || candidate.registered ? 1 : 0;
    this.writePerson(merged);
    return existing.id;
  }

  writePerson(person) {
    this.db
      .prepare(
        `UPDATE people SET first_name = ?, last_name = ?, name_key = ?, maiden_name = ?, maiden_key = ?, email = ?,
                           home_address = ?, phone = ?, birth_date = ?, birth_city = ?, deceased = ?, death_date = ?,
                           mother_id = ?, father_id = ?, registered = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      )
      .run(
        person.first_name || '',
        person.last_name || '',
        nameKey(person.first_name, person.last_name),
        person.maiden_name || null,
        maidenKey(person),
        person.email || null,
        person.home_address || null,
        person.phone || null,
        person.birth_date || null,
        person.birth_city || null,
        person.deceased ? 1 : 0,
        person.death_date || null,
        person.mother_id || null,
        person.father_id || null,
        person.registered ? 1 : 0,
        person.id
      );
  }

  // ----- marriages ---------------------------------------------------------

  // Records (or completes) a marriage between two people.
  addMarriage(aId, bId, details = {}) {
    const a = Number(aId);
    const b = Number(bId);
    if (!a || !b || a === b) throw new ValidationError('A marriage needs two different people.');
    this.requirePerson(a);
    this.requirePerson(b);
    const info = cleanMarriage(details);
    const [p1, p2] = a < b ? [a, b] : [b, a];
    const existing = this.db.prepare('SELECT * FROM marriages WHERE person1_id = ? AND person2_id = ?').get(p1, p2);
    if (existing) {
      this.db
        .prepare('UPDATE marriages SET marriage_date = ?, marriage_year = ?, marriage_city = ? WHERE id = ?')
        .run(
          info.marriage_date || existing.marriage_date,
          info.marriage_year || existing.marriage_year,
          info.marriage_city || existing.marriage_city,
          existing.id
        );
      return existing.id;
    }
    const result = this.db
      .prepare('INSERT INTO marriages (person1_id, person2_id, marriage_date, marriage_year, marriage_city) VALUES (?, ?, ?, ?, ?)')
      .run(p1, p2, info.marriage_date, info.marriage_year, info.marriage_city);
    return Number(result.lastInsertRowid);
  }

  // Adds a spouse to an existing person from a profile page.
  addSpouse(personId, form = {}) {
    return this.transaction(() => {
      const person = this.requirePerson(personId);
      const spouse = parseSpouse({
        spouse_name: form.spouse_name,
        spouse_maiden_name: form.spouse_maiden_name,
        spouse_deceased: form.spouse_deceased,
        spouse_death_date: form.spouse_death_date,
        marriage_year: form.marriage_year,
        marriage_city: form.marriage_city,
        marriage_date: form.marriage_date,
      });
      if (!spouse) throw new ValidationError("Please enter the spouse's name.");
      const exclude = new Set([person.id, ...this.ancestorDepths(person.id).keys()]);
      const spouseId = this.upsertPerson(spouse.person, { exclude });
      this.addMarriage(person.id, spouseId, spouse.marriage);
      return { spouseId };
    });
  }

  removeMarriage(marriageId) {
    const result = this.db.prepare('DELETE FROM marriages WHERE id = ?').run(Number(marriageId));
    if (!result.changes) throw new NotFoundError('That marriage was not found.');
  }

  // ----- registration ------------------------------------------------------

  // Records one family member's registration form and links everyone named in
  // it into the tree. Returns { personId, linked } where `linked` lists the
  // records created or reused for each role ("self", "mother", "spouse",
  // "sibling:0", ...).
  register(form) {
    const input = parseRegistration(form);
    return this.transaction(() => {
      const used = new Set();
      const linked = [];
      const resolve = (role, candidate) => {
        if (!candidate) return null;
        const id = this.upsertPerson(candidate, { exclude: used });
        used.add(id);
        linked.push({ role, id });
        return id;
      };

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

      input.siblings.forEach((sibling, index) => {
        const motherId = this.resolveSiblingParent(sibling.motherText, parentIds.mother, 'mother', sibling, used);
        const fatherId = this.resolveSiblingParent(sibling.fatherText, parentIds.father, 'father', sibling, used);
        if (!motherId && !fatherId) {
          throw new ValidationError(
            `To link ${sibling.person.first_name} as your sibling, enter your mother's or father's name (or theirs).`
          );
        }
        resolve(`sibling:${index}`, { ...sibling.person, mother_id: motherId, father_id: fatherId });
      });

      if (input.spouse) {
        const spouseId = resolve('spouse', input.spouse.person);
        this.addMarriage(personId, spouseId, input.spouse.marriage);
      }

      return {
        personId,
        linked: linked.map(({ role, id }) => ({ role, id, name: fullName(this.getPerson(id)) })),
      };
    });
  }

  // A sibling's parent is the registrant's own parent when left blank or when
  // the name entered matches that parent (by full name, surname or maiden
  // name); otherwise it is matched or created by name.
  resolveSiblingParent(text, ownParentId, role, sibling, used) {
    if (!text) return ownParentId || null;
    const key = normalizeKey(text);
    const own = this.getPerson(ownParentId);
    if (own) {
      const names = [fullName(own), own.last_name, own.maiden_name, own.maiden_name && `${own.first_name} ${own.maiden_name}`];
      if (names.some((n) => n && normalizeKey(n) === key)) return own.id;
    }
    const split = splitFullName(text);
    if (!split.last_name) {
      throw new ValidationError(
        `Please enter the full name of ${sibling.person.first_name}'s ${role === 'mother' ? "mother (her maiden name)" : 'father'}.`
      );
    }
    const candidate = role === 'mother' ? { ...split, maiden_name: split.last_name } : split;
    const id = this.upsertPerson(candidate, { exclude: used });
    used.add(id);
    return id;
  }

  // ----- editing -----------------------------------------------------------

  updatePerson(id, changes) {
    return this.transaction(() => {
      const person = this.requirePerson(id);
      const updated = { ...person };
      for (const field of EDITABLE_FIELDS) {
        if (!(field in changes)) continue;
        if (field === 'birth_date') updated[field] = cleanDate(changes[field], 'birth date');
        else if (field === 'death_date') updated[field] = cleanDate(changes[field], 'date of death');
        else if (field === 'email') updated[field] = cleanEmail(changes[field]);
        else if (field === 'deceased') updated[field] = truthy(changes[field]) ? 1 : 0;
        else updated[field] = clean(changes[field]);
      }
      updated.maiden_name = cleanMaiden(updated.first_name, updated.maiden_name);
      if (!updated.first_name && !updated.last_name) throw new ValidationError('A name is required.');
      // Unticking "deceased" clears the date; entering a date implies deceased.
      if ('deceased' in changes && !updated.deceased) updated.death_date = null;
      else if (updated.death_date) updated.deceased = 1;
      checkLifeDates(updated);
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
  // gains any facts only `removeId` had, and adopts its children, marriages,
  // photo tags and obituaries.
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
      for (const field of ['first_name', 'last_name', ...FACT_FIELDS]) {
        if (!merged[field] && remove[field]) merged[field] = remove[field];
      }
      merged.registered = keep.registered || remove.registered ? 1 : 0;
      merged.deceased = keep.deceased || remove.deceased ? 1 : 0;

      this.db.prepare('UPDATE people SET mother_id = ? WHERE mother_id = ?').run(keepId, removeId);
      this.db.prepare('UPDATE people SET father_id = ? WHERE father_id = ?').run(keepId, removeId);
      for (const m of this.marriagesOf(removeId)) {
        if (m.spouse_id !== keepId) {
          this.addMarriage(keepId, m.spouse_id, {
            marriage_date: m.marriage_date,
            marriage_year: m.marriage_year,
            marriage_city: m.marriage_city,
          });
        }
      }
      this.db.prepare('INSERT OR IGNORE INTO media_people (media_id, person_id) SELECT media_id, ? FROM media_people WHERE person_id = ?').run(keepId, removeId);
      this.db.prepare('UPDATE media SET person_id = ? WHERE person_id = ?').run(keepId, removeId);
      this.db.prepare('UPDATE users SET person_id = ? WHERE person_id = ?').run(keepId, removeId);
      // Clear the email first so the unique index allows moving it across.
      this.db.prepare('UPDATE people SET email = NULL WHERE id = ?').run(removeId);
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
    const brief = (p) =>
      p && {
        id: p.id,
        name: fullName(p),
        birth_date: p.birth_date,
        birth_city: p.birth_city,
        deceased: p.deceased,
        death_date: p.death_date,
      };
    const keys = [person.name_key, person.maiden_key].filter(Boolean);
    const marks = keys.map(() => '?').join(', ');
    return {
      ...person,
      mother: brief(this.getPerson(person.mother_id)),
      father: brief(this.getPerson(person.father_id)),
      children: this.childrenOf(person.id).map(brief),
      siblings: this.siblingsOf(person).map(brief),
      spouses: this.marriagesOf(person.id).map((m) => ({
        ...brief(this.getPerson(m.spouse_id)),
        marriage_id: m.id,
        marriage_date: m.marriage_date,
        marriage_year: m.marriage_year,
        marriage_city: m.marriage_city,
      })),
      possibleDuplicates: this.db
        .prepare(`SELECT * FROM people WHERE (name_key IN (${marks}) OR maiden_key IN (${marks})) AND id != ? ORDER BY id`)
        .all(...keys, ...keys, person.id)
        .map(brief),
    };
  }

  // Everyone connected to `id` through parent/child links and marriages
  // (capped at `limit`).
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
      const spouses = this.marriagesOf(current).map((m) => m.spouse_id);
      for (const next of [person.mother_id, person.father_id, ...spouses, ...kids.all(current, current).map((r) => r.id)]) {
        if (next && !seen.has(next)) queue.push(next);
      }
    }
    const people = [...seen.values()].map((p) => ({
      id: p.id,
      name: fullName(p),
      birth_date: p.birth_date,
      birth_city: p.birth_city,
      deceased: p.deceased,
      death_date: p.death_date,
      registered: p.registered,
      mother_id: seen.has(p.mother_id) ? p.mother_id : null,
      father_id: seen.has(p.father_id) ? p.father_id : null,
    }));
    const ids = [...seen.keys()];
    const marriages = ids.length
      ? this.db
          .prepare(
            `SELECT id, person1_id, person2_id, marriage_date, marriage_year FROM marriages
              WHERE person1_id IN (${ids.map(() => '?').join(',')}) AND person2_id IN (${ids.map(() => '?').join(',')})`
          )
          .all(...ids, ...ids)
      : [];
    return { focusId: Number(id), people, marriages, truncated: queue.some((q) => !seen.has(q)) };
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
      const married = this.marriagesOf(a.id).some((m) => m.spouse_id === b.id);
      return {
        a: brief(a),
        b: brief(b),
        related: married,
        description: married
          ? `${fullName(a)} and ${fullName(b)} are married.`
          : `No common ancestor has been recorded yet for ${fullName(a)} and ${fullName(b)}.`,
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
  if (row.maiden_name && candidate.maiden_name && !sameText(row.maiden_name, candidate.maiden_name)) return -1;
  if (row.death_date && candidate.death_date && row.death_date !== candidate.death_date) return -1;
  if (row.email && candidate.email && row.email.toLowerCase() !== candidate.email) return -1;
  if (row.mother_id && candidate.mother_id && row.mother_id !== candidate.mother_id) return -1;
  if (row.father_id && candidate.father_id && row.father_id !== candidate.father_id) return -1;
  let score = 0;
  if (row.birth_date && row.birth_date === candidate.birth_date) score += 4;
  if (row.mother_id && row.mother_id === candidate.mother_id) score += 3;
  if (row.father_id && row.father_id === candidate.father_id) score += 3;
  if (row.death_date && row.death_date === candidate.death_date) score += 2;
  if (row.maiden_name && candidate.maiden_name) score += 1;
  if (row.birth_city && candidate.birth_city) score += 1;
  return score;
}

function checkLifeDates(person) {
  const label = fullName(person) || 'this person';
  const today = new Date().toISOString().slice(0, 10);
  if (person.birth_date && person.birth_date > today) throw new ValidationError(`The birth date for ${label} is in the future.`);
  if (person.death_date && person.death_date > today) throw new ValidationError(`The date of death for ${label} is in the future.`);
  if (person.birth_date && person.death_date && person.death_date < person.birth_date) {
    throw new ValidationError(`The date of death for ${label} is before their birth date.`);
  }
}

// Reads the deceased checkbox and date of death for one person on the form.
function lifeStatus(form, prefix, label) {
  const deathDate = cleanDate(form[`${prefix}death_date`], `date of death for ${label}`);
  const deceased = truthy(form[`${prefix}deceased`]) || Boolean(deathDate);
  return { deceased, death_date: deceased ? deathDate : null };
}

function cleanMarriage(details) {
  const marriageDate = cleanDate(details.marriage_date, 'marriage date');
  let marriageYear = cleanYear(details.marriage_year, 'marriage year');
  if (marriageDate) {
    const fromDate = Number(marriageDate.slice(0, 4));
    if (marriageYear && marriageYear !== fromDate) {
      throw new ValidationError('The year married does not match the date married.');
    }
    marriageYear = fromDate;
  }
  return { marriage_date: marriageDate, marriage_year: marriageYear, marriage_city: clean(details.marriage_city) };
}

function parseSpouse(form) {
  const split = splitFullName(form.spouse_name);
  const marriage = cleanMarriage(form);
  if (!split) {
    if (clean(form.spouse_maiden_name) || marriage.marriage_date || marriage.marriage_year || marriage.marriage_city) {
      throw new ValidationError("Please enter your spouse's name to go with the marriage details.");
    }
    return null;
  }
  const person = {
    ...split,
    maiden_name: cleanMaiden(split.first_name, form.spouse_maiden_name),
    ...lifeStatus(form, 'spouse_', 'your spouse'),
  };
  checkLifeDates(person);
  return { person, marriage };
}

function parseRegistration(form = {}) {
  const first = clean(form.first_name);
  const last = clean(form.last_name);
  if (!first || !last) throw new ValidationError('First name and last name are required.');

  const self = {
    first_name: first,
    last_name: last,
    maiden_name: cleanMaiden(first, form.maiden_name),
    email: cleanEmail(form.email),
    home_address: clean(form.home_address),
    phone: clean(form.phone),
    birth_date: cleanDate(form.birth_date, 'birthday'),
    birth_city: clean(form.birth_city),
    ...lifeStatus(form, '', 'you'),
    registered: true,
  };
  checkLifeDates(self);

  const relative = (prefix, label, extra = {}) => {
    const split = splitFullName(form[`${prefix}name`]);
    const status = lifeStatus(form, prefix, label);
    if (!split) return null;
    const person = { ...split, ...status, ...extra };
    checkLifeDates(person);
    return person;
  };

  const mother = relative('mother_', 'your mother');
  if (mother) mother.maiden_name = cleanMaiden(mother.first_name, form.mother_maiden_name);
  const father = relative('father_', 'your father');

  const grandparent = (prefix, label) => {
    const birthDate = cleanDate(form[`${prefix}birth_date`], `birth date for your ${label}`);
    const birthCity = clean(form[`${prefix}birth_city`]);
    const person = relative(prefix, `your ${label}`, { birth_date: birthDate, birth_city: birthCity });
    if (!person && (birthDate || birthCity)) {
      throw new ValidationError('Please enter a name for each grandparent whose birth details you provide.');
    }
    return person;
  };
  const grandmother = grandparent('grandmother_', 'grandmother');
  const grandfather = grandparent('grandfather_', 'grandfather');

  const grandparentSide = form.grandparent_side === 'father' ? 'father' : 'mother';
  if ((grandmother || grandfather) && !(grandparentSide === 'father' ? father : mother)) {
    throw new ValidationError(
      `Please enter your ${grandparentSide}'s name so the grandparents on that side can be linked to them.`
    );
  }

  const rawSiblings = Array.isArray(form.siblings) ? form.siblings : [];
  if (rawSiblings.length > MAX_SIBLINGS) throw new ValidationError(`Please add at most ${MAX_SIBLINGS} siblings at a time.`);
  const siblings = [];
  for (const raw of rawSiblings) {
    if (!raw || typeof raw !== 'object') continue;
    const siblingFirst = clean(raw.first_name);
    const siblingLast = clean(raw.last_name);
    const hasAnything = siblingFirst || siblingLast || clean(raw.birth_date) || clean(raw.mother_maiden_name) || clean(raw.father_name);
    if (!hasAnything) continue;
    if (!siblingFirst) throw new ValidationError("Please enter each sibling's first name.");
    const label = `${siblingFirst} ${siblingLast || last}`;
    const person = {
      first_name: siblingFirst,
      last_name: siblingLast || last,
      birth_date: cleanDate(raw.birth_date, `birth date for ${label}`),
      ...lifeStatus(raw, '', label),
    };
    checkLifeDates(person);
    siblings.push({ person, motherText: clean(raw.mother_maiden_name), fatherText: clean(raw.father_name) });
  }

  const spouse = parseSpouse(form);
  return { self, mother, father, grandmother, grandfather, grandparentSide, siblings, spouse };
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
