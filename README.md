# SANParks FRIMS — Field Ranger & Incident Management System

Node.js + Express + SQLite (better-sqlite3) + JWT, with a single-page front-end served from the same app.

## Run it (2 minutes)

```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node 20 or newer. The SQLite database (`data/frims.db`) is created and seeded automatically on first run.
No `.env` file is needed locally. Run the tests with `npm test`.

## Demo accounts

| Role                 | Username     | Password     | Lands on                          |
|----------------------|--------------|--------------|-----------------------------------|
| Field Ranger         | `t.nkosi`    | `Ranger@123` | Mobile log-incident screen        |
| Section Ranger       | `s.mahlangu` | `Ranger@123` | Dashboard (Kruger South)          |
| Regional Ecologist   | `ecologist`  | `Eco@123`    | Dashboard (all sections, read-only) + audit log |
| System Administrator | `admin`      | `Admin@123`  | Dashboard + user management + audit log |

Others: `m.dlamini`, `k.vanwyk`, `n.zulu` (field rangers, Kruger South), `j.botha` (section ranger, Kruger North), `p.molefe` (field ranger, Kruger North) — password `Ranger@123`.

## What each role can do

| Capability                                   | Field Ranger | Section Ranger | Ecologist | Admin |
|----------------------------------------------|:-:|:-:|:-:|:-:|
| Log incidents (GPS, photo, live severity tag, works offline) | ✔ | | | |
| See own incidents                            | ✔ | | | |
| See incidents, stats, map, alerts            | | own section | all (filter by section) | all (filter by section) |
| Escalate / resolve / reopen incidents        | | own section | | ✔ |
| Export CSV / print PDF                       | | own section | all | all |
| View audit log                               | | | ✔ | ✔ |
| Create / edit / deactivate users             | | | | ✔ |

Scoping is enforced **on the server** (`src/scope.js`), not just hidden in the UI.

## How it works

- **Severity** ("AI suggestion") is calculated by the server (`src/triage.js`, rule-based: incident type + keywords in the notes). The client cannot choose severity or status. High → status *Escalated* and an alert is raised.
- **Offline queue**: if the network is down when a ranger submits, the report is saved on the device and sent automatically when the connection returns (or via *Profile → Sync now*). A `client_id` makes retries idempotent, so nothing is duplicated.
- **Security**: bcrypt password hashes, JWT (re-checked against the DB on every request, so deactivating a user takes effect immediately), role guards, input validation, parameterised SQL only, HTML-escaped output, strict Content-Security-Policy, login rate-limiting, CSV formula-injection protection, image-type whitelist for uploads, audit log that never stores password hashes.

## Project layout

```
server.js              start-up
src/app.js             express app (headers, routes, static files)
src/db.js              schema, indexes, seed data
src/auth.js            JWT + bcrypt helpers
src/middleware.js      authenticate, authorize, validate, error handlers
src/scope.js           role-based data scoping
src/triage.js          severity rules        src/audit.js  audit trail
src/routes/            auth, incidents, users, alerts, reports, audit
public/                index.html, styles.css, js/api.js, js/app.js, vendor/ (Leaflet, Chart.js)
tests/api.test.js      unit + integration tests (node:test)
render.yaml            Render blueprint       .github/workflows/ci-cd.yml   CI + deploy
```

## REST API (all JSON; all except login/health need `Authorization: Bearer <token>`)

| Method & path | Purpose | Roles |
|---|---|---|
| `POST /api/auth/login` · `GET /api/auth/me` | sign in / current user | any |
| `GET /api/incidents` (`status,severity,type,section_id,from,to,q,limit`) | list (scoped) | any |
| `GET /api/incidents/stats` · `GET /api/incidents/:id` | dashboard stats / detail + audit trail | any (scoped) |
| `POST /api/incidents/triage` | severity preview | any |
| `POST /api/incidents` | log incident | field & section ranger |
| `PATCH /api/incidents/:id` | change status/severity | section ranger, admin |
| `GET /api/alerts` · `PATCH /api/alerts/:id/read` · `PATCH /api/alerts/read-all` | alerts | section ranger, ecologist, admin |
| `GET /api/reports/incidents.csv` (or `.json`) | export | section ranger, ecologist, admin |
| `GET/POST /api/users` · `PATCH/DELETE /api/users/:id` · `GET /api/users/sections` | user admin (DELETE = deactivate) | admin |
| `GET /api/audit` | audit log | admin, ecologist |
| `GET /api/health` | health check | public |

## Deploy to Render

1. Push to GitHub, then in Render choose **New → Blueprint** and select the repo (`render.yaml` does the rest; `JWT_SECRET` is generated for you).
2. In the Render service, copy the **Deploy Hook** URL into a GitHub repo secret named `RENDER_DEPLOY_HOOK`. Every push to `main` that passes the tests then deploys.
3. Branching: `feature/*` → PR into `develop` → PR into `main`. CI runs on all pushes and PRs.

**Render free plan note:** the disk is ephemeral, so data and photos reset when the service restarts or redeploys (the demo data is re-seeded). See the comments in `render.yaml` for adding a persistent disk.

## Before real-world use

- Remove the demo-account buttons from `public/index.html` and change the seeded passwords.
- The map needs internet access for OpenStreetMap tiles; everything else is served locally.
- Uploaded photos are served from `/uploads/<random name>` without a login (names are unguessable); put them behind auth if that is not acceptable.
