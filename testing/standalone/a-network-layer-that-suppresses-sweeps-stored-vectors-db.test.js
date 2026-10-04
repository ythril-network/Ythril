/**
 * Suppression that arrives as a NETWORK schema layer sweeps the vectors already stored, as the operator's own edit
 * does (plan v3 §E, Q-230).
 *
 * ## The rule
 *
 * Turning suppression on in the space's own meta (`spaces/meta-update.ts`) sweeps the stored vectors of what it now
 * suppresses: suppression IS the absence of a vector, so a vector left behind is the feature failing. The same
 * schema- or space-tier `suppressEmbeddings` can also arrive from a network: every transport that stores a network
 * layer (the meta pull, a meta round, a space addition) goes through `storeNetworkLayer`, which recomputed the
 * effective meta and swept nothing. The space then reported its records suppressed and kept answering vector
 * searches with them until each was rewritten.
 *
 * What the sweep removes: `embedding` and `embeddingModel` — the vector and its provenance. `matchedText` STAYS:
 * the content did not change, and it is the lexical channel's text (removing it is a content decision, not a
 * suppression one). Files are covered (space tier only: a file has no type) and so are their chunk rows.
 *
 * The rule is asserted at `storeNetworkLayer`, the one sink every transport reaches; the record kinds are derived
 * from `TYPE_FIELD` (every knowledge type) with a floor.
 *
 * Seen red on the base (0b066822): nothing is swept after either layer is stored.
 *
 * Run: node --test testing/standalone/a-network-layer-that-suppresses-sweeps-stored-vectors-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { eventually } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const SPACE_TIER = 'layer-space';
const SCHEMA_TIER = 'layer-schema';
const NET = 'layer-net';
const MUTED = 'muted';
const VEC = { embedding: [0.25, 0.5, 0.75], embeddingModel: 'receiver-model', matchedText: 'the text it holds' };
/** How long the sweep may take to land after the layer is stored — it may run in the background. */
const SWEEP_DEADLINE_MS = 5_000;

let door, TYPE_FIELD, KINDS, COLLECTION_OF, getConfig, storeNetworkLayer;

function record(kind, space, id, typeValue) {
  return { _id: id, spaceId: space, seq: 1, tags: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    [TYPE_FIELD[kind]]: typeValue, ...VEC };
}

/** Wait until `ok()` holds or the sweep's deadline passes; returns whether it held (`_write-faults.mjs`). */
const swept = (ok) => eventually(ok, SWEEP_DEADLINE_MS, 50);

/** The vector fields still on a stored row, and whether its matchedText survived. */
async function stateOf(space, coll, id) {
  const d = await door.coll(space, coll).findOne({ _id: id });
  return { vector: ['embedding', 'embeddingModel'].filter(f => f in (d ?? {})), matchedText: d?.matchedText === VEC.matchedText };
}

describe('a network layer that suppresses sweeps the stored vectors', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'layer-sweep',
      spaces: [SPACE_TIER, SCHEMA_TIER].map(id => ({ id, label: id, folders: [], meta: {} })),
      networks: [{ id: NET, label: 'Layer network', type: 'closed', spaces: [SPACE_TIER, SCHEMA_TIER], members: [], votes: [],
        votingDeadlineHours: 24 }],
    });
    ({ TYPE_FIELD } = await import('../../server/dist/brain/ttl.js'));
    ({ RECORD_COLLECTION: COLLECTION_OF } = await import('../../server/dist/config/types-knowledge.js'));
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    ({ storeNetworkLayer } = await import('../../server/dist/spaces/effective-meta.js'));
    KINDS = Object.keys(TYPE_FIELD);

    for (const space of [SPACE_TIER, SCHEMA_TIER]) {
      for (const kind of KINDS) {
        await door.coll(space, COLLECTION_OF[kind]).insertMany([
          record(kind, space, `${kind}-muted`, MUTED),
          record(kind, space, `${kind}-plain`, 'plain'),
        ]);
      }
      await door.coll(space, 'files').insertMany([
        { _id: 'docs/a.md', spaceId: space, path: 'docs/a.md', tags: [], seq: 1, ...VEC },
        { _id: 'docs/a.md#chunk0', spaceId: space, path: 'docs/a.md#chunk0', parentFileId: 'docs/a.md', content: 'a passage', tags: [], ...VEC },
      ]);
    }
  });
  after(async () => { await door?.close(); });

  it('the record kinds are derived (every knowledge type)', () => {
    assert.ok(KINDS.length >= 4, `only ${KINDS.length} knowledge types in TYPE_FIELD: ${KINDS}`);
    for (const k of KINDS) assert.ok(COLLECTION_OF[k], `no collection for knowledge type ${k}`);
  });

  it('space tier: every record, file and chunk loses embedding and embeddingModel; matchedText stays', async () => {
    storeNetworkLayer(NET, SPACE_TIER, { suppressEmbeddings: true });
    assert.equal(getConfig().spaces.find(s => s.id === SPACE_TIER).meta.suppressEmbeddings, true,
      'fixture check: the network layer did not make the space suppress');
    const rows = [
      ...KINDS.flatMap(k => [[COLLECTION_OF[k], `${k}-muted`], [COLLECTION_OF[k], `${k}-plain`]]),
      ['files', 'docs/a.md'], ['files', 'docs/a.md#chunk0'],
    ];
    await swept(async () => {
      for (const [c, id] of rows) if ((await stateOf(SPACE_TIER, c, id)).vector.length) return false;
      return true;
    });
    const wrong = [];
    for (const [c, id] of rows) {
      const s = await stateOf(SPACE_TIER, c, id);
      if (s.vector.length) wrong.push(`${c}/${id} still holds ${s.vector.join(', ')}`);
      if (!s.matchedText) wrong.push(`${c}/${id} lost its matchedText — the content did not change`);
    }
    assert.deepEqual(wrong, [], `${SWEEP_DEADLINE_MS} ms after a network layer suppressed the space, it still answers `
      + 'vector searches with records it reports suppressed');
  });

  it('schema tier: records of the suppressed type lose their vectors; other types and files keep theirs', async () => {
    const muted = { [MUTED]: { suppressEmbeddings: true } };
    storeNetworkLayer(NET, SCHEMA_TIER, { typeSchemas: Object.fromEntries(KINDS.map(k => [k, muted])) });
    const meta = getConfig().spaces.find(s => s.id === SCHEMA_TIER).meta;
    assert.equal(meta.typeSchemas?.fact?.[MUTED]?.suppressEmbeddings, true, 'fixture check: the layer did not reach the meta');
    const gone = KINDS.map(k => [COLLECTION_OF[k], `${k}-muted`]);
    const kept = [...KINDS.map(k => [COLLECTION_OF[k], `${k}-plain`]), ['files', 'docs/a.md'], ['files', 'docs/a.md#chunk0']];
    await swept(async () => {
      for (const [c, id] of gone) if ((await stateOf(SCHEMA_TIER, c, id)).vector.length) return false;
      return true;
    });
    const wrong = [];
    for (const [c, id] of gone) {
      const s = await stateOf(SCHEMA_TIER, c, id);
      if (s.vector.length) wrong.push(`${c}/${id} (suppressed type) still holds ${s.vector.join(', ')}`);
      if (!s.matchedText) wrong.push(`${c}/${id} lost its matchedText`);
    }
    for (const [c, id] of kept) {
      const s = await stateOf(SCHEMA_TIER, c, id);
      if (s.vector.length !== 2) wrong.push(`${c}/${id} (not suppressed) lost its vector`);
    }
    assert.deepEqual(wrong, [], 'a type a network layer suppresses keeps its stored vectors, or the sweep took more than it suppresses');
  });
});
