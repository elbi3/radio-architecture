// One API, two storage engines: /api/pg/... and /api/mongo/...  (camelCase JSON both ways)
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Pool } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');

const pool = new Pool({ connectionString: process.env.PG_URL || 'postgres://postgres:postgres@localhost:5432/recordings' });
const mc = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27017');
let mdb;
const bad = (s, m) => Object.assign(new Error(m), { status: s });
const need = x => { if (!x) throw bad(404, 'not found'); return x; };

/* ---------- PostgreSQL ---------- */
const snake = k => k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const cam = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v]));
const q = async (s, p = []) => (await pool.query(s, p)).rows.map(cam);
const one = async (s, p) => need((await q(s, p))[0]);
const ins = (t, ok, b) => {          // column names come from our whitelist, values are parameterized
  const k = ok.filter(x => b[x] !== undefined);
  return one(`INSERT INTO ${t}(${k.map(snake)}) VALUES(${k.map((_, i) => '$' + (i + 1))}) RETURNING *`, k.map(x => b[x]));
};
const upd = (t, ok, id, b, w = '') => {
  const k = ok.filter(x => b[x] !== undefined);
  if (!k.length) throw bad(400, 'no updatable fields in body');
  return one(`UPDATE ${t} SET ${k.map((x, i) => snake(x) + '=$' + (i + 2)).concat('updated_at=now()')} WHERE id=$1 ${w} RETURNING *`, [id, ...k.map(x => b[x])]);
};
const del = t => async id => { need((await pool.query(`DELETE FROM ${t} WHERE id=$1`, [id])).rowCount); return { deleted: true }; };

const pg = {
  users: {
    create: b => ins('users', ['email', 'displayName', 'avatarUrl'], b),
    get: id => one('SELECT * FROM users WHERE id=$1', [id]),
    list: () => q('SELECT * FROM users ORDER BY created_at DESC LIMIT 100'),
    update: (id, b) => upd('users', ['displayName', 'avatarUrl'], id, b),
    remove: del('users'),                                   // FK cascades do the rest
  },
  recordings: {
    create: b => ins('recordings', ['ownerId', 'title', 'description', 'durationMs', 'recordedAt'], b),
    get: id => one('SELECT * FROM recordings WHERE id=$1 AND deleted_at IS NULL', [id]),
    list: () => q('SELECT * FROM recordings WHERE deleted_at IS NULL ORDER BY recorded_at DESC LIMIT 100'),
    update: async (id, b) => {
      const r = await upd('recordings', ['title', 'description', 'visibility', 'storageState', 'objectKey'], id, b, 'AND deleted_at IS NULL');
      if (r.visibility === 'private') await pool.query('DELETE FROM radio_station_items WHERE recording_id=$1', [id]);
      return r;
    },
    remove: async id => {                                    // soft delete + pull from queues, atomically
      await one(`WITH d AS (DELETE FROM radio_station_items WHERE recording_id=$1)
                 UPDATE recordings SET deleted_at=now(), visibility='private', updated_at=now()
                 WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
      return { deleted: true };
    },
  },
  stations: {
    create: b => ins('radio_stations', ['ownerId', 'name', 'description'], b),
    // One round trip: station + ordered queue as a JSON array
    get: id => one(`SELECT s.*, COALESCE(json_agg(json_build_object('itemId', i.id, 'recordingId', r.id,
                      'title', r.title, 'durationMs', r.duration_ms, 'position', i.position)
                      ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL), '[]') AS queue
                    FROM radio_stations s
                    LEFT JOIN radio_station_items i ON i.station_id = s.id
                    LEFT JOIN recordings r ON r.id = i.recording_id
                    WHERE s.id=$1 GROUP BY s.id`, [id]),
    list: () => q('SELECT * FROM radio_stations ORDER BY created_at DESC LIMIT 100'),
    update: (id, b) => upd('radio_stations', ['name', 'description', 'isLive'], id, b),
    remove: del('radio_stations'),
    addItem: async (id, b) => {
      const r = await q(`INSERT INTO radio_station_items(station_id, owner_id, recording_id, position)
        SELECT s.id, s.owner_id, r.id, (SELECT COALESCE(MAX(position),0)+1 FROM radio_station_items WHERE station_id=s.id)
        FROM radio_stations s JOIN recordings r ON r.id=$2 AND r.owner_id=s.owner_id
          AND r.visibility<>'private' AND r.deleted_at IS NULL
        WHERE s.id=$1 RETURNING *`, [id, b.recordingId]);
      if (!r[0]) throw bad(422, 'station or recording not found, different owner, or recording is private');
      return r[0];
    },
  },
};

/* ---------- MongoDB (station embeds its queue => one findOne reads everything) ---------- */
const col = n => mdb.collection(n), now = () => new Date();
const oid = v => { try { return new ObjectId(String(v)); } catch { throw bad(400, 'invalid id'); } };
const pick = (ok, b) => Object.fromEntries(ok.filter(k => b[k] !== undefined).map(k => [k, b[k]]));
const owner = async v => {           // no FKs in Mongo: integrity lives here
  const id = oid(v);
  if (!await col('users').findOne({ _id: id }, { projection: { _id: 1 } })) throw bad(422, 'owner not found');
  return id;
};
const after = { returnDocument: 'after' };

const mg = {
  users: {
    create: async b => {
      if (!b.email) throw bad(422, 'email required');
      const d = { ...pick(['email', 'displayName', 'avatarUrl'], b), createdAt: now(), updatedAt: now() };
      await col('users').insertOne(d); return d;
    },
    get: async id => need(await col('users').findOne({ _id: oid(id) })),
    list: () => col('users').find().sort({ createdAt: -1 }).limit(100).toArray(),
    update: async (id, b) => need(await col('users').findOneAndUpdate({ _id: oid(id) },
      { $set: { ...pick(['displayName', 'avatarUrl'], b), updatedAt: now() } }, after)),
    remove: async id => {
      const _id = oid(id); need((await col('users').deleteOne({ _id })).deletedCount);
      await col('recordings').deleteMany({ ownerId: _id }); await col('stations').deleteMany({ ownerId: _id });
      return { deleted: true };
    },
  },
  recordings: {
    create: async b => {
      if (!Number.isInteger(b.durationMs)) throw bad(422, 'durationMs required');
      const d = { ownerId: await owner(b.ownerId), clientRecordingId: b.clientRecordingId || crypto.randomUUID(),
        title: b.title || 'Untitled', description: b.description ?? null, durationMs: b.durationMs,
        recordedAt: b.recordedAt ? new Date(b.recordedAt) : now(), storage: { state: 'local_only', objectKey: null },
        visibility: 'private', createdAt: now(), updatedAt: now(), deletedAt: null };
      await col('recordings').insertOne(d); return d;
    },
    get: async id => need(await col('recordings').findOne({ _id: oid(id), deletedAt: null })),
    list: () => col('recordings').find({ deletedAt: null }).sort({ recordedAt: -1 }).limit(100).toArray(),
    update: async (id, b) => {
      const cur = need(await col('recordings').findOne({ _id: oid(id), deletedAt: null }));
      const set = { ...pick(['title', 'description', 'visibility'], b), updatedAt: now() };
      if (b.storageState) set['storage.state'] = b.storageState;
      if (b.objectKey) set['storage.objectKey'] = b.objectKey;
      const vis = set.visibility || cur.visibility, st = b.storageState || cur.storage.state;
      if (vis !== 'private' && st !== 'uploaded') throw bad(422, 'only uploaded recordings can be non-private');
      await col('recordings').updateOne({ _id: cur._id }, { $set: set });
      if (set.title)   // fan out the denormalized title snapshot
        await col('stations').updateMany({ 'queue.recordingId': cur._id }, { $set: { 'queue.$[e].title': set.title } },
          { arrayFilters: [{ 'e.recordingId': cur._id }] });
      if (vis === 'private') await col('stations').updateMany({}, { $pull: { queue: { recordingId: cur._id } } });
      return col('recordings').findOne({ _id: cur._id });
    },
    remove: async id => {
      const _id = oid(id);
      need((await col('recordings').updateOne({ _id, deletedAt: null }, { $set: { deletedAt: now(), visibility: 'private', updatedAt: now() } })).matchedCount);
      await col('stations').updateMany({}, { $pull: { queue: { recordingId: _id } } });
      return { deleted: true };
    },
  },
  stations: {
    create: async b => {
      if (!b.name) throw bad(422, 'name required');
      const d = { ownerId: await owner(b.ownerId), name: b.name, description: b.description ?? null, isLive: false,
        nowPlaying: null, queue: [], createdAt: now(), updatedAt: now() };
      await col('stations').insertOne(d); return d;
    },
    get: async id => need(await col('stations').findOne({ _id: oid(id) })),     // station + queue in one query
    list: () => col('stations').find({}, { projection: { queue: 0 } }).sort({ createdAt: -1 }).limit(100).toArray(),
    update: async (id, b) => need(await col('stations').findOneAndUpdate({ _id: oid(id) },
      { $set: { ...pick(['name', 'description', 'isLive'], b), updatedAt: now() } }, after)),
    remove: async id => { need((await col('stations').deleteOne({ _id: oid(id) })).deletedCount); return { deleted: true }; },
    addItem: async (id, b) => {
      const rec = await col('recordings').findOne({ _id: oid(b.recordingId), deletedAt: null, visibility: { $ne: 'private' } });
      const ok = rec && (await col('stations').updateOne({ _id: oid(id), ownerId: rec.ownerId },
        { $push: { queue: { recordingId: rec._id, title: rec.title, durationMs: rec.durationMs } }, $set: { updatedAt: now() } })).matchedCount;
      if (!ok) throw bad(422, 'station or recording not found, different owner, or recording is private');
      return mg.stations.get(id);
    },
  },
};

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json());
app.use((req, _s, next) => { req.body = req.body || {}; next(); });
app.use((req, res, next) => { res.on('finish', () => console.log(req.method, req.originalUrl, res.statusCode)); next(); });
app.use(express.static(path.join(__dirname, 'public')));
const wrap = (f, code = 200) => async (req, res, next) => {
  try { res.status(code).json(await f(req)); } catch (e) { next(e); }
};
const repo = (db, r) => { const x = ({ pg, mongo: mg })[db]?.[r]; if (!x) throw bad(404, 'unknown db or resource'); return x; };
const R = (req, r = req.params.res) => repo(req.params.db, r);

app.get('/api/:db/:res', wrap(r => R(r).list()));
app.get('/api/:db/:res/:id', wrap(r => R(r).get(r.params.id)));
app.post('/api/:db/:res', wrap(r => R(r).create(r.body), 201));
app.patch('/api/:db/:res/:id', wrap(r => R(r).update(r.params.id, r.body)));
app.delete('/api/:db/:res/:id', wrap(r => R(r).remove(r.params.id)));
app.post('/api/:db/stations/:id/items', wrap(r => R(r, 'stations').addItem(r.params.id, r.body), 201));

const CODES = { '23505': 409, '23503': 422, '23514': 422, '23502': 422, '22P02': 400, '11000': 409 };
app.use((e, _req, res, _next) => {
  res.status(e.status || CODES[String(e.code)] || 500).json({ error: e.message });
});

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await mc.connect(); mdb = mc.db('recordings');
  await Promise.all([
    col('users').createIndex({ email: 1 }, { unique: true }),
    col('recordings').createIndex({ ownerId: 1, clientRecordingId: 1 }, { unique: true }),
    col('recordings').createIndex({ ownerId: 1, recordedAt: -1 }),
    col('stations').createIndex({ ownerId: 1 }, { unique: true }),
    col('stations').createIndex({ 'queue.recordingId': 1 }),
  ]);
  app.listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
})().catch(e => { console.error(e); process.exit(1); });
