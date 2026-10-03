# Family Reunion

A private web app where relatives add themselves and their family. Shared ancestors are linked automatically, so everyone's entries grow into one family tree. The tree comes with a searchable directory, family photos, obituaries and a shared calendar. Only invited family members can sign in, and every sign-in needs both a password and a code from an authenticator app.

## Features

- **Private, invitation-only access with two-step sign-in (MFA)**
  - Each sign-in needs a password plus a 6-digit code from an authenticator app such as Google Authenticator, Microsoft Authenticator, Authy or 1Password. The app is set up by scanning a QR code.
  - Ten one-time **backup codes** are issued for when a phone isn't available.
  - Family members join through **single-use invitation links** that expire after 7 days. Any member can create one.
  - Administrators can issue an **access reset link** to a member who forgot their password or lost their phone, make other members administrators, or remove accounts.
- **Add your family**: one form covers:
  - **You**: first and last name, maiden name, email, home address, phone, birthday and birth city.
  - **Parents**: mother's name and maiden name, and father's name.
  - **A grandmother and grandfather**: name, birth date and birth city for each, on your mother's or your father's side.
  - **Spouse**: spouse's name and maiden name, plus the year, date and city you married.
  - **Siblings**, as many as you like: first name, last name, mother's maiden name, father's name and birth date. If a sibling's parents are left blank, they're treated as the same as yours. Different parents make them a half-sibling.
  - **Living or deceased** for every person on the form. Ticking *Deceased* shows a **date of death** field and an **obituary upload** button.
- **Automatic linking of common ancestors**: anyone named who is already in the database is reused rather than duplicated. Matching uses both current and maiden names, so a mother entered as "Linda Baker" by one child and "Linda Jones (née Baker)" by her husband ends up as one person.
- **Searchable database**: search everyone by name, maiden name, city, email, phone, address or year.
- **Interactive family tree**: generations in rows, spouses side by side joined by a dashed line, and relatives who have passed shown "in memory".
- **Photos**: upload `.jpeg`, `.jpg`, `.gif`, `.tiff`, `.webp`, `.bmp` and `.png` files, up to 30 MB each and several at a time with progress bars.
  - Add a caption and date, and tag the people in each photo.
  - Search photos by caption, person, date, file name or who shared them.
  - Files are stored in a **separate media storage location** (see below).
- **Obituaries**: upload a PDF, Word document, text file or a photo/scan of the obituary for anyone marked deceased.
- **Calendar tab**: one shared calendar that every member sees.
  - It shows **everyone's birthdays** (with ages, and "would have been N" for those who have passed) and **wedding anniversaries**.
  - Members can **add their own events**, either one-off or repeating every year.
- **"How are we related?"** names the relationship between any two people, such as second cousins once removed, siblings or married.
- **Profile pages** let you edit details, add a spouse, merge duplicate records, view a person's photos and manage their obituary.

## Getting started

Requires **Node.js 22.13 or newer**.

```bash
npm install      # one small dependency: qrcode
npm start        # http://localhost:3000
npm test         # run the test suite
```

The first time the server starts, it prints a one-time **setup code**:

```
No accounts exist yet. Open the site and create the administrator account
with this one-time setup code:  K7QM-2XPA-9DTR
```

Open the site, enter the setup code, and create the administrator account. You'll set up your authenticator app and save your backup codes. Then go to **Account → Invite family** to create invitation links for relatives.

The setup code changes each time the server restarts until the first account exists, so someone who reaches a new installation first can't take it over. You can set your own code with the `SETUP_CODE` environment variable.

## Configuration

| Variable        | Default                       | Purpose |
|-----------------|-------------------------------|---------|
| `PORT`          | `3000`                        | HTTP port |
| `DATA_DIR`      | `./data`                      | Folder for the database |
| `DB_FILE`       | `$DATA_DIR/family-reunion.db` | SQLite database file |
| `MEDIA_DIR`     | `./media`                     | **Photo and obituary storage** |
| `SETUP_CODE`    | random, printed at startup    | Code needed to create the first account |
| `COOKIE_SECURE` | off                           | Set to `1` when serving over HTTPS (recommended) |
| `TRUST_PROXY`   | off                           | Set to `1` behind a reverse proxy so rate limits see real client IPs |

### Separate photo storage

Photos and obituaries are written to `MEDIA_DIR`, not the database. Point it at a different drive, a NAS share or another mounted volume to keep the files on their own storage device:

```bash
MEDIA_DIR=/mnt/family-photos npm start
```

Files are saved as `photos/<year>/<month>/<random id>.<ext>` and `obituaries/<year>/<month>/…`. The searchable index of captions, dates, tags and uploaders stays in the database, so search is fast even with a large photo library. Each upload's type is checked against both its extension and its content. A `.png` must really be a PNG, for example.

Storage goes through a small interface in `src/media.js` (`LocalStorage`), so a cloud object-storage backend can be added later without changing the rest of the app.

Back up `DATA_DIR` and `MEDIA_DIR` together.

## Security notes

- Passwords are hashed with scrypt. Sessions are random tokens stored hashed, sent in `HttpOnly`, `SameSite=Lax` cookies, and replaced after the authenticator step.
- Failed passwords are rate-limited per account and per IP address. Wrong authenticator codes are limited both per sign-in attempt and per account. Each TOTP code can be used only once.
- Every request that changes data must carry a custom header, which blocks cross-site request forgery. Pages are served with a strict Content-Security-Policy, and uploaded files are served sandboxed.
- **Serve the app over HTTPS** in production, for example behind Caddy or nginx, and set `COOKIE_SECURE=1`.

## How ancestors are matched

Names are compared without regard to case, spacing or punctuation, and a person can match on their current name or their maiden name. An existing record is reused unless one of its known facts contradicts the new entry: a different birth date, birth city, maiden name, date of death, email address, mother or father. When several records qualify, the one sharing the most facts wins. The form is processed from the oldest generation down, so two people with the same name can be told apart by who their parents are. A record is never linked so that someone becomes their own ancestor.

When matching can't decide, such as two different spellings of a name, the profile page lists **possible duplicates**, and you can combine them in one click. Combining also moves marriages, photo tags and obituaries.

## Project layout

```
server.js           HTTP server: static files, JSON API, sessions, security headers
src/schema.js       Database schema and upgrades
src/store.js        People, marriages, matching/linking, search, tree, relationships
src/auth.js         Accounts, sessions, MFA, backup codes, invitations, resets
src/totp.js         RFC 6238 one-time codes
src/media.js        Photo/obituary uploads, file-type checks, storage, search
src/calendar.js     Birthdays, anniversaries and family events
public/             Front end (index.html, styles.css, js/*.js modules)
test/               node:test suites
```
