/**
 * A memory with no vector must survive the push door. Today it does not, and it is never offered again.
 *
 * ## The mismatch
 *
 * `FactDoc.embedding` is **optional** — `config/types.ts:1350`, optional since the embedding queue landed —
 * and `embedStoredRecord` `$unset`s both `embedding` and `embeddingModel` for any record whose type or space
 * suppresses embeddings (`brain/embed-record.ts:166-170`). `IncomingFactDoc` declares both **required**
 * (`api/sync/_shared.ts:142,152`).
 *
 * So the sender puts a perfectly valid stored document on the wire and the receiver's `safeParse` rejects it.
 * The rejection is a `flatMap` returning `[]` (`api/sync/docs.ts:528-529`): the document is removed from the
 * batch, counted in no statistic, logged nowhere, and the receiver answers **200**. The sender then advances
 * its watermark, and `embedStoredRecord` deliberately does not bump `seq` — so the record is never offered
 * again. **Permanent, silent, one-directional loss.**
 *
 * ## Why memories and nothing else
 *
 * `IncomingEntityDoc`, `IncomingEdgeDoc` and `IncomingChronoDoc` do not declare `embedding` at all. Zod strips
 * unlisted keys, so their vector is simply discarded and the document survives. Memories are the only record
 * type that requires the field, which is why they are the only type that vanishes.
 *
 * ## 3.7: no record type carries a vector at all
 *
 * Owner's ruling, 2026-09-01: *"dont transfer embeddings… It CAN break so it WILL break. on transfer the
 * receiver applies its rules. if the space has supressembeddings dont embed at all. if it should embed use the
 * receivers embedding mechanism."*
 *
 * So memories stopped declaring `embedding` and `embeddingModel`, which makes all four types alike: a vector
 * never crosses the wire, and the receiver computes its own with its own model. That closes the case this file
 * was written for by removing the field rather than by relaxing it — a memory with no vector now parses because
 * there is nothing to parse.
 *
 * The assertions below are kept, not deleted, and this is why: the failure they pin is a REQUIRED field on the
 * ingest schema, and the shape of a stored suppressed memory has not changed. If either field is ever
 * reintroduced, these three cases are what notice before a peer starts losing records again.
 *
 * ## Why this is a schema test rather than a two-instance one
 *
 * The loss is entirely decided by one `safeParse`, and the document that triggers it is exactly what
 * `embedStoredRecord` leaves behind. Driving two live peers to reproduce it would add a fixture larger than the
 * defect and would not pin the thing that is actually wrong, which is that the two declarations of one document
 * disagree about a field.
 *
 * The companion rule — that a dropped record is never silent — is `sync-dropped-record-is-not-silent.test.js`.
 * That gate pins the fork-depth drop. This is the same principle on the path it does not reach.
 *
 * Run: node --test testing/standalone/sync-carries-suppressed-memories.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { incomingSchemas } from '../_shared/incoming-sync-schemas.mjs';

const { IncomingFactDoc } = await import('../../server/dist/api/sync/_shared.js');

/** A stored memory as `embedStoredRecord` leaves it once suppression has unset the vector fields. */
function suppressedMemory(overrides = {}) {
  return {
    _id: '11111111-1111-4111-8111-111111111111',
    spaceId: 'demo',
    fact: 'Ada adopted a beagle called Pepper.',
    tags: [],
    entityIds: [],
    author: { instanceId: 'inst-1', instanceLabel: 'Peer A' },
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    seq: 7,
    ...overrides,
  };
}

describe('a memory with no vector survives the push door', () => {
  it('accepts a suppressed memory — no embedding, no embeddingModel', () => {
    const r = IncomingFactDoc.safeParse(suppressedMemory());
    assert.ok(
      r.success,
      'a suppressed memory is a valid stored document and must replicate. Rejecting it here removes it from '
      + 'the batch with no counter and no log, the receiver still answers 200, and the sender never offers it '
      + `again. Issues: ${JSON.stringify(r.error?.issues ?? [])}`,
    );
  });

  it('accepts a memory whose embed job has not run yet', () => {
    // Same shape: the queue writes the vector later, and `seq` is not bumped when it does.
    const r = IncomingFactDoc.safeParse(suppressedMemory({ description: 'pending its first embed' }));
    assert.ok(r.success, `a not-yet-embedded memory must replicate. Issues: ${JSON.stringify(r.error?.issues ?? [])}`);
  });

  it('accepts a memory that arrives WITH a vector, and drops the vector', () => {
    /*
     * A peer on an older build still sends one. It must not be a reason to reject the document — that is the
     * whole defect this file exists for, arriving from the other direction — and it must not be STORED either,
     * because it was computed by the sender's model. Zod strips what it does not declare, which gives both at
     * once: the record lands, the vector does not, and the receiver queues its own.
     */
    const r = IncomingFactDoc.safeParse(suppressedMemory({
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'nomic-embed-text-v1.5',
    }));
    assert.ok(r.success, `a memory from an older peer must still parse. Issues: ${JSON.stringify(r.error?.issues ?? [])}`);
    assert.equal(r.data.embedding, undefined,
      'a vector from the sending peer was stored. It was computed by that peer with ITS model, so the receiver '
      + 'would be ranking one record against vectors from two different models — owner ruling, 2026-09-01');
    assert.equal(r.data.embeddingModel, undefined, 'the sending model name was stored beside no vector');
  });

  it('NO incoming schema declares a vector — every one of them alike', async () => {
    // set-claim: the vector and its model name, which are set and unset together -- either one alone is a
    // lie about the other, as the comment below says. A pair, not a set.
    /*
     * Widened from three to four by the ruling. It was three because memories were the exception, and the
     * exception was the bug: a vector that crosses the wire is derived data computed by somebody else's model,
     * and a mixed-model network cannot rank it against its own.
     *
     * Both fields, because they are set and unset together and either one alone is a lie about the other.
     *
     * ## And then widened from four to ALL of them, which is not the same kind of change (`Q-5`)
     *
     * This case was titled "NO incoming schema" and looped over a hard-coded four. Six exist. The title was
     * the claim a reader took away and the loop was two thirds of it — so `IncomingFileMetaDoc` could have
     * gained a vector field with this gate green, and file metadata is the one collection whose ingest
     * MERGES rather than replaces, which is exactly where a foreign vector would be hardest to notice.
     *
     * The list is now read out of the module. Not corrected to six — DERIVED — because a corrected list is
     * the same defect with a later expiry date, and `CLAUDE.md` says so in as many words about this very
     * family of schemas: "Never count them here — the file is the list."
     *
     * The link schema is included here and not excluded as it is in the suppression gate: having nothing to
     * embed is a reason to carry no FLAG, and it is an even better reason to carry no VECTOR.
     */
    const shared = await import('../../server/dist/api/sync/_shared.js');
    for (const [name, schema] of incomingSchemas(shared)) {
      const shape = schema.shape ?? {};
      assert.ok(Object.keys(shape).length > 3, `${name} not found — re-anchor this gate`);
      for (const field of ['embedding', 'embeddingModel']) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(shape, field), false,
          `${name} declares '${field}'. Zod strips unlisted keys, so leaving it out is BOTH what lets a `
          + 'suppressed record replicate and what stops a vector from a foreign model being stored.',
        );
      }
    }
  });
});
