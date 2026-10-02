/**
 * The admin import restores what the export wrote — the 5.6.x version (`Q-205`, `Q-206`, ported by `Q-218`).
 *
 * Main's version of this file (`b569c464`) holds main's import, which is a restore through the arrival writer with
 * a new response shape, a seq refusal and `D-9` stamping. 5.6.2 carries only the `Fixed` half of that change, so
 * this file holds the fixes AND pins every cut — a cut case of main's was removed and written back as the answer
 * 5.6.1 gives, so a port that brings main's behaviour along fails here rather than shipping it in a patch.
 *
 * ## The fixes (red on 5.6.1)
 *
 *  - **F14, what this instance derives is dropped**: `embedding`, `embeddingModel`, `matchedText` are re-derived
 *    here, so a restored copy must not carry another model's.
 *  - **F14, the stamps are kept as what they are**: a retention stamp is a Date the sweep compares — JSON turned it
 *    into text, and text never compares with a Date, so a restored record the backup said would expire never did.
 *    A stamp that does not parse is removed rather than stored as text.
 *  - **F14, the counter moves past the highest PLAUSIBLE imported seq**, or the next local write sorts below a
 *    restored record that every peer already holds. A seq that fails the plausibility rule is stored (C7) but never
 *    moves the counter.
 *  - **F7, a repeated id stores the highest seq; an equal seq keeps the first**, as every other door reads a page.
 *  - **F13, the export carries links**, so export -> wipe -> import restores every family. Links were never
 *    exported, so a restore lost every link while reporting success.
 *
 * ## The cuts (green on 5.6.1, and must stay green)
 *
 *  - **C5, the response shape**: `{ spaceId, results }`, each family `{ inserted, updated, errors }` (plus
 *    `schemaViolations` only when there are some), and collapsed, derived and duplicate documents counted as 5.6.1
 *    counted them. No `refused`, `derived` or `restoredOverTombstone` keys.
 *  - **C6, derived file records are restored as 5.6.1 restored them**: a chunk and a face record are REPLACED in,
 *    so face labels survive a restore, and a file row is replaced (its sizes and hashes kept), not merged.
 *  - **C7, no import seq refusal**: an odd seq is stored as 5.6.1 stored it.
 *  - **C4, no `D-9`**: an imported record with no stamp stays unstamped; one that carries a stamp keeps it.
 *  - **F13's limit**: the export's projection stays `{ embedding: 0 }`, so `embeddingModel` and `matchedText` stay
 *    in the export, as `12-admin-api` promises.
 *  - **PINS**: imported records are queued for embedding (a link is not); the write is unguarded, so a same-seq or
 *    lower-seq re-import writes its content.
 *
 * Families are DERIVED from `REPLICATED_FAMILIES` (the import and export key a family by its collection), with a
 * floor, and a family found with no fixture fails rather than going unchecked.
 *
 * Run: node --test testing/standalone/an-import-restores-what-the-export-wrote-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-import-restore-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';

const SPACE = 'restore';
const KEEP = 'restore-keep'; // a retention window at space level, a shorter one on one fact type
const SPACE_WINDOW_DAYS = 30;
const SCHEMA_WINDOW_DAYS = 5;
const BRIEF = 'brief';
const CREATED = Date.parse('2026-06-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const author = { instanceId: 'origin', instanceLabel: 'Origin' };

let mongo, importMod, families, recordTypeOf, wireKeys, localOnly, seqMod, server, base, adminKey;
const coll = (space, c) => mongo.col(`${space}_${c}`);
const DERIVED_EMBED = ['embedding', 'embeddingModel', 'matchedText'];

/** One exported document per collection. A FIXTURE, literal on purpose; the derivation decides one is owed. */
function fixture(collection, id, seq, over = {}) {
  const common = { _id: id, spaceId: 'elsewhere', tags: [], author, createdAt: iso(CREATED), updatedAt: iso(CREATED),
    ...(seq === undefined ? {} : { seq }) };
  const shapes = {
    facts: { fact: `fact ${id}` },
    entities: { name: `Entity ${id}`, type: 'concept', properties: {} },
    edges: { from: `from-${id}`, to: `to-${id}`, label: `rel_${id.replace(/\W/g, '_')}` },
    chrono: { title: `chrono ${id}`, type: 'event', startsAt: iso(CREATED), status: 'upcoming' },
    links: { from: `src-${id}`, fromKind: 'fact', to: `dst-${id}`, toKind: 'entity', label: 'mentions' },
    files: { path: id },
  };
  assert.ok(shapes[collection], `no exported-document fixture for collection '${collection}' — add one`);
  return { ...common, ...shapes[collection], ...over };
}
const CONTENT_KEY = { facts: 'fact', entities: 'name', edges: 'label', chrono: 'title', links: 'from', files: 'path' };
/** A file chunk and a face record, as the export carries them (C6: both restored as 5.6.1 restored them). */
const FILE_CHUNK = (seq) => fixture('files', 'trip/a.md#chunk0', seq,
  { parentFileId: 'trip/a.md', chunkIndex: 0, text: 'the first passage' });
const FACE_RECORD = () => fixture('files', 'img.png#face-chunk0', undefined,
  { parentFileId: 'img.png', faceEntityId: 'person-1', faceLabel: 'Ada', bbox: [0, 0, 1, 1] });

const importKeys = () => families.map(f => f.collection);
async function wipe(space) {
  for (const c of [...importKeys(), 'embed_jobs', 'tombstones']) await coll(space, c).deleteMany({});
  await mongo.col('ythril_counters').deleteMany({ _id: space });
}

describe('the admin import restores what the export wrote (5.6.x: fixes red-first, cuts pinned)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'restore-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [
        { id: SPACE, label: 'Restore', folders: [], meta: {} },
        { id: KEEP, label: 'Keep', folders: [], recordTtlDays: SPACE_WINDOW_DAYS,
          meta: { typeSchemas: { fact: { [BRIEF]: { retention: { days: SCHEMA_WINDOW_DAYS } } } } } },
      ],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('importrestore');
    importMod = await import('../../server/dist/api/admin-import.js');
    seqMod = await import('../../server/dist/util/seq.js');
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    const kinds = await import('../../server/dist/config/types-knowledge.js');
    recordTypeOf = Object.fromEntries(families.map(f => [f.collection,
      Object.entries(kinds.RECORD_COLLECTION).find(([, c]) => c === f.collection)?.[0] ?? null]));
    const shared = await import('../../server/dist/api/sync/_shared.js');
    wireKeys = new Set(Object.keys(shared.IncomingFileMetaDoc.shape));
    ({ LOCAL_ONLY_FIELDS: localOnly } = await import('../../server/dist/sync/local-only-fields.js'));
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(r => server?.close(r));
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await wipe(SPACE); await wipe(KEEP); });

  it('the derivation finds every replicated family, and the import accepts each one', () => {
    assert.ok(families.length >= 6, `only ${families.length} replicated families — the registry moved`);
    for (const k of importKeys()) {
      assert.match(importMod.importPayloadError({ [k]: 'not an array' }) ?? '', new RegExp(k),
        `the import does not accept family '${k}' as a key`);
    }
    assert.ok(wireKeys.size >= 8 && wireKeys.has('path'), `the file wire keys did not derive: ${[...wireKeys]}`);
    assert.ok(DERIVED_EMBED.every(f => localOnly.has(f)), 'the derived embed fields are no longer local-only');
  });

  it('C7: an odd seq is stored as 5.6.1 stored it, and an implausible one never moves the counter (F14)', async () => {
    const ODD = { string: '7', negative: -1, fraction: 1.5, implausible: seqMod.MAX_INGEST_SEQ + 1, absent: undefined };
    const payload = {};
    const sent = [];
    for (const c of importKeys()) {
      payload[c] = [];
      for (const [why, seq] of Object.entries(ODD)) {
        const id = c === 'files' ? `odd/${why}.md` : `odd-${c}-${why}`;
        payload[c].push(fixture(c, id, seq));
        sent.push({ c, id, why });
      }
    }
    const out = await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const s of sent) {
      if (await coll(SPACE, s.c).countDocuments({ _id: s.id }) !== 1) wrong.push(`${s.c}/${s.id} (${s.why} seq) was not stored`);
    }
    for (const c of importKeys()) {
      const r = out.results[c];
      if (r.errors !== 0 || r.inserted !== Object.keys(ODD).length) wrong.push(`${c}: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(wrong, [], 'an import refused a record for its seq. 5.6.1 stores what the backup holds and 5.6.x '
      + 'keeps that (C7: main\'s import seq refusal is cut)');
    assert.ok(await seqMod.currentSeq(SPACE) < 1000,
      `an implausible imported seq moved the counter to ${await seqMod.currentSeq(SPACE)}: every later local write now `
      + 'sits inside the ceiling reserve');
  });

  it('PIN: a file metadata record with no seq is restored, and is not an error', async () => {
    const out = await importMod.importDocuments(SPACE, { files: [fixture('files', 'legacy/old.md', undefined)] });
    assert.equal(await coll(SPACE, 'files').countDocuments({ _id: 'legacy/old.md' }), 1, 'a pre-4.0 file was refused');
    assert.equal(out.results.files.errors, 0);
  });

  it('F14: the export\'s retention stamps are kept as Dates, sentinels included; syncBase is kept', async () => {
    const EPOCH = '1970-01-01T00:00:00.000Z';
    const FAR = '9999-12-31T23:59:59.999Z';
    const STAMP = '2027-03-04T05:06:07.000Z';
    const payload = {};
    const want = [];
    for (const c of importKeys()) {
      if (recordTypeOf[c] === null) continue; // links carry no retention
      const id = c === 'files' ? 'kept/stamp.md' : `stamp-${c}`;
      const stamp = c === 'facts' ? EPOCH : c === 'entities' ? FAR : STAMP;
      payload[c] = [fixture(c, id, 40, {
        _expireAt: stamp,
        ...(c === 'chrono' ? { _contentExpireAt: EPOCH } : {}),
        ...(c === 'files' ? { syncBase: { 'peer-x': 'sha-agreed' } } : {}),
      })];
      want.push({ c, id, field: '_expireAt', at: Date.parse(stamp) });
      if (c === 'chrono') want.push({ c, id, field: '_contentExpireAt', at: Date.parse(EPOCH) });
    }
    assert.ok(want.length >= 5, 'fixture check: fewer than five stamped families');
    await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const w of want) {
      const stored = await coll(SPACE, w.c).findOne({ _id: w.id });
      const v = stored?.[w.field];
      if (!(v instanceof Date) || v.getTime() !== w.at) {
        wrong.push(`${w.c}/${w.id}.${w.field}: stored ${JSON.stringify(v)} (${v === undefined ? 'absent' : typeof v}), want the Date ${iso(w.at)}`);
      }
    }
    const file = await coll(SPACE, 'files').findOne({ _id: 'kept/stamp.md' });
    if (file?.syncBase?.['peer-x'] !== 'sha-agreed') wrong.push(`files syncBase not kept: ${JSON.stringify(file?.syncBase)}`);
    assert.deepEqual(wrong, [], 'a restored stamp is not a stamp the sweep acts on: stored as text it never compares '
      + 'with a Date, so a record the backup said would expire never does');
  });

  it('F14: a stamp that does not parse is removed, never stored as text', async () => {
    await importMod.importDocuments(SPACE, { facts: [fixture('facts', 'bad-stamp', 41, { _expireAt: 'not a date' })] });
    const stored = await coll(SPACE, 'facts').findOne({ _id: 'bad-stamp' });
    assert.ok(stored, 'fixture check: the record was not stored');
    assert.equal(stored._expireAt, undefined, `an unparsable stamp was stored as ${JSON.stringify(stored._expireAt)}`);
  });

  it('F14: the derived embed fields are dropped; C6: chunks, face records and file sizes are restored as 5.6.1', async () => {
    const payload = {};
    for (const c of importKeys()) {
      const id = c === 'files' ? 'derived/a.md' : `derived-${c}`;
      payload[c] = [fixture(c, id, 50, { embedding: [0.5, 0.5], embeddingModel: 'their-model', matchedText: 'a snippet' })];
    }
    payload.files[0] = { ...payload.files[0], sizeBytes: 10, sha256: 'their-hash', excerpt: 'their excerpt' };
    payload.files.push(
      fixture('files', 'derived/a.md#chunk0', 51, { parentFileId: 'derived/a.md', chunkIndex: 0, text: 'passage' }),
      FACE_RECORD(),
    );
    await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const c of importKeys()) {
      const id = c === 'files' ? 'derived/a.md' : `derived-${c}`;
      const stored = await coll(SPACE, c).findOne({ _id: id });
      assert.ok(stored, `fixture check: ${c}/${id} was not stored`);
      const kept = DERIVED_EMBED.filter(f => f in stored);
      if (kept.length) wrong.push(`F14: ${c}/${id} kept the derived ${kept.join(', ')}`);
    }
    const file = await coll(SPACE, 'files').findOne({ _id: 'derived/a.md' });
    if (file?.sizeBytes !== 10 || file?.sha256 !== 'their-hash') {
      wrong.push(`C6: the file row was not replaced as 5.6.1 replaced it: ${JSON.stringify({ sizeBytes: file?.sizeBytes, sha256: file?.sha256 })}`);
    }
    const chunk = await coll(SPACE, 'files').findOne({ _id: 'derived/a.md#chunk0' });
    if (chunk?.parentFileId !== 'derived/a.md') wrong.push('C6: the file chunk was not restored');
    const face = await coll(SPACE, 'files').findOne({ _id: 'img.png#face-chunk0' });
    if (face?.faceLabel !== 'Ada') wrong.push('C6: the face record was not restored, so its face label is lost');
    assert.deepEqual(wrong, [], 'a restore stored another model\'s vector fields, or dropped a derived file record 5.6.1 '
      + 'restored (main\'s chunk and face drop is cut from 5.6.x: C6)');
  });

  it('PIN: every imported record with a record type is queued for embedding; a link is not', async () => {
    const payload = {};
    for (const c of importKeys()) payload[c] = [fixture(c, c === 'files' ? 'queued/a.md' : `queued-${c}`, 60)];
    await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const c of importKeys()) {
      const id = c === 'files' ? 'queued/a.md' : `queued-${c}`;
      const jobs = await coll(SPACE, 'embed_jobs').countDocuments({ recordId: id });
      const want = recordTypeOf[c] !== null;
      if ((jobs > 0) !== want) wrong.push(`${c}/${id}: queued=${jobs > 0}, want ${want}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('PIN: a restore REPLACES — a same-seq and a lower-seq re-import write their content, counted as updated', async () => {
    const payload = (seq, tag) => Object.fromEntries(importKeys().map(c => {
      const id = c === 'files' ? 'replace/a.md' : `replace-${c}`;
      return [c, [fixture(c, id, seq, { description: `version ${tag}` })]];
    }));
    const first = await importMod.importDocuments(SPACE, payload(10, 'A'));
    const same = await importMod.importDocuments(SPACE, payload(10, 'B'));
    const lower = await importMod.importDocuments(SPACE, payload(5, 'C'));
    const wrong = [];
    for (const c of importKeys()) {
      const id = c === 'files' ? 'replace/a.md' : `replace-${c}`;
      const r = [first, same, lower].map(o => `${o.results[c].inserted}/${o.results[c].updated}`).join(' ');
      if (r !== '1/0 0/1 0/1') wrong.push(`${c}: inserted/updated per import ${r}, want 1/0 0/1 0/1`);
      const stored = await coll(SPACE, c).findOne({ _id: id });
      if (stored?.description !== 'version C' || stored?.seq !== 5) {
        wrong.push(`${c}/${id}: stored ${JSON.stringify({ description: stored?.description, seq: stored?.seq })}, want version C at seq 5`);
      }
    }
    assert.deepEqual(wrong, [], 'a restore was guarded by seq like a peer arrival: an admin restoring a backup '
      + 'over newer data gets a 200 and keeps the newer data');
  });

  it('F7: the same id twice stores the HIGHEST seq, counted as 5.6.1 counted the two documents (C5)', async () => {
    const payload = {};
    for (const c of importKeys()) {
      const id = c === 'files' ? 'twice/a.md' : `twice-${c}`;
      payload[c] = [fixture(c, id, 9, { description: 'newer' }), fixture(c, id, 3, { description: 'older' })];
    }
    const out = await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const c of importKeys()) {
      const id = c === 'files' ? 'twice/a.md' : `twice-${c}`;
      const stored = await coll(SPACE, c).findOne({ _id: id });
      if (stored?.seq !== 9) wrong.push(`F7 ${c}/${id}: stored seq ${stored?.seq} (${stored?.description}), want 9`);
      const r = out.results[c];
      if (r.inserted !== 1 || r.updated !== 1 || r.errors !== 0) {
        wrong.push(`C5 ${c}: ${JSON.stringify(r)}, want 5.6.1's count for two copies of one id: inserted 1, updated 1`);
      }
    }
    assert.deepEqual(wrong, [], 'a repeated id was applied in file order, so the older copy overwrote the newer one — '
      + 'or the counters no longer read as 5.6.1\'s did');
  });

  it('F7: two copies of one id at an EQUAL seq — the earlier stands, as every other door reads a page', async () => {
    const payload = {};
    for (const c of importKeys()) {
      const id = c === 'files' ? 'tie/a.md' : `tie-${c}`;
      payload[c] = [fixture(c, id, 7, { description: 'first' }), fixture(c, id, 7, { description: 'second' })];
    }
    await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const c of importKeys()) {
      const id = c === 'files' ? 'tie/a.md' : `tie-${c}`;
      const stored = await coll(SPACE, c).findOne({ _id: id });
      if (stored?.description !== 'first') wrong.push(`${c}/${id}: stored '${stored?.description}', want 'first'`);
    }
    assert.deepEqual(wrong, []);
  });

  it('PIN: a record restored over a tombstone is restored, and the response gains no key for it (C5)', async () => {
    const payload = {};
    for (const c of importKeys()) {
      if (c === 'files') continue; // a file is not tombstoned in this collection (file tombstones are their own)
      const id = `tomb-${c}`;
      const type = recordTypeOf[c] ?? 'link';
      await coll(SPACE, 'tombstones').insertOne({ _id: id, type, spaceId: SPACE, deletedAt: iso(CREATED), instanceId: 'origin', seq: 70 });
      payload[c] = [fixture(c, id, 65)];
    }
    const out = await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const c of Object.keys(payload)) {
      if (await coll(SPACE, c).countDocuments({ _id: `tomb-${c}` }) !== 1) wrong.push(`${c}: not restored`);
      const extra = Object.keys(out.results[c]).filter(k => !['inserted', 'updated', 'errors', 'schemaViolations'].includes(k));
      if (extra.length) wrong.push(`${c}: response gained ${extra.join(', ')}`);
    }
    assert.deepEqual(wrong, [], 'a restore over a tombstone is not answered as 5.6.1 answered it (C5)');
  });

  it('F14: the counter is at least the max imported seq afterwards, in every family', async () => {
    const wrong = [];
    let seq = 100;
    for (const c of importKeys()) {
      seq += 100;
      await wipe(SPACE);
      await importMod.importDocuments(SPACE, { [c]: [fixture(c, c === 'files' ? 'ctr/a.md' : `ctr-${c}`, seq)] });
      const now = await seqMod.currentSeq(SPACE);
      if (now < seq) wrong.push(`${c}-only import at seq ${seq}: counter ${now}`);
    }
    assert.deepEqual(wrong, [], 'after a restore the next local write takes a seq at or below a restored record, and '
      + 'every peer that already holds that position never pulls the write');
  });

  it('C4: an unstamped import stays unstamped in a space with windows; a carried stamp is kept, as a Date (F14)', async () => {
    const CARRIED = '2031-01-01T00:00:00.000Z';
    const payload = {};
    const bare = [];
    for (const c of importKeys()) {
      const rt = recordTypeOf[c];
      if (rt === null || c === 'files') continue; // links carry no retention; files are the plain record-or-space case
      payload[c] = [fixture(c, `ttl-${c}`, 80)];
      bare.push({ c, id: `ttl-${c}` });
    }
    payload.facts.push(
      fixture('facts', 'ttl-brief', 81, { type: BRIEF }),
      fixture('facts', 'ttl-old', 82, { createdAt: '2020-01-01T00:00:00.000Z' }),
      fixture('facts', 'ttl-carried', 83, { _expireAt: CARRIED }),
    );
    bare.push({ c: 'facts', id: 'ttl-brief' }, { c: 'facts', id: 'ttl-old' });
    await importMod.importDocuments(KEEP, payload);
    const wrong = [];
    for (const w of bare) {
      const stored = await coll(KEEP, w.c).findOne({ _id: w.id });
      assert.ok(stored, `fixture check: ${w.c}/${w.id} was not stored`);
      if (stored._expireAt !== undefined) {
        wrong.push(`C4 ${w.c}/${w.id}: stamped ${JSON.stringify(stored._expireAt)} on import; 5.6.x stores it unstamped`);
      }
    }
    const carried = (await coll(KEEP, 'facts').findOne({ _id: 'ttl-carried' }))?._expireAt;
    if (!(carried instanceof Date) || carried.toISOString() !== CARRIED) {
      wrong.push(`F14 facts/ttl-carried: _expireAt ${JSON.stringify(carried)} (${typeof carried}), want the Date ${CARRIED}`);
    }
    assert.deepEqual(wrong, [], 'an import stamped a record by this instance\'s policy (main\'s D-9, cut from 5.6.x as '
      + 'C4), or a carried stamp did not come back as a stamp the sweep acts on');
  });

  it('C5: the response keys are exactly 5.6.1\'s, with derived, collapsed and malformed documents counted as 5.6.1', async () => {
    const out = await importMod.importDocuments(SPACE, {
      facts: [
        fixture('facts', 'shape-a', 1, { embedding: [1], embeddingModel: 'm' }),
        fixture('facts', 'shape-b', 9), fixture('facts', 'shape-b', 3),
        { fact: 'no id at all' },
      ],
      files: [fixture('files', 'shape/a.md', 2), fixture('files', 'shape/a.md#chunk0', 3, { parentFileId: 'shape/a.md' })],
    });
    const zero = { inserted: 0, updated: 0, errors: 0 };
    const expected = { spaceId: SPACE, results: Object.fromEntries(importKeys().map(c => [c, { ...zero }])) };
    expected.results.facts = { inserted: 2, updated: 1, errors: 1 };
    expected.results.files = { inserted: 2, updated: 0, errors: 0 };
    assert.deepEqual(Object.keys(out.results).sort(), Object.keys(expected.results).sort(), 'the families answered changed');
    assert.deepEqual(out, expected,
      'the import response is not 5.6.1\'s: a 5.6.1 integrator reads exactly { inserted, updated, errors } per family, '
      + 'and main\'s refused / derived / restoredOverTombstone keys are cut from 5.6.x (C5)');
  });

  describe('the export carries every family, and a round trip restores each (Q-206)', () => {
    const exportSpace = async () => {
      const r = await fetch(`${base}/api/admin/spaces/${SPACE}/export`, { headers: { Authorization: `Bearer ${adminKey}` } });
      assert.equal(r.status, 200, `export answered ${r.status}: ${await r.clone().text()}`);
      return r.json();
    };

    it('F13: every replicated family is a key of the export', async () => {
      const body = await exportSpace();
      const missing = importKeys().filter(k => !Array.isArray(body[k]));
      assert.deepEqual(missing, [], `the export omits ${missing.join(', ')} — a restore from it loses every one`);
    });

    it('PIN (F13 is additive): the export still omits the vector and still carries embeddingModel and matchedText', async () => {
      await coll(SPACE, 'facts').insertOne({ ...fixture('facts', 'proj', 5), spaceId: SPACE,
        embedding: [0.1, 0.2], embeddingModel: 'here-model', matchedText: 'what was embedded' });
      const body = await exportSpace();
      const doc = body.facts.find(d => d._id === 'proj');
      assert.ok(doc, 'fixture check: the fact was not exported');
      assert.deepEqual([doc.embedding, doc.embeddingModel, doc.matchedText], [undefined, 'here-model', 'what was embedded'],
        'the export projection changed: 12-admin-api promises the vector is omitted and nothing else is');
    });

    it('export -> wipe -> import restores every record of every family, a file chunk and a face record included', async () => {
      const seeded = [];
      let seq = 200;
      for (const c of importKeys()) {
        const id = c === 'files' ? 'trip/a.md' : `trip-${c}`;
        const doc = { ...fixture(c, id, ++seq), spaceId: SPACE,
          ...(recordTypeOf[c] !== null ? { _expireAt: new Date('2028-02-02T00:00:00.000Z') } : {}) };
        await coll(SPACE, c).insertOne(doc);
        seeded.push({ c, id, seq, content: doc[CONTENT_KEY[c]], stamped: recordTypeOf[c] !== null });
      }
      await coll(SPACE, 'files').insertMany([{ ...FILE_CHUNK(++seq), spaceId: SPACE }, { ...FACE_RECORD(), spaceId: SPACE }]);
      assert.ok(seeded.length >= 6, 'fixture check: fewer than six families seeded');
      const body = await exportSpace();
      await wipe(SPACE);
      const r = await fetch(`${base}/api/admin/spaces/${SPACE}/import`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200, `import answered ${r.status}: ${await r.clone().text()}`);
      const wrong = [];
      for (const s of seeded) {
        const stored = await coll(SPACE, s.c).findOne({ _id: s.id });
        if (!stored) { wrong.push(`${s.c}/${s.id}: not restored`); continue; }
        if (stored.seq !== s.seq || stored[CONTENT_KEY[s.c]] !== s.content) {
          wrong.push(`${s.c}/${s.id}: restored ${JSON.stringify({ seq: stored.seq, [CONTENT_KEY[s.c]]: stored[CONTENT_KEY[s.c]] })}`);
        }
        if (s.stamped && !(stored._expireAt instanceof Date)) wrong.push(`${s.c}/${s.id}: the stamp came back as ${typeof stored._expireAt}`);
      }
      if (!(await coll(SPACE, 'files').findOne({ _id: 'trip/a.md#chunk0' }))) wrong.push('C6: the file chunk did not survive the round trip');
      if ((await coll(SPACE, 'files').findOne({ _id: 'img.png#face-chunk0' }))?.faceLabel !== 'Ada') {
        wrong.push('C6: the face record did not survive the round trip, so its face label is lost');
      }
      assert.deepEqual(wrong, [], 'a backup taken by the export and restored by the import does not reproduce the space');
    });
  });
});
