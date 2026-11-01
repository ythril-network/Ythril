/**
 * A push that stopped early says which TARGET families are still to come, so a receiver does not record a reference whose target is on its
 * way as missing, and the next cycle completes the job (bundle-39 D4, `Q-334`).
 *
 * ## The defect
 *
 * A sender pushes one family per `batch-upsert` request, in `REPLICATED_FAMILIES` order (targets first, then edges, then links), and the receiver
 * checks strict linkage after each request with the families the sender has still to push AFTER that request left unjudged (`familiesAfter`). That
 * reads the ORDER, not what the sender did: when the entities push stops early (the receiver answers 503 on its second batch) the sender goes on and
 * pushes the edges and links of the same cycle, an edge to an entity of the unsent batch arrives with its target still on the sender, and the
 * receiver records a linkage violation (and fires `link_violation.created`) for a target that is coming. The same holds for a link to a file whose
 * file-metadata push stopped. The pull has the rule ("a family whose transfer stopped early leaves its targets unchecked that cycle"); the push did
 * not.
 *
 * ## The rule (design v2, v4 and v6: a wire field, the references are still pushed, the single push mark keeps its ceiling)
 *
 * Each push request carries `incomplete: [payloadKey, ...]` in its body: the TARGET families (`facts`, `entities`, `chrono`, `filemeta`: what an
 * edge or a link can point at) whose push stopped early earlier in this cycle. A receiver that reads it judges a target in those families not
 * missing for that request. Nothing else changes on the wire: the references are still pushed, because the push mark is ONE number per space and
 * a reference held back would leave no ceiling for it. A field that is not an array of known target keys (a string, an unknown key, a list of
 * fifty) is ignored by the receiver, never a 500.
 *
 * ## What is asserted
 *
 *  - sender, entities stopped (503 on the second entities request): the edges and links requests of that cycle carry `incomplete` naming exactly
 *    `entities`; the requests that came before the stop carry none; a link to a file whose `filemeta` push stopped names exactly `filemeta`; two
 *    stopped targets name both.
 *  - receiver: an edge to an entity the request says is still coming records no violation, an edge to a chrono entry the request does NOT name
 *    still records one, a link to a file in a stopped `filemeta` push records none, and a request that names an unrelated family hides nothing.
 *  - end to end: the sender's own captured cycle, replayed into a receiver, records no violation for the edge whose target was in the unsent batch.
 *  - a malformed `incomplete` (a string, an unknown key, fifty junk entries, an object, a list of non-strings) is answered 200 and hides nothing.
 *  - the next cycle completes: the push mark never passed the unsent record, every record is offered by the end, and a cycle in which nothing
 *    stopped names no family.
 *
 * ## What "red at base" is
 *
 * At a0efade0a no request carries `incomplete` (the sender tests fail with the wire the cycle actually sent), and the receiver reads none (the edge to
 * the entity still coming is recorded as a violation, for the direct request and for the replayed cycle). The malformed-field cases and the next-cycle
 * case hold at base: they are the guards that the new field is parsed defensively and costs the push nothing.
 *
 * ## The harness
 *
 * The sender is the REAL engine (`runSyncForPeer`) against the pull door's fake peer; the receiver is the REAL `batch-upsert` handler over the same
 * space (`door.push`). The requests are read off the fake peer's own log (`door.state.batchRequests`, which reads only the family keys of a body
 * and keeps `incomplete` as sent), and the Nth request is answered 503 by `door.state.failBatchAt`.
 *
 * Template: `a-push-never-skips-records-that-share-a-seq-db.test.js` (503 on a family's second batch), `a-push-cycle-records-no-violation-for-a-target-later-in-it-db.test.js`.
 * Run: node --test testing/standalone/a-push-says-which-targets-are-still-coming-db.test.js (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { positioned, readMark } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'pushcome';
/** The sender's batch size (`PUSH_BATCH_SIZE` in `sync/push-family.ts`): 201 records need a second batch. */
const PUSH_BATCH = 200;

let door, linkage, linkIdFor, ME;
let tap;

// ── the fake peer's own request log ────────────────────────────────────────────────────────────────────────────────
/**
 * The `batch-upsert` requests the fake peer receives from now on, read off its own log (`door.state.batchRequests`), with the numbered ones `failAt`
 * (counted from 1 since `reset`) answered 503 before the peer takes them (`door.state.failBatchAt`).
 *
 * Per request: `{ n, family, ids, incomplete, body, failed }`, `family` the one record family the body carries and `incomplete` the field as sent
 * (`undefined` when the body has none). `release()` stops the scripted refusals.
 */
function installTap(_port, failAt = []) {
  const from = door.state.batchRequests.length;
  door.state.failBatchAt = [...failAt];
  return {
    get requests() {
      return door.state.batchRequests.slice(from).map(r => ({ n: r.n, family: r.key, ids: r.ids, incomplete: r.incomplete, body: r.body, failed: r.status !== 200 }));
    },
    release: () => { door.state.failBatchAt = []; },
  };
}

const portOf = () => Number(new URL(door.url).port);
/** The requests of one record family, in request order. */
const ofFamily = (family) => tap.requests.filter(r => r.family === family);
/** The set a request names in `incomplete`, sorted; `null` when it carries none. */
const namedIncomplete = (r) => (Array.isArray(r.incomplete) ? [...r.incomplete].sort() : null);
const familiesSent = () => tap.requests.map(r => `${r.family}${r.failed ? '(503)' : ''}`).join(', ');

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** The sender's own records, stored as its own writes would, so the engine's push cycle offers them. */
async function seedLocal(byPart) {
  let top = 0;
  for (const [part, docs] of Object.entries(byPart)) {
    if (docs.length === 0) continue;
    await door.mongo.col(`${S}_${part}`).insertMany(docs.map(d => ({ ...positioned(d) })));
    for (const d of docs) top = Math.max(top, d.seq);
  }
  await door.raiseVersionTo(S, top);
}
const entityDoc = (id, seq) => build.entity(S, id, seq, { author: ME });
const link = (from, fromKind, to, toKind, seq) => ({
  ...build.link(S, 'x', seq, { from, fromKind, to, toKind, author: ME }), _id: linkIdFor(from, fromKind, to, toKind) });

/** 201 entities (uuids, seqs 1..201); the last is the one a 503 on the second batch leaves unsent. */
function entities201() {
  const ids = Array.from({ length: PUSH_BATCH + 1 }, () => randomUUID());
  return { ids, docs: ids.map((id, i) => entityDoc(id, i + 1)), first: ids[0], last: ids.at(-1) };
}
/** 201 file-metadata rows (paths, seqs from `from`); the last is left unsent by a 503 on the second batch. */
function files201(from) {
  const paths = Array.from({ length: PUSH_BATCH + 1 }, (_, i) => `notes/f-${String(i + 1).padStart(5, '0')}.md`);
  return { paths, docs: paths.map((p, i) => build.filemeta(S, p, from + i, { author: ME })), last: paths.at(-1) };
}

const violationsOf = async (docId) =>
  (await door.mongo.col(`${S}_link_violations`).find({ docId }).toArray()).map(v => v.field).sort();
const checksSettled = () => linkage.whenLinkageChecksSettle?.();

/** A record the receiver needs to hold for a reference's OTHER end to resolve. */
async function receive(key, doc) {
  const r = await door.push('/batch-upsert', { [key]: [doc] }, { spaceId: S });
  assert.equal(r.code, 200, `batch-upsert ${key}: ${JSON.stringify(r.body)}`);
  await checksSettled();
}

describe('a push says which targets are still coming', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'pushcome', spaces: [S], direction: 'push' });
    linkage = await import('../../server/dist/sync/linkage-check.js');
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { tap?.release(); await door?.close(); });
  beforeEach(async () => {
    tap?.release();
    await door.reset({ direction: 'push' });
    await door.mongo.col(`${S}_link_violations`).deleteMany({});
    tap = null;
  });

  // ── the sender ───────────────────────────────────────────────────────────────────────────────────────────────────
  describe('the sender', () => {
    it('entities stopped (503 on the second batch): the edges request of the cycle names exactly entities, and the requests before the stop name none', async () => {
      const e = entities201();
      const toUnsent = randomUUID();
      await seedLocal({
        entities: e.docs,
        edges: [build.edge(S, toUnsent, 202, { from: e.first, to: e.last, fromKind: 'entity', toKind: 'entity', author: ME })],
      });
      tap = installTap(portOf(), [2]);
      await door.logsDuring(() => door.sync());
      const sent = familiesSent();
      assert.deepEqual(ofFamily('entities').map(r => r.failed), [false, true], `the fixture did not stop the entities push on its second batch: the cycle sent ${sent}`);
      assert.equal(ofFamily('entities')[1].ids.at(-1), e.last, 'the failed request is not the one carrying the last entity');
      const edges = ofFamily('edges');
      assert.equal(edges.length, 1, `the cycle sent no edges request after the stopped entities push: ${sent}`);
      assert.deepEqual(namedIncomplete(edges[0]), ['entities'],
        `the edges request of a cycle whose entities push stopped says incomplete=${JSON.stringify(edges[0].incomplete)}: a receiver judges the edge to entity ${e.last} against an order, not against what was sent`);
      for (const r of ofFamily('entities')) assert.equal(namedIncomplete(r), null, `the entities request (n=${r.n}) names incomplete=${JSON.stringify(r.incomplete)}: nothing had stopped before it`);
    });

    it('links go on and carry it too: the links request names entities', async () => {
      const e = entities201();
      const fact = randomUUID();
      await seedLocal({
        facts: [build.fact(S, fact, 1, { author: ME })],
        entities: e.docs.map((d, i) => ({ ...d, seq: i + 2 })),
        links: [link(fact, 'fact', e.last, 'entity', 300)],
      });
      tap = installTap(portOf(), [3]);   // facts (#1), entities (#2), entities second batch (#3)
      await door.logsDuring(() => door.sync());
      assert.deepEqual(ofFamily('entities').map(r => r.failed), [false, true], `the fixture did not stop the entities push on its second batch: ${familiesSent()}`);
      const links = ofFamily('links');
      assert.equal(links.length, 1, `the cycle sent no links request after the stopped entities push: ${familiesSent()}`);
      assert.deepEqual(namedIncomplete(links[0]), ['entities'], `the links request says incomplete=${JSON.stringify(links[0].incomplete)}`);
      assert.deepEqual(namedIncomplete(ofFamily('facts')[0]), null, 'the facts request (before the stop) names a family');
    });

    it('file metadata stopped: a link to a file names exactly filemeta (the wire key, not the collection)', async () => {
      const fact = randomUUID();
      const f = files201(2);
      await seedLocal({
        facts: [build.fact(S, fact, 1, { author: ME })],
        files: f.docs,
        links: [link(fact, 'fact', f.last, 'file', 300)],
      });
      tap = installTap(portOf(), [3]);   // facts (#1), filemeta (#2), filemeta second batch (#3)
      await door.logsDuring(() => door.sync());
      assert.deepEqual(ofFamily('filemeta').map(r => r.failed), [false, true], `the fixture did not stop the filemeta push on its second batch: ${familiesSent()}`);
      const links = ofFamily('links');
      assert.equal(links.length, 1, `the cycle sent no links request after the stopped filemeta push: ${familiesSent()}`);
      assert.deepEqual(namedIncomplete(links[0]), ['filemeta'], `the links request says incomplete=${JSON.stringify(links[0].incomplete)}`);
    });

    it('two target families stopped in one cycle: the references name both', async () => {
      const e = entities201();
      const f = files201(202);
      const edge = randomUUID();
      await seedLocal({
        entities: e.docs, files: f.docs,
        edges: [build.edge(S, edge, 500, { from: e.first, to: e.last, fromKind: 'entity', toKind: 'entity', author: ME })],
      });
      tap = installTap(portOf(), [2, 4]);   // entities (#1), entities second (#2), filemeta (#3), filemeta second (#4)
      await door.logsDuring(() => door.sync());
      assert.deepEqual([ofFamily('entities').map(r => r.failed), ofFamily('filemeta').map(r => r.failed)], [[false, true], [false, true]],
        `the fixture did not stop both pushes on their second batch: ${familiesSent()}`);
      const edges = ofFamily('edges');
      assert.equal(edges.length, 1, `the cycle sent no edges request: ${familiesSent()}`);
      assert.deepEqual(namedIncomplete(edges[0]), ['entities', 'filemeta'], `the edges request says incomplete=${JSON.stringify(edges[0].incomplete)}`);
    });

    it('the end to end rule: the cycle the sender sent, replayed into a receiver, records no violation for the edge whose target was in the unsent batch', async () => {
      const e = entities201();
      const toUnsent = randomUUID();
      const toMissingChrono = randomUUID();
      await seedLocal({
        entities: e.docs,
        edges: [
          build.edge(S, toUnsent, 202, { from: e.first, to: e.last, fromKind: 'entity', toKind: 'entity', author: ME }),
          build.edge(S, toMissingChrono, 203, { from: e.first, to: randomUUID(), fromKind: 'entity', toKind: 'chrono', author: ME }),
        ],
      });
      tap = installTap(portOf(), [2]);
      await door.logsDuring(() => door.sync());
      const cycle = tap.requests.filter(r => !r.failed && r.body);
      assert.ok(cycle.some(r => r.family === 'edges'), `the cycle sent no edges request: ${familiesSent()}`);
      tap.release();

      await door.reset({ direction: 'push' });
      for (const r of cycle) {
        const answer = await door.push('/batch-upsert', r.body, { spaceId: S });
        assert.equal(answer.code, 200, `replayed ${r.family}: ${JSON.stringify(answer.body)}`);
      }
      await checksSettled();
      assert.ok(await door.mongo.col(`${S}_edges`).findOne({ _id: toUnsent }), 'the edge did not land on the receiver: the fixture is broken');
      assert.equal(await door.mongo.col(`${S}_entities`).findOne({ _id: e.last }), null, 'the unsent entity reached the receiver: the fixture is broken');
      assert.deepEqual(await violationsOf(toUnsent), [],
        `an edge to entity ${e.last}, which the sender had not yet sent when its entities push stopped, was recorded as a missing target (a violation, and a webhook)`);
      assert.deepEqual(await violationsOf(toMissingChrono), ['to'],
        'an edge to a chrono entry nothing sends must still be recorded: the stopped family is the only one the receiver may leave unjudged');
    });
  });

  // ── the receiver ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe('the receiver', () => {
    /** An edge from a landed entity to `to` (an entity id nothing holds), pushed with `incomplete`; the violations it left. */
    async function edgeToEntity(incomplete, { omit = false } = {}) {
      const from = randomUUID(), to = randomUUID(), edge = randomUUID();
      await receive('entities', entityDoc(from, 1));
      const body = { edges: [build.edge(S, edge, 2, { from, to, fromKind: 'entity', toKind: 'entity', author: ME })], ...(omit ? {} : { incomplete }) };
      const answer = await door.push('/batch-upsert', body, { spaceId: S });
      await checksSettled();
      return { answer, violations: await violationsOf(edge), to };
    }

    it('an edge to an entity the request says is still coming records no violation', async () => {
      const r = await edgeToEntity(['entities']);
      assert.equal(r.answer.code, 200, JSON.stringify(r.answer.body));
      assert.deepEqual(r.violations, [], `an edge whose target (entity ${r.to}) the sender named in incomplete was recorded missing`);
    });

    it('control: without the field the same edge IS recorded, so the case above is about the field', async () => {
      const r = await edgeToEntity(undefined, { omit: true });
      assert.equal(r.answer.code, 200, JSON.stringify(r.answer.body));
      assert.deepEqual(r.violations, ['to'], 'an edge to an entity no request carries and none is coming must be recorded once');
    });

    it('a request that names an unrelated target family hides nothing: the edge to a missing entity is still recorded', async () => {
      for (const named of [['chrono'], ['facts', 'filemeta'], []]) {
        const r = await edgeToEntity(named);
        assert.equal(r.answer.code, 200, JSON.stringify(r.answer.body));
        assert.deepEqual(r.violations, ['to'], `incomplete=${JSON.stringify(named)} hid an edge to a missing ENTITY`);
      }
    });

    it('a link to a file in a stopped filemeta push records no violation; naming only entities does not hide it', async () => {
      const mk = async (incomplete) => {
        const fact = randomUUID();
        const file = `notes/${randomUUID()}.md`;
        await receive('facts', build.fact(S, fact, 1, { author: ME }));
        const answer = await door.push('/batch-upsert', { links: [link(fact, 'fact', file, 'file', 2)], incomplete }, { spaceId: S });
        await checksSettled();
        return { answer, violations: await violationsOf(fact) };
      };
      const coming = await mk(['filemeta']);
      assert.equal(coming.answer.code, 200, JSON.stringify(coming.answer.body));
      assert.deepEqual(coming.violations, [], 'a link to a file whose file-metadata push stopped was recorded missing');
      const other = await mk(['entities']);
      assert.deepEqual(other.violations, ['fact.file'], 'naming entities hid a link to a missing FILE');
    });

    for (const [label, value] of [
      ['a string', 'entities'],
      ['a comma list in a string', 'entities,facts'],
      ['an unknown key', ['no-such-family']],
      ['fifty junk entries', Array.from({ length: 50 }, (_, i) => `family-${i}`)],
      ['an object', { entities: true }],
      ['a list of non-strings', [1, null, { entities: 1 }, ['entities']]],
      ['a number', 7],
      ['null', null],
    ]) {
      it(`a malformed incomplete (${label}) is answered 200 and hides nothing`, async () => {
        const r = await edgeToEntity(value);
        assert.equal(r.answer.code, 200, `incomplete=${JSON.stringify(value)} answered ${r.answer.code}: ${JSON.stringify(r.answer.body)}`);
        assert.deepEqual(r.violations, ['to'], `a malformed incomplete (${label}) suppressed the check: it is an untrusted peer's field`);
      });
    }

    it('fifty copies of one valid key is answered 200 (it is never a 500, whatever it is read as)', async () => {
      const r = await edgeToEntity(Array.from({ length: 50 }, () => 'entities'));
      assert.equal(r.answer.code, 200, JSON.stringify(r.answer.body));
    });
  });

  // ── the next cycle ───────────────────────────────────────────────────────────────────────────────────────────────
  describe('the next cycle', () => {
    it('completes the stopped family: the mark never passed the unsent record, every record is offered by the end, and a cycle in which nothing stopped names no family', async () => {
      const e = entities201();
      await seedLocal({
        entities: e.docs,
        edges: [build.edge(S, randomUUID(), 202, { from: e.first, to: e.last, fromKind: 'entity', toKind: 'entity', author: ME })],
      });
      tap = installTap(portOf(), [2]);
      await door.logsDuring(() => door.sync());
      const unsentPosition = PUSH_BATCH + 1;
      const afterStop = readMark(door, 'pushed', S) ?? 0;
      assert.ok(afterStop < unsentPosition, `the push mark is ${afterStop} after a cycle that never sent the record at position ${unsentPosition}: the next cycle would start past it`);
      const first = ofFamily('entities').flatMap(r => (r.failed ? [] : r.ids));
      assert.equal(first.length, PUSH_BATCH, `the first cycle delivered ${first.length} entities, not ${PUSH_BATCH}: the fixture is broken`);
      tap.release();

      tap = installTap(portOf(), []);
      await door.sync();
      const second = ofFamily('entities').flatMap(r => r.ids);
      assert.ok(second.includes(e.last), `the second cycle did not offer entity ${e.last}, the record the first cycle never sent`);
      const missing = e.ids.filter(id => !first.includes(id) && !second.includes(id));
      assert.deepEqual(missing, [], `${missing.length} entities were offered in neither cycle`);
      assert.ok((readMark(door, 'pushed', S) ?? 0) >= unsentPosition, `the mark is ${readMark(door, 'pushed', S)} after the cycle that sent the last entity`);
      const naming = tap.requests.filter(r => (namedIncomplete(r) ?? []).length > 0).map(r => `${r.family}:${JSON.stringify(r.incomplete)}`);
      assert.deepEqual(naming, [], `a cycle in which no family stopped named incomplete families: ${naming.join('; ')}`);
    });
  });
});
