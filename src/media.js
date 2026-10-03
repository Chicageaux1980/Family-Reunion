'use strict';

// Photos and obituaries. Files are written to a separate media storage
// location (MEDIA_DIR, typically a different disk or network mount), while a
// searchable index of captions, dates and the people in each file is kept in
// the database.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { ValidationError, NotFoundError, AuthError, clean, cleanMultiline, cleanDate, normalizeKey } = require('./util');

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const ascii = (buf, start, text) => buf.subarray(start, start + text.length).toString('latin1') === text;

// Each allowed file type, with a check on the file's first bytes so a file
// can't pretend to be something it isn't.
const FILE_TYPES = {
  jpeg: { mime: 'image/jpeg', image: true, sniff: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpg: { mime: 'image/jpeg', image: true, sniff: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  png: { mime: 'image/png', image: true, sniff: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  gif: { mime: 'image/gif', image: true, sniff: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a') },
  tiff: {
    mime: 'image/tiff',
    image: true,
    sniff: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  tif: {
    mime: 'image/tiff',
    image: true,
    sniff: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  webp: { mime: 'image/webp', image: true, sniff: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  bmp: { mime: 'image/bmp', image: true, sniff: (b) => ascii(b, 0, 'BM') },
  pdf: { mime: 'application/pdf', sniff: (b) => ascii(b, 0, '%PDF-') },
  doc: { mime: 'application/msword', sniff: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sniff: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  },
  rtf: { mime: 'application/rtf', sniff: (b) => ascii(b, 0, '{\\rtf') },
  txt: { mime: 'text/plain; charset=utf-8', sniff: (b) => !b.includes(0) },
};

const PHOTO_EXTENSIONS = ['jpeg', 'jpg', 'gif', 'tiff', 'tif', 'webp', 'bmp', 'png'];
const OBITUARY_EXTENSIONS = ['pdf', 'doc', 'docx', 'rtf', 'txt', ...PHOTO_EXTENSIONS];
const ALLOWED = { photo: PHOTO_EXTENSIONS, obituary: OBITUARY_EXTENSIONS };

// Stores files on a local or mounted filesystem. Another backend (such as
// cloud object storage) only needs the same four methods.
class LocalStorage {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(path.join(this.root, '.incoming'), { recursive: true });
  }

  resolve(key) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key.');
    return full;
  }

  tempPath() {
    return path.join(this.root, '.incoming', crypto.randomUUID());
  }

  async commit(tempFile, key) {
    const target = this.resolve(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(tempFile, target);
  }

  createReadStream(key) {
    return fs.createReadStream(this.resolve(key));
  }

  async remove(key) {
    await fsp.rm(this.resolve(key), { force: true });
  }
}

function extensionOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

function safeFilename(filename) {
  const base = path.basename(String(filename || 'file')).replace(/[^\w.\- ()]+/g, '_').slice(-150);
  return base || 'file';
}

class MediaService {
  constructor(db, storage) {
    this.db = db;
    this.storage = storage;
  }

  static allowedExtensions(kind) {
    return ALLOWED[kind] || [];
  }

  // Streams an upload from `source` into storage after validating its type
  // and size, then indexes it. `meta`: { kind, filename, size, caption,
  // taken_date, people: [ids], person_id }.
  async upload(source, meta, user) {
    const kind = meta.kind === 'obituary' ? 'obituary' : meta.kind === 'photo' ? 'photo' : null;
    if (!kind) throw new ValidationError('Unknown upload type.');
    const extension = extensionOf(meta.filename);
    if (!ALLOWED[kind].includes(extension)) {
      throw new ValidationError(
        `${kind === 'photo' ? 'Photos' : 'Obituaries'} must be one of these file types: ${ALLOWED[kind]
          .filter((e) => e !== 'tif')
          .map((e) => `.${e}`)
          .join(', ')}.`
      );
    }
    const declared = Number(meta.size);
    if (!Number.isFinite(declared) || declared <= 0) throw new ValidationError('The file is empty.');
    if (declared > MAX_UPLOAD_BYTES) throw tooLarge();

    const caption = cleanMultiline(meta.caption, 1000);
    const takenDate = cleanDate(meta.taken_date, 'photo date');
    const people = this.validPeople(meta.people);
    let personId = null;
    if (kind === 'obituary') {
      const person = this.db.prepare('SELECT id, deceased FROM people WHERE id = ?').get(Number(meta.person_id));
      if (!person) throw new ValidationError('Please choose whose obituary this is.');
      if (!person.deceased) throw new ValidationError('Obituaries can only be added for someone marked as deceased.');
      personId = person.id;
      if (!people.includes(personId)) people.push(personId);
    }

    const temp = this.storage.tempPath();
    try {
      let received = 0;
      const counter = new Transform({
        transform(chunk, _enc, done) {
          received += chunk.length;
          if (received > MAX_UPLOAD_BYTES) return done(tooLarge());
          done(null, chunk);
        },
      });
      await pipeline(source, counter, fs.createWriteStream(temp, { flags: 'wx' }));
      if (received === 0) throw new ValidationError('The file is empty.');

      const head = Buffer.alloc(4096);
      const handle = await fsp.open(temp, 'r');
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(head, 0, head.length, 0));
      } finally {
        await handle.close();
      }
      const type = FILE_TYPES[extension];
      if (!type.sniff(head.subarray(0, bytesRead))) {
        throw new ValidationError(`"${safeFilename(meta.filename)}" does not look like a real .${extension} file.`);
      }

      const now = new Date();
      const key = `${kind === 'photo' ? 'photos' : 'obituaries'}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${extension}`;
      await this.storage.commit(temp, key);
      try {
        const result = this.db
          .prepare(
            `INSERT INTO media (kind, storage_key, original_name, mime_type, size, caption, taken_date, person_id, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(kind, key, safeFilename(meta.filename), type.mime, received, caption, takenDate, personId, user ? user.id : null);
        const mediaId = Number(result.lastInsertRowid);
        this.setPeople(mediaId, people);
        return this.get(mediaId);
      } catch (err) {
        await this.storage.remove(key);
        throw err;
      }
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }

  validPeople(raw) {
    const ids = (Array.isArray(raw) ? raw : String(raw || '').split(','))
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);
    const unique = [...new Set(ids)].slice(0, 100);
    if (!unique.length) return [];
    const found = this.db
      .prepare(`SELECT id FROM people WHERE id IN (${unique.map(() => '?').join(',')})`)
      .all(...unique)
      .map((r) => r.id);
    return unique.filter((id) => found.includes(id));
  }

  setPeople(mediaId, people) {
    this.db.prepare('DELETE FROM media_people WHERE media_id = ?').run(mediaId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO media_people (media_id, person_id) VALUES (?, ?)');
    for (const personId of people) insert.run(mediaId, personId);
  }

  get(id) {
    const row = this.db
      .prepare(
        `SELECT m.*, u.display_name AS uploaded_by_name
           FROM media m LEFT JOIN users u ON u.id = m.uploaded_by
          WHERE m.id = ?`
      )
      .get(Number(id));
    if (!row) throw new NotFoundError('That file was not found.');
    return this.decorate(row);
  }

  decorate(row) {
    const people = this.db
      .prepare(
        `SELECT p.id, trim(p.first_name || ' ' || p.last_name) AS name
           FROM media_people mp JOIN people p ON p.id = mp.person_id
          WHERE mp.media_id = ? ORDER BY p.last_name, p.first_name`
      )
      .all(row.id);
    const { storage_key, ...rest } = row;
    return { ...rest, is_image: Boolean(FILE_TYPES[extensionOf(storage_key)]?.image), people, url: `/api/media/${row.id}/file` };
  }

  // Searches captions, file names, dates, uploader and the names of everyone
  // tagged in each file.
  search({ q = '', kind = 'photo', personId = null, limit = 60, offset = 0 } = {}) {
    const terms = normalizeKey(q).split(' ').filter(Boolean).slice(0, 8);
    const where = [];
    const params = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (personId) {
      where.push('id IN (SELECT media_id FROM media_people WHERE person_id = ?)');
      params.push(Number(personId));
    }
    for (const term of terms) {
      where.push('haystack LIKE ?');
      params.push(`%${term}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const base = `
      SELECT * FROM (
        SELECT m.*, u.display_name AS uploaded_by_name,
               lower(coalesce(m.caption, '') || ' ' || m.original_name || ' ' || coalesce(m.taken_date, '') || ' ' ||
                     coalesce(u.display_name, '') || ' ' ||
                     coalesce((SELECT group_concat(p.first_name || ' ' || p.last_name || ' ' || coalesce(p.maiden_name, ''), ' ')
                                 FROM media_people mp JOIN people p ON p.id = mp.person_id
                                WHERE mp.media_id = m.id), '')) AS haystack
          FROM media m LEFT JOIN users u ON u.id = m.uploaded_by
      ) ${clause}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...params).n;
    const rows = this.db
      .prepare(`${base} ORDER BY coalesce(taken_date, created_at) DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(Math.max(Number(limit) || 60, 1), 200), Math.max(Number(offset) || 0, 0));
    return { total, results: rows.map(({ haystack, ...row }) => this.decorate(row)) };
  }

  update(id, changes) {
    const media = this.get(id);
    const caption = 'caption' in changes ? cleanMultiline(changes.caption, 1000) : media.caption;
    const takenDate = 'taken_date' in changes ? cleanDate(changes.taken_date, 'photo date') : media.taken_date;
    this.db.prepare('UPDATE media SET caption = ?, taken_date = ? WHERE id = ?').run(caption, takenDate, media.id);
    if ('people' in changes) {
      const people = this.validPeople(changes.people);
      if (media.person_id && !people.includes(media.person_id)) people.push(media.person_id);
      this.setPeople(media.id, people);
    }
    return this.get(media.id);
  }

  async remove(id, user) {
    const row = this.db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id));
    if (!row) throw new NotFoundError('That file was not found.');
    if (!user.is_admin && row.uploaded_by !== user.id) {
      throw new AuthError('Only the person who uploaded this file, or an administrator, can delete it.', 403);
    }
    this.db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    await this.storage.remove(row.storage_key);
  }

  // Returns { record, stream } for serving a stored file.
  open(id) {
    const row = this.db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id));
    if (!row) throw new NotFoundError('That file was not found.');
    return { record: row, stream: this.storage.createReadStream(row.storage_key) };
  }
}

function tooLarge() {
  const err = new ValidationError(`Files can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  err.status = 413;
  return err;
}

module.exports = { MediaService, LocalStorage, FILE_TYPES, PHOTO_EXTENSIONS, OBITUARY_EXTENSIONS, MAX_UPLOAD_BYTES };
