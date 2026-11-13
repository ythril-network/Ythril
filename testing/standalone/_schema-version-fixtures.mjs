/**
 * What the bundle-267 tests of schema versions (Q-741 filter, Q-742 versions, Q-743 validate against the stamp) need and no helper
 * had: a schema version saved the way a door saves it with its private row landed, stored records of each stamped collection carrying a
 * chosen stamp (or none), and an explain of a command a door really sent, read for covered-ness.
 *
 * ## What a hand-written copy drops
 *
 * - **The row.** A schema save keeps its snapshot row DETACHED (`keepVariationSnapshots`): a test that reads versions right after a
 *   save races it. `saveVersion` awaits the housekeeping step that writes every owed row (`ensureSchemaSnapshots`), so a case that
 *   wants the row has it, and one that wants it lagging stands an act first (`_space-act-harness.mjs`), never a sleep.
 * - **The type field.** An edge's type is its `label`, every other stamped collection's is `type` (design r2, "Type field"):
 *   `recordOf` writes the one the collection reads, and leaves it out for an untyped record.
 * - **Covered, not just indexed.** An IXSCAN that FETCHes every record is the cost probe 2 measured (`$exists` cannot be answered
 *   from an index). `explainOf` answers the stages, the index names and the documents examined, so a test asserts no FETCH and
 *   `docsExamined` 0 where the design says covered, never an IXSCAN alone.
 */

import { waitFor } from '../_shared/wait-for.mjs';

const DIST = '../../server/dist/';

/** The field a stamped collection's records name their type in. */
export const typeFieldOf = (part) => (part === 'edges' ? 'label' : 'type');

/** A position far above any the clock gives a test, so the landing order is the order records were made here. */
const POS0 = 1_763_000_000_000_000;

/**
 * One stored record of `part` in `spaceId`, as a write leaves it: `type` (or the edge's `label`) left out when `type` is null,
 * `schemaFingerprint` left out when `fp` is null. `over` replaces fields (an edge's `from`/`to`, `properties`, `tags`).
 */
export function recordOf(part, spaceId, i, { type = null, fp = null, ...over } = {}) {
  const id = `${part.slice(0, 2)}-${String(i).padStart(6, '0')}`;
  const base = {
    _id: id, spaceId, tags: [], properties: {}, seq: i, pos: POS0 + i * 1000, posAtSeq: i,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    author: { instanceId: 'b267', instanceLabel: 'b267' },
  };
  const body = part === 'entities' ? { name: `Entity ${i}`, description: '' }
    : part === 'facts' ? { fact: `Fact ${i}`, entityIds: [] }
      // Distinct ends per record: an edge is unique by (from, to, label), and the identity index refuses a second one.
      : part === 'edges' ? { from: `en-from-${i}`, to: `en-to-${i}` }
        : { title: `Entry ${i}`, kind: 'event', startsAt: '2026-11-01T00:00:00.000Z' };
  return {
    ...base, ...body,
    ...(type !== null ? { [typeFieldOf(part)]: type } : {}),
    ...(fp !== null ? { schemaFingerprint: fp } : {}),
    ...over,
  };
}

/**
 * Save `meta` as `spaceId`'s own schema the way a door does (`updateSpace`), then run the housekeeping step that writes every row the
 * variation owes, so the row is there when this returns (unless an act stands, which is how a case holds it lagging).
 * @returns the version now current: `{ fp, text }`, read from the config (`variationOf`), never from a row.
 */
export async function saveVersion(spaceId, meta, { landRow = true } = {}) {
  const { updateSpace } = await import(`${DIST}spaces/spaces.js`);
  const { variationOf } = await import(`${DIST}spaces/schema-stamp.js`);
  updateSpace(spaceId, { meta: structuredClone(meta) });
  if (landRow) await (await import(`${DIST}spaces/schema-snapshot-store.js`)).ensureSchemaSnapshots();
  const { fp, text } = variationOf(spaceId).stamp;
  return { fp, text };
}

/** The rows of `spaceId`'s private snapshot collection, by fingerprint. */
export async function heldRows(mongo, spaceId) {
  return (await mongo.col(`${spaceId}_schema_snapshots`).find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id);
}

/** Stages, index names and the most documents/keys any stage examined, anywhere in an explain answer, whatever shape the version gives. */
export function planOf(node, out = { indexes: [], stages: [], docsExamined: 0, keysExamined: 0 }) {
  if (Array.isArray(node)) { for (const n of node) planOf(n, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.indexName === 'string') out.indexes.push(node.indexName);
  if (typeof node.stage === 'string') out.stages.push(node.stage);
  if (typeof node.totalDocsExamined === 'number') out.docsExamined = Math.max(out.docsExamined, node.totalDocsExamined);
  if (typeof node.totalKeysExamined === 'number') out.keysExamined = Math.max(out.keysExamined, node.totalKeysExamined);
  for (const [k, v] of Object.entries(node)) if (k !== 'parsedQuery' && k !== 'command' && k !== 'rejectedPlans' && k !== 'allPlansExecution') planOf(v, out);
  return out;
}

/**
 * The keys among `keys` that the section of `docRel` (under `docs/`) headed `heading` does not name in backticks. A section runs from its
 * heading to the next heading of the same or a higher level. Throws when the heading is not found, so a moved section is a red, never a pass.
 */
export async function undocumentedKeys(docRel, heading, keys) {
  const { readDoc } = await import('./_docs.mjs');
  const lines = readDoc(docRel).split('\n');
  const at = lines.findIndex(l => /^#{1,6}\s/.test(l) && l.includes(heading));
  if (at < 0) throw new Error(`docs/${docRel} has no heading "${heading}"`);
  const level = /^#+/.exec(lines[at])[0].length;
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l) && /^#+/.exec(l)[0].length <= level);
  const section = lines.slice(at, end < 0 ? undefined : end).join('\n');
  return [...new Set(keys)].filter(k => !section.includes(`\`${k}\``) && !new RegExp(`[\\\`{,\\s"]${k}[\\\`:,}\\s"]`).test(section));
}

/** A read command a door sent (captured by command monitoring), explained with execution stats, as `planOf` reads it. */
export async function explainOf(db, { name, command }) {
  const hint = command.hint !== undefined ? { hint: command.hint } : {};
  const explain = name === 'aggregate'
    ? { aggregate: command.aggregate, pipeline: command.pipeline, cursor: {}, ...hint }
    : name === 'distinct'
      ? { distinct: command.distinct, key: command.key, query: command.query, ...hint }
      : name === 'count'
        ? { count: command.count, query: command.query, ...hint }
        : { find: command.find, filter: command.filter, projection: command.projection, sort: command.sort, limit: command.limit, skip: command.skip, ...hint };
  return planOf(await db.command({ explain, verbosity: 'executionStats' }));
}

/** How long `collection` must see no command, with none in flight, before a count starts. */
const QUIET_MS = 250;
/** How long a count waits for that quiet before it refuses to measure at all. */
const QUIET_LIMIT_MS = 15_000;

/**
 * Resolves once `collection` has had no command from `client` for QUIET_MS, with none still in flight; rejects after QUIET_LIMIT_MS.
 *
 * Why a count waits first: an earlier step may have left a reader of the same collection running, and its commands land inside the
 * measured window. Saving a schema version starts the snapshot sweep detached (`sweepAfterMetaWrite`), and the sweep reads the stamps
 * through `fingerprintsCarriedIn`. Main's CI run 43499981804 counted that read as the measured call's second command.
 */
async function quietOn(client, collection) {
  const inFlight = new Set();
  let last = Date.now();
  const mine = (ev) => ev.command?.[ev.commandName] === collection || (ev.commandName === 'getMore' && ev.command?.collection === collection);
  const started = (ev) => { if (mine(ev)) { inFlight.add(ev.requestId); last = Date.now(); } };
  const ended = (ev) => { if (inFlight.delete(ev.requestId)) last = Date.now(); };
  client.on('commandStarted', started);
  client.on('commandSucceeded', ended);
  client.on('commandFailed', ended);
  try {
    await waitFor(() => inFlight.size === 0 && Date.now() - last >= QUIET_MS, QUIET_LIMIT_MS, 25, undefined,
      { what: `${collection} to be quiet for ${QUIET_MS} ms before the count (a background reader kept running)` });
  } finally {
    client.off('commandStarted', started);
    client.off('commandSucceeded', ended);
    client.off('commandFailed', ended);
  }
}

/**
 * The read commands the server's client sends to `collection` while `fn` runs, counted only after the collection went quiet (`quietOn`),
 * so a reader an earlier step left running is waited out rather than counted. Needs a client opened with command monitoring
 * (`openPushDoor({ monitorCommands: true })`).
 */
export async function readsDuring(client, collection, fn) {
  await quietOn(client, collection);
  const sent = [];
  const listen = (ev) => {
    if (ev.command?.[ev.commandName] === collection && ['aggregate', 'find', 'distinct', 'count'].includes(ev.commandName)) {
      sent.push({ name: ev.commandName, command: ev.command });
    }
  };
  client.on('commandStarted', listen);
  try { return { result: await fn(), sent }; } finally { client.off('commandStarted', listen); }
}
