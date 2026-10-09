/**
 * Once the RECORD has landed, a failure of its connections answers `written` — never "retry" — on every door that takes inline
 * `edges` (bundle-96, Q-170, design 8).
 *
 * ## The rule
 *
 * A single-record door writes the record FIRST and its inline edges after (a relationship needs both ends), so there is a window
 * in which the record is stored and its connections are not: the edge stage meets the store failing, or the far end the door
 * checked a moment ago has gone. Whatever the door answers THEN is read by a caller that cannot see the store, and the old answers
 * were all wrong in the same direction — a `503` with `Retry-After` and `retryable: true` (the store's own answer, true of a write
 * that did not land), or a `500`, or the edge's refusal as if nothing had been written. A caller who retries sends the record
 * again, and a create without an id stores a second one.
 *
 * So the answer names what happened: `written: { kind, id, edges: [ids of the edges that DID land] }`, it is not retryable, a REST
 * answer carries no `Retry-After`, and the text says to send the connections as an update to that id. The write is audited as a
 * write of that id. A bulk item whose record committed and whose edge did not carries the same `written` on its `errors` row.
 *
 * ## The doors are derived
 *
 * `_inline-edge-doors.mjs` reads them out of the MCP tool registry and the mounted REST routes (REST through the whole app over
 * HTTP, MCP through `callTool`) and floors them. A case below is a loop over that table, so a door added next year is held to
 * every rule here the day it is registered.
 *
 * ## The faults are the store's, never built errors
 *
 * The space's `edges` collection is given a VALIDATOR (`_write-faults.mjs` `withValidator`), so the store itself refuses the
 * insert (code 121) — the record collections are untouched, so the record lands. One validator refuses every edge; another
 * refuses only an edge to one far end, which lets the FIRST of two inline edges land and the second fail. `withEdgeWritesRefused`
 * proves the validator refuses before it hands the collection to a case: a fault that failed nothing would pass every case below.
 *
 * ## The window between the check and the edge write
 *
 * A far end that vanishes after the door looked and before the edge is written is reached deterministically by PARKING the
 * record's own write (`parkWrites`): the door's pre-check has run by then, the record has not landed, the test deletes the far end,
 * and the release lets the record land into a space whose edge stage now has nothing to connect to. On a strict space that is a
 * refusal of the edge AFTER the record is stored — which must be answered as `written`, not as the edge's refusal. (On today's
 * code there is no pre-check, so the same park still reaches the same state and the refusal is answered as nothing-was-written.)
 *
 * ## What each case asserts
 *
 * Identities, never counts: the stored record's id from the store, the edge ids read from the `edges` collection, and the `written`
 * answer compared to both. Run:
 *      node --test testing/standalone/a-connection-failure-after-the-record-names-what-was-written-db.test.js
 * (requires a prior `npm run build` in server/ and the harness Mongo)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { withValidator, parkWrites } from './_write-faults.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';
import {
  openInlineEdgeDoors, inlineEdgeDoors, seedInlineEdgeSpace,
  KINDS, LABELS, FAR_ENDS, IDS, EDITED_DESCRIPTION, edge,
} from './_inline-edge-doors.mjs';

const skip = await mongoSkipReason();

const STRICT = 'cw-strict';

/** Opened at module level for the reason the sibling `an-inline-edge-refused-writes-nothing-on-every-door-db` states: the doors are derived from the built registry. */
const doors = skip ? null : await openInlineEdgeDoors({
  suite: 'connwritten',
  spaces: [{ id: STRICT, strictLinkage: true, validationMode: 'strict' }],
});
const env = doors?.env ?? {};
const DOORS = skip ? [] : await inlineEdgeDoors(env);

const SINGLES = DOORS.filter(d => !d.bulk);
const BULKS = DOORS.filter(d => d.bulk);

/** Every edge write refused; and only an edge TO alice refused (so an edge to bob lands before it). */
const REFUSE_EVERY_EDGE = { _id: { $exists: false } };
const REFUSE_EDGE_TO_ALICE = { to: { $ne: IDS.ALICE } };

describe('a failure of the connections after the record landed is answered `written`', { skip }, () => {
  after(async () => { await doors?.close(); });

  const fresh = () => seedInlineEdgeSpace(env, STRICT);

  /**
   * The space's edge collection refuses what `validator` does not admit while `fn` runs.
   * Throws when it does NOT refuse — a refusal that was never installed would leave every case below passing over a write that
   * succeeded — by probing with an edge to alice, which both validators refuse.
   */
  async function withEdgeWritesRefused(validator, fn) {
    const db = env.door.mongo.getDb();
    return withValidator(db, `${STRICT}_edges`, validator, async () => {
      await assert.rejects(
        db.collection(`${STRICT}_edges`).insertOne({ _id: 'fault-probe', spaceId: STRICT, from: IDS.BOB, to: IDS.ALICE, label: LABELS.plain }),
        'the edge collection accepted a write its validator was meant to refuse — the fault is not installed',
      );
      return fn();
    });
  }

  /** The fields a door is sent: a create marks a new record, an update edits its seeded one. */
  const fieldsFor = (d, marker, edges) => (d.verb === 'update'
    ? { description: EDITED_DESCRIPTION, edges }
    : { ...KINDS[d.kind].valid(marker), edges });
  const targetOf = (d) => (d.verb === 'update' ? KINDS[d.kind].updId : undefined);

  /**
   * Send one write and answer `{ status, body, text, headers, path }`. REST is called here rather than through the table's `send`
   * because the table's answer carries no headers, and `Retry-After` is part of what is asserted; the path and the body are the table's.
   */
  async function call(d, fields) {
    if (d.channel === 'mcp') return { ...(await d.send(STRICT, { fields, id: targetOf(d) })), headers: null, path: `http:${d.tool}` };
    const path = d.path.replace(':spaceId', STRICT).replace(':id', targetOf(d) ?? '');
    const r = await fetch(`${env.base}${path}`, {
      method: d.method,
      headers: { Authorization: `Bearer ${env.adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(d.bulk ? { [d.collection]: [fields] } : fields),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, text, headers: r.headers, path };
  }

  /** The record a write addressed: a create's is looked up by its marker (exactly one), an update's is the one it edited. */
  async function subjectOf(d, marker) {
    if (d.verb === 'update') {
      assert.ok(await d.stored(STRICT, KINDS[d.kind].updId), `${d.name}: the record being edited is not stored`);
      return KINDS[d.kind].updId;
    }
    const found = await d.found(STRICT, marker);
    assert.deepEqual(found.length, 1, `${d.name}: the record was not stored exactly once for the marker "${marker}" — ${JSON.stringify(found)}`);
    return found[0];
  }

  /** The edges in the space, as rows with their ids. */
  const storedEdges = async () => (await env.door.coll(STRICT, 'edges').find({}).toArray());

  /** The `written` a bulk answer carries on the item's row: the row for item 0 of this door's kind. */
  const bulkRow = (d, answer) => (Array.isArray(answer.body?.errors) ? answer.body.errors : []).find(e => e.index === 0 && e.type === d.kind && e.written);

  /**
   * The answer names what was written, and says it is not a retry. `edgeIds` is the ids of the edges that landed (none, or the one).
   */
  function assertWritten(d, answer, { id, edgeIds }) {
    const written = d.bulk ? bulkRow(d, answer)?.written : answer.body?.written;
    assert.ok(written, `${d.name} answered ${answer.status} with no \`written\` — the record ${id} is stored and the caller is not told: ${answer.text.slice(0, 400)}`);
    assert.equal(written.kind, d.kind, `${d.name}: \`written.kind\``);
    assert.equal(written.id, id, `${d.name}: \`written.id\` is not the stored record's id`);
    assert.ok(Array.isArray(written.edges), `${d.name}: \`written.edges\` is not a list: ${JSON.stringify(written)}`);
    assert.deepEqual([...written.edges].sort(), [...edgeIds].sort(), `${d.name}: \`written.edges\` does not name the edges that landed`);
    if (d.bulk) return;
    assert.notEqual(answer.body.retryable, true, `${d.name} said the write is retryable — the record ${id} is stored, a retry stores another`);
    assert.ok(answer.text.includes(id), `${d.name}: the answer does not tell the caller which record to update (${id}): ${answer.text.slice(0, 400)}`);
    if (d.channel === 'rest') {
      assert.equal(answer.headers.get('retry-after'), null, `${d.name} sent Retry-After for a write whose record landed`);
    }
  }

  it('the table found its doors: single-record and bulk, on both surfaces', () => {
    for (const channel of ['rest', 'mcp']) {
      assert.ok(SINGLES.filter(d => d.channel === channel).length >= 6, `${channel}: fewer than six single-record doors`);
      assert.ok(BULKS.filter(d => d.channel === channel).length >= 3, `${channel}: fewer than three bulk doors`);
    }
    assert.ok(SINGLES.some(d => d.verb === 'create') && SINGLES.some(d => d.verb === 'update'));
  });

  describe('the edge stage fails at the store after the record was written', () => {
    for (const d of SINGLES) {
      it(d.name, async () => {
        await fresh();
        const marker = `store ${d.name}`;
        const answer = await withEdgeWritesRefused(REFUSE_EVERY_EDGE, () => call(d, fieldsFor(d, marker, [edge(LABELS.plain, FAR_ENDS.entity.exists)])));
        const id = await subjectOf(d, marker);
        assert.deepEqual(await storedEdges(), [], `${d.name}: an edge was stored although the store refused it — the fault did not bite`);
        assertWritten(d, answer, { id, edgeIds: [] });
      });
    }
  });

  describe('the far end vanishes between the check and the edge write, on a strict space', () => {
    for (const d of SINGLES) {
      it(d.name, async () => {
        await fresh();
        const marker = `window ${d.name}`;
        const recordColl = `${STRICT}_${KINDS[d.kind].coll}`;
        const park = parkWrites(Object.getPrototypeOf(env.door.mongo.col('probe')));
        let answer;
        try {
          // The record's own write is held: whatever the door checks before writing it has been checked by now.
          const hold = park.arm(recordColl, { when: (method) => !/^delete/.test(method) });
          const pending = call(d, fieldsFor(d, marker, [edge(LABELS.plain, FAR_ENDS.entity.exists)]));
          const answeredEarly = pending.then(a => ({ answered: a }));
          const first = await Promise.race([hold.reached.then(() => ({ reached: true })), answeredEarly]);
          if (first.answered) {
            hold.release();
            assert.fail(`${d.name} answered ${first.answered.status} without writing its record — the window was never reached: ${first.answered.text.slice(0, 300)}`);
          }
          if (d.verb === 'create') assert.deepEqual(await d.found(STRICT, marker), [], `${d.name}: the record had landed before its write was released`);
          await env.door.coll(STRICT, 'entities').deleteOne({ _id: IDS.BOB });
          hold.release();
          answer = await pending;
        } finally {
          park.restore();
        }
        const id = await subjectOf(d, marker);
        assertWritten(d, answer, { id, edgeIds: [] });
        assert.deepEqual(await storedEdges(), [], `${d.name}: an edge to a far end that no longer exists was stored on a strict space`);
      });
    }
  });

  describe('the first of two inline edges lands and the second fails: `written.edges` names exactly the first', () => {
    for (const d of DOORS) {
      it(d.name, async () => {
        await fresh();
        const marker = `second ${d.name}`;
        const first = edge(LABELS.plain, FAR_ENDS.entity.exists);
        const second = edge(LABELS.plain, { to: IDS.ALICE });
        const answer = await withEdgeWritesRefused(REFUSE_EDGE_TO_ALICE, () => call(d, fieldsFor(d, marker, [first, second])));
        const id = await subjectOf(d, marker);
        const stored = await storedEdges();
        assert.deepEqual(stored.map(e => ({ from: e.from, to: e.to, label: e.label })), [{ from: id, to: IDS.BOB, label: LABELS.plain }],
          `${d.name}: the first edge did not land alone`);
        assertWritten(d, answer, { id, edgeIds: stored.map(e => e._id) });
      });
    }
  });

  describe('a bulk item whose record committed and whose inline edge failed at commit carries `written` on its errors row', () => {
    for (const d of BULKS) {
      it(d.name, async () => {
        await fresh();
        const marker = `bulk ${d.name}`;
        const answer = await withEdgeWritesRefused(REFUSE_EVERY_EDGE, () => call(d, fieldsFor(d, marker, [edge(LABELS.plain, FAR_ENDS.entity.exists)])));
        const id = await subjectOf(d, marker);
        assert.deepEqual(await storedEdges(), [], `${d.name}: an edge was stored although the store refused it — the fault did not bite`);
        const rows = (Array.isArray(answer.body?.errors) ? answer.body.errors : []).filter(e => e.index === 0 && e.type === d.kind);
        assert.ok(rows.length > 0, `${d.name} reported no error for the item whose edge failed (${answer.status}): ${answer.text.slice(0, 400)}`);
        assertWritten(d, answer, { id, edgeIds: [] });
      });
    }
  });

  describe('a `written` answer is audited as a write of that record, on both surfaces', () => {
    /** Audit rows are written fire-and-forget, so a row is waited for; the ones this call left are told by door, space and time. */
    const auditRowsOf = (d, answer, since) => env.door.mongo.getDb().collection('audit_log').find({
      spaceId: STRICT,
      method: d.channel === 'mcp' ? 'MCP' : d.method,
      path: answer.path,
      timestamp: { $gte: since },
    }).toArray();

    for (const d of SINGLES) {
      it(d.name, async () => {
        // The operation this door audits a clean write under: asked of the door, not written down.
        await fresh();
        const sinceControl = new Date().toISOString();
        const control = await call(d, fieldsFor(d, `audit control ${d.name}`, [edge(LABELS.plain, FAR_ENDS.entity.exists)]));
        assert.ok(control.status < 400, `${d.name} refused a clean write (${control.status}): ${control.text.slice(0, 300)}`);
        assert.ok(await holdsWithin(async () => (await auditRowsOf(d, control, sinceControl)).length > 0, 3000),
          `${d.name}: a clean write left no audit row — the oracle for this case is gone`);
        const operation = (await auditRowsOf(d, control, sinceControl))[0].operation;

        await fresh();
        const marker = `audit ${d.name}`;
        const since = new Date().toISOString();
        const answer = await withEdgeWritesRefused(REFUSE_EVERY_EDGE, () => call(d, fieldsFor(d, marker, [edge(LABELS.plain, FAR_ENDS.entity.exists)])));
        const id = await subjectOf(d, marker);
        const named = async () => (await auditRowsOf(d, answer, since)).filter(r => r.entryId === id && r.operation === operation);
        const found = await holdsWithin(async () => (await named()).length > 0, 3000);
        assert.ok(found, `${d.name}: no audit row names the written record ${id} under \`${operation}\` — rows left: ${
          JSON.stringify((await auditRowsOf(d, answer, since)).map(r => ({ operation: r.operation, entryId: r.entryId, status: r.status })))}`);
      });
    }
  });
});
