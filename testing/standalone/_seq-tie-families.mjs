/**
 * The replicated record families as a test fixture, and runs of records that SHARE a seq — written once for every
 * test that asks what a seq-ordered reader does at a boundary inside such a run (bundle-52, `Q-277`).
 *
 * ## Why equal seqs are the case to test
 *
 * A record keeps its AUTHOR's seq when it replicates, so records from several authors share seqs. Every reader that
 * pages by `seq > last` is correct while every seq is distinct and loses the tail of a run at a page or batch boundary,
 * or at a stop. A fixture with distinct seqs — which is what every record seeded one by one with `bumpSeq` has — can
 * never show it, so this one builds the run on purpose: where it starts, how long it is, and what follows it.
 *
 * ## What it derives and what it declares
 *
 * The families are READ from `REPLICATED_FAMILIES` (floor 6), so a seventh cannot go unchecked; the one thing declared is
 * the builder each payload key needs (`MAKE`), because a document's required keys are a property of its type. A family
 * the registry has and `MAKE` lacks throws, naming it, rather than being skipped.
 */
import assert from 'node:assert/strict';
import { build } from './_push-door.mjs';

const MAKE = Object.freeze({
  facts: build.fact, entities: build.entity, chrono: build.chrono, filemeta: build.filemeta, edges: build.edge, links: build.link,
});

/** `[{ payloadKey, collection, make(space, id, seq, extra), tombstoneType | null }]`, one per replicated family. */
export async function replicatedFixtureFamilies() {
  const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
  const { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } = await import('../../server/dist/config/types.js');
  assert.ok(REPLICATED_FAMILIES.length >= 6, `only ${REPLICATED_FAMILIES.length} replicated families — the derivation is broken`);
  return REPLICATED_FAMILIES.map((f) => {
    const make = MAKE[f.payloadKey];
    assert.ok(make, `no document builder for the '${f.payloadKey}' family — add it to MAKE in _seq-tie-families.mjs, or it goes unchecked`);
    // A family whose deletions ride in its page: the tombstone type whose collection name is this family's. Files have none.
    const tombstoneType = TOMBSTONE_TYPES.find(t => TOMBSTONE_COLLECTION[t] === f.collection) ?? null;
    return { payloadKey: f.payloadKey, collection: f.collection, pushFilter: f.pushFilter, make, tombstoneType };
  });
}

/**
 * A run of records, in ascending seq:
 *
 *   - `before` records at seqs 1 .. before, one each;
 *   - `tie` records that ALL carry seq before + 1 (ids end `-a`, `-b`, …);
 *   - `after` records at the next seqs, one each.
 *
 * Ids sort in the order the records are listed, so a reader ordered by `(seq, _id)` meets them in this order.
 * `extra` is merged into every document (an author, local-only fields). Returns `{ docs, tieIds, tieSeq, ids }`.
 */
export function tieRun(family, space, { before, tie, after = 0, extra = {}, tieIds }) {
  const pad = (n) => String(n).padStart(5, '0');
  const stem = family.payloadKey === 'filemeta' ? (id) => `notes/${id}.md` : (id) => id;
  const docs = [];
  for (let s = 1; s <= before; s++) docs.push(family.make(space, stem(`r-${pad(s)}`), s, extra));
  const tieSeq = before + 1;
  const names = tieIds ?? Array.from({ length: tie }, (_, k) => `r-${pad(tieSeq)}-${String.fromCharCode(97 + k)}`);
  const ties = names.map(id => family.make(space, stem(id), tieSeq, extra));
  docs.push(...ties);
  for (let k = 0; k < after; k++) docs.push(family.make(space, stem(`r-${pad(tieSeq + 1 + k)}`), tieSeq + 1 + k, extra));
  return { docs, tieSeq, tieIds: ties.map(d => d._id), ids: docs.map(d => d._id) };
}

/** `ids` with each value's count, so a duplicate and a loss are told apart in one message. */
export function tally(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** What is missing from `got` and what was seen more than once, against `want` — empty arrays when it is exactly once each. */
export function missingAndRepeated(want, got) {
  const counts = tally(got);
  return {
    missing: want.filter(id => !counts.has(id)),
    repeated: [...counts].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`),
    unexpected: [...counts.keys()].filter(id => !want.includes(id)),
  };
}
