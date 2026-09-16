/**
 * A record replicated from a peer gets a vector on THIS instance.
 *
 * ## The bug
 *
 * `embedding` is a derived field, deliberately excluded from replication (`merkle.ts` `DERIVED_FIELDS`)
 * because two peers may run different models. Sync ingest is a plain `replaceOne` of the incoming
 * document. Put those together and a record arriving from a peer had **no vector on the receiving
 * instance, and nothing ever gave it one**.
 *
 * A vectorless record is invisible to recall — the vector search never returns it, and the lexical channel
 * needs an embedding to compute a real similarity and skips what it cannot score. So an instance could
 * hold a peer's entire knowledge base and answer nothing from it, silently, until an operator happened to
 * run a manual whole-space `POST /reindex`. Nothing measured it and nothing reported it.
 *
 * ## What this pins
 *
 * The decision, not the route. `enqueueIngestedRecord` is what every ingest write site reaches, so this tests
 * the thing all of them share: an arrival is queued, the job names the right record, and a record the
 * RECEIVER does not want embedded is not queued at all.
 *
 * ## 3.7 changed what the decision is
 *
 * Owner's ruling, 2026-09-01: *"dont transfer embeddings... It CAN break so it WILL break. on transfer the
 * receiver applies its rules. if the space has supressembeddings dont embed at all. if it should embed use the
 * receivers embedding mechanism."*
 *
 * Two consequences, and each replaced a case in this file:
 *
 * - **The arriving vector is no longer consulted.** It used to return early when the incoming document had
 *   one, so a peer that sent a vector did not have it thrown away. No ingest schema declares `embedding` any
 *   more — memories were the last — so a vector cannot arrive at all, and a branch reading it would be both
 *   unreachable and a statement of the belief the ruling overturns.
 * - **The receiver's own suppression decides.** `embeddingSuppressedFor` resolves `record > schema > space`,
 *   the last two from THIS instance's configuration. Asked here rather than only in the embed worker, because
 *   otherwise every suppressed record is queued, claimed and discarded on every sync — and a queue full of
 *   work that exists to be thrown away is how a real backlog becomes invisible.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/sync-ingest-embeds-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-sync-embed-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, queue;
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);

describe('a synced-in record is queued for embedding', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('syncembed');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await jobs().deleteMany({}); });

  it('an arrival with no vector is queued', async () => {
    await queue.enqueueIngestedRecord(SPACE, 'fact', { _id: 'm-1' });
    const job = await jobs().findOne({ _id: 'fact:m-1' });
    assert.ok(job, 'the peer stripped the embedding, so this instance must compute one');
    assert.equal(job.status, 'pending');
    assert.equal(job.recordType, 'fact');
    assert.equal(job.recordId, 'm-1');
  });

  it('an arrival that carries a vector is queued ANYWAY', async () => {
    /*
     * The inversion the ruling makes. A peer on an older build still sends one; the ingest schema strips it,
     * so the stored record has no vector — and skipping the queue on the strength of a field that was
     * discarded would leave the record permanently unsearchable here.
     *
     * The deeper reason is not the strip: a vector computed by another instance's model cannot be ranked
     * against this instance's own, and a mixed-model search produces plausible nonsense rather than an error.
     */
    await queue.enqueueIngestedRecord(SPACE, 'entity', { _id: 'e-1', embedding: [0.1, 0.2, 0.3] });
    assert.ok(await jobs().findOne({ _id: 'entity:e-1' }),
      'the arriving vector was trusted. It was computed by the sending peer with ITS model, and the ingest '
      + 'schema stripped it in any case, so the stored record has no vector at all');
  });

  it('a record its author marked "never embed" is NOT queued', async () => {
    /*
     * The record tier of the receiver's resolution, and the reason the mark now crosses the wire: stripped, it
     * would arrive absent, and a record deliberately kept out of meaning-ranked search would enter one on
     * every peer.
     *
     * Exercised against a real queue rather than read off the source, because "the code consults the resolver"
     * is a decision being MADE, not a decision coming out right.
     */
    await queue.enqueueIngestedRecord(SPACE, 'edge', { _id: 'g-1', suppressEmbeddings: true });
    assert.equal(await jobs().countDocuments({}), 0,
      'a suppressed record was queued. The job would be claimed and discarded on every sync of that record, '
      + 'and a queue full of work that exists to be thrown away hides a real backlog');
  });

  it('and the pre-3.1 spelling is NOT honoured — it is an ordinary field now', async () => {
    /*
     * Inverted by `D-6`. This asserted that a peer on an older build sending `excludeFromVectorSearch`
     * was still suppressed, so the outcome did not depend on the sender's version. The peer floor makes
     * that sender impossible on a 4.x network — it refuses every 3.x peer — and the ingest schemas no
     * longer declare the field, so it is stripped on push before this path ever sees it.
     *
     * Kept and inverted rather than deleted: a leftover read of the retired key would suppress a record
     * on a stale field nobody set, which is the same class of silent wrongness the original guarded
     * against, pointing the other way.
     */
    await queue.enqueueIngestedRecord(SPACE, 'chrono', { _id: 'c-1', excludeFromVectorSearch: true });
    assert.ok(await jobs().findOne({ _id: 'chrono:c-1' }),
      'the retired spelling still suppresses on ingest, so a stale field silently skips embedding');
  });

  it('but `false` is "not stated" and still queues', async () => {
    // The tier resolution treats `false` as absent so it falls through to the schema and the space rather than
    // overriding them. That is stated in the field's own docblock, so it is worth one case.
    await queue.enqueueIngestedRecord(SPACE, 'fact', { _id: 'm-2', suppressEmbeddings: false });
    assert.ok(await jobs().findOne({ _id: 'fact:m-2' }), '`false` was read as a suppression');
  });

  /*
   * The structural half of this rule — that `ingestBrainDoc` is the ONLY thing which may write an arriving
   * brain document — lives in `a-receiver-embeds-by-its-own-rules.test.js` instead, because it needs no
   * database and this suite self-skips without one. A rule that can only be checked where Mongo happens to be
   * running is a rule that goes unchecked on the machine where it is broken.
   */
});
