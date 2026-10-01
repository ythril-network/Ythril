/**
 * A bulk edge whose end is a `$ref` is stored with the KIND of the record the reference names — at either end,
 * for every non-entity kind a payload can declare, whatever the space's `strictLinkage`.
 *
 * ## The defect (`Q-193`)
 *
 * `bulkWrite` resolves `$ref:<key>` to the minted id AND the kind of the array the key was declared in —
 * `fromRef.kind` — and uses that kind for its own shape and existence checks. Then it hands `upsertEdge` the
 * kinds only when the CALLER typed them (`rawFromKind !== undefined`). So an edge from `$ref:f1`, a fact, with
 * no `fromKind` stated, was checked as a fact and stored as an entity edge: `fromKind` absent, which every
 * reader takes to mean `entity`. Traversal then looks for the end in the entities collection, finds nothing,
 * and the edge is a relationship nobody can walk.
 *
 * The bulk docs say a `$ref` makes the stated kind redundant — *"the array decides"*. The stored record has to
 * say what the array decided, or that sentence is true of the check and false of the data.
 *
 * ## The rule, over the set it applies to
 *
 * Every kind a `$ref` can be declared as other than `entity` (an entity end is stored with the kind absent, so
 * it cannot show the defect) — derived from `REF_KINDS` minus the kinds `bulkWrite` has no array for — at both
 * ends, with `strictLinkage` on and off. The kind is asserted on the stored edge AND through a walk, because the
 * walk is what an absent kind actually breaks. The single-door control writes the same edge with the kind
 * stated, so the walk assertion is known to be able to pass.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-ref-edge-end-takes-its-records-kind-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-ref-edge-kind-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const HUB = 'aaaaaaaa-0000-4000-8000-0000000c0193';

let mongo, loader, bulkMod, edgeMod, factMod, chronoMod, REF_KINDS, BULK_BODY_KEYS;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

/** Which bulk array declares a record of each kind, and a minimal item for it. */
const DECLARE = {
  fact: { array: 'facts', item: (key) => ({ $ref: key, fact: `a fact keyed ${key}` }) },
  chrono: { array: 'chrono', item: (key) => ({ $ref: key, title: `an event keyed ${key}`, type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }) },
};

function writeConfig(strictLinkage) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'ref-edge-kind-test', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: strictLinkage ? {} : { strictLinkage: false } }],
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

/** What a one-hop walk from the hub reaches: each node's id and the kind the walk reported for it. */
async function reachedFromHub(direction) {
  const res = await edgeMod.traverseGraph([SPACE], HUB, direction, undefined, 1, 100, false, false, false, true);
  return res.nodes.filter(n => n._id !== HUB).map(n => `${n.kind ?? 'entity'}:${n._id}`).sort();
}

describe('a $ref edge end takes the kind of the record it names', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('refedgekind');
    loader = await import('../../server/dist/config/loader.js');
    writeConfig(true);
    bulkMod = await import('../../server/dist/brain/bulk.js');
    edgeMod = await import('../../server/dist/brain/edges.js');
    factMod = await import('../../server/dist/brain/fact.js');
    chronoMod = await import('../../server/dist/brain/chrono.js');
    ({ REF_KINDS } = await import('../../server/dist/config/types-knowledge.js'));
    ({ BULK_BODY_KEYS } = bulkMod);
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    writeConfig(true);
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'embed_jobs', 'tombstones', 'links']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertOne({ _id: HUB, spaceId: SPACE, name: 'Hub', type: 'concept', tags: [], seq: 1 });
  });

  it('the set is derived, and it is the set this file covers', () => {
    // Every kind a `$ref` can be declared as is a kind with a bulk array of its own. `entity` is left out on
    // purpose: an entity end is stored with the kind ABSENT, so a dropped kind is invisible there.
    const declarable = REF_KINDS.filter(k => BULK_BODY_KEYS.some(a => a === k || a === `${k}s`));
    const nonEntity = declarable.filter(k => k !== 'entity').sort();
    assert.ok(nonEntity.length >= 2, `derived only ${JSON.stringify(nonEntity)} — the derivation found nothing to cover`);
    assert.deepEqual(Object.keys(DECLARE).sort(), nonEntity,
      'a kind a bulk payload can declare by `$ref` is not covered here, or one covered here is no longer declarable');
  });

  it('control: an edge with the kind STATED is walked to its non-entity end', async () => {
    // Without this, "the walk does not reach it" could be a property of the walk rather than of the edge.
    const fact = await factMod.saveFact(SPACE, 'a control fact', []);
    const chrono = await chronoMod.createChrono(SPACE, { title: 'a control event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' });
    await edgeMod.upsertEdge(SPACE, HUB, fact._id, 'cites', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, { toKind: 'fact' });
    await edgeMod.upsertEdge(SPACE, HUB, chrono._id, 'cites', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, { toKind: 'chrono' });
    const reached = await reachedFromHub('outbound');
    assert.deepEqual(reached, [`fact:${fact._id}`, `chrono:${chrono._id}`].sort(),
      'the walk cannot reach a fact or chrono end even when the kind is stated');
  });

  for (const strict of [true, false]) {
    for (const kind of Object.keys(DECLARE)) {
      for (const end of ['from', 'to']) {
        it(`strictLinkage ${strict ? 'on' : 'off'}: a \`${end}\` end naming a ${kind} by $ref, with no kind stated, is stored as a ${kind}`, async () => {
          writeConfig(strict);
          const key = `k-${kind}-${end}`;
          const edge = end === 'from'
            ? { from: `$ref:${key}`, to: HUB, label: 'about' }
            : { from: HUB, to: `$ref:${key}`, label: 'about' };
          const res = await bulkMod.bulkWrite(SPACE, {
            [DECLARE[kind].array]: [DECLARE[kind].item(key)],
            edges: [edge],
          });
          const minted = res.refs?.[key]?.id;
          assert.ok(minted, `the ${kind} keyed ${key} was not written: ${JSON.stringify(res.errors)}`);
          assert.deepEqual(res.errors, [],
            `the edge naming the ${kind} by $ref was refused — the $ref already says what it names, so a `
            + `missing ${end}Kind is not a reason to treat its end as an entity: ${JSON.stringify(res.errors)}`);

          const stored = await coll('edges').findOne({ label: 'about' });
          assert.ok(stored, 'the edge was not stored');
          assert.equal(stored[end], minted, `the edge's ${end} is not the id the $ref resolved to`);
          assert.equal(stored[`${end}Kind`], kind,
            `the edge's ${end} names a ${kind} and was stored with ${end}Kind ${JSON.stringify(stored[`${end}Kind`])}, `
            + 'which every reader takes to mean an ENTITY — so the relationship points into a collection the '
            + 'record is not in');

          const reached = await reachedFromHub(end === 'from' ? 'inbound' : 'outbound');
          assert.deepEqual(reached, [`${kind}:${minted}`],
            `a walk from the other end does not reach the ${kind}: the edge is stored and cannot be traversed`);
        });
      }
    }
  }
});
