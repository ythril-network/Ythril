/**
 * A `functional` label holds under CONCURRENT local writers: of two writers that each planned against "no edge under this
 * label yet", at most one lands, on every door that can write an edge (Q-439).
 *
 * ## The defect
 *
 * `functional` says a subject carries at most one edge under a label. The planner decides it from a COUNT of the other
 * edges (`ReadSet.otherEdgesFromSubject`), read before the write. Two writers that read before either has written both see
 * zero, and the edge's own identity index cannot object: the two edges differ in `to`, so they are two identities. Both
 * land, and the space holds the breach the schema was declared to prevent. The write stage's own re-plan (a lost seq race,
 * a duplicate key) is what re-reads the count, and nothing here makes the second writer lose.
 *
 * ## What the cases state
 *
 * - **the guard exists** — every space's `edges` collection, built by `initSpace`, carries the partial unique index on the
 *   marker `_functionalGuard`. Without it the cases below race on a store that cannot refuse, so this is asserted first,
 *   and is itself red until the index exists.
 * - **the race, on every door** — over a set DERIVED from the doors, never listed: every inline-edge door of
 *   `_inline-edge-doors.mjs` (record writes carrying `edges`), every direct edge-create door (REST route and MCP tool, each
 *   read out of the other's registry), the bulk door's top-level `edges` array, and both relabel doors — each relabel raced
 *   twice, for an edge this instance wrote (a re-key: delete and insert in a transaction) and one a peer wrote (updated in
 *   place), which are two writes. Both writers' reads of the functional count are interleaved with `parkReadsAfterAnswer` so
 *   BOTH plan against zero; then exactly one edge is stored (by id), the winner's answer is an acceptance, and the loser's is
 *   the ordinary functional refusal ON ITS DOOR. What that refusal is, is asked of the door itself: the same write refused
 *   SEQUENTIALLY (the other edge already stored) is the oracle, taken per door and never written down. An inline
 *   single-record door's loser has had its record written by then, so its answer is Q-170's `ConnectionsNotWritten`
 *   (`written`, never retryable) carrying that same refusal; a bulk door's is the item's `errors` row.
 *   An inline BULK door is raced too, but it cannot show the defect: its record is rewritten in the same commit and the
 *   record's own seq guard makes the second batch lose on the RECORD, so at most one edge lands whatever the edge rule says.
 *   It stays in the set so that stays true; the bulk edge race is the top-level `edges` array's.
 * - **the same triplet** — two writers of one and the same edge: the loser CONVERGES onto it and is accepted.
 * - **a bulk** — two concurrent batches of 200 edges over 200 DISTINCT subjects, on both bulk doors: at most one edge per
 *   subject, every stored edge carries the marker, and the batch that loses every item reports each one refused.
 * - **where the guard does NOT apply** — a `warn` space (both land, nothing is stamped), a merge relink, a sync arrival and
 *   an import of a functional duplicate (stored, nothing stamped; the marker never arrives and a merge drops it).
 * - **a flag flipped off and back on** — the marker a landed edge carries outlives the flip, and a stale plan that meets it
 *   re-plans and is refused.
 *
 * ## How the interleaving is reached
 *
 * A door reads the functional count one or more times before its write (an inline door reads it once to refuse before the
 * record is written and again to write the edge). The number of reads is not assumed: the writer is run once with a
 * counting predicate and the race parks the LAST of them, which is the one the commit trusts. `holdWhileOtherRuns` proves
 * the park was reached and never awaits the second writer past a window, so a fix that serialises the two is as correct as
 * one that lets the second through.
 *
 * Assertions are on identities (the `to` of every edge stored under the label, the ids of the rows refused), never on a
 * count alone.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-functional-label-holds-under-concurrent-writers-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { parkReadsAfterAnswer, holdWhileOtherRuns } from './_read-park.mjs';
import { mountedRoutesWithSource } from './_routes.mjs';
import { CAPABILITIES } from './_capability-map.mjs';
import {
  openInlineEdgeDoors, inlineEdgeDoors, seedInlineEdgeSpace, refusalDifferences,
  KINDS, LABELS, IDS, EDITED_DESCRIPTION, edge,
} from './_inline-edge-doors.mjs';

const skip = await mongoSkipReason();

/** A strict space, a warn-only one, and one whose flag a case flips. */
const STRICT = 'fl-strict';
const WARN = 'fl-warn';
const FLIP = 'fl-flip';
const SPACES = [STRICT, WARN, FLIP];

/** The marker the write guard stamps on an edge insert under a functional label of a strict space. */
const GUARD = '_functionalGuard';

/** Opened at module level for the reason `an-inline-edge-refused-writes-nothing-on-every-door-db` states: the doors are derived from the built registry. */
const doors = skip ? null : await openInlineEdgeDoors({
  suite: 'functionalrace',
  spaces: [
    { id: STRICT, strictLinkage: true, validationMode: 'strict' },
    { id: WARN, strictLinkage: true, validationMode: 'warn' },
    { id: FLIP, strictLinkage: true, validationMode: 'strict' },
  ],
});
const env = doors?.env ?? {};
const INLINE = skip ? [] : await inlineEdgeDoors(env);
const { edgeIdFor } = skip ? {} : await import('../../server/dist/brain/edge-id.js');
const { ALL_TOOLS } = skip ? {} : await import('../../server/dist/mcp/tools/index.js');

/** The subject of every direct edge door and every relabel door: a seeded entity (`seedInlineEdgeSpace`). */
const SUBJECT = IDS.UPD_ENTITY;
/** Writer A's far end and writer B's: two distinct identities under one (subject, label). */
const TO_A = IDS.ALICE;
const TO_B = IDS.BOB;

// ── Calling ────────────────────────────────────────────────────────────────────────────────────────────────────────

const CALLER = () => ({ rights: env.ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' });

async function rest(method, path, body) {
  const r = await fetch(`${env.base}${path}`, {
    method, headers: { Authorization: `Bearer ${env.adminKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text, refused: r.status >= 400 };
}

async function mcp(name, args) {
  const out = await env.callTool({ name, args, caller: CALLER() });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  const isError = out.result.isError === true;
  return { status: out.status, body: out.result.structuredContent ?? {}, text, refused: isError || out.status >= 400, isError };
}

// ── The doors, derived ─────────────────────────────────────────────────────────────────────────────────────────────

/** The tool the capability map documents as answering a REST route, checked against the registry. */
function toolAnswering(method, path) {
  const row = CAPABILITIES.find(([, , route]) => route === `${method} ${path}`);
  if (!row) throw new Error(`no MCP tool is documented as answering ${method} ${path} — the edge door has no twin to race`);
  const tool = ALL_TOOLS.find(t => t.name === row[1]);
  if (!tool) throw new Error(`the capability map names ${row[1]} for ${method} ${path} and the registry holds no such tool`);
  return tool;
}

const SCHEMA_ARGS = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };
const propsOf = (tool) => Object.keys(tool.inputSchema(SCHEMA_ARGS)?.properties ?? {});

/**
 * The doors that write ONE edge directly, derived from two independent sources that must agree: the mounted REST routes (a
 * handler that calls `upsertEdge(` and reads a `label` from its body is a create; one that calls `updateEdgeById(` is the
 * relabel) with the MCP tool the capability map documents for each, and — the other way round — every registered tool that
 * declares an edge's own fields (`weight` beside `label`) must be one of those twins. THROWS when they disagree: a door the
 * REST derivation missed would otherwise be a door this file silently stopped racing.
 */
function directEdgeDoors() {
  const routes = mountedRoutesWithSource();
  const creates = routes.filter(r => /\bupsertEdge\s*\(/.test(r.source) && /\blabel\b[^;]*=\s*req\.body/.test(r.source));
  const relabels = routes.filter(r => /\bupdateEdgeById\s*\(/.test(r.source));
  const out = [];
  for (const [verb, rs] of [['create', creates], ['relabel', relabels]]) {
    for (const r of rs) {
      out.push({ verb, channel: 'rest', name: `REST ${r.method} ${r.path} (${verb})`, method: r.method, path: r.path });
      const tool = toolAnswering(r.method, r.path);
      out.push({ verb, channel: 'mcp', name: `MCP ${tool.name} (${verb})`, tool: tool.name });
    }
  }
  const claimed = new Set(out.filter(d => d.channel === 'mcp').map(d => d.tool));
  const unclaimed = ALL_TOOLS.filter(t => {
    const p = propsOf(t);
    return p.includes('weight') && p.includes('label') && !p.includes('edges') && !claimed.has(t.name) && /edge/.test(t.name);
  }).map(t => t.name);
  if (unclaimed.length > 0) throw new Error(`tools declare an edge's own fields and no REST edge door answers for them: ${unclaimed}`);
  return out;
}
const DIRECT = skip ? [] : directEdgeDoors();

// ── Writers: one shape for every door ──────────────────────────────────────────────────────────────────────────────

const fromKindFields = (kind) => (kind === 'entity' ? {} : { fromKind: kind });
const functionalIds = (subject, to, kind = 'entity') => edgeIdFor(subject, to, LABELS.functional, kind === 'entity' ? undefined : kind, undefined);

/**
 * The edges stored under the functional label from `subject` in `space`, as the `to` of each — the identities, sorted.
 * A plain `find` filter that no read park matches.
 */
async function landedTos(space, subject) {
  const rows = await env.door.coll(space, 'edges').find({ from: subject, label: LABELS.functional }).toArray();
  return rows.map(e => e.to).sort();
}

/**
 * One way to write an edge under the functional label from `subject`, whichever door:
 * `seed(space, { existing })` empties and seeds the space (and stores a functional edge to `existing` when named, for the
 * oracle), `run(space, to, tag)` sends the write and answers `{ status, body, text, refused }`, `landed(space)` is the `to`
 * of every edge stored under the label, and `loser(answer, oracle, to)` lists what is wrong with a LOSING answer.
 */
function inlineWriter(d) {
  const subject = KINDS[d.kind].updId;
  const fieldsFor = (tag, to) => (d.verb === 'update'
    ? { description: EDITED_DESCRIPTION, edges: [edge(LABELS.functional, { to })] }
    : { ...KINDS[d.kind].valid(`race ${tag}`), id: subject, edges: [edge(LABELS.functional, { to })] });
  return {
    name: d.name, kind: d.bulk ? 'inline-bulk' : 'inline', subject, door: d,
    async seed(space, { existing } = {}) {
      await seedInlineEdgeSpace(env, space);
      if (existing) {
        await env.door.coll(space, 'edges').insertOne(build.edge(space, functionalIds(subject, existing, d.kind), 3,
          { from: subject, to: existing, label: LABELS.functional, ...fromKindFields(d.kind) }));
      }
    },
    async run(space, to, tag) {
      const a = await d.send(space, { fields: fieldsFor(tag, to), id: d.verb === 'update' ? subject : undefined });
      return { ...a, refused: a.refusal !== null };
    },
    landed: (space) => landedTos(space, subject),
    loser(answer, oracle) {
      const problems = [];
      if (!answer.refused) return ['it was accepted'];
      if (d.bulk) {
        const row = (Array.isArray(answer.body?.errors) ? answer.body.errors : []).find(e => e.index === 0 && e.type === d.kind);
        const ours = (Array.isArray(oracle.body?.errors) ? oracle.body.errors : []).find(e => e.index === 0 && e.type === d.kind);
        if (!row) return [`no errors row for item 0 of ${d.kind}: ${answer.text.slice(0, 300)}`];
        // The loser's record was written before its edge lost, so its row also says what was written: every key the
        // sequential refusal's row has must be there, and `written` may be the one more.
        for (const k of Object.keys(ours ?? {})) if (!(k in row)) problems.push(`the errors row lacks \`${k}\`, which the sequential refusal's carries`);
        return problems;
      }
      // A single-record door: the record is written by the time the edge loses, so the answer is `ConnectionsNotWritten`
      // (Q-170) — the record named, never retryable — and carries the ordinary refusal's words.
      if (answer.status >= 500) problems.push(`status ${answer.status}: a lost race is the caller's, not a server error`);
      const written = answer.body?.written;
      if (!written) return [...problems, `no \`written\` — the record ${subject} is stored and the caller is not told: ${answer.text.slice(0, 300)}`];
      if (written.id !== subject) problems.push(`written.id is ${written.id}, the record is ${subject}`);
      if (answer.body.retryable === true) problems.push('the answer says retry for a write whose record landed');
      const reason = String(oracle.body?.message ?? '').replace(/^edges\[\d+\]:?\s*/, '');
      if (!reason || !String(answer.body.refusal ?? '').includes(reason)) {
        problems.push(`the refusal is not the ordinary functional refusal (sequentially: ${JSON.stringify(reason)}; here: ${JSON.stringify(answer.body.refusal)})`);
      }
      return problems;
    },
  };
}

function directWriter(d) {
  const subject = SUBJECT;
  return {
    name: d.name, kind: 'direct', subject, door: d,
    async seed(space, { existing } = {}) {
      await seedInlineEdgeSpace(env, space);
      if (existing) {
        await env.door.coll(space, 'edges').insertOne(build.edge(space, functionalIds(subject, existing), 3,
          { from: subject, to: existing, label: LABELS.functional }));
      }
    },
    run: (space, to) => (d.channel === 'rest'
      ? rest(d.method, d.path.replace(':spaceId', space), { from: subject, to, label: LABELS.functional })
      : mcp(d.tool, { space, from: subject, to, label: LABELS.functional })),
    landed: (space) => landedTos(space, subject),
    loser: (answer, oracle) => sameRefusal(answer, oracle),
  };
}

/**
 * What authored an edge a relabel moves. A relabel of an edge THIS instance wrote is a re-key (a delete and an insert under the
 * id the new label derives, in a transaction); one a PEER wrote cannot be moved that way (`rekeyEdges`: only the author may) and is
 * updated IN PLACE. They are two writes, so a guard that covers one leaves the other open, and both are raced.
 */
const AUTHORS = Object.freeze({
  own: { instanceId: 'functionalrace-receiver', instanceLabel: 'Receiver' },
  peer: undefined,
});

function relabelWriter(d, authored) {
  const subject = SUBJECT;
  return {
    name: `${d.name}, edge written ${authored === 'own' ? 'here (re-keyed)' : 'by a peer (in place)'}`, kind: 'relabel', subject, door: d,
    async seed(space, { existing } = {}) {
      await seedInlineEdgeSpace(env, space);
      // The two edges a writer relabels: plain ones, to the two far ends.
      await env.door.coll(space, 'edges').insertMany([TO_A, TO_B].map(to => build.edge(space, edgeIdFor(subject, to, LABELS.plain), 3,
        { from: subject, to, label: LABELS.plain, ...(AUTHORS[authored] ? { author: AUTHORS[authored] } : {}) })));
      if (existing) {
        await env.door.coll(space, 'edges').insertOne(build.edge(space, functionalIds(subject, existing), 3,
          { from: subject, to: existing, label: LABELS.functional }));
      }
    },
    async run(space, to) {
      const stored = await env.door.coll(space, 'edges').findOne({ from: subject, to, label: LABELS.plain });
      assert.ok(stored, `${d.name}: the edge to relabel (${subject} -> ${to}) is not stored`);
      return d.channel === 'rest'
        ? rest(d.method, d.path.replace(':spaceId', space).replace(':id', stored._id), { label: LABELS.functional })
        : mcp(d.tool, { space, id: stored._id, label: LABELS.functional });
    },
    landed: (space) => landedTos(space, subject),
    loser: (answer, oracle) => sameRefusal(answer, oracle),
  };
}

/** The door's own refusal, held to the sequential one: the same status, the same `error` code, every key it carries. */
function sameRefusal(answer, oracle) {
  return refusalDifferences({ bulk: false }, { ...answer, refusal: answer.refused ? {} : null }, { ...oracle, refusal: oracle.refused ? {} : null });
}

/**
 * The bulk doors, one per surface, read out of the inline-edge table (`bulk` doors there are the same route and tool that
 * take the top-level `edges` array): the batch that writes edges and nothing else. Named for what they carry here.
 */
const BULK_EDGE_DOORS = skip ? [] : INLINE.filter(d => d.bulk)
  .filter((d, i, all) => all.findIndex(x => x.channel === d.channel) === i)
  .map(d => ({ ...d, name: d.channel === 'rest' ? `REST ${d.method} ${d.path} (edges)` : `MCP ${d.tool} (edges)` }));

/** The rows of a bulk answer's `errors` that are about an edge item, by index. */
const edgeErrorRows = (answer) => (Array.isArray(answer.body?.errors) ? answer.body.errors : []).filter(e => e.type === 'edge');

/** A bulk door carrying ONE top-level edge per batch: nothing about a record in it, so the only thing two writers share is the subject. */
function bulkEdgeWriter(d) {
  const subject = SUBJECT;
  const send = (space, body) => (d.channel === 'rest'
    ? rest(d.method, d.path.replace(':spaceId', space), body)
    : mcp(d.tool, { space, ...body }));
  return {
    name: d.name, kind: 'bulk-edge', subject, door: d,
    async seed(space, { existing } = {}) {
      await seedInlineEdgeSpace(env, space);
      if (existing) {
        await env.door.coll(space, 'edges').insertOne(build.edge(space, functionalIds(subject, existing), 3,
          { from: subject, to: existing, label: LABELS.functional }));
      }
    },
    async run(space, to) {
      const a = await send(space, { edges: [{ from: subject, to, label: LABELS.functional }] });
      // A bulk answers 207 for any outcome: it is refused when the item has an `errors` row.
      return { ...a, refused: edgeErrorRows(a).some(e => e.index === 0) };
    },
    landed: (space) => landedTos(space, subject),
    loser(answer, oracle) {
      const row = edgeErrorRows(answer).find(e => e.index === 0);
      const ours = edgeErrorRows(oracle).find(e => e.index === 0);
      if (!row) return [`no errors row for edge 0: ${answer.text.slice(0, 300)}`];
      return Object.keys(ours ?? {}).filter(k => !(k in row)).map(k => `the errors row lacks \`${k}\`, which the sequential refusal's carries`);
    },
  };
}

/** Every writer, one per door: the inline doors, the direct edge-create doors, the relabel doors and the bulk edge doors. */
const WRITERS = skip ? [] : [
  ...INLINE.map(inlineWriter),
  ...DIRECT.filter(d => d.verb === 'create').map(directWriter),
  ...DIRECT.filter(d => d.verb === 'relabel').flatMap(d => Object.keys(AUTHORS).map(a => relabelWriter(d, a))),
  ...BULK_EDGE_DOORS.map(bulkEdgeWriter),
];

/**
 * A writer whose two concurrent writes do not both reach the edge. An inline BULK door writes its record in the same commit,
 * and the record's own seq guard makes the second of two batches that rewrite ONE record lose on the RECORD ("changed by another
 * write") whatever the edge says — so what a lost race answers there is the record's conflict, and "the loser converges" or
 * "a warn space takes both" cannot be asked of it. Its edge race is the top-level `edges` array's, which has no such record.
 */
const sharesARecordWrite = (w) => w.kind === 'inline-bulk';

// ── The interleaving ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A read of the functional count: the read set's `{ $or: [{ from, label }...] }` over a space's edges, and nothing else —
 * not its triplet read, which carries `spaceId` and the triplet's `to`.
 */
const isFunctionalCountRead = (f) => f.spaceId === undefined && Array.isArray(f.$or) && f.$or.length > 0
  && f.$or.every(c => Object.keys(c).sort().join() === 'from,label');

describe('a functional label holds under concurrent local writers', { skip }, () => {
  let reads;
  before(() => { reads = parkReadsAfterAnswer(env.door.mongo); });
  after(async () => {
    reads?.restore();
    await doors?.close();
  });

  /** Nothing armed: a park left over from a case must not hold the next one's read. */
  const disarm = () => reads.arm('__nothing__', () => false);

  /** What the same write, from `writer`, answers when the OTHER edge is already stored — the door's own refusal, taken not remembered. */
  async function sequentialRefusal(writer, space, to, existing) {
    await writer.seed(space, { existing });
    const answer = await writer.run(space, to, 'sequential');
    assert.ok(answer.refused, `${writer.name} accepted a second edge under a functional label with one already stored (${answer.status}: ${answer.text.slice(0, 300)}) — no oracle can be taken from it`);
    assert.ok(answer.status < 500, `${writer.name} answered ${answer.status} for a plain functional breach: ${answer.text.slice(0, 300)}`);
    return answer;
  }

  /** How many functional-count reads one successful write of `writer` makes — asked of the door, never written down. */
  async function functionalReadsOf(writer, space) {
    await writer.seed(space);
    let n = 0;
    reads.arm(`${space}_edges`, (f) => { if (isFunctionalCountRead(f)) n++; return false; });
    const answer = await writer.run(space, TO_A, 'count');
    disarm();
    assert.equal(answer.refused, false, `${writer.name} refused a first edge under a functional label (${answer.status}): ${answer.text.slice(0, 300)}`);
    assert.ok(n >= 1, `${writer.name} never read the functional count — the interleaving this file is about cannot be reached on it`);
    return n;
  }

  /**
   * Run writer A (to `toA`) and writer B (to `toB`) so that BOTH have read the count before either has written: A's last read
   * of the count is parked, B runs to its end, A is released. Answers `{ a, b }`.
   */
  async function raced(writer, space, toA, toB) {
    const last = await functionalReadsOf(writer, space);
    await writer.seed(space);
    let seen = 0;
    const park = reads.arm(`${space}_edges`, (f) => isFunctionalCountRead(f) && ++seen === last);
    const answers = {};
    try {
      await holdWhileOtherRuns(park, {
        first: async () => { answers.a = await writer.run(space, toA, 'A'); },
        second: async () => { answers.b = await writer.run(space, toB, 'B'); },
      });
    } finally { disarm(); }
    return answers;
  }

  /** The guard index, as `listIndexes` reports it, or `undefined`. */
  async function guardIndex(space) {
    const indexes = await env.door.coll(space, 'edges').listIndexes().toArray();
    return indexes.find(i => Object.keys(i.key).length === 1 && i.key[GUARD] === 1);
  }

  describe('the guard exists', () => {
    for (const space of SPACES) {
      it(`initSpace gives ${space}'s edges collection the partial unique index on ${GUARD}`, async () => {
        const index = await guardIndex(space);
        assert.ok(index, `${space}_edges carries no index on ${GUARD} — a functional race there is refused by nothing but the planner's own count`);
        assert.equal(index.unique, true, `the ${GUARD} index of ${space}_edges is not unique`);
        assert.ok(index.partialFilterExpression, `the ${GUARD} index of ${space}_edges is not partial: every edge without the marker would collide on its absence`);
      });
    }
  });

  it('the table found its doors: record writes with edges, direct edge creates and relabels, on both surfaces', () => {
    assert.ok(INLINE.length >= 18, `${INLINE.length} inline-edge doors`);
    for (const channel of ['rest', 'mcp']) {
      for (const verb of ['create', 'relabel']) {
        assert.ok(DIRECT.some(d => d.channel === channel && d.verb === verb), `no ${channel} ${verb} edge door`);
      }
      assert.ok(INLINE.some(d => d.channel === channel && d.bulk), `no ${channel} bulk door`);
    }
    assert.deepEqual(BULK_EDGE_DOORS.map(d => d.channel).sort(), ['mcp', 'rest'], 'one bulk door per surface');
    assert.ok(WRITERS.length >= INLINE.length + 8, `${WRITERS.length} writers`);
    assert.ok(WRITERS.filter(w => w.kind === 'relabel').length >= 4, 'a relabel door is raced for both authorships');
  });

  describe('two writers that both planned against zero: exactly one edge lands, the other is refused as a functional breach', () => {
    for (const writer of WRITERS) {
      it(writer.name, async () => {
        const refusals = {
          [TO_A]: await sequentialRefusal(writer, STRICT, TO_A, TO_B),
          [TO_B]: await sequentialRefusal(writer, STRICT, TO_B, TO_A),
        };
        const { a, b } = await raced(writer, STRICT, TO_A, TO_B);
        const landed = await writer.landed(STRICT);
        assert.ok(landed.length === 1 && [TO_A, TO_B].includes(landed[0]),
          `${writer.name}: the two writers left ${JSON.stringify(landed)} under ${LABELS.functional} from ${writer.subject}; exactly one of [${TO_A}, ${TO_B}] is the rule`);
        const [winner, loser, loserTo] = landed[0] === TO_A ? [a, b, TO_B] : [b, a, TO_A];
        assert.equal(winner.refused, false, `${writer.name}: the edge that landed (to ${landed[0]}) was answered as refused (${winner.status}): ${winner.text.slice(0, 300)}`);
        assert.deepEqual(writer.loser(loser, refusals[loserTo], loserTo), [], `${writer.name}: the loser (to ${loserTo}) did not answer the ordinary refusal — ${loser.text.slice(0, 400)}`);
      });
    }
  });

  describe('two writers of the SAME edge: the loser converges onto it and is accepted', () => {
    for (const writer of WRITERS.filter(w => w.kind !== 'relabel' && !sharesARecordWrite(w))) {
      it(writer.name, async () => {
        const { a, b } = await raced(writer, STRICT, TO_A, TO_A);
        assert.deepEqual(await writer.landed(STRICT), [TO_A], `${writer.name}: one edge to ${TO_A} was the rule`);
        assert.equal(a.refused, false, `${writer.name}: writer A was refused (${a.status}): ${a.text.slice(0, 300)}`);
        assert.equal(b.refused, false, `${writer.name}: writer B was refused for writing the edge A wrote (${b.status}): ${b.text.slice(0, 300)}`);
      });
    }
  });

  describe('on a space that only warns, both edges land and nothing is stamped', () => {
    for (const writer of WRITERS.filter(w => !sharesARecordWrite(w))) {
      it(writer.name, async () => {
        const { a, b } = await raced(writer, WARN, TO_A, TO_B);
        assert.deepEqual(await writer.landed(WARN), [TO_A, TO_B].sort(), `${writer.name}: a warn-only space refuses nothing, both edges belong there`);
        assert.equal(a.refused, false, `${writer.name}: writer A was refused (${a.status}): ${a.text.slice(0, 300)}`);
        assert.equal(b.refused, false, `${writer.name}: writer B was refused (${b.status}): ${b.text.slice(0, 300)}`);
        const stamped = (await env.door.coll(WARN, 'edges').find({}).toArray()).filter(e => GUARD in e).map(e => e._id);
        assert.deepEqual(stamped, [], `${writer.name}: edges of a warn-only space carry ${GUARD}, which would refuse the second writer`);
      });
    }
  });

  describe('a bulk of edges over 200 distinct subjects', () => {
    const SUBJECTS = Array.from({ length: 200 }, (_, i) => `dddddddd-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
    const asBatch = (to) => SUBJECTS.map(from => ({ from, to, label: LABELS.functional }));
    const send = (d, space, to) => (d.channel === 'rest'
      ? rest(d.method, d.path.replace(':spaceId', space), { edges: asBatch(to) })
      : mcp(d.tool, { space, edges: asBatch(to) }));
    const seed = async (space) => {
      await seedInlineEdgeSpace(env, space);
      await env.door.coll(space, 'entities').insertMany(SUBJECTS.map(id => build.entity(space, id, 3, { name: `Subject ${id}`, type: 'person' })));
    };
    /** Every subject's edges under the label: `{ subject: [to...] }`, over the stored rows. */
    const stored = async (space) => {
      const rows = await env.door.coll(space, 'edges').find({ label: LABELS.functional }).toArray();
      const bySubject = new Map(SUBJECTS.map(s => [s, []]));
      for (const r of rows) bySubject.get(r.from)?.push(r.to);
      return { rows, bySubject };
    };

    for (const d of BULK_EDGE_DOORS) {
      it(`${d.name}: at most one edge per subject lands, and every stored edge carries ${GUARD}`, async () => {
        await seed(STRICT);
        await Promise.all([send(d, STRICT, TO_A), send(d, STRICT, TO_B)]);
        const { rows, bySubject } = await stored(STRICT);
        const doubled = [...bySubject].filter(([, tos]) => tos.length > 1).map(([s, tos]) => `${s}: ${tos}`);
        assert.deepEqual(doubled, [], `${d.name}: subjects that hold two edges under ${LABELS.functional}`);
        const unlanded = [...bySubject].filter(([, tos]) => tos.length === 0).map(([s]) => s);
        assert.deepEqual(unlanded, [], `${d.name}: subjects neither batch landed an edge for`);
        assert.deepEqual(rows.filter(r => typeof r[GUARD] !== 'string').map(r => r._id), [],
          `${d.name}: edges stored under a functional label of a strict space without ${GUARD}`);
      });

      it(`${d.name}: the batch that loses every item reports each one refused`, async () => {
        await seed(STRICT);
        const last = await (async () => {
          let n = 0;
          reads.arm(`${STRICT}_edges`, (f) => { if (isFunctionalCountRead(f)) n++; return false; });
          await send(d, STRICT, TO_A);
          disarm();
          return n;
        })();
        assert.ok(last >= 1, `${d.name} never read the functional count`);
        await seed(STRICT);
        let seen = 0;
        const park = reads.arm(`${STRICT}_edges`, (f) => isFunctionalCountRead(f) && ++seen === last);
        const answers = {};
        try {
          await holdWhileOtherRuns(park, {
            first: async () => { answers.loser = await send(d, STRICT, TO_A); },
            second: async () => { answers.winner = await send(d, STRICT, TO_B); },
          });
        } finally { disarm(); }
        const { bySubject } = await stored(STRICT);
        const wrong = [...bySubject].filter(([, tos]) => tos.length !== 1 || tos[0] !== TO_B).map(([s, tos]) => `${s}: [${tos}]`);
        assert.deepEqual(wrong, [], `${d.name}: the batch that ran to its end owns every subject (to ${TO_B}), and the parked one landed none`);
        const refused = edgeErrorRows(answers.loser).map(e => e.index).sort((x, y) => x - y);
        assert.deepEqual(refused, SUBJECTS.map((_, i) => i), `${d.name}: the batch that lost every item did not report each as refused (${answers.loser.status}): ${answers.loser.text.slice(0, 300)}`);
      });
    }
  });

  describe('where the guard does not apply', () => {
    it('a merge relink drops the marker an absorbed edge carried, whoever authored it, and refuses nothing', async () => {
      await seedInlineEdgeSpace(env, STRICT);
      const P = 'eeeeeeee-0000-4000-8000-0000000000a1';
      const S = 'eeeeeeee-0000-4000-8000-0000000000a2';
      const X = IDS.ALICE;
      const Y = IDS.BOB;
      const Z = IDS.DOC;
      const own = { instanceId: 'functionalrace-receiver', instanceLabel: 'Receiver' };
      await env.door.coll(STRICT, 'entities').insertMany([
        build.entity(STRICT, P, 3, { name: 'Absorbed', type: 'person' }),
        build.entity(STRICT, S, 3, { name: 'Survivor', type: 'person' }),
      ]);
      // The survivor already reports to Z; the absorbed entity's two edges (one written here, one by a peer) carry a marker.
      await env.door.coll(STRICT, 'edges').insertMany([
        build.edge(STRICT, edgeIdFor(S, Z, LABELS.functional), 3, { from: S, to: Z, label: LABELS.functional, author: own }),
        build.edge(STRICT, edgeIdFor(P, X, LABELS.functional), 3, { from: P, to: X, label: LABELS.functional, author: own, [GUARD]: 'seeded-guard-own' }),
        build.edge(STRICT, edgeIdFor(P, Y, LABELS.functional), 3, { from: P, to: Y, label: LABELS.functional, [GUARD]: 'seeded-guard-peer' }),
      ]);
      const answer = await mcp('graph_merge', { space: STRICT, survivorId: S, absorbedId: P, resolutions: [] });
      assert.equal(answer.refused, false, `a merge that leaves two edges under a functional label was refused (${answer.status}): ${answer.text.slice(0, 300)}`);
      assert.deepEqual(await landedTos(STRICT, S), [X, Y, Z].sort(), 'the merge must relink every absorbed edge onto the survivor, functional or not');
      const carried = (await env.door.coll(STRICT, 'edges').find({ from: S }).toArray()).filter(e => GUARD in e).map(e => e.to);
      assert.deepEqual(carried, [], `a relinked edge kept the marker of the subject it left (to ${carried}), which would lock the survivor's (from, label) for ever`);
    });

    it('a sync arrival of a functional duplicate is stored, and nothing is stamped', async () => {
      await seedInlineEdgeSpace(env, STRICT);
      const have = build.edge(STRICT, edgeIdFor(SUBJECT, TO_A, LABELS.functional), 3, { from: SUBJECT, to: TO_A, label: LABELS.functional });
      await env.door.coll(STRICT, 'edges').insertOne(have);
      const arriving = build.edge(STRICT, edgeIdFor(SUBJECT, TO_B, LABELS.functional), 11, { from: SUBJECT, to: TO_B, label: LABELS.functional, [GUARD]: 'peer-marker' });
      const answer = await env.door.push('/edges', arriving, { spaceId: STRICT, token: PEER_TOKEN });
      assert.ok(answer.code < 300, `a peer's edge was refused for sharing a functional subject (${answer.code}): ${JSON.stringify(answer.body).slice(0, 300)}`);
      assert.deepEqual(await landedTos(STRICT, SUBJECT), [TO_A, TO_B].sort(), 'the arriving edge belongs in the space: arrivals are not refused by the local guard');
      const stamped = (await env.door.coll(STRICT, 'edges').find({}).toArray()).filter(e => GUARD in e).map(e => e._id);
      assert.deepEqual(stamped, [], 'an arriving edge was stored carrying a marker: markers belong to the instance that stamped them and never arrive');
    });

    it('an import of a functional duplicate is stored, and nothing is stamped', async () => {
      await seedInlineEdgeSpace(env, STRICT);
      const { importDocuments } = await import('../../server/dist/api/admin-import.js');
      await env.door.coll(STRICT, 'edges').insertOne(build.edge(STRICT, edgeIdFor(SUBJECT, TO_A, LABELS.functional), 3, { from: SUBJECT, to: TO_A, label: LABELS.functional }));
      const exported = build.edge(STRICT, edgeIdFor(SUBJECT, TO_B, LABELS.functional), 7, { from: SUBJECT, to: TO_B, label: LABELS.functional, [GUARD]: 'exported-marker' });
      await importDocuments(STRICT, { edges: [exported] });
      assert.deepEqual(await landedTos(STRICT, SUBJECT), [TO_A, TO_B].sort(), 'an import restores what it is given, a functional duplicate included');
      const stamped = (await env.door.coll(STRICT, 'edges').find({}).toArray()).filter(e => GUARD in e).map(e => e._id);
      assert.deepEqual(stamped, [], 'an imported edge kept the marker its export carried: a restore must not bring one in');
    });
  });

  describe('a flag flipped off and back on', () => {
    /** Rewrite whether `reports_to` is functional in `space`'s declared schema, and reload it. */
    async function setFunctional(space, on) {
      const path = process.env['CONFIG_PATH'];
      const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
      const entry = cfg.spaces.find(s => s.id === space);
      entry.meta.typeSchemas.edge[LABELS.functional] = on ? { functional: true } : {};
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      (await import('../../server/dist/config/loader.js')).loadConfig();
    }

    for (const writer of WRITERS.filter(w => w.kind === 'direct')) {
      it(`${writer.name}: the marker of an edge that landed outlives the flip, and a plan made before it is re-planned and refused`, async () => {
        await setFunctional(FLIP, true);
        const refusals = { [TO_A]: await sequentialRefusal(writer, FLIP, TO_A, TO_B) };
        const last = await functionalReadsOf(writer, FLIP);
        await writer.seed(FLIP);
        let seen = 0;
        const park = reads.arm(`${FLIP}_edges`, (f) => isFunctionalCountRead(f) && ++seen === last);
        const answers = {};
        try {
          await holdWhileOtherRuns(park, {
            first: async () => { answers.a = await writer.run(FLIP, TO_A, 'A'); },
            second: async () => {
              answers.b = await writer.run(FLIP, TO_B, 'B');
              await setFunctional(FLIP, false);
              await setFunctional(FLIP, true);
            },
          });
        } finally { disarm(); await setFunctional(FLIP, true); }
        assert.deepEqual(await writer.landed(FLIP), [TO_B], `${writer.name}: the edge that landed first is the only one the label may hold, whatever the flag did meanwhile`);
        assert.equal(answers.b.refused, false);
        assert.deepEqual(writer.loser(answers.a, refusals[TO_A], TO_A), [], `${writer.name}: the stale writer did not answer the ordinary refusal — ${answers.a.text.slice(0, 300)}`);
      });
    }
  });
});
