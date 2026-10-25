/**
 * Every per-space index that existed before the declaration says, in the declaration, whether it is built at every boot - and
 * says what it did at df2e7534, with the failure policy it had (bundle-101, Q-445 design rev 5.1 items 1 and 6b).
 *
 * ## The rule this holds, and why
 *
 * `initSpace` runs for every space at every boot before the server listens; an index built there over a large existing
 * collection is a boot that does not finish (premise R5). So the declaration marks each index `bootSafe` (built at every boot on
 * an existing collection) or not (built only on a collection created now, and by the background pass), and an index added later
 * defaults to NOT boot-safe. A default is right for a new index and wrong for an old one: an old index the declaration forgot to
 * mark would silently stop being built at boot. So:
 *
 * - every index that existed at df2e7534 has a declared entry whose `bootSafe` is a boolean, not left to the default;
 * - its value is what that index did at df2e7534: built by `initSpace` on an existing collection, or not;
 * - the four failure policies carry today's behaviour (premise R4): the edges' identity index throws, the guard is reported,
 *   `lexical_text` is best effort, the TTL indexes are reported.
 *
 * ## The fixture, and why it is literal
 *
 * {@link AT_BASE} is a historical fact, not a derivation of the code under test: the indexes a space carried at df2e7534 once every
 * builder ran, split by whether `initSpace` built them on an existing collection. It was READ from the store at that commit (a
 * fresh space through `initSpace`, `ensureQueryIndexes` and `ensureTtlIndex`; then every index dropped and `initSpace` run again
 * on the existing collections), never typed from the source. It does not grow: an index added after it is the default's.
 *
 * ## Seen red
 *
 * At df2e7534 every case, on the declaration: `spaces/space-indexes.ts` is not built.
 *
 * Run: node --test testing/standalone/every-pre-existing-space-index-says-whether-it-is-boot-safe.test.js (a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requireSpaceIndexDeclaration, indexId } from './_space-index-declaration.mjs';

/** `<collection suffix>:<index name>` at df2e7534, by whether `initSpace` built it on an existing collection. */
const AT_BASE = Object.freeze({
  bootSafe: [
    'chrono:lexical_text', 'chrono:startsAt_1', 'chrono:status_1', 'chrono:type_1', 'conflicts:detectedAt_-1',
    'contradiction_candidates:status_1_confidence_-1_detectedAt_-1', 'contradiction_candidates:type_1',
    'dupe_candidates:status_1_score_-1_detectedAt_-1', 'edges:from_1_to_1_label_1_fromKind_1_toKind_1', 'edges:lexical_text',
    'edges:to_1', 'edges:type_1', 'embed_jobs:rebuild_1_status_1', 'embed_jobs:status_1_priority_1_claimableAfter_1_createdAt_1',
    'embed_jobs:status_1_progressAt_1', 'embed_jobs:status_1_revivedForVersion_1', 'entities:lexical_text', 'entities:name_1_type_1',
    'entities:type_1', 'facts:forkOf_1', 'facts:lexical_text', 'facts:tags_1', 'facts:type_1', 'file_tombstones:move.from_1_move.to_1',
    'file_tombstones:move.to_1', 'file_tombstones:path_1', 'file_tombstones:pending_1_settleAt_1', 'file_tombstones:positionAt_1__id_1',
    'files:faceEntityId_1', 'files:lexical_text', 'files:parentFileId_1', 'files:tags_1', 'files:updatedAt_-1',
    'links:from_1_fromKind_1_to_1_toKind_1', 'links:to_1_toKind_1', 'media_jobs:status_1_claimableAfter_1_createdAt_1',
    'media_jobs:status_1_progressAt_1',
  ],
  notBootSafe: [
    'chrono:seq_1__id_1', 'edges:seq_1__id_1', 'entities:seq_1__id_1', 'facts:seq_1__id_1', 'files:seq_1__id_1', 'links:seq_1__id_1',
    // `tombstones:type_1_seq_1__id_1` (the typed twin) is gone with the grouped per-type answer it served (bundle-81, design rev 8 §3 step 7).
    'tombstones:seq_1__id_1', 'edges:_functionalGuard_1',
    'chrono:ttl_expireAt', 'chrono:ttl_contentExpireAt', 'edges:ttl_expireAt', 'entities:ttl_expireAt', 'facts:ttl_expireAt',
    'files:ttl_expireAt', 'files:ttl_deletedAt',
  ],
});

/** The policies premise R4 names, each by the index it governs. */
const POLICY_AT_BASE = Object.freeze({
  'edges:from_1_to_1_label_1_fromKind_1_toKind_1': 'throw',
  'edges:_functionalGuard_1': 'report',
  ...Object.fromEntries(['facts', 'entities', 'edges', 'chrono', 'files'].map(c => [indexId(c, 'lexical_text'), 'best-effort'])),
  ...Object.fromEntries(AT_BASE.notBootSafe.filter(id => id.includes(':ttl_')).map(id => [id, 'report'])),
});

describe('every pre-existing space index says whether it is boot-safe', () => {
  it('the fixture is whole: no index in both lists, and a floor on each', () => {
    const both = AT_BASE.bootSafe.filter(id => AT_BASE.notBootSafe.includes(id));
    assert.deepEqual(both, [], 'an index is both boot-safe and not');
    assert.ok(AT_BASE.bootSafe.length >= 30 && AT_BASE.notBootSafe.length >= 10, 'the fixture lost its rows');
  });

  it('every index that existed at df2e7534 has a declared entry with an explicit bootSafe', async () => {
    const declared = new Map((await requireSpaceIndexDeclaration(assert)).map(e => [e.id, e]));
    const findings = [];
    for (const id of [...AT_BASE.bootSafe, ...AT_BASE.notBootSafe]) {
      const e = declared.get(id);
      if (!e) findings.push(`${id} is not declared`);
      else if (typeof e.bootSafe !== 'boolean') findings.push(`${id} leaves bootSafe to the default (${JSON.stringify(e.bootSafe)})`);
    }
    assert.deepEqual(findings, [], `pre-existing indexes without an explicit bootSafe: ${findings.join('; ')}`);
  });

  it('each one is boot-safe exactly when initSpace built it on an existing collection at df2e7534', async () => {
    const declared = new Map((await requireSpaceIndexDeclaration(assert)).map(e => [e.id, e]));
    const findings = [
      ...AT_BASE.bootSafe.filter(id => declared.get(id)?.bootSafe !== true).map(id => `${id} was built at every boot and is not declared boot-safe`),
      ...AT_BASE.notBootSafe.filter(id => declared.get(id)?.bootSafe !== false).map(id => `${id} was not built at boot on an existing collection and is not declared bootSafe: false`),
    ];
    assert.deepEqual(findings, [], findings.join('; '));
  });

  it('the failure policies carry today\'s behaviour: identity throws, the guard and the TTL indexes are reported, lexical_text is best effort', async () => {
    const declared = new Map((await requireSpaceIndexDeclaration(assert)).map(e => [e.id, e]));
    const findings = Object.entries(POLICY_AT_BASE)
      .filter(([id, policy]) => declared.get(id)?.policy !== policy)
      .map(([id, policy]) => `${id}: declared ${JSON.stringify(declared.get(id)?.policy)}, today's is ${policy}`);
    assert.deepEqual(findings, [], findings.join('; '));
  });
});
