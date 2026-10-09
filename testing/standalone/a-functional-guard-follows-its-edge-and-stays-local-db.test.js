/**
 * The functional guard marker follows ITS edge, stays on THIS instance, and its index is there and says so when it cannot
 * be built (Q-439, design rev 4, items A, B, C, E, K, L).
 *
 * ## The rule
 *
 * An edge inserted under a `functional` label in a STRICT space carries `_functionalGuard`, and a partial unique index
 * over that field is what stops two writers racing to a second edge for one subject. The marker is only safe while it is
 * a PURE FUNCTION of the edge that carries it: `_functionalGuard === key(from, label)` for a strict functional label, and
 * absent otherwise. A marker that outlives the (from, label) it was stamped for is a phantom lock - the subject can never
 * be written again, and nothing says why. So this file holds, over every door that can change an edge's `from` or `label`:
 *
 * - **it follows its edge**: an insert stamps it, a converge keeps it, a relabel onto a functional label stamps it and a
 *   relabel away drops it (the held-transaction rekey of a local edge AND the in-place branch a peer-authored edge takes),
 *   a merge's relink drops it, and an arrival replaces a row keeping it only while `from` and `label` are unchanged;
 * - **it never leaves this instance**: an export carries none, an import stores none, and it is on no answer - a read, a
 *   write's return, a webhook payload, the live-view bus - even when a caller asks for it by projection;
 * - **a stale one is healed, counted and reported**: a phantom marker does not block the next insert for its subject,
 *   the heal is signalled through the housekeeping reporter, and `validate-schema` names stale markers under `staleGuards`
 *   without moving `totalViolations`;
 * - **its index exists** after `initSpace` and after an online restore, is partial (unmarked edges, and edges whose marker
 *   is `null`, coexist), is reported when it cannot be built over duplicate markers WITHOUT aborting `initSpace`, and a
 *   store failure during the build still propagates instead of being swallowed as "a duplicate".
 *
 * ## What is derived, and what is chosen
 *
 * - The doors: each family of doors is read out of `CAPABILITIES` (`save_edge` and `update_edge` and the route each is
 *   documented as answering), never listed here; each family is floored.
 * - **key(from, label)**: the plan fixes it as "a subject key that cannot collide (no NUL; the length-prefixed form)".
 *   `keyOf` below spells that form once - the same one `validate-stored-edges.ts` already uses for its subject count - and
 *   the first case pins that what a real insert stamps IS that form. A fixture that needs a VALID marker uses `keyOf`; a
 *   fixture that needs "some marker" uses `SEEDED`, so a case does not depend on the format it is not about.
 * - The module that exports `ensureEdgeGuardIndex` is found by reading `server/dist`, because the plan fixes the NAME and
 *   not the path; exactly one module must export it.
 * - What is observed on a webhook is the dispatcher's own retry row (the subscription points where the SSRF guard refuses
 *   at once, so every dispatch leaves a row carrying the payload it would have sent) and the in-process bus the live view
 *   reads; both are given the same `entry` by `emitWebhookEvent`.
 *
 * ## Fixtures that place a marker place it DIRECTLY in the collection
 *
 * A case about "the marker is not returned / is dropped" cannot get its marker from a write the code under test has not
 * learnt to stamp yet, or it would be red for the wrong reason (nothing was stamped) and green for the wrong one after.
 * So those cases seed the row, with the marker on it, and then act. The cases about STAMPING do not seed.
 *
 * Assertions are on ids and values (the edge found at `(from, to, label)`, its marker), never on a count alone.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-functional-guard-follows-its-edge-and-stays-local-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { build } from './_push-door.mjs';
import { openInlineEdgeDoors, seedInlineEdgeSpace, IDS, LABELS } from './_inline-edge-doors.mjs';
import { CAPABILITIES } from './_capability-map.mjs';
import { withCollectionAsView } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

/** A strict space (the guard applies), a warn-only one (it must not), and the one the online restore replaces. */
const STRICT = 'gl-strict';
const WARN = 'gl-warn';

const MARKER = '_functionalGuard';
/** A marker value a case places itself when the case is not about what the value IS. */
const SEEDED = 'seeded-marker';
const RETRY_QUEUE = '_webhook_retry_queue';

/**
 * key(from, label): length-prefixed, so no part can forge the separator (`("a:b", "c")` and `("a", "b:c")` are two
 * subjects). The form `spaces/validate-stored-edges.ts` counts a subject by; the plan's item 1 names it.
 */
const keyOf = (from, label) => `${from.length}:${from}${label.length}:${label}`;

/** Ids of the fixtures this file adds to `seedInlineEdgeSpace`'s: literal, a fixture deriving its expectations asserts the code equals itself. */
const ID = Object.freeze({
  R1: 'dddddddd-0000-4000-8000-0000000000a1',
  R2: 'dddddddd-0000-4000-8000-0000000000a2',
  R3: 'dddddddd-0000-4000-8000-0000000000a3',
  R4: 'dddddddd-0000-4000-8000-0000000000a4',
});

let env, doors, edgeIdFor, getConfig, initSpace, importDocuments, merge, signals, bus, hooks;
let subscriptionId;
const LOCAL = () => ({ instanceId: getConfig().instanceId, instanceLabel: 'Receiver' });
const PEER = Object.freeze({ instanceId: 'a-peer-of-this-instance', instanceLabel: 'Peer' });

// ── Calling ────────────────────────────────────────────────────────────────────────────────────────────────────────

const callerOf = () => ({ rights: env.ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' });

async function rest(method, route, body) {
  const r = await fetch(`${env.base}${route}`, {
    method, headers: { Authorization: `Bearer ${env.adminKey}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { ok: r.status < 400, status: r.status, body: parsed, text };
}

async function mcp(name, args) {
  const out = await env.callTool({ name, args, caller: callerOf() });
  const text = JSON.stringify(out.result);
  return { ok: out.result.isError !== true, status: out.status, body: out.result.structuredContent ?? {}, text };
}

/** The method and path the capability map documents a tool as answering: the REST twin is derived from the MCP name. */
function routeOf(tool) {
  const row = CAPABILITIES.find(([, t]) => t === tool);
  assert.ok(row, `no capability row names the tool ${tool}`);
  const [method, route] = row[2].split(' ');
  return { method, route };
}

/** The doors that CREATE an edge: the REST route `save_edge` is documented as answering, and the tool. */
function createDoors() {
  const { method, route } = routeOf('save_edge');
  return [
    { name: `REST ${method} ${route}`, send: (space, e) => rest(method, route.replace(':spaceId', space), e) },
    { name: 'MCP save_edge', send: (space, e) => mcp('save_edge', { space, ...e }) },
  ];
}

/** The doors that PATCH an edge (a relabel included). */
function updateDoors() {
  const { method, route } = routeOf('update_edge');
  return [
    { name: `REST ${method} ${route}`, send: (space, id, patch) => rest(method, route.replace(':spaceId', space).replace(':id', id), patch) },
    { name: 'MCP update_edge', send: (space, id, patch) => mcp('update_edge', { space, id, ...patch }) },
  ];
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────────

const edgesOf = (space) => env.door.coll(space, 'edges');
const edgeAt = (space, from, to, label) => edgesOf(space).findOne({ from, to, label });
const markerAt = async (space, from, to, label) => (await edgeAt(space, from, to, label))?.[MARKER];
const fresh = (space) => seedInlineEdgeSpace(env, space);

/**
 * A stored edge with the marker on it, placed directly. `peer` makes it a PEER-authored row (a rekey declines it and the
 * relabel falls back to the in-place write); the default is authored HERE, under the id its identity derives (the rekey path).
 */
async function seedEdge(space, { from, to, label, marker, peer = false, id, seq = 4, extra = {} }) {
  const _id = id ?? (peer ? `peer-${from}-${to}-${label}` : edgeIdFor(from, to, label));
  const doc = build.edge(space, _id, seq, { from, to, label, author: peer ? PEER : LOCAL(), ...extra });
  if (marker !== undefined) doc[MARKER] = marker;
  await edgesOf(space).insertOne(doc);
  return _id;
}

/** The guard index of a space's edges, found by its key; `undefined` when there is none. */
async function guardIndex(space) {
  const ixs = await edgesOf(space).listIndexes().toArray();
  return ixs.find(ix => Object.keys(ix.key).length === 1 && ix.key[MARKER] === 1);
}

async function dropGuardIndex(space) {
  const ix = await guardIndex(space);
  if (ix) await edgesOf(space).dropIndex(ix.name);
}

/** The reporter's failure signals raised while `fn` runs - what `ythril_housekeeping_space_failures_total` counts. */
async function failuresDuring(fn) {
  const events = [];
  const off = signals.onHousekeepingSignal(e => { if (e.type === 'space-failure') events.push(e); });
  try { return { value: await fn(), events }; } finally { off(); }
}

/** What an action made this instance emit: the bus the live view reads, and the payloads the webhook dispatcher queued. */
async function emittedDuring(space, action) {
  await env.door.mongo.col(RETRY_QUEUE).deleteMany({});
  const seen = [];
  const off = bus.subscribeBrainChanges(space, ev => seen.push(ev));
  let value;
  try {
    value = await action();
    const queued = async () => (await env.door.mongo.col(RETRY_QUEUE).find({ webhookId: subscriptionId }).toArray());
    await waitFor(async () => seen.length > 0 && (await queued()).length >= seen.length, 10_000, 50,
      () => `the action emitted ${seen.length} bus event(s) and the dispatcher queued ${seen.length > 0 ? 'fewer' : 'none'} - no payload to read`);
    const payloads = (await queued()).map(r => ({ event: r.event, entry: JSON.parse(r.body).entry }));
    return { value, bus: seen.map(e => ({ event: e.event, entry: e.entry })), payloads };
  } finally { off(); }
}

const carriesMarker = (what) => JSON.stringify(what).includes(MARKER);

/** Which of the three ways an edge write is told to the outside carried the marker: the caller's answer, a webhook payload, the live-view bus. */
function channelsCarryingMarker(out) {
  return [
    ['the answer', out.value.text],
    ['the webhook payload', out.payloads],
    ['the live-view event', out.bus],
  ].filter(([, what]) => carriesMarker(what)).map(([name]) => name);
}
const describeLeak = (out) => `${JSON.stringify(channelsCarryingMarker(out))} - answer: ${out.value.text.slice(0, 200)}`;

// ── The doors that build the whole thing ───────────────────────────────────────────────────────────────────────────

describe('the functional guard marker follows its edge and stays on this instance', { skip }, () => {
  before(async () => {
    doors = await openInlineEdgeDoors({
      suite: 'guardlife',
      spaces: [
        { id: STRICT, strictLinkage: false, validationMode: 'strict' },
        { id: WARN, strictLinkage: false, validationMode: 'warn' },
      ],
    });
    env = doors.env;
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    ({ initSpace } = await import('../../server/dist/spaces/lifecycle.js'));
    ({ importDocuments } = await import('../../server/dist/api/admin-import.js'));
    merge = await import('../../server/dist/brain/merge.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
    bus = await import('../../server/dist/brain/brain-events.js');
    hooks = await import('../../server/dist/webhooks/store.js');
    // One subscription to everything, aimed where the SSRF guard refuses at once: a dispatch leaves a retry row.
    subscriptionId = (await hooks.createWebhook({ url: 'http://127.0.0.1:9/hook', secret: 'guardlife-secret' })).id;
    assert.ok(createDoors().length >= 2 && updateDoors().length >= 2, 'the REST and MCP twins of save_edge and update_edge were not both found');
  });
  after(async () => {
    if (subscriptionId) await hooks?.deleteWebhook(subscriptionId).catch(() => {});
    await env?.door.mongo.col(RETRY_QUEUE).deleteMany({}).catch(() => {});
    await doors?.close();
  });
  beforeEach(async () => { await fresh(STRICT); await fresh(WARN); });

  // ── 1. It is stamped on an insert and follows its edge through every change of from or label ────────────────────

  describe('an insert stamps it', () => {
    for (const d of createDoors()) {
      it(`${d.name}: a strict functional insert carries key(from, label), and a converge keeps it unchanged`, async () => {
        const made = await d.send(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional });
        assert.ok(made.ok, `fixture: the create was refused: ${made.text.slice(0, 300)}`);
        const first = await edgeAt(STRICT, IDS.ALICE, IDS.BOB, LABELS.functional);
        assert.ok(first, 'fixture: the edge was not stored');
        assert.equal(first[MARKER], keyOf(IDS.ALICE, LABELS.functional),
          `the stored edge ${first._id} carries ${JSON.stringify(first[MARKER])}, not key(from, label)`);
        assert.ok(!first[MARKER].includes('\u0000'), 'the key holds a NUL, which makes git treat its source as binary and lets a part forge the separator');

        // The same triplet again, with a changed description: a converge, never a new stamp.
        const again = await d.send(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, description: 'said again' });
        assert.ok(again.ok, `fixture: the converge was refused: ${again.text.slice(0, 300)}`);
        const second = await edgeAt(STRICT, IDS.ALICE, IDS.BOB, LABELS.functional);
        assert.equal(second._id, first._id, 'the converge wrote a second edge');
        assert.equal(second.description, 'said again', 'fixture: the converge did not land');
        assert.equal(second[MARKER], first[MARKER], 'a converge changed the marker');
      });

      it(`${d.name}: the marker is a function of (from, label) alone - the same subject re-written after a delete carries the same one, another subject another`, async () => {
        await d.send(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional });
        const a = await markerAt(STRICT, IDS.ALICE, IDS.BOB, LABELS.functional);
        await edgesOf(STRICT).deleteMany({});
        await d.send(STRICT, { from: IDS.ALICE, to: IDS.DOC, label: LABELS.functional });
        const again = await markerAt(STRICT, IDS.ALICE, IDS.DOC, LABELS.functional);
        await d.send(STRICT, { from: IDS.BOB, to: IDS.DOC, label: LABELS.functional });
        const other = await markerAt(STRICT, IDS.BOB, IDS.DOC, LABELS.functional);
        assert.equal(typeof a, 'string', 'no marker was stamped on the first insert');
        assert.equal(again, a, 'the same (from, label) with another `to` was stamped with a different key');
        assert.notEqual(other, a, 'two subjects share one key, so the second subject could never hold an edge');
      });

      it(`${d.name} CONTROL: an insert under a label that is not functional, and a functional one in a warn-only space, carry no marker`, async () => {
        const plain = await d.send(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.plain });
        const warned = await d.send(WARN, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional });
        assert.ok(plain.ok && warned.ok, `fixture: a create was refused: ${plain.text.slice(0, 200)} / ${warned.text.slice(0, 200)}`);
        assert.equal(MARKER in (await edgeAt(STRICT, IDS.ALICE, IDS.BOB, LABELS.plain)), false, 'a plain label was stamped');
        assert.equal(MARKER in (await edgeAt(WARN, IDS.ALICE, IDS.BOB, LABELS.functional)), false,
          'a warn-only space was stamped: the guard is for strict mode, and warn must not refuse through the index');
      });
    }
  });

  describe('a relabel re-stamps it', () => {
    /**
     * The two ways an edge is relabelled: a local edge is RE-KEYED inside the held transaction (delete and insert under the
     * derived id), a PEER-authored one is not moved (only the author may move it) and is written in place. The marker must
     * follow the label on BOTH, or the in-place branch is a phantom-lock factory.
     */
    const HOW = [
      { how: 'the held-transaction rekey (an edge authored here)', peer: false },
      { how: 'the in-place write (an edge a peer authored)', peer: true },
    ];
    for (const d of updateDoors()) {
      for (const { how, peer } of HOW) {
        it(`${d.name}, ${how}: relabel ONTO a functional label stamps key(from, label)`, async () => {
          const id = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.plain, peer });
          const out = await d.send(STRICT, id, { label: LABELS.functional });
          assert.ok(out.ok, `fixture: the relabel was refused: ${out.text.slice(0, 300)}`);
          const moved = await edgeAt(STRICT, IDS.ALICE, IDS.BOB, LABELS.functional);
          assert.ok(moved, 'fixture: no edge is stored under the new label');
          assert.equal(moved[MARKER], keyOf(IDS.ALICE, LABELS.functional),
            `the edge ${moved._id} now under ${LABELS.functional} carries ${JSON.stringify(moved[MARKER])}: a relabel onto a functional label leaves it unguarded`);
        });

        it(`${d.name}, ${how}: relabel AWAY from a functional label drops the marker`, async () => {
          const id = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, peer, marker: keyOf(IDS.ALICE, LABELS.functional) });
          const out = await d.send(STRICT, id, { label: LABELS.plain });
          assert.ok(out.ok, `fixture: the relabel was refused: ${out.text.slice(0, 300)}`);
          const moved = await edgeAt(STRICT, IDS.ALICE, IDS.BOB, LABELS.plain);
          assert.ok(moved, 'fixture: no edge is stored under the new label');
          assert.equal(moved[MARKER], undefined,
            `the edge ${moved._id} now under ${LABELS.plain} still carries ${JSON.stringify(moved[MARKER])}: a phantom lock on (${IDS.ALICE}, ${LABELS.functional})`);
        });
      }
    }
  });

  describe('a merge drops it', () => {
    it('a merge relinks the absorbed entity\'s edges - re-keyed (authored here) and in place (authored by a peer) - and neither keeps a marker', async () => {
      // The absorbed entity is the SUBJECT of both, so key(from, label) changes with the relink and the old marker is a phantom.
      const local = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.DOC, label: LABELS.functional, marker: keyOf(IDS.ALICE, LABELS.functional) });
      const peer = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.plain, peer: true, marker: keyOf(IDS.ALICE, LABELS.plain) });
      const survivor = await env.door.coll(STRICT, 'entities').findOne({ _id: IDS.BOB });
      const absorbed = await env.door.coll(STRICT, 'entities').findOne({ _id: IDS.ALICE });
      assert.ok(survivor && absorbed, 'fixture: the entities are not seeded');
      await merge.executeMerge(STRICT, survivor, absorbed, {}, undefined);

      const relinkedLocal = await edgeAt(STRICT, IDS.BOB, IDS.DOC, LABELS.functional);
      const relinkedPeer = await edgesOf(STRICT).findOne({ _id: peer });
      assert.ok(relinkedLocal, `fixture: the edge ${local} authored here was not relinked onto the survivor`);
      assert.ok(relinkedPeer && relinkedPeer.from === IDS.BOB, `fixture: the peer-authored edge ${peer} was not relinked in place`);
      const keptMarker = [['re-keyed', relinkedLocal], ['relinked in place', relinkedPeer]].filter(([, e]) => MARKER in e).map(([how, e]) => `${how}: ${e._id} kept ${JSON.stringify(e[MARKER])}`);
      assert.deepEqual(keptMarker, [], 'a relinked edge kept the marker of the subject it no longer has');
    });
  });

  describe('an arrival replaces a row and keeps it only while the subject is unchanged', () => {
    /**
     * The row held here is a peer's, carrying this instance's marker; a PEER's version of it arrives at a higher seq. What
     * crosses the replace is decided against what ARRIVED: from and label unchanged keeps the marker, a changed one drops it.
     */
    const ARRIVALS = [
      { what: 'only its description changed', change: { description: 'edited by the peer' }, keeps: true },
      { what: 'its label changed', change: { label: LABELS.plain }, keeps: false },
      { what: 'its subject (from) changed', change: { from: IDS.DOC }, keeps: false },
    ];
    for (const { what, change, keeps } of ARRIVALS) {
      it(`the arriving copy of a marked edge ${what}: the stored row ${keeps ? 'keeps' : 'drops'} its marker`, async () => {
        const id = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, peer: true, id: ID.R1, marker: SEEDED, seq: 5 });
        const arrived = build.edge(STRICT, id, 6, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, ...change });
        const r = await env.door.push('/edges', arrived, { spaceId: STRICT });
        assert.deepEqual([r.code, r.body], [200, { status: 'ok' }], 'fixture: the arrival was not accepted');
        const stored = await edgesOf(STRICT).findOne({ _id: id });
        assert.equal(stored.seq, 6, 'fixture: the stored row is not the arriving version');
        for (const [k, v] of Object.entries(change)) assert.equal(stored[k], v, `fixture: the arriving ${k} was not stored`);
        assert.equal(stored[MARKER], keeps ? SEEDED : undefined,
          keeps ? 'the arrival erased this instance\'s marker though its from and label did not change, so the next race on this subject is unguarded'
            : `the arrival changed from/label and the row kept ${JSON.stringify(stored[MARKER])}: a phantom lock on the old subject`);
      });
    }
  });

  // ── 2. It never leaves this instance ───────────────────────────────────────────────────────────────────────────────

  describe('restore and import drop it', () => {
    it('an export carries no edge marker', async () => {
      await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, marker: keyOf(IDS.ALICE, LABELS.functional) });
      await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.DOC, label: LABELS.plain, peer: true });
      const r = await rest('GET', `/api/admin/spaces/${STRICT}/export`);
      assert.ok(r.ok && Array.isArray(r.body?.edges), `fixture: the export answered ${r.status}: ${r.text.slice(0, 200)}`);
      const exported = r.body.edges.map(e => e._id);
      assert.equal(exported.length, 2, `fixture: the export holds the edges ${JSON.stringify(exported)}`);
      const leaking = r.body.edges.filter(e => MARKER in e).map(e => e._id);
      assert.deepEqual(leaking, [], `the export wrote the marker of ${JSON.stringify(leaking)}: a backup taken here would carry this instance's lock to another`);
    });

    for (const shape of ['a new row', 'a row it replaces']) {
      it(`an imported edge that carries a marker is stored without it (${shape})`, async () => {
        const id = shape === 'a new row'
          ? ID.R2
          : await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, peer: true, id: ID.R2, marker: SEEDED, seq: 2 });
        const doc = build.edge(STRICT, id, 5, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, [MARKER]: 'a-marker-from-another-instance' });
        const out = await importDocuments(STRICT, { edges: [doc] });
        assert.deepEqual([out.results.edges.errors, out.results.edges.inserted + out.results.edges.updated], [0, 1],
          `fixture: the import did not store the edge: ${JSON.stringify(out.results.edges)}`);
        const stored = await edgesOf(STRICT).findOne({ _id: id });
        assert.equal(stored.seq, 5, 'fixture: the stored row is not the imported one');
        assert.equal(stored[MARKER], undefined, `the import stored the exported marker ${JSON.stringify(stored[MARKER])}: it holds another instance's lock here`);
      });
    }
  });

  describe('the marker appears on no answer and no webhook payload', () => {
    for (const d of createDoors()) {
      it(`${d.name}: the 201/answer, the edge.created webhook payload and the live-view event carry no marker (and the stored edge does)`, async () => {
        const out = await emittedDuring(STRICT, () => d.send(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional }));
        assert.ok(out.value.ok, `fixture: the create was refused: ${out.value.text.slice(0, 300)}`);
        assert.equal(typeof (await markerAt(STRICT, IDS.ALICE, IDS.BOB, LABELS.functional)), 'string',
          'fixture: the stored edge carries no marker, so there is nothing for an answer to withhold');
        assert.ok(out.payloads.some(p => p.event === 'edge.created') && out.bus.some(e => e.event === 'edge.created'), 'fixture: no edge.created was emitted');
        assert.deepEqual(channelsCarryingMarker(out), [], `the marker left this instance on these channels: ${describeLeak(out)}`);
      });
    }

    /**
     * An edit of a row that ALREADY carries one: the answer is built from the stored row, so a marker there leaks unless the
     * answer is built without it. The three paths an update takes - a field patch, a rekey, an in-place relabel.
     */
    const EDITS = [
      { what: 'a field patch', patch: { description: 'edited' }, peer: false },
      { what: 'a relabel re-keyed in the held transaction', patch: { label: LABELS.plain }, peer: false },
      { what: 'a relabel written in place (a peer\'s edge)', patch: { label: LABELS.plain }, peer: true },
    ];
    for (const d of updateDoors()) {
      for (const { what, patch, peer } of EDITS) {
        it(`${d.name}, ${what}: the answer, the edge.updated webhook payload and the live-view event carry no marker`, async () => {
          const id = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, peer, marker: keyOf(IDS.ALICE, LABELS.functional) });
          const out = await emittedDuring(STRICT, () => d.send(STRICT, id, patch));
          assert.ok(out.value.ok, `fixture: the update was refused: ${out.value.text.slice(0, 300)}`);
          assert.ok(out.payloads.some(p => p.event === 'edge.updated') && out.bus.some(e => e.event === 'edge.updated'), 'fixture: no edge.updated was emitted');
          assert.deepEqual(channelsCarryingMarker(out), [], `the marker left this instance on these channels: ${describeLeak(out)}`);
        });
      }
    }

    /**
     * The reads that return an edge row: the generic REST door of `filter` and the tool, and the traversal on both doors -
     * each also asked for the field BY NAME, because an inclusion projection reaches any stored field a read does not withhold.
     */
    function readDoors() {
      const traverse = routeOf('graph_traverse');
      const t = (space, projection) => ({ startId: IDS.ALICE, direction: 'both', maxDepth: 2, includeEdges: true, ...(projection ? { projection } : {}) });
      return [
        { name: 'REST POST /api/filter', send: (space, projection) => rest('POST', '/api/filter', { space, collection: 'edges', filter: {}, ...(projection ? { projection } : {}) }) },
        { name: 'MCP filter', send: (space, projection) => mcp('filter', { space, collection: 'edges', filter: {}, ...(projection ? { projection } : {}) }) },
        { name: `REST ${traverse.method} ${traverse.route}`, send: (space, projection) => rest(traverse.method, traverse.route.replace(':spaceId', space), t(space, projection)) },
        { name: 'MCP graph_traverse', send: (space, projection) => mcp('graph_traverse', { space, ...t(space, projection) }) },
      ];
    }
    for (const d of readDoors()) {
      for (const asked of [undefined, { [MARKER]: 1 }]) {
        it(`${d.name}${asked ? ` asked for ${MARKER} by projection` : ''}: a stored marker is not in the answer`, async () => {
          const id = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, marker: keyOf(IDS.ALICE, LABELS.functional) });
          const out = await d.send(STRICT, asked);
          assert.ok(out.ok, `fixture: the read was refused: ${out.text.slice(0, 300)}`);
          assert.ok(out.text.includes(id), 'fixture: the read did not return the seeded edge at all');
          assert.equal(out.text.includes(MARKER), false, `the read returned the marker: ${out.text.slice(0, 500)}`);
        });
      }
    }
  });

  // ── 3. A stale marker is healed, counted and reported ──────────────────────────────────────────────────────────────

  describe('a phantom marker is healed', () => {
    /** An edge whose marker names a subject it is no longer under: `(ALICE, knows)` carrying key(ALICE, reports_to). */
    const PHANTOM = () => ({ from: IDS.ALICE, to: IDS.BOB, label: LABELS.plain, peer: true, id: ID.R3, marker: keyOf(IDS.ALICE, LABELS.functional) });

    for (const d of createDoors()) {
      it(`${d.name}: the next insert for the phantom's subject lands, clears the holder's marker, and the heal is counted`, async () => {
        await seedEdge(STRICT, PHANTOM());
        const { value: out, events } = await failuresDuring(() => d.send(STRICT, { from: IDS.ALICE, to: IDS.DOC, label: LABELS.functional }));
        assert.ok(out.ok, `the insert for a subject whose only lock is a phantom was refused (${out.status}): ${out.text.slice(0, 300)}`);
        const landed = await edgeAt(STRICT, IDS.ALICE, IDS.DOC, LABELS.functional);
        assert.ok(landed, 'the insert did not land');
        assert.equal((await edgesOf(STRICT).findOne({ _id: ID.R3 }))[MARKER], undefined, 'the phantom holder kept its marker, so the next write of this subject heals again');
        assert.ok(events.length >= 1, 'the heal was not reported through the housekeeping reporter: no counter moved, and nothing says an edge held a phantom lock');
        assert.ok(events.every(e => signals.declaredSteps().includes(e.step)), `a failure was counted under an undeclared step: ${JSON.stringify(events)}`);
        assert.equal(landed[MARKER], keyOf(IDS.ALICE, LABELS.functional), 'the landed edge is not guarded by the subject\'s key');
      });
    }

    for (const d of updateDoors()) {
      for (const peer of [false, true]) {
        it(`${d.name}, ${peer ? 'in place' : 're-keyed'}: a relabel onto the phantom's subject lands, clears the holder's marker, and the heal is counted`, async () => {
          await seedEdge(STRICT, PHANTOM());
          const id = await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.DOC, label: LABELS.plain, peer, id: peer ? ID.R4 : undefined });
          const { value: out, events } = await failuresDuring(() => d.send(STRICT, id, { label: LABELS.functional }));
          assert.ok(out.ok, `the relabel onto a subject whose only lock is a phantom was refused (${out.status}): ${out.text.slice(0, 300)}`);
          const moved = await edgeAt(STRICT, IDS.ALICE, IDS.DOC, LABELS.functional);
          assert.ok(moved, 'the relabel did not land');
          assert.equal((await edgesOf(STRICT).findOne({ _id: ID.R3 }))[MARKER], undefined, 'the phantom holder kept its marker');
          assert.ok(events.length >= 1, 'the heal was not reported through the housekeeping reporter');
          assert.equal(moved[MARKER], keyOf(IDS.ALICE, LABELS.functional), 'the relabelled edge is not guarded by the subject\'s key');
        });
      }
    }
  });

  describe('validate-schema reports a stale marker without calling it a violation', () => {
    it('`staleGuards` names the edge whose marker does not match its (from, label); `totalViolations` is what it was without markers', async () => {
      // Two edges under one functional label (the subject's other edge each: a real violation apiece), a valid marked
      // edge on another subject, and an edge under a plain label carrying a marker for a subject it is not under.
      await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, peer: true, id: ID.R1 });
      await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.DOC, label: LABELS.functional, peer: true, id: ID.R2 });
      await seedEdge(STRICT, { from: IDS.BOB, to: IDS.DOC, label: LABELS.functional, peer: true, id: ID.R3 });
      await seedEdge(STRICT, { from: IDS.BOB, to: IDS.ALICE, label: LABELS.plain, peer: true, id: ID.R4 });
      const ask = () => rest('POST', `/api/spaces/${STRICT}/validate-schema`, {});

      const before = await ask();
      assert.equal(before.status, 200, `fixture: validate-schema answered ${before.status}: ${before.text.slice(0, 300)}`);
      assert.ok(before.body.totalViolations >= 2, `fixture: the two edges under one functional label are not reported: ${before.text.slice(0, 300)}`);
      assert.deepEqual(before.body.staleGuards ?? [], [], 'fixture: unmarked edges were reported as stale');

      await edgesOf(STRICT).updateOne({ _id: ID.R3 }, { $set: { [MARKER]: keyOf(IDS.BOB, LABELS.functional) } });
      await edgesOf(STRICT).updateOne({ _id: ID.R4 }, { $set: { [MARKER]: keyOf(IDS.BOB, LABELS.functional + 'x') } });
      const after = await ask();
      assert.equal(after.status, 200, `validate-schema answered ${after.status}: ${after.text.slice(0, 300)}`);
      assert.deepEqual(after.body.staleGuards, [{ _id: ID.R4, label: LABELS.plain }],
        `staleGuards must name exactly the edge whose marker is not key(from, label), by id and label: ${JSON.stringify(after.body.staleGuards)}`);
      assert.equal(after.body.totalViolations, before.body.totalViolations, 'a stale marker was counted as a schema violation: totalViolations changed meaning');
      assert.equal(JSON.stringify(after.body.violations).includes(ID.R4), false, 'a stale marker was listed among the violations');
    });
  });

  // ── 4. Its index exists, is partial, and is reported when it cannot be built ───────────────────────────────────────

  describe('its index', () => {
    it('initSpace builds a unique partial index over the marker', async () => {
      const ix = await guardIndex(STRICT);
      assert.ok(ix, 'the edges collection has no index over _functionalGuard after initSpace: a race on a functional subject is unguarded');
      assert.equal(ix.unique, true, 'the guard index is not unique, so it refuses nothing');
      assert.ok(ix.partialFilterExpression, 'the guard index is not partial: every unmarked edge is indexed under the same absent key and collides');
    });

    it('is partial: unmarked edges and edges with a null marker coexist, and two edges with one marker collide', async () => {
      const put = (id, to, extra) => edgesOf(STRICT).insertOne(build.edge(STRICT, id, 4, { from: IDS.ALICE, to, label: LABELS.plain, ...extra }));
      // Unmarked and null: not in the index, so any number share a subject.
      await put('plain-1', IDS.BOB, {});
      await put('plain-2', IDS.DOC, {});
      await put('null-1', IDS.FACT_FAR, { [MARKER]: null });
      await put('null-2', IDS.CHRONO_FAR, { [MARKER]: null });
      assert.deepEqual((await edgesOf(STRICT).find({}).toArray()).map(e => e._id).sort(), ['null-1', 'null-2', 'plain-1', 'plain-2'],
        'edges without a marker, or with a null one, were refused: the index is not partial on a string marker');

      await put('marked-1', IDS.UPD_ENTITY, { [MARKER]: SEEDED });
      let refused;
      try { await put('marked-2', IDS.UPD_DOC_ENTITY, { [MARKER]: SEEDED }); } catch (err) { refused = err; }
      assert.equal(refused?.code, 11000, `a second edge with the marker ${SEEDED} was stored: the index guards nothing (${refused ? refused.message : 'no error'})`);
      assert.equal(await edgesOf(STRICT).findOne({ _id: 'marked-2' }), null, 'the colliding edge is stored');
      assert.ok(await edgesOf(STRICT).findOne({ _id: 'marked-1' }), 'the first marked edge was lost');
    });

    it('over duplicate markers the build is REPORTED (a declared step counts it), initSpace still completes every later index, and no two edges share a marker afterwards', async () => {
      await dropGuardIndex(STRICT);
      await edgesOf(STRICT).insertMany([
        build.edge(STRICT, ID.R1, 4, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, [MARKER]: SEEDED }),
        build.edge(STRICT, ID.R2, 4, { from: IDS.ALICE, to: IDS.DOC, label: LABELS.functional, [MARKER]: SEEDED }),
      ]);
      // Dropped so the rebuild is observable: the chrono and file indexes are created AFTER the edges' in initSpace.
      await env.door.coll(STRICT, 'chrono').dropIndex({ startsAt: 1 }).catch(() => {});
      await env.door.coll(STRICT, 'files').dropIndex({ updatedAt: -1 }).catch(() => {});

      const { value, events } = await failuresDuring(() => initSpace(STRICT, { waitForVectorReady: false }).then(() => 'completed', err => err));
      assert.equal(value, 'completed', `initSpace threw over duplicate markers: ${value?.message ?? value} - a space that cannot build one index must still initialise`);
      assert.ok(events.length >= 1, 'the failed build was not reported: no counter moved, so a space without a guard looks like one with it');
      assert.ok(events.every(e => signals.declaredSteps().includes(e.step)), `a failure was counted under an undeclared step: ${JSON.stringify(events)}`);
      const startsAt = (await env.door.coll(STRICT, 'chrono').listIndexes().toArray()).find(ix => ix.key.startsAt === 1);
      const updatedAt = (await env.door.coll(STRICT, 'files').listIndexes().toArray()).find(ix => ix.key.updatedAt === -1);
      assert.ok(startsAt && updatedAt, 'initSpace stopped at the failed guard build: a later index was not created');

      const holders = (await edgesOf(STRICT).find({ [MARKER]: SEEDED }).toArray()).map(e => e._id);
      assert.ok(holders.length <= 1, `the duplicate markers were left in place (${JSON.stringify(holders)}): the guard index can never be built over them`);
      assert.ok(await guardIndex(STRICT), 'the guard index was not built after the duplicates were thinned');
    });

    it('a STORE failure during the build propagates; it is not swallowed as "a duplicate"', async () => {
      const ensure = await ensureEdgeGuardIndexOf();
      // `createIndex` on a view is the store refusing the command (CommandNotSupportedOnView), which is nothing like E11000.
      await withCollectionAsView(env.door.mongo.getDb(), `${STRICT}_edges`, `${STRICT}_facts`, async () => {
        await assert.rejects(() => ensure(STRICT),
          (err) => err?.code !== 11000 && err instanceof Error,
          'ensureEdgeGuardIndex answered normally while the store refused the command: a failing build looks like a built index');
      }, { restore: () => initSpace(STRICT, { waitForVectorReady: false }) });
    });
  });

  // ── 5. The online restore leaves the indexes behind it ─────────────────────────────────────────────────────────────

  describe('an online restore (POST /api/admin/data/restore, which never runs initSpace)', () => {
    let indexKeys;
    let indexes;
    before(async () => {
      await fresh(STRICT);
      await seedEdge(STRICT, { from: IDS.ALICE, to: IDS.BOB, label: LABELS.functional, marker: keyOf(IDS.ALICE, LABELS.functional) });
      const backup = await rest('POST', '/api/admin/data/backup');
      assert.ok(backup.ok, `fixture: the backup answered ${backup.status}: ${backup.text.slice(0, 300)}`);
      const restored = await rest('POST', '/api/admin/data/restore', { backupId: backup.body.backup.id });
      assert.ok(restored.ok, `fixture: the restore answered ${restored.status}: ${restored.text.slice(0, 300)}`);
      indexes = await edgesOf(STRICT).listIndexes().toArray();
      indexKeys = indexes.map(ix => Object.keys(ix.key).join(','));
    });

    it('leaves the edges\' identity index present and unique', () => {
      const identity = indexes.find(ix => Object.keys(ix.key).join(',') === 'from,to,label,fromKind,toKind');
      assert.ok(identity?.unique, `the restore left the edge identity index missing or not unique: ${JSON.stringify(indexKeys)}; two edges can now share an identity`);
    });

    it('leaves the edges\' guard index present and unique', () => {
      const guard = indexes.find(ix => Object.keys(ix.key).join(',') === MARKER);
      assert.ok(guard?.unique, `the restore left no unique guard index: ${JSON.stringify(indexKeys)}; a functional race is unguarded until the next boot`);
    });
  });
});

/**
 * `ensureEdgeGuardIndex`, from whichever module of `server/dist` exports it. The plan fixes the NAME and not the path, so the
 * module is found by reading the built tree; exactly one must define it (one guarded build, the plan's item B).
 */
async function ensureEdgeGuardIndexOf() {
  const dist = path.resolve('server', 'dist');
  const exported = new RegExp(String.raw`export\s+(?:async\s+)?(?:function|const)\s+ensureEdgeGuardIndex\b|export\s*\{[^}]*\bensureEdgeGuardIndex\b`);
  const files = fs.readdirSync(dist, { recursive: true }).filter(f => String(f).endsWith('.js')).map(f => path.join(dist, String(f)));
  assert.ok(files.length > 200, `only ${files.length} built modules were read under ${dist} - the build tree moved, and the search would find nothing`);
  const defining = files.filter(f => exported.test(fs.readFileSync(f, 'utf8')));
  assert.equal(defining.length, 1, `exactly one module of server/dist must export ensureEdgeGuardIndex; found ${JSON.stringify(defining)}`);
  const mod = await import(pathToFileURL(defining[0]).href);
  assert.equal(typeof mod.ensureEdgeGuardIndex, 'function', `${defining[0]} does not export a function named ensureEdgeGuardIndex`);
  return mod.ensureEdgeGuardIndex;
}
