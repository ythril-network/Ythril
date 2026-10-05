/**
 * Every tombstone this instance issues carries `originalSeq` — the seq of the record it deletes (Q-361 item 14).
 *
 * ## Why the field is not optional
 *
 * `tombstoneDoc`'s docblock calls it the forgettable half. The tombstone page a peer pulls filters a tombstone out when
 * the peer's watermark never reached the record it deletes (`originalSeq > since` is the test; an UNDEFINED one always
 * passes). So a tombstone written without it is offered to every peer — including one that never held the record — as a
 * deletion, and the same record on a peer that did hold it is deleted by a tombstone that cannot say which version it
 * meant. Four writers of a tombstone did not carry it on 5.6.3:
 *
 *  - the DUPLICATE edge a merge drops because the survivor already has the same one (`merge.ts`);
 *  - the LINK a merge moves off the absorbed entity — it is re-keyed, and the old id is tombstoned (`merge.ts`);
 *  - the ABSORBED ENTITY itself (`merge.ts`, phase 5);
 *  - the LINK a reconcile removes because the record no longer names its target (`links.ts` `reconcileLinks`), whose read
 *    of the existing set projected `_id` alone and so had no seq to carry.
 *
 * ## The writer set is read out of the source, and each writer is driven
 *
 * The first case reads every `writeTombstone(` and `tombstoneDoc(` call in `server/src` (the module that defines them
 * excepted), asserts a floor on how many it found, and asserts each hands over an `originalSeq` that is not the literal
 * `undefined`. It then holds the set of FILES those calls live in equal to the files a case below drives, in both
 * directions — a writer added tomorrow that no case drives fails it, and a row left for a writer that is gone fails it.
 * The edge RE-KEY (`edge-rekey.ts`) writes its tombstone by `tombstoneDoc` directly, inside the delete-and-insert it
 * owns, and is driven by the two doors that reach it.
 *
 * Each case asserts the VALUE: the seq of the record it deletes, read BEFORE the operation, so an `originalSeq` that is
 * merely present but wrong (the tombstone's own seq, the survivor's) fails too.
 *
 * Driven through `executeMerge`, which every merge door calls, `reconcileLinks`, `updateEdgeById` and the four plain
 * deletes, in a space initialised as production does so the unique indexes are real.
 *
 * Seen red on 6eb5a333 (5.6.3): all four tombstones above carry no `originalSeq`. Seen red again on 5.6.4 by hand: every
 * writer's value turned into `undefined` fails the scan case and its own case, and the edge re-key's value turned into
 * its tombstone's own seq fails the two re-key cases only (the scan cannot see a wrong value, which is why the cases
 * assert it); restored by hand.
 *
 * Run: node --test testing/standalone/a-tombstone-carries-the-seq-of-the-record-it-deletes-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { callSitesIn } from './_call-graph.mjs';

const skip = await mongoSkipReason();

/** The two functions that issue a tombstone, and the module that defines them (the one file they are not called from). */
const ISSUERS = ['writeTombstone', 'tombstoneDoc'];
const DEFINING_MODULE = 'server/src/brain/tombstones.ts';

/**
 * The files whose tombstone writers a case below drives. Held EQUAL to the files the source scan finds, so a writer
 * added tomorrow that no case drives fails the scan case, and a row left for a writer that is gone fails it too.
 */
const DRIVEN_FILES = new Set(['merge', 'links', 'edge-rekey', 'edges', 'entities', 'fact', 'chrono'].map(n => `server/src/brain/${n}.ts`));

/** The offset of the `)` that closes the `(` at `open`, skipping quoted text. */
function closingParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      for (i++; i < code.length && code[i] !== ch; i++) if (code[i] === '\\') i++;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  throw new Error(`no closing parenthesis for the call opened at ${open}`);
}

/** Every call of a tombstone issuer in the server source, as `{ file, name, args }` (comments stripped first). */
function issuerCalls() {
  const calls = [];
  for (const { file, text } of readTrackedSources('server/src', { floor: 300, untracked: true })) {
    if (file === DEFINING_MODULE) continue;
    const code = stripComments(text);
    for (const site of callSitesIn(code, { closures: true })) {
      if (ISSUERS.includes(site.name)) calls.push({ file, name: site.name, args: code.slice(site.paren + 1, closingParen(code, site.paren)) });
    }
  }
  return calls;
}

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-tomb-seq-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const S = 'tombseq';
const INSTANCE = 'tomb-seq-test';
const LOCAL = { instanceId: INSTANCE, instanceLabel: 'Here' };
const T0 = '2026-09-01T00:00:00.000Z';

let mongo, merge, links, edgeIdFor, linkIdFor, edges, entities, facts, chrono;
let seq = 100;
const coll = (n) => mongo.col(`${S}_${n}`);

const entity = (_id) => ({ _id, spaceId: S, name: `E ${_id.slice(0, 4)}`, type: 'thing', tags: [], properties: {},
  author: LOCAL, createdAt: T0, updatedAt: T0, seq: ++seq });
const edge = (over) => ({ spaceId: S, label: 'knows', fromKind: 'entity', toKind: 'entity', tags: [], author: LOCAL,
  createdAt: T0, updatedAt: T0, seq: ++seq, ...over });
const fact = (_id) => ({ _id, spaceId: S, fact: `fact ${_id.slice(0, 4)}`, tags: [], author: LOCAL, createdAt: T0, updatedAt: T0, seq: ++seq });
const chronoEntry = (_id) => ({ _id, spaceId: S, title: `Chrono ${_id.slice(0, 4)}`, type: 'event', startsAt: T0, status: 'upcoming',
  tags: [], author: LOCAL, createdAt: T0, updatedAt: T0, seq: ++seq });
const link = (from, fromKind, to, toKind) => ({ _id: linkIdFor(from, fromKind, to, toKind), spaceId: S, from, fromKind, to, toKind,
  author: LOCAL, createdAt: T0, updatedAt: T0, seq: ++seq });

async function runMerge(survivorId, absorbedId) {
  const survivor = await coll('entities').findOne({ _id: survivorId });
  const absorbed = await coll('entities').findOne({ _id: absorbedId });
  return merge.executeMerge(S, survivor, absorbed, {}, undefined);
}

describe('a tombstone carries the seq of the record it deletes', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('tombseq');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: INSTANCE, instanceLabel: 'Here', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Tomb seq', folders: [], completeLinkage: true, meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    await (await import('../../server/dist/spaces/lifecycle.js')).initSpace(S, { waitForVectorReady: false });
    merge = await import('../../server/dist/brain/merge.js');
    links = await import('../../server/dist/brain/links.js');
    edges = await import('../../server/dist/brain/edges.js');
    entities = await import('../../server/dist/brain/entities.js');
    facts = await import('../../server/dist/brain/fact.js');
    chrono = await import('../../server/dist/brain/chrono.js');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ linkIdFor } = links);
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'links', 'facts', 'chrono', 'files', 'tombstones', 'embed_jobs']) await coll(c).deleteMany({});
  });

  it('an edge a merge moves onto the survivor: the old id\'s tombstone (the edge re-key) carries the seq of that edge', async () => {
    const [SURV, ABS, X] = [randomUUID(), randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(SURV), entity(ABS), entity(X)]);
    const old = edge({ from: ABS, to: X });
    old._id = edgeIdFor(old.from, old.to, old.label, old.fromKind, old.toKind);
    await coll('edges').insertOne(old);
    await runMerge(SURV, ABS);
    assert.ok(await coll('edges').findOne({ _id: edgeIdFor(SURV, X, old.label, old.fromKind, old.toKind) }), 'fixture check: the edge was not re-keyed onto the survivor');
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'edge' });
    assert.ok(tomb, 'no tombstone for the moved edge\'s old id');
    assert.equal(tomb.originalSeq, old.seq, `the re-keyed edge's tombstone carries originalSeq ${tomb.originalSeq}, not the edge's seq ${old.seq}`);
  });

  it('an edge given a new label: the old id\'s tombstone (the edge re-key) carries the seq of that edge', async () => {
    const [A, B] = [randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(A), entity(B)]);
    const old = edge({ from: A, to: B });
    old._id = edgeIdFor(old.from, old.to, old.label, old.fromKind, old.toKind);
    await coll('edges').insertOne(old);
    const out = await edges.updateEdgeById(S, old._id, { label: 'renamed' });
    assert.equal(out?.label, 'renamed', 'fixture check: the label was not changed');
    assert.equal(await coll('edges').findOne({ _id: old._id }), null, 'fixture check: the old id still holds an edge (no re-key happened)');
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'edge' });
    assert.ok(tomb, 'no tombstone for the re-labelled edge\'s old id');
    assert.equal(tomb.originalSeq, old.seq, `the re-labelled edge's tombstone carries originalSeq ${tomb.originalSeq}, not the edge's seq ${old.seq}`);
  });

  // The plain deletes: each reads the record's seq before it removes it, and each is a writer the scan case above finds.
  for (const [what, type, coll_, make, remove] of [
    ['an edge', 'edge', 'edges', () => edge({ from: randomUUID(), to: randomUUID() }), (id) => edges.deleteEdge(S, id)],
    ['an entity', 'entity', 'entities', () => entity(randomUUID()), (id) => entities.deleteEntity(S, id)],
    ['a fact', 'fact', 'facts', () => fact(randomUUID()), (id) => facts.deleteFact(S, id)],
    ['a chrono entry', 'chrono', 'chrono', () => chronoEntry(randomUUID()), (id) => chrono.deleteChrono(S, id)],
  ]) {
    it(`${what} deleted: its tombstone carries the seq the record held`, async () => {
      const doc = make();
      doc._id ??= edgeIdFor(doc.from, doc.to, doc.label, doc.fromKind, doc.toKind);
      await coll(coll_).insertOne(doc);
      assert.equal(await remove(doc._id), true, 'fixture check: the delete did not find the record');
      const tomb = await coll('tombstones').findOne({ _id: doc._id, type });
      assert.ok(tomb, `no tombstone for the deleted ${type}`);
      assert.equal(tomb.originalSeq, doc.seq, `the ${type}'s tombstone carries originalSeq ${tomb.originalSeq}, not the record's seq ${doc.seq}`);
    });
  }

  it('a duplicate edge a merge drops: its tombstone carries the seq of that edge', async () => {
    const [SURV, ABS, X] = [randomUUID(), randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(SURV), entity(ABS), entity(X)]);
    const kept = edge({ from: SURV, to: X });
    kept._id = randomUUID();
    const doomed = edge({ from: ABS, to: X });
    doomed._id = edgeIdFor(doomed.from, doomed.to, doomed.label, doomed.fromKind, doomed.toKind);
    await coll('edges').insertMany([kept, doomed]);
    const out = await runMerge(SURV, ABS);
    assert.deepEqual(out.deletedDuplicateEdgeIds, [doomed._id], 'fixture check: the merge did not drop the duplicate');
    const tomb = await coll('tombstones').findOne({ _id: doomed._id });
    assert.ok(tomb, 'no tombstone for the dropped duplicate');
    assert.equal(tomb.originalSeq, doomed.seq, `the duplicate's tombstone carries originalSeq ${tomb.originalSeq}, not the deleted edge's seq ${doomed.seq}`);
  });

  it('a link a merge moves off the absorbed entity: the old id\'s tombstone carries the seq of that link', async () => {
    const [SURV, ABS, F] = [randomUUID(), randomUUID(), randomUUID()];
    await coll('entities').insertMany([entity(SURV), entity(ABS)]);
    const old = link(F, 'fact', ABS, 'entity');
    await coll('links').insertOne(old);
    await runMerge(SURV, ABS);
    assert.ok(await coll('links').findOne({ _id: linkIdFor(F, 'fact', SURV, 'entity') }), 'fixture check: the link was not moved onto the survivor');
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'link' });
    assert.ok(tomb, 'no tombstone for the moved link\'s old id');
    assert.equal(tomb.originalSeq, old.seq, `the moved link's tombstone carries originalSeq ${tomb.originalSeq}, not the link's seq ${old.seq}`);
  });

  it('the absorbed entity: its tombstone carries the seq the entity held', async () => {
    const [SURV, ABS] = [randomUUID(), randomUUID()];
    const absorbed = entity(ABS);
    await coll('entities').insertMany([entity(SURV), absorbed]);
    await runMerge(SURV, ABS);
    const tomb = await coll('tombstones').findOne({ _id: ABS, type: 'entity' });
    assert.ok(tomb, 'no tombstone for the absorbed entity');
    assert.equal(tomb.originalSeq, absorbed.seq, `the absorbed entity's tombstone carries originalSeq ${tomb.originalSeq}, not its seq ${absorbed.seq}`);
  });

  it('a link a reconcile removes: its tombstone carries the seq of that link', async () => {
    const [F, E] = [randomUUID(), randomUUID()];
    await coll('entities').insertOne(entity(E));
    const old = link(F, 'fact', E, 'entity');
    await coll('links').insertOne(old);
    // The fact no longer names the entity: an authoritative write of an empty set detaches it.
    const out = await links.reconcileLinks(S, F, 'fact', { entity: [] }, LOCAL);
    assert.equal(out.removed, 1, `fixture check: the reconcile removed ${out.removed} link(s)`);
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'link' });
    assert.ok(tomb, 'no tombstone for the removed link');
    assert.equal(tomb.originalSeq, old.seq, `the removed link's tombstone carries originalSeq ${tomb.originalSeq}, not the link's seq ${old.seq}`);
  });

  it('PIN a link that carries no seq (written before seqs) is tombstoned without one, as it must be', async () => {
    const [F, E] = [randomUUID(), randomUUID()];
    await coll('entities').insertOne(entity(E));
    const old = link(F, 'fact', E, 'entity');
    delete old.seq;
    await coll('links').insertOne(old);
    const out = await links.reconcileLinks(S, F, 'fact', { entity: [] }, LOCAL);
    assert.equal(out.removed, 1);
    const tomb = await coll('tombstones').findOne({ _id: old._id, type: 'link' });
    assert.ok(tomb, 'no tombstone for the removed link');
    assert.equal(tomb.originalSeq, undefined, 'an originalSeq was invented for a link that never had a seq');
  });
});

// No database: the writer set is a fact about the source, so it is asserted whether or not a Mongo is reachable.
describe('every writer of a tombstone names the seq of the record it deletes', () => {
  it('every call of a tombstone issuer passes an originalSeq that is not the literal undefined, and each file that calls one is driven above', () => {
    const calls = issuerCalls();
    assert.ok(calls.length >= DRIVEN_FILES.size, `only ${calls.length} tombstone issuer calls found — the scan is broken, not the code`);
    const valueless = calls.filter(c => {
      const value = /\boriginalSeq\s*:\s*([^,}\s][^,}]*)/.exec(c.args)?.[1]?.trim();
      return value === undefined || value === 'undefined';
    });
    assert.deepEqual(valueless.map(c => `${c.file}: ${c.name}(${c.args.replace(/\s+/g, ' ').slice(0, 90)})`), [],
      'these tombstones are issued without the seq of the record they delete');
    const files = new Set(calls.map(c => c.file));
    assert.deepEqual([...files].filter(f => !DRIVEN_FILES.has(f)).sort(), [], 'these files issue a tombstone that no case above drives — add one');
    assert.deepEqual([...DRIVEN_FILES].filter(f => !files.has(f)).sort(), [], 'these files are listed as driven but no longer issue a tombstone');
  });
});