/**
 * A passed `meta_change` round applies its own fields, not a stale snapshot of the whole meta.
 *
 * The loss it prevents, in the order it happens on a real network:
 *
 *   1. The space's meta is at version 7.
 *   2. Alice proposes a new `purpose`. Her round carries the FULL meta — new purpose, v7's everything else.
 *   3. Bob proposes `strictLinkage: true`. His round carries the FULL meta — v7's purpose, new flag.
 *   4. Alice's round passes. Purpose updated, version 8.
 *   5. Bob's round passes. The whole meta is replaced by his snapshot, still holding **v7's purpose**.
 *
 * Alice's change is gone, and nothing anywhere says so: the round passed, the vote is recorded as carried,
 * and the resulting meta is internally consistent. Rounds stay open for `votingDeadlineHours` — hours,
 * often days — so this is not an exotic race, it is what happens whenever two operators configure a space
 * in the same week.
 *
 * Two behaviours are load-bearing and easy to get backwards, so both are pinned here:
 *
 *   - **Same-field collision resolves to the round's value.** The network voted for it. Refusing to apply
 *     a carried motion because the field moved would relocate the silent loss, not remove it.
 *   - **A round with no provenance applies WHOLESALE.** Rounds gossip, so one proposed by a peer that
 *     predates field-merge arrives with neither `metaChangedFields` nor `baseMetaVersion`. Field-merging
 *     an unknown changed-set would merge nothing — a passed round that does nothing at all.
 *
 * Run: node --test testing/standalone/meta-round-merge.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let applyMetaRound;
let proposedMetaFields;

/** The space's meta as it stood when both proposals were computed. */
const V7 = {
  version: 7,
  updatedAt: '2026-07-01T00:00:00.000Z',
  purpose: 'original purpose',
  usageNotes: 'original notes',
  strictLinkage: false,
  typeSchemas: { fact: { note: { properties: { a: {} } } } },
  previousVersions: [{ version: 6, meta: {}, updatedAt: '2026-06-01T00:00:00.000Z' }],
};

/** What a proposer stores: the base with its own patch already merged in. */
const proposalFrom = (base, patch) => ({
  pendingMeta: { ...base, ...patch },
  metaChangedFields: Object.keys(patch),
  baseMetaVersion: base.version ?? 0,
});

/**
 * What `updateSpace` does after a round is applied: bump the counter and push the outgoing meta onto
 * `previousVersions`. Modelled here rather than skipped, because that history is where conflict detection
 * recovers the round's base from — a test that dropped it would exercise only the degraded path.
 */
const commit = (previous, applied) => {
  const { previousVersions: _drop, ...snapshot } = previous;
  return {
    ...applied.meta,
    version: (previous.version ?? 0) + 1,
    updatedAt: '2026-07-02T00:00:00.000Z',
    previousVersions: [
      { version: previous.version ?? 0, meta: snapshot, updatedAt: previous.updatedAt },
      ...(previous.previousVersions ?? []),
    ],
  };
};

describe('meta_change round application', () => {
  before(async () => {
    ({ applyMetaRound, proposedMetaFields } = await import('../../server/dist/sync/meta-round-merge.js'));
  });

  describe('the concurrent-edit loss', () => {
    it('a second round does not revert the first round\'s field', () => {
      const alice = proposalFrom(V7, { purpose: 'alice purpose' });
      const bob = proposalFrom(V7, { strictLinkage: true });

      // Alice concludes first.
      const afterAlice = applyMetaRound(V7, alice);
      assert.equal(afterAlice.meta.purpose, 'alice purpose');
      assert.deepEqual(afterAlice.conflicts, [], 'nothing had moved yet');

      const v8 = commit(V7, afterAlice);

      // Bob concludes second, against the meta as it now stands.
      const afterBob = applyMetaRound(v8, bob);
      assert.equal(afterBob.meta.strictLinkage, true, 'Bob\'s field is applied');
      assert.equal(afterBob.meta.purpose, 'alice purpose',
        'Alice\'s edit must survive — reverting it is the defect this whole module exists for');
      assert.deepEqual(afterBob.conflicts, [], 'different fields are not a conflict, only a later base');
    });

    it('fields nobody proposed are left exactly as they are', () => {
      const round = proposalFrom(V7, { purpose: 'new' });
      const current = { ...V7, version: 9, usageNotes: 'someone else changed this' };
      const { meta } = applyMetaRound(current, round);
      assert.equal(meta.usageNotes, 'someone else changed this');
    });

    it('never writes housekeeping fields back', () => {
      // set-claim: the three housekeeping fields the SPACE layer owns and re-adds, named as the boundary
      // between the two layers rather than copied from a list.
      // `version`, `updatedAt` and `previousVersions` belong to the space layer, which re-adds them.
      // A round carrying v7's copies into a v9 write would rewind the counter and the history with it.
      const round = proposalFrom(V7, { purpose: 'new' });
      const { meta } = applyMetaRound({ ...V7, version: 9 }, round);
      for (const k of ['version', 'updatedAt', 'previousVersions']) {
        assert.ok(!(k in meta), `${k} must not be carried by the round`);
      }
    });

    it('ignores housekeeping even if a round names it as changed', () => {
      // A hand-built or hostile round could list `version` among its changed fields; the space layer's
      // counter is not something a vote may set.
      const round = {
        pendingMeta: { ...V7, version: 2, purpose: 'new' },
        metaChangedFields: ['version', 'previousVersions', 'purpose'],
        baseMetaVersion: 7,
      };
      const { meta } = applyMetaRound({ ...V7, version: 9 }, round);
      assert.ok(!('version' in meta));
      assert.ok(!('previousVersions' in meta));
      assert.equal(meta.purpose, 'new');
    });
  });

  describe('same-field collision — the vote wins, and says so', () => {
    it('applies the round\'s value over one changed since it was proposed', () => {
      const alice = proposalFrom(V7, { purpose: 'alice purpose' });
      const bob = proposalFrom(V7, { purpose: 'bob purpose' });

      const v8 = commit(V7, applyMetaRound(V7, alice));
      const afterBob = applyMetaRound(v8, bob);

      assert.equal(afterBob.meta.purpose, 'bob purpose', 'the passed vote is applied, not discarded');
      assert.deepEqual(afterBob.conflicts, ['purpose'], 'and the overwrite is reported');
    });

    it('reports nothing when the base version still matches', () => {
      // Same version means nothing concluded in between, so every write is uncontested — reporting a
      // conflict here would train an operator to ignore the warning.
      const round = proposalFrom(V7, { purpose: 'new' });
      assert.deepEqual(applyMetaRound(V7, round).conflicts, []);
    });

    it('reports nothing when the meta moved but landed on the same value', () => {
      // Two operators proposing the identical value is agreement, not collision.
      const round = proposalFrom(V7, { purpose: 'same' });
      const moved = { ...V7, version: 8, purpose: 'same' };
      assert.deepEqual(applyMetaRound(moved, round).conflicts, []);
    });

    it('reports the overwrite when the base rolled out of the version history', () => {
      // `previousVersions` is capped. With the base gone there is no way to tell "somebody else changed
      // this" from "this round is changing it", so the coarse rule stands and the overwrite is reported.
      // Over-reporting a rare case beats asserting an uncontested write that was not.
      const round = proposalFrom(V7, { strictLinkage: true });
      const farLater = { ...V7, version: 40, previousVersions: [{ version: 39, meta: {}, updatedAt: 'x' }] };
      assert.deepEqual(applyMetaRound(farLater, round).conflicts, ['strictLinkage']);
    });

    it('clearing a scalar is a real proposal, not an absent one', () => {
      const round = { pendingMeta: { ...V7, purpose: undefined }, metaChangedFields: ['purpose'], baseMetaVersion: 7 };
      const { meta } = applyMetaRound(V7, round);
      assert.ok(!('purpose' in meta), 'an undefined proposal clears the field rather than being skipped');
    });
  });

  describe('typeSchemas merge per knowledge-type', () => {
    it('keeps a type another round added', () => {
      const round = proposalFrom(V7, {
        typeSchemas: { fact: { note: { properties: { a: {}, b: {} } } } },
      });
      const current = {
        ...V7, version: 8,
        typeSchemas: { fact: { note: { properties: { a: {} } }, task: { properties: {} } } },
      };
      const { meta } = applyMetaRound(current, round);
      assert.ok(meta.typeSchemas.fact.task, 'a concurrently-added type must survive');
      assert.deepEqual(meta.typeSchemas.fact.note.properties, { a: {}, b: {} }, 'and this round\'s edit applies');
    });

    it('does not disturb a knowledge type the round never mentions', () => {
      const round = proposalFrom(V7, { typeSchemas: { fact: { note: { properties: { z: {} } } } } });
      const current = { ...V7, version: 8, typeSchemas: { ...V7.typeSchemas, entity: { person: {} } } };
      const { meta } = applyMetaRound(current, round);
      assert.deepEqual(meta.typeSchemas.entity, { person: {} });
    });

    it('reports the colliding knowledge type by name', () => {
      const round = proposalFrom(V7, { typeSchemas: { fact: { note: { properties: { b: {} } } } } });
      const current = { ...V7, version: 8, typeSchemas: { fact: { note: { properties: { c: {} } } } } };
      const { conflicts } = applyMetaRound(current, round);
      assert.deepEqual(conflicts, ['typeSchemas.fact']);
    });
  });

  describe('rounds from peers that have not upgraded', () => {
    it('apply wholesale when the base version is absent', () => {
      // The compatibility switch. An older proposer computed pendingMeta as the complete intended result.
      const legacy = { pendingMeta: { ...V7, purpose: 'legacy purpose' } };
      const current = { ...V7, version: 12, usageNotes: 'changed since' };
      const out = applyMetaRound(current, legacy);
      assert.equal(out.wholesale, true);
      assert.equal(out.meta.purpose, 'legacy purpose');
      assert.equal(out.meta.usageNotes, 'original notes', 'wholesale means wholesale — the old behaviour');
    });

    it('apply wholesale when the changed-field list is absent', () => {
      // Belt and braces: a round with a version but no field list must not field-merge an empty set, which
      // would be a carried motion that changes nothing.
      const half = { pendingMeta: { ...V7, purpose: 'p' }, baseMetaVersion: 7 };
      const out = applyMetaRound({ ...V7, version: 8 }, half);
      assert.equal(out.wholesale, true);
      assert.equal(out.meta.purpose, 'p');
    });

    it('a modern round is never treated as wholesale', () => {
      const out = applyMetaRound(V7, proposalFrom(V7, { purpose: 'p' }));
      assert.equal(out.wholesale, false);
    });

    it('an empty changed-field list is honoured, not mistaken for absent', () => {
      // `[]` says "this round proposes nothing", which is different from "we do not know what it proposes".
      const round = { pendingMeta: { ...V7, purpose: 'ignored' }, metaChangedFields: [], baseMetaVersion: 7 };
      const out = applyMetaRound({ ...V7, version: 8, purpose: 'kept' }, round);
      assert.equal(out.wholesale, false);
      assert.equal(out.meta.purpose, 'kept');
    });
  });

  describe('a space with no meta yet', () => {
    it('applies the round\'s fields onto an empty base', () => {
      const round = { pendingMeta: { purpose: 'first' }, metaChangedFields: ['purpose'], baseMetaVersion: 0 };
      const { meta, conflicts } = applyMetaRound(undefined, round);
      assert.equal(meta.purpose, 'first');
      assert.deepEqual(conflicts, []);
    });
  });

  describe('proposedMetaFields', () => {
    it('reads the patch keys, not a diff against the base', () => {
      // A patch setting a field to the value it already holds is still a proposal to set it. Diffing would
      // drop it from the round, so a concurrent change to that field would win by default — the network
      // voted on the intent, not on whether the bytes differed.
      assert.deepEqual(proposedMetaFields({ purpose: 'unchanged' }), ['purpose']);
    });

    it('drops housekeeping keys a client may have echoed back', () => {
      assert.deepEqual(
        proposedMetaFields({ version: 3, updatedAt: 'x', previousVersions: [], purpose: 'p' }),
        ['purpose'],
      );
    });

    it('is empty for an empty patch', () => {
      assert.deepEqual(proposedMetaFields({}), []);
    });
  });
});
