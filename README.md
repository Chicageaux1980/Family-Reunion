# Family Reunion

A web app where relatives add themselves and their ancestors. Shared ancestors are linked automatically, so everyone's entries grow into one family tree you can search and explore.

## Features

- **Join the family**: a form for your first and last name, email, home address, phone number, birthday and birth city, plus your mother's and father's names and a grandmother and grandfather (each with name, birth date and birth city). You choose whether the grandparents are on your mother's side or your father's side.
- **Automatic ancestor linking**: everyone named in a form becomes a person in the database. When a parent or grandparent matches someone already recorded, the existing record is reused, so siblings share parents and cousins share grandparents.
- **Searchable database**: search everyone by name, city, email, phone, address or birth year, and filter to registered members only.
- **Interactive family tree**: a tree of everyone connected to a person, laid out by generation. Click a person to centre the tree on them, or double-click to open their profile.
- **"How are we related?"**: pick any two people to see their closest common ancestors and the relationship. Examples: siblings, aunt/uncle, second cousins once removed.
- **Profile tools**: edit a person's details, combine duplicate records, or remove a person.

## How ancestors are matched

Names are compared without regard to case, spacing or punctuation. A record with the same name is reused unless one of its known facts contradicts the new entry: a different birth date, birth city, email address, mother or father. When several records qualify, the one sharing the most facts wins. The form is processed from the oldest generation down, so two people with the same name can be told apart by who their parents are. A record is never linked so that someone becomes their own ancestor.

Name matching can't catch everything. One relative might enter a mother's maiden name while another enters her married name. When that happens, the profile page lists **possible duplicates** that share the name, and you can combine them in one click.

## Running it

Requires **Node.js 22.13 or newer**. The app has no dependencies to install: it uses Node's built-in `node:sqlite`.

```bash
npm start        # http://localhost:3000
npm test         # run the test suite
```

Environment variables:

| Variable   | Default                    | Purpose                    |
|------------|----------------------------|----------------------------|
| `PORT`     | `3000`                     | HTTP port                  |
| `DATA_DIR` | `./data`                   | Folder for the database    |
| `DB_FILE`  | `$DATA_DIR/family-reunion.db` | SQLite database file path |

## Project layout

```
server.js          HTTP server: static files + JSON API
src/store.js       SQLite schema, matching/linking, search, tree and relationship logic
public/            Single-page front end (index.html, app.js, styles.css)
test/              node:test suites for the store and the HTTP API
```

### API

| Method | Path                              | Description                              |
|--------|-----------------------------------|------------------------------------------|
| POST   | `/api/register`                   | Submit the registration form             |
| GET    | `/api/people?q=&registered=1`     | Search people                            |
| GET    | `/api/people/:id`                 | Person with parents, siblings, children  |
| PATCH  | `/api/people/:id`                 | Edit a person's details                  |
| DELETE | `/api/people/:id`                 | Remove a person                          |
| POST   | `/api/people/:id/merge`           | Merge `{ merge_id }` into this person    |
| GET    | `/api/people/:id/tree`            | Everyone connected to this person        |
| GET    | `/api/relationship?a=&b=`         | How two people are related               |
| GET    | `/api/stats`                      | Counts for the home page                 |

## Privacy note

The app has no login, so anyone who can open it can see and edit everyone's contact details. Run it on a private network, or put it behind authentication (for example, a reverse proxy with basic auth), before sharing it widely.
