# Recordings and Radio: PostgreSQL vs MongoDB Demo

A small Node.js service that stores the same domain in two databases so the designs can be compared side by side.

**Domain:** a user records audio and keeps it private by default. They can put a recording on their own radio station, and (in the full design) share it so other users can "grab" it. A station plays an ordered queue of its owner's recordings.

The schema and code were drafted with an AI assistant (Claude) and then audited, corrected and run by the author. This README documents how to run it, the exact prompts used, and a critique of where the AI's output was wrong or made questionable trade-offs.

Demo recording: _add link here_

---

## Contents

1. [What's in the repo](#1-whats-in-the-repo)
2. [Setup](#2-setup)
3. [Using the demo UI](#3-using-the-demo-ui)
4. [API reference](#4-api-reference)
5. [Data models](#5-data-models)
6. [QA checklist mapping](#6-qa-checklist-mapping)
7. [Exact prompts used](#7-exact-prompts-used)
8. [Critique of the AI's output](#8-critique-of-the-ais-output)
9. [Known limitations](#9-known-limitations)

---

## 1. What's in the repo

```
.
├── README.md
├── package.json          express, pg, mongodb
├── docker-compose.yml    Postgres 16 + Mongo 7
├── schema.sql            Postgres schema (idempotent; applied at server start)
├── server.js             Express API, one repository per database
└── public/
    └── index.html        Guided demo UI (must live in public/)
```

`server.js` exposes one API shape under two prefixes, `/api/pg/...` and `/api/mongo/...`, so the same UI and the same `curl` commands work against both databases.

---

## 2. Setup

### Prerequisites

- Node.js 18 or newer
- Docker with Compose v2 (`docker compose ...`)
- Free ports: **3000** (app), **5432** (Postgres), **27017** (Mongo)

### Steps

```bash
# 1. Start both databases
docker compose up -d
docker compose ps          # postgres and mongo should both be "running"
                           # wait ~5 seconds on a fresh start

# 2. Install dependencies
npm install

# 3. Start the app
npm start                  # prints http://localhost:3000
```

Then open **http://localhost:3000**.

On startup the server:

1. Runs `schema.sql` against Postgres (all statements are `IF NOT EXISTS` or guarded, so reruns are safe).
2. Connects to Mongo (database `recordings`) and creates its indexes.
3. Starts listening and prints one line per request: `METHOD /path status`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PG_URL` | `postgres://postgres:postgres@localhost:5432/recordings` | Postgres connection |
| `MONGO_URL` | `mongodb://localhost:27017` | Mongo connection (database name is fixed to `recordings`) |
| `PORT` | `3000` | HTTP port, for example `PORT=3001 npm start` |

### Reset to a clean state

```bash
docker compose down -v     # removes containers and their data
docker compose up -d
```

Wait a few seconds before `npm start`.

### Inspecting the data directly

```bash
# Postgres
docker compose exec postgres psql -U postgres -d recordings
#   \dt                     list tables
#   \d radio_station_items  columns, constraints, foreign keys
#   SELECT * FROM radio_station_items;
#   \q                      leave psql

# Mongo
docker compose exec mongo mongosh recordings
#   show collections
#   db.stations.find().pretty()
#   exit
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot GET /` in the browser | `index.html` is not in `public/` | Create `public/` and move `index.html` into it |
| `EADDRINUSE ... :3000` | An old server is still running | Ctrl+C in its terminal, or `fuser -k 3000/tcp`, or `PORT=3001 npm start` |
| `ECONNREFUSED 127.0.0.1:5432` | Postgres is not running or still starting | `docker compose up -d`, wait ~5 s, retry |
| `port is already allocated` | Another Postgres or Mongo uses 5432 or 27017 | Stop it, or change the port mappings and set `PG_URL` and `MONGO_URL` |
| Stuck in `psql` or `mongosh` | Wrong exit command | `\q` for psql, `exit` for mongosh |
| `GET /favicon.ico 404` in the log | Browser asks for a tab icon | Harmless |

---

## 3. Using the demo UI

Pick **PostgreSQL** or **MongoDB** at the top. Each database keeps its own selected user, recording and station (shown in the line at the top), because IDs differ between engines. Work top to bottom:

1. **Create user**
2. **Create recording** (private by default)
3. **Put recording on radio** (marks it uploaded and visible to radio)
4. **Create station** (one per user)
5. **Add to station queue**, then **View station and queue**

The most useful demonstration is the order of steps 3 and 5. Clicking **Add to station queue** before step 3 returns `422 Rejected by a rule`, because private recordings cannot be queued. After step 3 it succeeds.

Other buttons: **Rename it** (update an attribute on a recording or station), the **Delete** buttons (recording, station, user), and **All users / All recordings / All stations** (list).

---

## 4. API reference

All bodies and responses are JSON with camelCase fields. `:db` is `pg` or `mongo`. `:res` is `users`, `recordings` or `stations`.

| Operation | Request |
|---|---|
| Create | `POST /api/:db/:res` |
| Read by ID | `GET /api/:db/:res/:id` |
| List all (max 100) | `GET /api/:db/:res` |
| Update attributes | `PATCH /api/:db/:res/:id` |
| Delete | `DELETE /api/:db/:res/:id` |
| Add recording to queue | `POST /api/:db/stations/:id/items` |

Accepted fields (anything else is ignored):

| Resource | Create | Update |
|---|---|---|
| `users` | `email` (required), `displayName`, `avatarUrl` | `displayName`, `avatarUrl` |
| `recordings` | `ownerId` (required), `durationMs` (required), `title`, `description`, `recordedAt` | `title`, `description`, `visibility`, `storageState`, `objectKey` |
| `stations` | `ownerId` (required), `name` (required), `description` | `name`, `description`, `isLive` |
| queue item | `recordingId` | n/a |

Status codes:

| Code | Meaning |
|---|---|
| 200 / 201 | Success / created (creates and queue adds return 201) |
| 400 | Malformed ID or JSON, or an empty update body (Postgres path) |
| 404 | Record not found (or soft-deleted) |
| 409 | Unique violation: duplicate email, second station for a user, duplicate client recording ID |
| 422 | Rule violation: foreign key, CHECK, NOT NULL, missing owner, private recording queued |

Example:

```bash
curl -X POST localhost:3000/api/pg/users -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","displayName":"Ana"}'

curl -X PATCH localhost:3000/api/pg/recordings/<id> -H "Content-Type: application/json" \
  -d '{"storageState":"uploaded","objectKey":"demo/a.m4a","visibility":"radio"}'
```

---

## 5. Data models

### PostgreSQL (`schema.sql`)

```mermaid
erDiagram
  users ||--o{ recordings : owns
  users ||--o| radio_stations : "owns one"
  users ||--o{ recording_grabs : grabs
  users ||--o{ radio_subscriptions : follows
  recordings ||--o{ recording_grabs : "grabbed by"
  radio_stations ||--o{ radio_station_items : queue
  recordings ||--o{ radio_station_items : "played as"
  radio_stations ||--o{ radio_subscriptions : "followed by"
```

Six tables. Every table has a primary key and `created_at`; mutable tables also have `updated_at`.

- **Foreign keys** all declare their delete behavior. User deletion cascades to recordings, stations, grabs and subscriptions. `radio_stations.current_item_id` uses `ON DELETE SET NULL`.
- **Composite foreign keys** on `radio_station_items`: `(station_id, owner_id)` and `(recording_id, owner_id)`. The database itself rejects a station that plays someone else's recording.
- **CHECK constraints:** a recording may only be non-private when `storage_state = 'uploaded'`, and an uploaded recording must have an `object_key`.
- **Indexes** cover each FK that is queried or cascaded through, plus `recordings (owner_id, recorded_at DESC)` and a partial index for shared recordings.

`recording_grabs` and `radio_subscriptions` exist in the schema, but no API endpoints use them yet.

### MongoDB

Three collections are used by the app: `users`, `recordings`, `stations`.

```js
// stations: the queue is embedded, so one findOne returns the whole station
{ _id, ownerId, name, description, isLive: false, nowPlaying: null,
  queue: [ { recordingId, title, durationMs }, ... ],   // title is a snapshot
  createdAt, updatedAt }

// recordings: nested storage subdocument
{ _id, ownerId, clientRecordingId, title, description, durationMs, recordedAt,
  storage: { state: "local_only" | "uploading" | "uploaded" | "failed", objectKey },
  visibility: "private" | "radio" | "shared", createdAt, updatedAt, deletedAt }
```

Indexes: unique `users.email`; unique `(ownerId, clientRecordingId)`; `(ownerId, recordedAt desc)`; unique `stations.ownerId`; multikey `stations.queue.recordingId`.

### Same rule, different enforcement

| Rule | PostgreSQL | MongoDB |
|---|---|---|
| Owner must exist | Foreign key | `owner()` check in `server.js` |
| Non-private requires uploaded | CHECK constraint | Check in `recordings.update` |
| Station plays only its owner's recordings | Composite FK | Query filter on `ownerId` in `addItem` |
| Delete user removes their data | `ON DELETE CASCADE` | Manual `deleteMany` calls |
| Delete recording leaves queues | Query deletes `radio_station_items` rows | `$pull` from `stations.queue` |
| One station per user | `UNIQUE (owner_id)` | Unique index on `ownerId` |
| Read station with queue | `LEFT JOIN` plus `json_agg` | One `findOne` |
| Rename recording shows in queue | Automatic (join reads live data) | Fan-out `updateMany` with `arrayFilters` |

---

## 6. QA checklist mapping

| Checklist item | How it is exercised |
|---|---|
| SQL create and read with join | Create user, recording, station, queue item; `GET /api/pg/stations/:id` returns the joined queue |
| SQL update | Rename the station, read it back |
| SQL delete and cascade | Delete the station, then `SELECT * FROM radio_station_items;` is empty. Delete a user and the recordings are gone |
| SQL negative constraint | In `psql`: `INSERT INTO recordings (owner_id, duration_ms) VALUES (gen_random_uuid(), 1000);` fails with a foreign key violation. Via the API, a made-up `ownerId` returns 422 |
| NoSQL create and read | `GET /api/mongo/stations/:id` is a single `findOne` with the queue embedded |
| NoSQL embedded update | Adding to the queue is a `$push`. Renaming a recording updates the embedded title |
| NoSQL delete | Delete a recording and the queue entry is pulled |
| UI and responsive | Chrome device toolbar (Ctrl+Shift+M). Try a very long title. Result text wraps rather than clipping |
| Network status codes | DevTools Network tab: 201, 200, 400, 404, 409, 422 as above |
| Terminal health | One log line per request. Queries use `$1, $2...` placeholders via `pool.query`; Mongo values go through driver calls |

---

## 7. Exact prompts used

These are the author's prompts, reproduced verbatim (including typos).

### Prompt 1: initial design

```text
Hi, happy Monday. I'd like your help as a senior database architect. I am working on making the database design for a particular scenario. A user can hear songs, and record them in our app, and then save that particular song to their user account. I want to design a domain data model for this feature. I don't have all the details yet since we are still in the design and ideation phase, but I do need something realistic in place so we can get our demo up for user testing. If the storage works conceptually, I am sure we can use it in our implementation phase with very little refinement. Can you help me generate the initial schema definitions and CRUD implementation for a relational database (probably our user table at least), and then a NoSQL implementation? I am leaning toward having the user store the recorded songs locally on device (cell phone), unless you have an alternative suggestion. I also need to provide functionality for users to have their own "radio" going that other users can subscribe to. Can you help me architect this scenario? I'd like to get the main ideas down before making a mock-up.
```

The AI proposed a shared `songs` catalog, `recordings`, `saved_songs`, radio tables, and a hybrid on-device and server storage model. It also recommended that radio reference licensed catalog tracks.

### Prompt 2: scope correction

```text
Ok, Iike where you are headed. However, for this scenario, we are assuming the individual essentially owns the song they record. I've left out some key information, so it requires a bit of suspension of disbelief, if that makes sense. I think order of priority is allowing users to store their recorded songs (for personal use and then the radio-broadcast feature), and then if they choose to upload/share other users can grab their songs. Again, I'm leaving some details out to try to keep this as agnostic as possible.
```

The AI dropped the catalog, made the recording the primary asset, and added `visibility`, `storage_state`, `recording_grabs`, and composite foreign keys for stations.

### Prompt 3: audit and working application

```text
Ok, this is great. I'd like to make a mock-up that I can share with the other devs on my team. Just to double-check our work, can you make sure the relational db storage has normalized (3NF) tables with primary keys, foreign keys, timestamps, and indexes and that we ensure proper referential integrity (e.g., ON DELETE CASCADE). For out MongoDB NoSQL db, check that we design an idiomatic document model for the exact same domain and optimize for reading a complete project with its associated tasks in a single query (denormalized or embedded array). I want to do a working application/CRUD service with NOde.js and implement basic endpoints/methods for both databases: 
     * Create a record/document
     * Read by ID and list all records
     * Update an attribute
     * Delete a record
IF you could do a minimal frontend so we can verify these operations against both databses, I'd love that. Feel free to interpret the scenario as you like, I just need to get something reasonably accurate in front of these guys so we can keep the project going.
```

The prompt mentions "projects" and "tasks", which do not exist in this domain. The AI interpreted a radio station as the project and its queue as the tasks. This produced `schema.sql`, `server.js`, `package.json`, `docker-compose.yml` and the first UI.

### Prompt 4: QA checklist

```text
One more thing, can you help me verify we are able to get through this checklist: Step 3: Web Project Testing & Quality Assurance (QA) Checklist
Run your polyglot database application through this QA framework. You will demonstrate these live in your recording:

* [ ] 1. Relational (SQL) CRUD & Integrity Tests:
   * Create & Read: Successfully insert a parent and related child record (e.g., Project and Task); verify that relational joins retrieve the complete joined dataset.
   * Update: Update a record attribute and verify data reflects immediately in subsequent reads.
   * Delete & Cascade: Delete a parent record and verify that child records either cascade-delete or restrict deletion according to foreign key rules.
   * Negative Constraint Test: Attempt to insert an orphaned record with an invalid foreign key ID and verify the database rejects the insert with a constraint error.
* [ ] 2. NoSQL CRUD & Document Tests:
   * Create & Read: Insert a complete document; verify that retrieving the document requires a single query without manual multi-collection joins.
   * Update: Perform an atomic update on an embedded field or push a new sub-item into an embedded array.
   * Delete: Remove a document and verify clean state cleanup.
* [ ] 3. UI & Responsive Design (If using a frontend):
   * Data tables/forms render cleanly on both desktop and mobile viewports.
   * Forms handle empty inputs and long text strings without UI clipping.
* [ ] 4. Browser Console & Terminal Health:
   * Browser DevTools Network tab shows proper HTTP status codes (200 OK, 201 Created, 400 Bad Request, 404 Not Found).
   * Terminal/console logs show parameterized queries executing without runtime database driver warnings or connection leaks.
```

The AI mapped each item to a concrete check, and recommended two code changes: returning 201 on creates and logging one line per request.

### Later, unlogged conversation

After these prompts there was further conversation (setup errors, a request for a simpler UI, and demo scripts). That text is not reproduced here. The resulting changes are described in section 8.4.

---

## 8. Critique of the AI's output

### 8.1 Schema defects and hallucinations

| # | What the AI produced | Why it is wrong | Resolution |
|---|---|---|---|
| 1 | Subscribe query `UPDATE radio_stations SET subscriber_count = subscriber_count + 1 WHERE id = $1 AND FOUND;` | `FOUND` is a PL/pgSQL variable, not valid in plain SQL. Even if it worked, the counter would increment when the insert hit `ON CONFLICT DO NOTHING`, so retried subscribes would inflate it. The AI's own comment ("check rowcount in app code") admitted the query was not real | Removed the counter (item 2). A correct version must check the insert's row count in app code |
| 2 | `subscriber_count` and `grab_count` columns | Derived data stored beside its source. It violates 3NF and can silently drift from the true count | Dropped both. Use `COUNT(*)`, or add a counter later as a deliberate optimization |
| 3 | `radio_stations.current_item_id uuid` with no foreign key | A "pointer" the database cannot validate. It can reference a deleted or nonexistent item | Added `FOREIGN KEY ... ON DELETE SET NULL` after the items table exists |
| 4 | `users.deleted_at` (soft delete) alongside `ON DELETE CASCADE` foreign keys | The two policies conflict. A soft-deleted user keeps all data, so the cascades never fire, and in the first draft `recordings.user_id` had no delete rule at all | The demo uses hard delete for users so cascades are real. Soft delete remains on recordings only. A production design should choose one policy deliberately |
| 5 | Composite FK `recordings(id, owner_id)` from queue items with no `ON DELETE` rule | The default (`NO ACTION`) blocks cleanup paths and complicates hard deletes of recordings | Added `ON DELETE CASCADE` |
| 6 | `updated_at` missing on some tables, FK columns without supporting indexes | Violates the "timestamps and indexes" requirement of prompt 3 | Added `updated_at` to mutable tables and indexes on queried FKs |
| 7 | Idempotent create: `ON CONFLICT (owner_id, client_recording_id) DO UPDATE SET title = ...` | If the existing row is soft-deleted, the upsert updates a deleted row and leaves it deleted. A device re-syncing a deleted recording would silently go nowhere | Not implemented in the demo (it uses a plain insert). Flagged as a future issue |
| 8 | Mongo "insert subscription, then `$inc` subscriberCount" | Two non-atomic writes. A crash between them leaves the counter wrong, and the AI hand-waved this as "periodic reconciliation" | Counters removed from the demo model |
| 9 | "Cap the queue at ~200 items" | Stated as a design rule, but nothing enforces it. An embedded array can grow toward the 16 MB document limit | Still unenforced (section 9) |

### 8.2 Unwarranted assumptions

- **A song catalog the author never asked for.** Prompt 1 said users "hear songs, and record them". The AI invented recognition, provider IDs (Spotify, Apple), an ISRC column, and a licensing-driven rule that radio must play catalog tracks. Prompt 2 had to undo all of that. The lesson is that the AI filled an under-specified brief with a plausible but unrequested product.
- **"Projects with tasks".** Prompt 3's wording belongs to a generic assignment and does not match the domain. The AI silently reinterpreted it (station as project, queue as tasks) and did not flag the mismatch until after it had built it.
- **A bias toward Postgres.** The AI repeatedly described the domain as "clearly relational". That is defensible, but it should have been stated as a judgment, not a fact. Mongo is a good fit for the "read a whole station" access pattern.

### 8.3 Architectural trade-offs

- **Enforcing rules in the database or in code.** Postgres rejects an orphan, a private-but-queued recording, or a station playing someone else's audio, regardless of which code path wrote the data. Mongo enforces the same rules only in `server.js`. Any other writer (a script, a future service) can bypass them. This is the strongest argument for Postgres as the source of truth.
- **Reads: join versus embed.** The embedded queue makes "open a station" one `findOne`. The cost is staleness: queue titles are snapshots, so renames need a fan-out `updateMany`, and deletes need `$pull` across stations. Postgres reads the live row at the cost of a join.
- **Deliberate 3NF exception.** `radio_station_items.owner_id` duplicates the station's owner so a composite FK can enforce "own recordings only". It buys database-level integrity at the price of one redundant column. A trigger is the purist alternative.
- **Hard versus soft delete.** Recordings are soft-deleted (so background jobs can clean up the audio object), and users and stations are hard-deleted. That mix is pragmatic but inconsistent.
- **Local-first versus server metadata.** The design keeps raw audio on the device but syncs metadata to the server, because a device-only library cannot support sharing or radio. Sharing implies upload. The demo models the states (`storage_state`) but does not implement upload.
- **Grab as reference, not copy.** One stored object with many references makes revocation easy and storage cheap, but it conflicts with the user expectation that "grabbing" keeps a copy. This was raised as an open decision and never resolved.
- **Counters versus counts.** Removing denormalized counters keeps 3NF and avoids drift, but listing popular recordings would need aggregation or a materialized view.

### 8.4 Problems found while running it

- **Syntax error in the generated `server.js`.** The error-handler middleware did not parse. It was caught by `node --check` and rewritten with a named status-code map.
- **File layout.** The files were delivered flat, but the server serves `public/index.html`, producing `Cannot GET /`. This confused the author and cost setup time.
- **Hidden state in the first UI.** The first UI was a raw API tester ("Update ID with body"). The queue button silently used the "last recording" the page remembered, which caused unexplained 422s. It was rewritten as a numbered, step-by-step page with per-database state and plain-language results.
- **Unverified claims.** The AI initially said how things "should" behave (status codes, responsive layout) without being able to run them. Anything not demonstrated live should be treated as unverified.

---

## 9. Known limitations

- **No authentication or authorization.** `ownerId` is supplied in the request body, and list endpoints return every user's records, including private recordings. This is demo-only.
- **Mongo validation gap.** `visibility` and `storageState` are not checked against allowed values on the Mongo path. For example, an uploaded recording could be set to `visibility: "banana"`. Postgres rejects this with CHECK constraints. A `$jsonSchema` validator on the collection would close the gap.
- **Email uniqueness differs.** Postgres uses `citext` (case-insensitive), while Mongo's unique index is case-sensitive, so `Ana@x.com` and `ana@x.com` can both exist there.
- **Update behavior differs on empty bodies.** The Postgres path returns 400 for an empty update. The Mongo path accepts it and only refreshes `updatedAt`.
- **Queue position race.** Positions are computed as `MAX(position)+1`. Two concurrent adds could collide on the `UNIQUE (station_id, position)` constraint and one would fail with a 409.
- **Multi-step operations are not all atomic.** Postgres `remove` for a recording is atomic (one CTE), but making a recording private does two statements. Mongo's recording update and delete touch several collections without a transaction.
- **Queue cap not enforced** in Mongo (see 8.1, item 9).
- **Not implemented:** grab and subscribe endpoints, real audio upload and signed URLs, live radio playback (now-playing timeline), and the on-device SQLite sync layer.
- **No automated tests and no migration tool.** `schema.sql` is applied on every start, and testing was manual through the UI and `psql`/`mongosh`.