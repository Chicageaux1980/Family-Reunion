'use strict';

// Database schema for every part of the app, plus in-place upgrades for
// databases created by earlier versions.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
    id           INTEGER PRIMARY KEY,
    first_name   TEXT NOT NULL DEFAULT '',
    last_name    TEXT NOT NULL DEFAULT '',
    name_key     TEXT NOT NULL,
    maiden_name  TEXT,
    maiden_key   TEXT,
    email        TEXT,
    home_address TEXT,
    phone        TEXT,
    birth_date   TEXT,
    birth_city   TEXT,
    deceased     INTEGER NOT NULL DEFAULT 0,
    death_date   TEXT,
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

  -- person1_id is always the smaller id so each couple has exactly one row.
  CREATE TABLE IF NOT EXISTS marriages (
    id             INTEGER PRIMARY KEY,
    person1_id     INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    person2_id     INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    marriage_date  TEXT,
    marriage_year  INTEGER,
    marriage_city  TEXT,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (person1_id, person2_id),
    CHECK (person1_id < person2_id)
  );
  CREATE INDEX IF NOT EXISTS idx_marriages_person2 ON marriages(person2_id);

  CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name        TEXT NOT NULL,
    password_hash       TEXT NOT NULL,
    is_admin            INTEGER NOT NULL DEFAULT 0,
    totp_secret         TEXT,
    totp_pending_secret TEXT,
    totp_enabled        INTEGER NOT NULL DEFAULT 0,
    totp_last_step      INTEGER NOT NULL DEFAULT 0,
    person_id           INTEGER REFERENCES people(id) ON DELETE SET NULL,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at       TEXT
  );

  -- stage: 'mfa' (password ok, code needed), 'mfa_setup' (must enrol an
  -- authenticator) or 'full' (signed in).
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage        TEXT NOT NULL,
    mfa_failures INTEGER NOT NULL DEFAULT 0,
    expires_at   INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS backup_codes (
    id        INTEGER PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_backup_codes_user ON backup_codes(user_id);

  -- kind: 'invite' (join the family) or 'reset' (regain access to user_id).
  CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY,
    code_hash   TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL DEFAULT 'invite',
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    note        TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at  INTEGER NOT NULL,
    used_at     TEXT,
    used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Files themselves live in the media storage directory; this is the
  -- searchable index. kind: 'photo' or 'obituary'.
  CREATE TABLE IF NOT EXISTS media (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL,
    storage_key   TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL,
    caption       TEXT,
    taken_date    TEXT,
    person_id     INTEGER REFERENCES people(id) ON DELETE SET NULL,
    uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
  CREATE INDEX IF NOT EXISTS idx_media_person ON media(person_id);

  CREATE TABLE IF NOT EXISTS media_people (
    media_id  INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, person_id)
  );
  CREATE INDEX IF NOT EXISTS idx_media_people_person ON media_people(person_id);

  CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY,
    title          TEXT NOT NULL,
    event_date     TEXT NOT NULL,
    event_time     TEXT,
    location       TEXT,
    description    TEXT,
    repeats_yearly INTEGER NOT NULL DEFAULT 0,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
`;

// Columns added to `people` after the first release.
const PEOPLE_UPGRADES = [
  ['maiden_name', 'TEXT'],
  ['maiden_key', 'TEXT'],
  ['deceased', 'INTEGER NOT NULL DEFAULT 0'],
  ['death_date', 'TEXT'],
];

function migrate(db) {
  const hasPeople = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'people'").get();
  if (hasPeople) {
    const columns = new Set(db.prepare('PRAGMA table_info(people)').all().map((c) => c.name));
    for (const [name, type] of PEOPLE_UPGRADES) {
      if (!columns.has(name)) db.exec(`ALTER TABLE people ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(SCHEMA);
  db.exec('CREATE INDEX IF NOT EXISTS idx_people_maiden_key ON people(maiden_key)');
}

module.exports = { migrate };
