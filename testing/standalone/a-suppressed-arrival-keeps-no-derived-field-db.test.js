/**
 * After ANY arrival lands, a record the receiver suppresses holds no derived field — `Q-218` round R, item R1
 * (a regression of 5.6.2 against 5.6.1).
 *
 * ## The rule
 *
 * The derived local-only fields (`DERIVED_LOCAL_FIELDS` in `sync/local-only-fields.ts`: the vector, its model and
 * `matchedText`) are what THIS instance computed from the record. The arrival writer carries them across a replace so
 * that a peer's edit does not drop a still-valid vector — and that is right only while the receiver still embeds the
 * record. The embed queue skips a record the receiver suppresses (`embeddingSuppressedFor`, record > schema >
 * space), so nothing ever comes back to remove a carried vector: an arrival that turns suppression on leaves a stale
 * vector and `matchedText` on the stored record for good, and the record stays in meaning-ranked search after its
 * author (or the operator) retired it. 5.6.1's whole-document replace dropped them.
 *
 * So, for every door that stores an arrival — a peer's push (single and batch), a pulled page, an admin restore —
 * every family that embeds, and every tier that can suppress:
 *
 *  - a record the receiver SUPPRESSES after the arrival holds none of the derived fields;
 *  - a record it does NOT suppress keeps the carried vector until it is re-embedded (the reason they are carried) —
 *    on a peer's arrival. A RESTORE carries nothing of the copy it replaces (R2), so a restored record holds no
 *    derived field whatever the tier: it is the backup's record, and every restored record the space embeds is queued.
 *
 * File metadata is not in the set: a peer's file is MERGED (`ingestFileMeta`, `$set`), as on 5.6.1, so no carried
 * field is a 5.6.2 change there.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-suppressed-arrival-keeps-no-derived-field-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateHostAddress, privateAddressSkipReason } from './_private-address.mjs';
import { openPushDoor, build, FAMILIES } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
process.env['SYNC_ALLOW_INSECURE_PEERS'] = 'true';

const OPEN = 'supp-open';
const MUTED = 'supp-muted';
const PEER = 'supp-peer';
const NET = 'supp-net';
/** The family's type field, as the suppression resolver keys the schema tier (`TYPE_FIELD`): an edge keys on label. */
const TYPE_KEY = { fact: 'type', entity: 'type', edge: 'label', chrono: 'type' };
/** A chrono space that declares types allows only those, so the default `event` is declared beside them. */
const schemas = (name, suppressEmbeddings) =>
  Object.fromEntries(Object.keys(TYPE_KEY).map(t => [t, { [name]: { suppressEmbeddings }, ...(t === 'chrono' ? { event: {} } : {}) }]));

/** Each tier that can suppress, and the control that does not. */
const ROWS = [
  { space: OPEN,  mark: undefined, type: undefined, suppressed: false, label: 'nothing suppresses (control)' },
  { space: OPEN,  mark: true,      type: undefined, suppressed: true,  label: 'the arrival carries the record mark' },
  { space: OPEN,  mark: undefined, type: 'quiet',   suppressed: true,  label: 'the arrival takes a type whose schema suppresses' },
  { space: MUTED, mark: undefined, type: undefined, suppressed: true,  label: 'the receiver\'s space suppresses' },
];

/** The four families that embed: the ones with a record type and a single push route. */
const EMBEDDING = Object.entries(FAMILIES).filter(([, f]) => f.single && f.type).map(([key, f]) => ({ key, ...f }));

/** One value per derived field the stored copy holds before the arrival — a fixture; the SET is the module's. */
const DERIVED_VALUES = { embedding: [0.25, 0.5, 0.75], embeddingModel: 'receiver-model', matchedText: 'what this instance embedded' };

let door, DERIVED, importDocuments, engine, peer, served = {};
let seq = 100;
let n = 0;

/** Seed a stored copy holding this instance's derived fields, and build the newer arrival for one row. */
async function seeded(fam, row, via) {
  const id = `${via}-${fam.type}-${++n}`;
  const derived = Object.fromEntries([...DERIVED].map(f => [f, DERIVED_VALUES[f]]));
  const at = (seq += 2);
  await door.coll(row.space, fam.coll).insertOne({ ...build[fam.type](row.space, id, at - 1, { author: { instanceId: PEER, instanceLabel: 'Peer' } }), ...derived });
  const extra = { author: { instanceId: PEER, instanceLabel: 'Peer' } };
  if (row.mark !== undefined) extra.suppressEmbeddings = row.mark;
  if (row.type !== undefined) extra[TYPE_KEY[fam.type]] = row.type;
  return build[fam.type](row.space, id, at, extra);
}

/** What the stored record holds after the arrival, against the rule. */
async function verdict(fam, row, doc, via) {
  const after = await door.coll(row.space, fam.coll).findOne({ _id: doc._id });
  if (!after || after.seq !== doc.seq) return `${via} ${fam.type} (${row.label}): fixture check — the arrival did not land (${JSON.stringify(after?.seq)})`;
  const held = [...DERIVED].filter(f => after[f] !== undefined);
  // A restore carries nothing of the copy it replaces (R2): the record is the backup's, queued to be re-embedded.
  if (via === 'import') {
    return held.length > 0 ? `import ${fam.type} (${row.label}): restored, and still holds ${held.join(', ')} of the replaced copy` : null;
  }
  if (row.suppressed && held.length > 0) {
    return `${via} ${fam.type} (${row.label}): suppressed, and still holds ${held.join(', ')}`;
  }
  if (!row.suppressed && JSON.stringify(after.embedding) !== JSON.stringify(DERIVED_VALUES.embedding)) {
    return `${via} ${fam.type} (${row.label}): not suppressed, and the carried vector was dropped`;
  }
  return null;
}

function startPeer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/api\/sync\/([a-z]+)$/);
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' || !m) return send(404, { error: 'not served by the fake peer' });
    if (m[1] === 'tombstones') return send(200, {});
    send(200, { items: served[url.searchParams.get('spaceId')]?.[m[1]] ?? [], nextCursor: null });
  });
  return new Promise(resolve => server.listen(0, '0.0.0.0', () => resolve(server)));
}

describe('after any arrival lands, a record the receiver suppresses holds no derived field', { skip }, () => {
  before(async () => {
    peer = await startPeer();
    const url = `http://${privateHostAddress()}:${peer.address().port}`;
    door = await openPushDoor({
      suite: 'suppderived',
      spaces: [
        { id: OPEN, label: 'Open', folders: [], meta: { typeSchemas: schemas('quiet', true) } },
        { id: MUTED, label: 'Muted', folders: [], meta: { suppressEmbeddings: true, typeSchemas: schemas('loud', false) } },
      ],
      networks: [{ id: NET, label: 'Pull net', type: 'pubsub', spaces: [OPEN, MUTED], votes: [],
        members: [{ instanceId: PEER, label: 'Peer', url, tokenHash: 'x', direction: 'pull' }] }],
    });
    const loader = await import('../../server/dist/config/loader.js');
    loader.saveSecrets({ peerTokens: { [PEER]: 'peer-token' } });
    ({ DERIVED_LOCAL_FIELDS: DERIVED } = await import('../../server/dist/sync/local-only-fields.js'));
    ({ importDocuments } = await import('../../server/dist/api/admin-import.js'));
    engine = await import('../../server/dist/sync/engine.js');
  });
  after(async () => {
    await new Promise(r => peer?.close(r));
    await door?.close();
  });

  it('the derived field set and the family set are read from the code, with floors', () => {
    assert.ok(DERIVED.size >= 3, `DERIVED_LOCAL_FIELDS: ${[...DERIVED]}`);
    assert.deepEqual([...DERIVED].filter(f => !(f in DERIVED_VALUES)), [], 'a derived field with no fixture goes unchecked');
    assert.deepEqual(EMBEDDING.map(f => f.type).sort(), Object.keys(TYPE_KEY).sort());
  });

  for (const via of ['single push', 'batch push']) {
    it(`${via}: every family, every tier`, async () => {
      const wrong = [];
      for (const fam of EMBEDDING) {
        for (const row of ROWS) {
          const doc = await seeded(fam, row, via.split(' ')[0]);
          const r = via === 'single push'
            ? await door.push(fam.single, doc, { spaceId: row.space })
            : await door.push('/batch-upsert', { [fam.key]: [doc] }, { spaceId: row.space });
          assert.equal(r.code, 200, JSON.stringify(r.body));
          const w = await verdict(fam, row, doc, via);
          if (w) wrong.push(w);
        }
      }
      assert.deepEqual(wrong, [], 'an arrival left this instance\'s derived fields on a record the receiver suppresses: '
        + 'the embed queue skips it, so the stale vector stays for good and the record stays in meaning-ranked search');
    });
  }

  it('pull: every family, every tier', async () => {
    const cases = [];
    served = {};
    for (const fam of EMBEDDING) {
      for (const row of ROWS) {
        const doc = await seeded(fam, row, 'pull');
        ((served[row.space] ??= {})[fam.key] ??= []).push(doc);
        cases.push({ fam, row, doc });
      }
    }
    const out = await engine.runSyncForPeer(PEER);
    assert.equal(out.errors, 0, `the pull cycle failed: ${JSON.stringify(out)}`);
    const wrong = [];
    for (const c of cases) { const w = await verdict(c.fam, c.row, c.doc, 'pull'); if (w) wrong.push(w); }
    assert.deepEqual(wrong, [], 'a pulled page left this instance\'s derived fields on a record the receiver suppresses');
  });

  it('import (a restore): every family, every tier', async () => {
    const wrong = [];
    for (const fam of EMBEDDING) {
      for (const row of ROWS) {
        const doc = await seeded(fam, row, 'import');
        const r = await importDocuments(row.space, { [fam.coll]: [doc] });
        assert.equal(r.results[fam.coll].errors, 0, JSON.stringify(r.results[fam.coll]));
        const w = await verdict(fam, row, doc, 'import');
        if (w) wrong.push(w);
      }
    }
    assert.deepEqual(wrong, [], 'a restore left this instance\'s derived fields on a record the receiver suppresses');
  });
});
