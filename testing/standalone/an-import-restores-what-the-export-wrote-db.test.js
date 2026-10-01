/**
 * The admin import restores what the export wrote, and refuses what no export could have written (`Q-205`, `Q-206`,
 * `D-9`).
 *
 * ## The rules this file holds, each over every family the import accepts
 *
 * An import is an MFA-gated admin RESTORE, not a peer arrival, and the plan (`Q-107` part 1 §4) draws the line
 * between the two where it does for that reason:
 *
 *  1. **A seq is a non-negative integer the counter can carry**, or the record is refused, NAMED by id and reason.
 *     Absent is allowed for file metadata (pre-4.0 files carry none) and nowhere else. It wrote whatever arrived:
 *     a string seq, a negative one, a fraction, or one inside the protocol's ceiling reserve.
 *  2. **What the export carried as the RECORD's local state is kept**: the retention stamps (they ARE the record
 *     tier — `ttlDays` is never stored) and `syncBase` (dropping it on a self-restore turns every divergent file into
 *     a conflict copy). Kept as what they are — a stamp is a Date the sweep can compare, including a sentinel at the
 *     epoch or at the far end of the calendar, not the ISO string JSON turned it into.
 *  3. **What THIS instance derives is dropped**: `embedding`, `embeddingModel`, `matchedText` (re-embedded here),
 *     every file CHUNK and face record (re-derived from the blob), and every file-metadata key that is not on the
 *     wire (`IncomingFileMetaDoc`) — sizes, hashes and excerpts describe bytes this instance has not got.
 *  4. **Imported records are queued for embedding** by the receiver's rules; a link has nothing to embed.
 *  5. **The write is UNGUARDED**: a restore replaces, so a same-seq or lower-seq re-import writes its content.
 *  6. **A repeated id in one file stores the highest seq**, not the last one read.
 *  7. **Inserted and updated are counted correctly**; **a record restored over a tombstone is reported** by id.
 *  8. **The seq counter is at least the max imported seq afterwards** — or the next local write sorts below a
 *     restored record and every peer that already holds that seq ignores it.
 *  9. **D-9**: an imported record with no stamp, in a space with a window, is stamped from its own `createdAt` by
 *     `schema > space`; one that carries a stamp keeps it.
 * 10. **The export carries every replicated family — links included — and export -> wipe -> import restores each.**
 *     Links were never exported, so a restore lost every link while reporting success.
 *
 * Rules 4, 5 and the counting half of 7 hold on the base and are PINS: the rewrite onto the shared arrivals writer
 * must not lose them (the writer guards by seq, and a restore must not be guarded).
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
const DAY_MS = 86_400_000;
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

const importKeys = () => families.map(f => f.collection);
async function wipe(space) {
  for (const c of [...importKeys(), 'embed_jobs', 'tombstones']) await coll(space, c).deleteMany({});
  await mongo.col('ythril_counters').deleteMany({ _id: space });
}

/** Find, anywhere in one family's result, an entry that names `id` (a string, or an object with `_id`/`id`). */
function namedIn(result, id, keyPattern = /./) {
  for (const [k, v] of Object.entries(result ?? {})) {
    if (!Array.isArray(v) || !keyPattern.test(k)) continue;
    const hit = v.find(e => e === id || e?._id === id || e?.id === id);
    if (hit !== undefined) return { key: k, entry: hit };
  }
  return null;
}

describe('the admin import restores what the export wrote', { skip }, () => {
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
    assert.equal(importMod.importPayloadError(Object.fromEntries(importKeys().map(k => [k, 'x']))) !== null, true,
      'the import shape check accepts none of the family keys');
    for (const k of importKeys()) {
      assert.match(importMod.importPayloadError({ [k]: 'not an array' }) ?? '', new RegExp(k),
        `the import does not accept family '${k}' as a key`);
    }
    assert.ok(wireKeys.size >= 8 && wireKeys.has('path'), `the file wire keys did not derive: ${[...wireKeys]}`);
    assert.ok(DERIVED_EMBED.every(f => localOnly.has(f)), 'the derived embed fields are no longer local-only');
  });

  it('a seq that is not a non-negative integer the counter can carry is refused, by id and reason, in every family', async () => {
    const BAD = { string: '7', negative: -1, fraction: 1.5, implausible: seqMod.MAX_INGEST_SEQ + 1, absent: undefined };
    const payload = {};
    const refused = [];
    for (const c of importKeys()) {
      payload[c] = [];
      for (const [why, seq] of Object.entries(BAD)) {
        if (why === 'absent' && c === 'files') continue; // allowed: file metadata older than seqs carries none
        const id = c === 'files' ? `bad/${why}.md` : `bad-${c}-${why}`;
        payload[c].push(fixture(c, id, seq));
        refused.push({ c, id, why });
      }
    }
    const out = await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const r of refused) {
      if (await coll(SPACE, r.c).countDocuments({ _id: r.id }) > 0) wrong.push(`${r.c}/${r.id} (${r.why} seq) was STORED`);
      const named = namedIn(out.results[r.c], r.id);
      if (!named || typeof (named.entry.reason ?? named.entry.error) !== 'string') {
        wrong.push(`${r.c}/${r.id} (${r.why} seq) is not named with a reason in the result`);
      }
    }
    assert.deepEqual(wrong, [], 'an import stored a record whose seq no export could have written, or refused it '
      + 'anonymously. A string seq never compares with a number, so that record is invisible to every seq-paged pull; '
      + 'one inside the ceiling reserve strands the counter.');
    assert.ok(await seqMod.currentSeq(SPACE) < 1000, 'an implausible seq moved the counter');
  });

  it('a file metadata record with no seq is restored, and is not an error', async () => {
    const out = await importMod.importDocuments(SPACE, { files: [fixture('files', 'legacy/old.md', undefined)] });
    assert.equal(await coll(SPACE, 'files').countDocuments({ _id: 'legacy/old.md' }), 1, 'a pre-4.0 file was refused');
    assert.equal(out.results.files.errors, 0);
  });

  it('the export\'s retention stamps and syncBase are kept as what they are, sentinels included', async () => {
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
      + 'with a Date, so a record the backup said would expire never does — and a "never" that was a far-future stamp '
      + 'reads the same way only by accident');
  });

  it('what this instance derives is dropped: embed fields, file chunks and face records, non-wire file keys', async () => {
    const payload = {};
    for (const c of importKeys()) {
      const id = c === 'files' ? 'derived/a.md' : `derived-${c}`;
      payload[c] = [fixture(c, id, 50, { embedding: [0.5, 0.5], embeddingModel: 'their-model', matchedText: 'a snippet' })];
    }
    payload.files[0] = { ...payload.files[0], sizeBytes: 10, sha256: 'their-hash', excerpt: 'their excerpt',
      chunkCount: 2, embeddingStatus: 'done', mediaType: 'text' };
    payload.files.push(
      fixture('files', 'derived/a.md#chunk0', 51, { parentFileId: 'derived/a.md', chunkIndex: 0, embedding: [1] }),
      fixture('files', 'img.png#face-chunk0', undefined, { parentFileId: 'img.png', faceEmbedding: [0.1], faceEntityId: 'e1', bbox: [0, 0, 1, 1] }),
    );
    await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const c of importKeys()) {
      const id = c === 'files' ? 'derived/a.md' : `derived-${c}`;
      const stored = await coll(SPACE, c).findOne({ _id: id });
      assert.ok(stored, `fixture check: ${c}/${id} was not stored`);
      const kept = DERIVED_EMBED.filter(f => f in stored);
      if (kept.length) wrong.push(`${c}/${id} kept the derived ${kept.join(', ')}`);
    }
    const allowedFileKeys = new Set([...wireKeys, ...[...localOnly].filter(f => !DERIVED_EMBED.includes(f))]);
    const file = await coll(SPACE, 'files').findOne({ _id: 'derived/a.md' });
    const extra = Object.keys(file).filter(k => !allowedFileKeys.has(k));
    if (extra.length) wrong.push(`file metadata kept non-wire keys: ${extra.join(', ')}`);
    for (const chunk of ['derived/a.md#chunk0', 'img.png#face-chunk0']) {
      if (await coll(SPACE, 'files').countDocuments({ _id: chunk })) wrong.push(`the chunk/face record ${chunk} was stored`);
    }
    assert.deepEqual(wrong, [], 'an import stored what only this instance can derive. A vector from another model ranks '
      + 'plausibly and wrongly; a chunk stored as a record shows in every file list; a size and hash describe bytes this '
      + 'instance does not hold');
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

  it('a file holding the same id twice stores the HIGHEST seq, and counts one record', async () => {
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
      if (stored?.seq !== 9) wrong.push(`${c}/${id}: stored seq ${stored?.seq} (${stored?.description}), want 9`);
      if (out.results[c].inserted !== 1) wrong.push(`${c}: inserted ${out.results[c].inserted}, want 1`);
    }
    assert.deepEqual(wrong, [], 'a repeated id was applied in file order, so the older copy overwrote the newer one');
  });

  it('two copies of one id at an EQUAL seq: the earlier stands, as the push planner reads a page', async () => {
    // The one tie-break (`isNewerCopy`, dup pass): an equal seq is not newer. It was "the later wins" in the
    // writer's collapse while the push planner kept the earlier — two readings of one page.
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

  it('a fault part-way through a family reports what landed and refuses only what did not', async () => {
    /*
     * Lens S2: the writer commits a family 500 documents at a time, so a fault in the second chunk leaves the first
     * stored. The import answered "every document refused, inserted 0" over records it had written. The fault is a
     * dropped connection on the SECOND write of the collection (the whole second chunk, and its per-document retry),
     * injected below the driver API the way the pull test does — no store refusal could produce it, because a
     * document's own refusal is refused by id and never stops the page. Seen red by mutation, restored by hand: the
     * import's partial-outcome branch removed.
     */
    const { MongoNetworkError } = await import('mongodb');
    const N = 600;
    const docs = Array.from({ length: N }, (_, i) => fixture('facts', `chunk-${String(i).padStart(3, '0')}`, 1000 + i));
    const target = `${SPACE}_facts`;
    const proto = Object.getPrototypeOf(mongo.col('probe'));
    const originals = { bulkWrite: proto.bulkWrite, updateOne: proto.updateOne };
    let bulkCalls = 0;
    proto.bulkWrite = function faulty(...args) {
      if (this.collectionName === target && ++bulkCalls >= 2) return Promise.reject(new MongoNetworkError('injected: reset'));
      return originals.bulkWrite.apply(this, args);
    };
    proto.updateOne = function faulty(...args) {
      if (this.collectionName === target && bulkCalls >= 2) return Promise.reject(new MongoNetworkError('injected: reset'));
      return originals.updateOne.apply(this, args);
    };
    let out;
    try {
      out = await importMod.importDocuments(SPACE, { facts: docs });
    } finally {
      Object.assign(proto, originals);
    }
    assert.ok(bulkCalls >= 2, 'fixture check: the second chunk was never written, so no fault was reached');
    const stored = await coll(SPACE, 'facts').countDocuments({ _id: { $regex: '^chunk-' } });
    assert.equal(stored, 500, `fixture check: the first chunk should be stored, found ${stored}`);
    const r = out.results.facts;
    assert.deepEqual([r.inserted, r.updated, r.errors], [500, 0, 100],
      `an import that stored 500 of 600 reported ${JSON.stringify({ inserted: r.inserted, updated: r.updated, errors: r.errors })}`);
    assert.equal(r.refusedTotal ?? r.refused.length, 100, 'the refused count does not match the documents not written');
    assert.ok(r.refused.every(x => /retry the import/.test(x.reason)), 'an unwritten document carries no retry reason');
    assert.ok(!r.refused.some(x => x._id === 'chunk-000'), 'a document that landed is reported refused');
  });

  it('a record restored over a tombstone is reported by id', async () => {
    const payload = {};
    const want = [];
    for (const c of importKeys()) {
      if (c === 'files') continue; // a file is not tombstoned in this collection (file tombstones are their own)
      const id = `tomb-${c}`;
      const type = recordTypeOf[c] ?? 'link';
      await coll(SPACE, 'tombstones').insertOne({ _id: id, type, spaceId: SPACE, deletedAt: iso(CREATED), instanceId: 'origin', seq: 70 });
      payload[c] = [fixture(c, id, 65)];
      want.push({ c, id });
    }
    const out = await importMod.importDocuments(SPACE, payload);
    const wrong = want.filter(w => !namedIn(out.results[w.c], w.id, /tomb/i)).map(w => `${w.c}/${w.id}`);
    assert.deepEqual(wrong, [], 'a deleted record came back from the backup and nothing said so — the next sync with a '
      + 'peer holding the tombstone deletes it again, which reads as data loss');
  });

  it('the counter is at least the max imported seq afterwards, in every family', async () => {
    const wrong = [];
    let seq = 100;
    for (const c of importKeys()) {
      seq += 100;
      const space = SPACE;
      await wipe(space);
      await importMod.importDocuments(space, { [c]: [fixture(c, c === 'files' ? 'ctr/a.md' : `ctr-${c}`, seq)] });
      const now = await seqMod.currentSeq(space);
      if (now < seq) wrong.push(`${c}-only import at seq ${seq}: counter ${now}`);
    }
    assert.deepEqual(wrong, [], 'after a restore the next local write takes a seq at or below a restored record, and '
      + 'every peer that already holds that position never pulls the write');
  });

  it('D-9: an unstamped import is stamped from its createdAt by schema > space; a carried stamp is kept', async () => {
    const OLD = Date.parse('2020-01-01T00:00:00.000Z');
    const CARRIED = '2031-01-01T00:00:00.000Z';
    const payload = {};
    const want = [];
    for (const c of importKeys()) {
      const rt = recordTypeOf[c];
      if (rt === null || c === 'files') continue; // links carry no retention; files are the plain record-or-space case
      payload[c] = [fixture(c, `ttl-${c}`, 80)];
      want.push({ c, id: `ttl-${c}`, at: CREATED + SPACE_WINDOW_DAYS * DAY_MS, why: 'space window' });
    }
    payload.facts.push(
      fixture('facts', 'ttl-brief', 81, { type: BRIEF }),
      fixture('facts', 'ttl-old', 82, { createdAt: iso(OLD) }),
      fixture('facts', 'ttl-carried', 83, { _expireAt: CARRIED }),
    );
    want.push(
      { c: 'facts', id: 'ttl-brief', at: CREATED + SCHEMA_WINDOW_DAYS * DAY_MS, why: 'the schema window wins' },
      { c: 'facts', id: 'ttl-old', at: OLD + SPACE_WINDOW_DAYS * DAY_MS, why: 'from createdAt, not now' },
      { c: 'facts', id: 'ttl-carried', at: Date.parse(CARRIED), why: 'a carried stamp is the record tier and is kept' },
    );
    await importMod.importDocuments(KEEP, payload);
    const wrong = [];
    for (const w of want) {
      const stored = await coll(KEEP, w.c).findOne({ _id: w.id });
      assert.ok(stored, `fixture check: ${w.c}/${w.id} was not stored`);
      const v = stored._expireAt;
      if (!(v instanceof Date) || v.getTime() !== w.at) wrong.push(`${w.c}/${w.id}: _expireAt ${JSON.stringify(v)}, want ${iso(w.at)} (${w.why})`);
    }
    assert.deepEqual(wrong, [], 'an imported record is not stamped by this instance\'s retention policy');
  });

  describe('the export carries every family, and a round trip restores each (Q-206)', () => {
    const exportSpace = async () => {
      const r = await fetch(`${base}/api/admin/spaces/${SPACE}/export`, { headers: { Authorization: `Bearer ${adminKey}` } });
      assert.equal(r.status, 200, `export answered ${r.status}: ${await r.clone().text()}`);
      return r.json();
    };

    it('every replicated family is a key of the export', async () => {
      const body = await exportSpace();
      const missing = importKeys().filter(k => !Array.isArray(body[k]));
      assert.deepEqual(missing, [], `the export omits ${missing.join(', ')} — a restore from it loses every one`);
    });

    it('export -> wipe -> import restores every record of every family', async () => {
      const seeded = [];
      let seq = 200;
      for (const c of importKeys()) {
        const id = c === 'files' ? 'trip/a.md' : `trip-${c}`;
        const doc = { ...fixture(c, id, ++seq), spaceId: SPACE,
          ...(recordTypeOf[c] !== null ? { _expireAt: new Date('2028-02-02T00:00:00.000Z') } : {}) };
        await coll(SPACE, c).insertOne(doc);
        seeded.push({ c, id, seq, content: doc[CONTENT_KEY[c]], stamped: recordTypeOf[c] !== null });
      }
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
      assert.deepEqual(wrong, [], 'a backup taken by the export and restored by the import does not reproduce the space');
    });
  });
});
