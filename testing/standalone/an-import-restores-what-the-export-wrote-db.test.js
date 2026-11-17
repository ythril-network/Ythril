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
 *  8. **The seq counter is NOT moved by an import** (bundle-81, D-19 B; this rule read "at least the max imported seq afterwards — or the next local write
 *     sorts below a restored record and every peer that already holds that seq ignores it"). A seq is a version: a local write stamps above the version of
 *     the record it writes, so one that replaces a restored record is above it whatever the counter stands at, and an import that lifted the counter would
 *     lift every later stamp of the space to the backup's clock. (The restore ACT, which loads a backup raw, still floors the counter at the highest
 *     version below the cap: `a-restored-space-has-its-indexes-before-writes-resume-db`.)
 *  9. **D-9**: an imported record with no stamp, in a space with a window, is stamped from its own `createdAt` by
 *     `schema > space`; one that carries a stamp keeps it.
 * 10. **The export carries every replicated family — links included — and export -> wipe -> import restores each.**
 *     Links were never exported, so a restore lost every link while reporting success. **Field for field** (Q-792 part 8):
 *     every field the family's interface declares (extends and module augmentation followed, `_record-doc-fields.mjs`) is
 *     seeded and comes back deep-equal, or is NOT_CARRIED_BY_BACKUP and does not come back, or is listed with its reason in
 *     `an-import-restores-what-the-export-wrote-db.allow.json`; the comparison was `seq` and one content key, so a dropped
 *     or leaked field stayed green, and face descriptors once reached exports past a hand-edited field list.
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
import { isDeepStrictEqual } from 'node:util';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { recordDocFields } from './_record-doc-fields.mjs';

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

let mongo, importMod, families, recordTypeOf, wireKeys, localOnly, notCarried, seqMod, server, base, adminKey;
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

/** The stored document interface of each replicated family (`server/src/config/types.ts`); a family with none here fails the round trip. */
const FAMILY_DOC = { facts: 'FactDoc', entities: 'EntityDoc', edges: 'EdgeDoc', chrono: 'ChronoEntry', links: 'LinkDoc', files: 'FileMetaDoc' };
/** The field count each interface derived to when the round trip was made field-by-field (Q-792): a reader that finds fewer has broken. */
const FIELD_FLOOR = { facts: 21, entities: 21, edges: 27, chrono: 29, links: 11, files: 42 };
/** Declared fields a restore deliberately does not bring back that NOT_CARRIED_BY_BACKUP does not name, each with its reason. */
const NOT_RESTORED = JSON.parse(fs.readFileSync(new URL('./an-import-restores-what-the-export-wrote-db.allow.json', import.meta.url), 'utf8')).entries;
const notRestored = (family, field) => NOT_RESTORED.find(e => e.family === family && e.field === field);

/**
 * A seed value for a declared field, chosen by its declared TYPE, so a field added to an interface is seeded without editing this file;
 * a field whose type is neither here nor in SEED_BY_FIELD throws, naming it, rather than going unseeded and so uncompared.
 */
const SEED_BY_TYPE = {
  string: (c, f) => `${c}.${f} seeded`,
  number: () => 0.5,
  boolean: () => true,
  true: () => true,
  'number[]': () => [0.25, 0.5],
  'string[]': () => ['seeded-tag'],
  'string | null': (c, f) => `${c}.${f} seeded`,
  Date: () => new Date('2028-02-02T00:00:00.000Z'),
  AuthorRef: () => ({ ...author }),
  'Record<string, string | number | boolean>': () => ({ seededText: 'v', seededNumber: 2, seededFlag: true }),
  'Record<string, string>': () => ({ 'peer-x': 'sha-agreed' }),
  '[number, number, number, number]': () => [0.1, 0.2, 0.3, 0.4],
};
/** Fields whose value has a meaning or a validator a type-derived value would miss (the record's identity, ISO stamps, enums). */
const SEED_BY_FIELD = {
  _id: (c, id) => id,
  path: (c, id) => id,
  spaceId: () => SPACE,
  seq: (c, id, seq) => seq,
  createdAt: () => iso(CREATED),
  updatedAt: () => iso(CREATED + 1000),
  startsAt: () => iso(CREATED + DAY_MS),
  endsAt: () => iso(CREATED + 2 * DAY_MS),
  contentRedactedAt: () => iso(CREATED + 3 * DAY_MS),
  deletedAt: () => iso(CREATED + 4 * DAY_MS),
  bytesAbsentSince: () => iso(CREATED + 5 * DAY_MS),
  type: (c) => (c === 'chrono' ? 'event' : c === 'entities' ? 'concept' : `seeded_${c}`),
  status: () => 'upcoming',
  fromKind: () => 'fact',
  toKind: () => 'entity',
  descriptionSource: () => 'generated',
  retiredBy: () => 'bytes-lost',
  schemaFingerprint: () => 'ab'.repeat(32), // a sha256 in lowercase hex: a malformed stamp is read as absent (withoutMalformedStamp)
  stampSkew: () => ({ property: 'when', stamp: '2026-05-01T00:00:00.000Z', skewMs: -86_400_000, thresholdMs: 3_600_000 }),
  forkOf: () => 'trip-parent',
  forkAt: () => 7, // an integer seq: the shared version a fork's id is derived from (forkRowVerdict)
  recurrence: () => ({ freq: 'weekly', interval: 2, until: iso(CREATED + 90 * DAY_MS) }),
};

/** The row the round trip seeds for one family: one value for every declared field, bar a field whose presence makes it a row no backup holds. */
function tripRow(c, id, seq, fields) {
  const doc = {};
  for (const f of fields) {
    if (notRestored(c, f.name)?.seeded === false) continue;
    const literal = f.type.match(/^'([^']+)'(?:\s*\|\s*'[^']+')*$/);
    const make = Object.hasOwn(SEED_BY_FIELD, f.name) ? () => SEED_BY_FIELD[f.name](c, id, seq)
      : Object.hasOwn(SEED_BY_TYPE, f.type) ? () => SEED_BY_TYPE[f.type](c, f.name)
        : literal ? () => literal[1] : null;
    assert.ok(make, `${FAMILY_DOC[c]}.${f.name}: no seed value for type '${f.type}' — add one to SEED_BY_TYPE or SEED_BY_FIELD`);
    doc[f.name] = make();
  }
  return doc;
}

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
    importMod = await import('../../server/dist/sync/space-import.js');
    seqMod = await import('../../server/dist/util/seq.js');
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    const kinds = await import('../../server/dist/config/types-knowledge.js');
    recordTypeOf = Object.fromEntries(families.map(f => [f.collection,
      Object.entries(kinds.RECORD_COLLECTION).find(([, c]) => c === f.collection)?.[0] ?? null]));
    const shared = await import('../../server/dist/api/sync/_shared.js');
    wireKeys = new Set(Object.keys(shared.IncomingFileMetaDoc.shape));
    ({ LOCAL_ONLY_FIELDS: localOnly, NOT_CARRIED_BY_BACKUP: notCarried } = await import('../../server/dist/sync/local-only-fields.js'));
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
    base = server.url;
  });

  after(async () => {
    await server?.close();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await wipe(SPACE); await wipe(KEEP); });

  it('the derivation finds every replicated family, and the import accepts each one', async () => {
    assert.ok(families.length >= 6, `only ${families.length} replicated families — the registry moved`);
    // The door's reader (`indexExportBody`) is the shape check: a family key whose value is not an array refuses the body, naming the key, so
    // every family is one it reads as a family; an empty array of each is a body it takes.
    const { indexExportBody, ExportBodyMalformed } = await import('../../server/dist/sync/export-stream.js');
    const body = path.join(tmpDir, 'shape.json');
    for (const k of importKeys()) {
      fs.writeFileSync(body, JSON.stringify({ [k]: 'not an array' }));
      await assert.rejects(indexExportBody(body), (err) => err instanceof ExportBodyMalformed && new RegExp(`'${k}'`).test(err.message),
        `the import does not read family '${k}' as a family`);
    }
    fs.writeFileSync(body, JSON.stringify(Object.fromEntries(importKeys().map(k => [k, []]))));
    assert.deepEqual([...(await indexExportBody(body)).families.keys()].sort(), importKeys().sort(), 'the reader does not take an empty array of every family');
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
    assert.equal(r.errors, 100, 'the refused count does not match the documents not written');
    // Lens S4: the named list is bounded — the first NAMED_IN_SUMMARY, with `errors` the total.
    const { NAMED_IN_SUMMARY } = await import('../../server/dist/sync/arrivals.js');
    assert.equal(r.refused.length, NAMED_IN_SUMMARY, `the response names ${r.refused.length} refusals, unbounded`);
    assert.ok(r.refused.every(x => /retry the import/.test(x.reason)), 'an unwritten document carries no retry reason');
    assert.ok(!r.refused.some(x => x._id === 'chunk-000'), 'a document that landed is reported refused');
  });

  it('the restored-over-tombstone list is bounded and says how many there were', async () => {
    // Lens S4. Seen red by mutation, restored by hand: the slice removed.
    const { NAMED_IN_SUMMARY } = await import('../../server/dist/sync/arrivals.js');
    const n = NAMED_IN_SUMMARY + 3;
    const ids = Array.from({ length: n }, (_, i) => `many-tomb-${i}`);
    await coll(SPACE, 'tombstones').insertMany(ids.map(_id =>
      ({ _id, type: 'fact', spaceId: SPACE, deletedAt: iso(CREATED), instanceId: 'origin', seq: 70 })));
    const out = await importMod.importDocuments(SPACE, { facts: ids.map(id => fixture('facts', id, 65)) });
    const r = out.results.facts;
    assert.deepEqual([r.restoredOverTombstone?.length, r.restoredOverTombstoneTotal], [NAMED_IN_SUMMARY, n], JSON.stringify(r));
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

  it('the counter is moved by no import, in any family; the record it restores is stored at its seq', async () => {
    const wrong = [];
    let seq = 100;
    for (const c of importKeys()) {
      seq += 100;
      const space = SPACE;
      await wipe(space);
      const before = await seqMod.currentSeq(space);
      const id = c === 'files' ? 'ctr/a.md' : `ctr-${c}`;
      await importMod.importDocuments(space, { [c]: [fixture(c, id, seq)] });
      const now = await seqMod.currentSeq(space);
      if (now !== before) wrong.push(`${c}-only import at seq ${seq}: counter ${before} -> ${now}`);
      const stored = await coll(space, c).findOne({ _id: id });
      if (stored?.seq !== seq) wrong.push(`${c}-only import at seq ${seq}: stored at ${stored?.seq}`);
    }
    assert.deepEqual(wrong, [], 'an import lifted the counter to the backup\'s clock (every later stamp of the space follows it), or did not store the record');
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

    it('every entry of the not-restored list is explained, current, and names a declared field no backup class already covers', () => {
      const bad = [];
      const today = new Date().toISOString().slice(0, 10);
      for (const e of NOT_RESTORED) {
        const at = `${e.family}.${e.field}`;
        if (!importKeys().includes(e.family)) bad.push(`${at}: '${e.family}' is not a replicated family`);
        else if (!recordDocFields(FAMILY_DOC[e.family]).some(f => f.name === e.field)) bad.push(`${at}: ${FAMILY_DOC[e.family]} declares no such field — remove the entry`);
        if (notCarried.has(e.field)) bad.push(`${at}: already NOT_CARRIED_BY_BACKUP — the entry is redundant`);
        if (typeof e.reason !== 'string' || e.reason.trim().split(/\s+/).length < 3) bad.push(`${at}: needs a reason of three words or more`);
        if (typeof e.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy) || Number.isNaN(Date.parse(e.reviewBy))) bad.push(`${at}: needs a reviewBy date (YYYY-MM-DD)`);
        else if (e.reviewBy < today) bad.push(`${at}: past its reviewBy ${e.reviewBy} — review it`);
        if (typeof e.seeded !== 'boolean') bad.push(`${at}: needs seeded: true|false (false only where the field makes the row one no backup holds)`);
      }
      assert.deepEqual(bad, []);
    });

    it('export -> wipe -> import restores every declared field of every family, or the field is one no backup carries', async () => {
      // Q-792 part 8. The comparison was `seq` plus one content key, so a field the export projected out or the import dropped stayed
      // green — and so did one that leaked through: face descriptors once reached exports past a design that edited a field list.
      // Each family's field set is read from its interface (extends and module augmentation followed, `_record-doc-fields.mjs`), never
      // listed here; the seeded row covers it; every field comes back deep-equal (a Date a Date), or is NOT_CARRIED_BY_BACKUP and does
      // not come back, or is in this file's not-restored list with a reason. Seen red by mutation (a carried field projected out of
      // the export at admin-space-transfer.ts), restored by hand.
      const { forkIdFor, forkRowVerdict } = await import('../../server/dist/sync/upsert-plan.js');
      const { authoredContentHash } = await import('../../server/dist/sync/authored-content.js');
      // A fork EDGE shares its subject's five identity fields, so the import stores one only where the space's identity index is the partial one
      // (`edge_identity_building`, 503, otherwise: the sender keeps it and offers it again). A space is converted at boot; this one is made by the test.
      await (await import('../../server/dist/spaces/edge-identity-index.js')).ensurePartialEdgeIdentity(SPACE);
      const seeded = [];
      const wrong = [];
      let seq = 200;
      for (const c of importKeys()) {
        assert.ok(FAMILY_DOC[c], `replicated family '${c}' has no document interface named here — add it to FAMILY_DOC`);
        const fields = recordDocFields(FAMILY_DOC[c]);
        assert.ok(fields.length >= FIELD_FLOOR[c], `${FAMILY_DOC[c]}: only ${fields.length} field(s) derived, floor ${FIELD_FLOOR[c]} — the reader or the type moved`);
        const doc = tripRow(c, c === 'files' ? 'trip/a.md' : `trip-${c}`, ++seq, fields);
        // A seeded `forkOf` makes the row a FORK, which every door refuses unless its id derives from its subject (`forkRowVerdict`): the id is
        // `forkIdFor(forkOf, forkAt, authoredContentHash(family, row).text)`, the text being the row's body without its version fields. A row that
        // declares one of the two marks and not the other is no fork any door accepts, so it fails here rather than seeding a row no backup holds.
        if (typeof doc.forkOf === 'string') {
          assert.equal(typeof doc.forkAt, 'number', `${FAMILY_DOC[c]} declares forkOf and not forkAt: a fork row with no forkAt derives from nothing a peer can verify`);
          doc._id = forkIdFor(doc.forkOf, doc.forkAt, authoredContentHash(c, doc).text);
          assert.equal(forkRowVerdict(c, doc, authoredContentHash(c, doc).text), 'ok', `${c}: the seeded fork row's id does not derive (forkRowVerdict)`);
        }
        const id = doc._id;
        const declared = new Set(fields.map(f => f.name));
        const uncovered = fields.filter(f => !(f.name in doc) && notRestored(c, f.name)?.seeded !== false).map(f => f.name);
        if (uncovered.length) wrong.push(`${c}/${id}: the seeded row does not cover ${uncovered.join(', ')} — a field never seeded is a field never compared`);
        const undeclared = Object.keys(doc).filter(k => !declared.has(k));
        if (undeclared.length) wrong.push(`${c}/${id}: seeded ${undeclared.join(', ')}, which ${FAMILY_DOC[c]} does not declare`);
        await coll(SPACE, c).insertOne(doc);
        seeded.push({ c, id, doc, fields });
      }
      assert.ok(seeded.length >= 6, 'fixture check: fewer than six families seeded');
      assert.deepEqual(wrong, [], 'the round trip cannot judge a field it does not seed');
      const body = await exportSpace();
      await wipe(SPACE);
      const r = await fetch(`${base}/api/admin/spaces/${SPACE}/import`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200, `import answered ${r.status}: ${await r.clone().text()}`);
      const answer = await r.json();
      const show = (v) => (v instanceof Date ? `Date ${v.toISOString()}` : JSON.stringify(v));
      for (const { c, id, doc, fields } of seeded) {
        const exported = (body[c] ?? []).find(x => x?._id === id);
        const stored = await coll(SPACE, c).findOne({ _id: id });
        if (!exported) { wrong.push(`${c}/${id}: not exported`); continue; }
        if (!stored) { wrong.push(`${c}/${id}: not restored (the import answered ${JSON.stringify(answer?.results?.[c] ?? answer)})`); continue; }
        for (const { name } of fields) {
          if (!(name in doc)) continue;
          const back = isDeepStrictEqual(stored[name], doc[name]);
          if (notCarried.has(name)) {
            if (name in exported) wrong.push(`${c}.${name}: the export carried it, and it is NOT_CARRIED_BY_BACKUP`);
            if (back) wrong.push(`${c}.${name}: came back through the import, and it is NOT_CARRIED_BY_BACKUP`);
          } else if (notRestored(c, name)) {
            if (back) wrong.push(`${c}.${name}: listed as not restored, and it came back — remove the entry`);
          } else if (!(name in exported)) {
            wrong.push(`${c}.${name}: DROPPED by the export (seeded ${show(doc[name])})`);
          } else if (!back) {
            wrong.push(`${c}.${name}: changed or dropped by the import: stored ${name in stored ? show(stored[name]) : 'nothing'}, seeded ${show(doc[name])}`);
          }
        }
        const declared = new Set(fields.map(f => f.name));
        for (const k of Object.keys(stored)) {
          // Undeclared and not seeded: only this instance's own classified local state may appear (a landing's position and
          // written-here bit, the deliverer of what landed); anything else came from nowhere a backup accounts for.
          if (declared.has(k) || localOnly.has(k)) continue;
          wrong.push(`${c}.${k}: LEAKED — the restored row holds ${show(stored[k])}, which ${FAMILY_DOC[c]} does not declare and no local-only class names`);
        }
      }
      assert.deepEqual(wrong, [], 'a backup taken by the export and restored by the import does not reproduce the space field for field');
    });
  });
});
