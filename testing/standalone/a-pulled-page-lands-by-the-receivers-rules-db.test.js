/**
 * A page pulled from a peer lands by the RECEIVER's rules (`Q-107` part 1, `Q-203`, `D-9`).
 *
 * ## The rules this file holds, each over every family the pull door writes
 *
 *  1. **A pulled record is offered to this instance's embedder** (`Q-203`). The push door queues an arriving
 *     record (`ingestBrainDoc` -> `enqueueIngestedRecord`); the pull door wrote its page with a bare `bulkWrite`
 *     and queued nothing, so every record a peer handed over by pull was stored and absent from meaning-ranked
 *     search on this instance until somebody ran a reindex. Whether to queue is the receiver's
 *     `record > schema > space` resolution — asserted as a truth table, not as one case.
 *  2. **A page holding the same `_id` twice stores the highest seq.** The page was written in arrival order by an
 *     unordered bulk write, so `[9, 3]` stored 3: an older version won over a newer one in the same page.
 *  3. **The seq counter is bumped per landed page, not once after the run.** The bump was after all six transfers
 *     and up to 50 pages each, so for the whole run a local write could take a seq below a record already stored.
 *  4. **A write fault that is not a duplicate holds the watermark and is reported as a record-write failure, not
 *     as an unreachable peer.** It escaped to the member-level catch, which counts it toward `PEER UNREACHABLE`
 *     and names the driver error and nothing else.
 *  5. **On 5.6.x an arrival with no receiver stamp stays unstamped, and the sender's stamp is never adopted.**
 *     Main stamps it from its `createdAt` by this instance's `schema > space` (`D-9`); that is cut from 5.6.x
 *     (`C4` of the 5.6.2 plan) and pinned here, so a port that brings `D-9` along fails this file.
 *  6. **Pulled file metadata lands in `<space>_files`** (`F15`). The page write named its collection after the
 *     URL suffix, so a pulled `filemeta` page went to a `<space>_filemeta` collection nothing reads.
 *  7. **A store refusal on a pulled page holds that family's position like any write fault** (`C3`, `F10`): the
 *     watermark does not pass the refused record, and the cycle does not count it as an unreachable peer.
 *
 * ## How the door is driven
 *
 * The REAL engine (`runSyncForPeer`) against a fake peer: an HTTP server in this process that answers the sync
 * routes from fixtures and 404s everything else (gossip, votes, warm, files — all best-effort on the engine side).
 * It binds to this host's LAN address, because the peer fetch refuses loopback whatever the opt-in
 * (`_private-address.mjs` says why); `SYNC_ALLOW_PRIVATE_PEERS` admits the LAN address. The member is a `pull`
 * subscriber on a pubsub network, so the cycle pulls and never pushes.
 *
 * Families are DERIVED from `REPLICATED_FAMILIES`, and the record type of each from `RECORD_COLLECTION`, with a
 * floor; a family the derivation finds and no fixture covers fails rather than passing unchecked. File metadata is
 * the one family left out of rules 1, 2 and 5 and the reason is stated where it is skipped.
 *
 * Run: node --test testing/standalone/a-pulled-page-lands-by-the-receivers-rules-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { MongoNetworkError } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateHostAddress, privateAddressSkipReason } from './_private-address.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-pull-arrivals-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
process.env['SYNC_ALLOW_INSECURE_PEERS'] = 'true';

const PEER = 'peer-a';
const NET = 'net-pull';
const DAY_MS = 86_400_000;
const SPACE_WINDOW_DAYS = 30;
const SCHEMA_WINDOW_DAYS = 5;

/** Spaces, one per question, so no case reads another's records or counter. */
const S = {
  open: 'pa-open',      // suppression off at space level; a type schema that suppresses
  quiet: 'pa-quiet',    // suppression ON at space level; a type schema that un-suppresses
  dup: 'pa-dup',
  pages: 'pa-pages',
  fault: 'pa-fault',
  keep: 'pa-keep',      // retention: space window, a schema window on one type
  files: 'pa-files',    // pulled file metadata
  refuse: 'pa-refuse',  // a validator on facts refuses the text POISON
};

const SUPPRESSING = 'muted';     // a type whose schema says suppressEmbeddings: true
const UNSUPPRESSING = 'loud';    // a type whose schema says suppressEmbeddings: false
const BRIEF = 'brief';           // a type whose schema has its own retention window

let mongo, engine, seqMod, families, recordTypeOf, typeField, peer, peerUrl, logMod;
const coll = (space, c) => mongo.col(`${space}_${c}`);

/** What the fake peer serves: space -> payloadKey -> pages (arrays of items). */
let served = {};
/** Called with (space, payloadKey, pageIndex) before a page is served — lets a case observe the receiver mid-run. */
let onServe = null;

function startPeer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/api\/sync\/([a-z]+)$/);
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' || !m) return send(404, { error: 'not served by the fake peer' });
    const space = url.searchParams.get('spaceId');
    if (m[1] === 'tombstones') return send(200, {});
    const pages = served[space]?.[m[1]];
    if (!families.some(f => f.payloadKey === m[1])) return send(404, { error: 'not a family' });
    const at = Number(url.searchParams.get('cursor') ?? 0);
    if (onServe) await onServe(space, m[1], at);
    const items = pages?.[at] ?? [];
    send(200, { items, nextCursor: pages && at + 1 < pages.length ? String(at + 1) : null });
  });
  return new Promise(resolve => server.listen(0, '0.0.0.0', () => resolve(server)));
}

const iso = (ms) => new Date(ms).toISOString();
const author = { instanceId: PEER, instanceLabel: 'Peer A' };
const CREATED = Date.parse('2026-06-01T00:00:00.000Z');

/**
 * One pulled document per record type. A FIXTURE — literal on purpose; the derivation decides a fixture is owed.
 * Every one carries a SENDER retention stamp and a sender vector, which the receiver must never adopt.
 */
function fixture(recordType, id, seq, over = {}) {
  const base = {
    _id: id, spaceId: 'sender-space', seq, author, tags: [], createdAt: iso(CREATED), updatedAt: iso(CREATED),
    _expireAt: iso(CREATED + 1 * DAY_MS), embedding: [0.1, 0.2], embeddingModel: 'sender-model',
  };
  const shapes = {
    fact: { fact: `fact ${id}` },
    entity: { name: `Entity ${id}`, type: 'concept', properties: {} },
    edge: { from: `from-${id}`, to: `to-${id}`, label: 'relates_to' },
    chrono: { title: `chrono ${id}`, type: 'event', startsAt: iso(CREATED), status: 'upcoming' },
  };
  assert.ok(shapes[recordType], `no pulled-document fixture for record type '${recordType}' — add one`);
  return { ...base, ...shapes[recordType], ...over };
}

function writeConfig() {
  const typeSchemasFor = (schemas) => Object.fromEntries(
    Object.keys(recordTypeOf).map(c => recordTypeOf[c]).filter(Boolean).map(t => [t, schemas]),
  );
  const space = (id, meta = {}, extra = {}) => ({ id, label: id, folders: [], meta, ...extra });
  const spaces = [
    space(S.open, { typeSchemas: typeSchemasFor({ [SUPPRESSING]: { suppressEmbeddings: true } }) }),
    space(S.quiet, { suppressEmbeddings: true, typeSchemas: typeSchemasFor({ [UNSUPPRESSING]: { suppressEmbeddings: false } }) }),
    space(S.dup), space(S.pages), space(S.fault), space(S.files), space(S.refuse),
    space(S.keep, { typeSchemas: { fact: { [BRIEF]: { retention: { days: SCHEMA_WINDOW_DAYS } } } } },
      { recordTtlDays: SPACE_WINDOW_DAYS }),
  ];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'receiver', instanceLabel: 'Receiver', tokens: [], spaces,
    networks: [{
      id: NET, label: 'Pull net', type: 'pubsub', spaces: spaces.map(s => s.id), votes: [],
      members: [{ instanceId: PEER, label: 'Peer A', url: peerUrl, tokenHash: 'x', direction: 'pull' }],
    }],
  }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(tmpDir, 'secrets.json'), JSON.stringify({ peerTokens: { [PEER]: 'peer-token' } }), { mode: 0o600 });
}

function member() {
  return engine.cfg().networks.find(n => n.id === NET).members.find(m => m.instanceId === PEER);
}

/** Families the pull door writes as whole documents, with the record type each holds (null: nothing to embed). */
function writtenFamilies() {
  // File metadata is merged by `applyFileMetaPage` (`ingestFileMeta`), queued only when the blob is held, and has
  // its own suites; it is the `Q-107` part 2 half. Named here rather than silently absent.
  return families.filter(f => f.payloadKey !== 'filemeta');
}

/** Capture every warn/error line the server logs during `fn`. */
async function capturingLogs(fn) {
  const lines = [];
  const orig = { warn: logMod.log.warn, error: logMod.log.error };
  logMod.log.warn = (...a) => { lines.push(a.join(' ')); };
  logMod.log.error = (...a) => { lines.push(a.join(' ')); };
  try { return { result: await fn(), lines }; } finally { Object.assign(logMod.log, orig); }
}

describe('a pulled page lands by the receiver\'s rules', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('pullarrivals');
    peer = await startPeer();
    peerUrl = `http://${privateHostAddress()}:${peer.address().port}`;
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    const kinds = await import('../../server/dist/config/types-knowledge.js');
    recordTypeOf = Object.fromEntries(families.map(f => [f.collection,
      Object.entries(kinds.RECORD_COLLECTION).find(([, c]) => c === f.collection)?.[0] ?? null]));
    ({ TYPE_FIELD: typeField } = await import('../../server/dist/brain/ttl.js'));
    writeConfig();
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    engine = { ...(await import('../../server/dist/sync/engine.js')), cfg: loader.getConfig };
    seqMod = await import('../../server/dist/util/seq.js');
    logMod = await import('../../server/dist/util/log.js');
  });

  after(async () => {
    await new Promise(r => peer?.close(r));
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(() => { served = {}; onServe = null; });

  it('the derivation finds the replicated families and a record type for each brain family', () => {
    assert.ok(families.length >= 6, `only ${families.length} replicated families — the registry moved`);
    const typed = writtenFamilies().filter(f => recordTypeOf[f.collection]);
    assert.ok(typed.length >= 4, `only ${typed.length} family/families map to a record type: ${JSON.stringify(recordTypeOf)}`);
    assert.equal(recordTypeOf['links'], null, 'links hold no text, so they map to no record type');
  });

  describe('Q-203: a pulled record is queued for embedding, by the receiver\'s record > schema > space', () => {
    /*
     * The truth table. `record` is the record's own `suppressEmbeddings` (only `true` is a statement); `schema` is
     * the receiver's type schema for the record's type; `space` is the receiver's space setting. Rows chosen so
     * each tier both wins and loses at least once.
     */
    const ROWS = [
      { space: S.open, type: 'plain', record: undefined, queued: true, why: 'nothing suppresses' },
      { space: S.open, type: 'plain', record: true, queued: false, why: 'the record tier suppresses' },
      { space: S.open, type: SUPPRESSING, record: undefined, queued: false, why: 'the schema tier suppresses' },
      { space: S.quiet, type: 'plain', record: undefined, queued: false, why: 'the space suppresses' },
      { space: S.quiet, type: UNSUPPRESSING, record: undefined, queued: true, why: 'the schema overrides the space' },
      { space: S.quiet, type: UNSUPPRESSING, record: true, queued: false, why: 'the record overrides the schema' },
    ];

    it('every row, for every brain family the pull door writes; links queue nothing', async () => {
      const expected = [];
      let seq = 10;
      for (const fam of writtenFamilies()) {
        const rt = recordTypeOf[fam.collection];
        if (rt === null) {
          // A link: a pair of ids, no text. Pulled, it must land and queue nothing.
          served[S.open] ??= {};
          served[S.open][fam.payloadKey] = [[{
            _id: 'link-1', spaceId: 'sender-space', seq: ++seq, author, from: 'x', fromKind: 'fact', to: 'y',
            toKind: 'entity', label: 'mentions', createdAt: iso(CREATED), updatedAt: iso(CREATED),
          }]];
          expected.push({ space: S.open, coll: fam.collection, id: 'link-1', queued: false, why: 'a link has nothing to embed' });
          continue;
        }
        ROWS.forEach((row, i) => {
          const id = `${rt}-${i}`;
          const doc = fixture(rt, id, ++seq, {
            [typeField[rt]]: row.type,
            ...(row.record === undefined ? {} : { suppressEmbeddings: row.record }),
          });
          served[row.space] ??= {};
          (served[row.space][fam.payloadKey] ??= [[]])[0].push(doc);
          expected.push({ space: row.space, coll: fam.collection, id, queued: row.queued, why: row.why, rt });
        });
      }
      const out = await engine.runSyncForPeer(PEER);
      assert.equal(out.errors, 0, `the pull cycle failed: ${JSON.stringify(out)}`);

      const wrong = [];
      for (const e of expected) {
        const stored = await coll(e.space, e.coll).countDocuments({ _id: e.id });
        assert.equal(stored, 1, `fixture check: ${e.coll}/${e.id} was not stored by the pull in ${e.space}`);
        const jobs = await coll(e.space, 'embed_jobs').countDocuments({ recordId: e.id });
        if ((jobs > 0) !== e.queued) wrong.push(`${e.space} ${e.coll}/${e.id}: queued=${jobs > 0}, want ${e.queued} (${e.why})`);
      }
      assert.deepEqual(wrong, [],
        'a pulled record was not offered to this instance\'s embedder by the receiver\'s own rules. Unqueued, it is '
        + 'stored and absent from every meaning-ranked search here until a reindex nobody was told to run.');
    });
  });

  it('a page holding the same _id twice stores the HIGHEST seq, in every family', async () => {
    let n = 0;
    const want = [];
    for (const fam of writtenFamilies()) {
      const rt = recordTypeOf[fam.collection];
      const id = `dup-${fam.collection}`;
      const make = (seq) => rt === null
        ? { _id: id, spaceId: 's', seq, author, from: `f${seq}`, fromKind: 'fact', to: 't', toKind: 'entity', label: 'mentions',
          createdAt: iso(CREATED), updatedAt: iso(CREATED) }
        : fixture(rt, id, seq, rt === 'edge' ? { from: `from-${seq}` } : {});
      const hi = 900 + (n += 10);
      served[S.dup] ??= {};
      served[S.dup][fam.payloadKey] = [[make(hi), make(hi - 6)]];
      want.push({ coll: fam.collection, id, hi });
    }
    const { result: out, lines } = await capturingLogs(() => engine.runSyncForPeer(PEER));
    assert.equal(out.errors, 0, JSON.stringify(out));
    const wrong = [];
    for (const w of want) {
      const stored = await coll(S.dup, w.coll).findOne({ _id: w.id });
      if (stored?.seq !== w.hi) wrong.push(`${w.coll}/${w.id}: stored seq ${stored?.seq}, want ${w.hi}`);
      // Lens S5: the collapse is reported, naming the id, rather than recorded and read by nobody.
      if (!lines.some(l => l.includes('sent more than once') && l.includes(w.id))) wrong.push(`${w.coll}/${w.id}: collapse not reported`);
    }
    assert.deepEqual(wrong, [], 'a repeated id in one page let the OLDER version win: the page was applied in '
      + 'arrival order instead of collapsing to the highest seq — or the collapse went unreported');
  });

  it('the counter is at least the max landed seq after EACH page, not only after the run', async () => {
    const fam = writtenFamilies().find(f => recordTypeOf[f.collection] === 'fact');
    assert.ok(fam, 'no facts family derived');
    served[S.pages] = { [fam.payloadKey]: [
      [fixture('fact', 'pg-1', 501), fixture('fact', 'pg-2', 502), fixture('fact', 'pg-3', 503)],
      [fixture('fact', 'pg-4', 504)],
    ] };
    const seen = [];
    onServe = async (space, key, at) => {
      if (space === S.pages && key === fam.payloadKey && at === 1) seen.push(await seqMod.currentSeq(S.pages));
    };
    const out = await engine.runSyncForPeer(PEER);
    assert.equal(out.errors, 0, JSON.stringify(out));
    assert.equal(seen.length, 1, 'fixture check: the second page was never requested');
    assert.ok(seen[0] >= 503,
      `when the second page was requested the counter was ${seen[0]}, below the first page's landed max 503. `
      + 'Until the run ends a local write can take a seq beneath a record already stored, which a peer that has '
      + 'pulled past it never asks for.');
    assert.ok(await seqMod.currentSeq(S.pages) >= 504, 'and after the run, at least the max of the run');
  });

  it('a non-duplicate write fault holds the watermark and is a record-write failure, not an unreachable peer', async () => {
    const fam = writtenFamilies().find(f => recordTypeOf[f.collection] === 'fact');
    served[S.fault] = { [fam.payloadKey]: [[fixture('fact', 'flt-1', 701), fixture('fact', 'flt-2', 702)]] };
    const target = `${S.fault}_${fam.collection}`;
    const proto = Object.getPrototypeOf(mongo.col('probe'));
    const METHODS = ['bulkWrite', 'replaceOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'findOneAndReplace',
      'findOneAndUpdate'];
    const originals = Object.fromEntries(METHODS.map(m => [m, proto[m]]));
    let faults = 0;
    for (const m of METHODS) {
      proto[m] = function faulty(...args) {
        if (this.collectionName === target) { faults++; return Promise.reject(new MongoNetworkError('injected: connection reset')); }
        return originals[m].apply(this, args);
      };
    }
    const failuresBefore = member().consecutiveFailures ?? 0;
    let captured;
    try {
      captured = await capturingLogs(() => engine.runSyncForPeer(PEER));
    } finally {
      Object.assign(proto, originals);
    }
    assert.ok(faults > 0, 'fixture check: the injected fault was never reached — the page was not written');
    const through = member().lastSeqReceived?.[S.fault] ?? 0;
    assert.ok(through < 701, `the watermark moved to ${through}, past a page that never landed`);
    assert.equal(await coll(S.fault, fam.collection).countDocuments({}), 0, 'fixture check: something landed');

    assert.equal(member().consecutiveFailures ?? 0, failuresBefore,
      'a record-write fault was counted as a failure to reach the peer. That counter is what prints PEER UNREACHABLE, '
      + 'and it sent the operator to look at the network for a fault in this instance\'s own database.');
    const named = captured.lines.filter(l => l.includes(S.fault) && /write/i.test(l) && /fact/i.test(l));
    assert.ok(named.length > 0,
      'the failure is not reported as a record write naming the space and family. Logged:\n' + captured.lines.join('\n'));

    // And it heals: with the fault gone the same page lands and the watermark moves.
    const out = await engine.runSyncForPeer(PEER);
    assert.equal(out.errors, 0, JSON.stringify(out));
    assert.equal(await coll(S.fault, fam.collection).countDocuments({}), 2);
    assert.ok((member().lastSeqReceived?.[S.fault] ?? 0) >= 702, 'the healed page did not move the watermark');
  });

  it('C4: an arrival with no receiver stamp stays unstamped here, and the sender\'s stamp is not adopted', async () => {
    const OLD = Date.parse('2020-01-01T00:00:00.000Z'); // older than every window: main would stamp it in the past
    const want = [];
    let seq = 300;
    for (const fam of writtenFamilies()) {
      const rt = recordTypeOf[fam.collection];
      if (rt === null) continue; // a link has no retention bucket
      const id = `keep-${rt}`;
      served[S.keep] ??= {};
      (served[S.keep][fam.payloadKey] ??= [[]])[0].push(fixture(rt, id, ++seq));
      want.push({ coll: fam.collection, id });
      if (rt === 'fact') {
        served[S.keep][fam.payloadKey][0].push(fixture(rt, 'keep-brief', ++seq, { type: BRIEF }));
        want.push({ coll: fam.collection, id: 'keep-brief' });
        served[S.keep][fam.payloadKey][0].push(fixture(rt, 'keep-old', ++seq, { createdAt: iso(OLD) }));
        want.push({ coll: fam.collection, id: 'keep-old' });
      }
    }
    assert.ok(want.length >= 4, 'fixture check: fewer than four families');
    const out = await engine.runSyncForPeer(PEER);
    assert.equal(out.errors, 0, JSON.stringify(out));
    const wrong = [];
    for (const w of want) {
      const stored = await coll(S.keep, w.coll).findOne({ _id: w.id });
      assert.ok(stored, `fixture check: ${w.coll}/${w.id} did not land`);
      if (stored._expireAt !== undefined || stored._contentExpireAt !== undefined) {
        wrong.push(`${w.coll}/${w.id}: _expireAt ${JSON.stringify(stored._expireAt)}, _contentExpireAt `
          + `${JSON.stringify(stored._contentExpireAt)}`);
      }
    }
    assert.deepEqual(wrong, [], 'a pulled record with no stamp of this instance\'s was stored with one. Either the '
      + 'sender\'s stamp was adopted (a peer deciding when this instance deletes its data) or main\'s D-9 stamping '
      + 'came along with the port, which 5.6.x cuts (C4)');
  });

  it('F15: pulled file metadata lands in <space>_files, never in a <space>_filemeta collection nothing reads', async () => {
    served[S.files] = { filemeta: [[{
      _id: 'docs/pulled.md', spaceId: 'sender-space', path: 'docs/pulled.md', tags: ['pulled'], description: 'from the peer',
      author, createdAt: iso(CREATED), updatedAt: iso(CREATED), seq: 1201,
    }]] };
    const out = await engine.runSyncForPeer(PEER);
    assert.equal(out.errors, 0, JSON.stringify(out));
    const stray = await coll(S.files, 'filemeta').countDocuments({});
    const landed = await coll(S.files, 'files').findOne({ _id: 'docs/pulled.md' });
    assert.deepEqual([stray, landed?.description ?? null], [0, 'from the peer'],
      `pulled file metadata went to ${S.files}_filemeta (${stray} document(s)) instead of ${S.files}_files: the page `
      + 'write named its collection after the URL suffix, so a subscriber that pulls never sees a published description');
  });

  it('C3/F10: a store refusal on a pulled page holds the family\'s position and is not an unreachable peer', async () => {
    const fam = writtenFamilies().find(f => recordTypeOf[f.collection] === 'fact');
    const target = `${S.refuse}_${fam.collection}`;
    const db = mongo.getDb();
    if (!(await db.listCollections({ name: target }).toArray()).length) await db.createCollection(target);
    await db.command({ collMod: target, validator: { $jsonSchema: { properties: { fact: { not: { enum: ['POISON'] } } } } },
      validationLevel: 'strict', validationAction: 'error' });
    served[S.refuse] = { [fam.payloadKey]: [[
      fixture('fact', 'rf-1', 801), fixture('fact', 'rf-bad', 802, { fact: 'POISON' }), fixture('fact', 'rf-3', 803),
    ]] };
    const failuresBefore = member().consecutiveFailures ?? 0;
    const { lines } = await capturingLogs(() => engine.runSyncForPeer(PEER));
    assert.equal(await coll(S.refuse, fam.collection).countDocuments({ _id: 'rf-bad' }), 0, 'fixture check: the poison landed');
    const through = member().lastSeqReceived?.[S.refuse] ?? 0;
    assert.ok(through < 802,
      `the watermark moved to ${through}, past a record the store refused: it is never offered again (C3: a store `
      + 'refusal holds the position like any write fault)');
    assert.equal(member().consecutiveFailures ?? 0, failuresBefore,
      'a store refusal on a pulled page was counted as a failure to reach the peer, which is what prints PEER '
      + 'UNREACHABLE. Logged:\n' + lines.join('\n'));
  });
});
