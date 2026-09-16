/**
 * A record that arrives by sync is embedded by the RECEIVER, under the receiver's own rules — or not at all.
 *
 * ## The ruling
 *
 * Owner, 2026-09-01: *"dont transfer embeddings... It CAN break so it WILL break. on transfer the receiver
 * applies its rules. if the space has supressembeddings dont embed at all. if it should embed use the
 * receivers embedding mechanism. everything else makes no sense."*
 *
 * Two halves, and each is checkable:
 *
 * 1. **No vector crosses the wire.** Held by `sync-carries-suppressed-memories.test.js`, which asserts that no
 *    ingest schema declares `embedding` or `embeddingModel`. A vector is derived data computed by a particular
 *    model, and a network whose members run different models cannot rank one peer's vectors against its own.
 * 2. **Every arriving record is offered to the receiver's own embedder, and the receiver's own suppression
 *    decides.** That is this file.
 *
 * ## Why the second half needs a gate rather than a reading
 *
 * There are **thirteen** ingest write sites in `api/sync/docs.ts` — four single-document routes, four batch
 * loops, and the fork paths — because a document arrives four ways and each type has its own conflict rules.
 * Thirteen call sites for one rule is precisely how a rule comes to hold at twelve of them. A fourteenth added
 * without the enqueue would produce a record that is stored, listed, traversable, and absent from every
 * meaning-ranked search, with no error anywhere.
 *
 * So the check is structural: **no bare `replaceOne` on a brain collection**, anywhere in that file. The write
 * and the enqueue happen together in `ingestBrainDoc`, which is the only thing that may write one, and that is
 * what makes forgetting impossible rather than merely unlikely.
 *
 * ## The suppression half, and why the flag has to travel
 *
 * Suppression resolves `record > schema > space`. The space tier and the schema tier are the RECEIVER's, and
 * always were — they are read from the receiver's own configuration. The RECORD tier is a field on the
 * document, so it only reaches the receiver if the ingest schema declares it, and it did not.
 *
 * Left that way, the ruling would be half-implemented in the worst direction: an author marks one record
 * "never embed this", it syncs, and the receiver — finding no mark, because the mark was stripped — embeds it.
 * A record deliberately kept out of meaning-ranked search would enter one on every peer. That is not the
 * receiver applying its rules, it is the receiver being denied a fact it needs, so both spellings of the flag
 * now cross.
 *
 * Run: node --test testing/standalone/a-receiver-embeds-by-its-own-rules.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';
import { embeddableIncomingSchemas } from '../_shared/incoming-sync-schemas.mjs';

const DOCS = 'server/src/api/sync/docs.ts';
const QUEUE = 'server/src/brain/embed-queue.js';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/** The four types, and the collection each lands in. */
const TYPES = [
  ['fact', 'facts'],
  ['entity', 'entities'],
  ['edge', 'edges'],
  ['chrono', 'chrono'],
];

describe('nothing writes an arriving record without offering it to the embedder', () => {
  it('the ingest file is the one this gate thinks it is', () => {
    // Floors every assertion below: a moved file would read as an empty string and pass everything.
    const s = src(DOCS);
    assert.ok(s.includes('IncomingFactDoc'), `${DOCS} is not the sync ingest router any more — re-anchor`);
    assert.ok(s.length > 10_000, 'the ingest router is suspiciously small — re-anchor this gate');
  });

  it('the sweep finds the ingest writes, so it cannot pass by finding nothing', () => {
    /*
     * The floor, and it is here because its absence has already cost something. The rule used to be a COUNT:
     * every `.replaceOne(`/`.insertOne(` into a synced brain collection matched by an enqueue somewhere in the
     * file. Thirteen of each, and it worked — until the write was extracted into one helper, at which point
     * nought equalled nought and the check passed by looking at nothing.
     */
    const ingests = src(DOCS).split('\n').filter(l => /ingestBrainDoc[<(]/.test(l)).length;
    assert.ok(ingests >= 8, `the ingest router has ${ingests} ingest writes — re-anchor this gate`);
  });

  it('no raw write into a synced brain collection survives in the ingest router', () => {
    /*
     * The whole mechanism. Thirteen sites wrote the document and then queued it as a separate following
     * statement, which works for exactly as long as everyone writing the fourteenth remembers the second line.
     * One helper does both now, so a new site cannot be written wrong: there is no way to write the document
     * without queueing it.
     *
     * Scoped from the SHAPE of a write rather than a list of route names — a name list is how a sweep of the
     * merge rule once missed its twelfth copy.
     */
    const bare = src(DOCS).split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) =>
        /col<\w+>\(`\$\{spaceId\}_(memories|entities|edges|chrono)`\)\s*\.?\s*(replaceOne|insertOne)\(/.test(l));
    assert.deepEqual(bare.map(([n]) => n), [],
      'a raw write into a synced brain collection is back in the ingest router, at line(s) '
      + `${bare.map(([n]) => n).join(', ')}. Use ingestBrainDoc, which writes the document AND queues its `
      + 'embedding — a record written without the queue is stored, listed, traversable, and absent from every '
      + 'meaning-ranked search on that peer, with no error to find it by');
  });

  it('and all four record types reach it', () => {
    /*
     * Per type, because the four are written by four different code paths and "it is handled" has been true of
     * three out of four before now.
     *
     * Asserted on the whole call, built from the type name, rather than on a windowed search near the helper:
     * a window with a character count in it spans different amounts of code on CRLF than on CI's LF, and the
     * repo forbids them for that reason.
     */
    const s = src(DOCS);
    for (const [kind, collection] of TYPES) {
      assert.ok(s.includes(`ingestBrainDoc<`) && s.includes(`, '${kind}', '${collection}',`),
        `nothing queues an arriving ${kind} for embedding, so a synced ${collection} record ranks in no recall`);
    }
  });
});

describe('and the receiver decides whether to embed it', () => {
  const queue = src('server/src/brain/embed-queue.ts');

  it('the ingest enqueue consults the receiver own suppression resolution', () => {
    /*
     * `embeddingSuppressedFor` reads the record, then the type schema, then the space — the last two from the
     * receiver's own configuration. Consulting it here is what makes "the receiver applies its rules" true of
     * the arriving record rather than only of records written locally.
     *
     * Asserted on the CALL, not on the identifier appearing in the file: a mention in a comment is exactly
     * what a gate like this passes on if it is written lazily.
     */
    const body = bodyOf(queue, 'enqueueIngestedRecord');
    assert.ok(body.length > 40, 'enqueueIngestedRecord is gone or renamed — re-anchor this gate');
    assert.match(body, /embeddingSuppressedFor\(/,
      'the ingest enqueue does not ask whether the receiver wants this record embedded, so a record its '
      + 'author suppressed is queued anyway');
  });

  it('and it no longer trusts a vector that arrived with the record', () => {
    /*
     * It used to return early when the incoming document already had a vector — reasonable while memories
     * shipped theirs, and dead now. Worse than dead: it reads as a statement that a peer may send a usable
     * vector, which is the belief the ruling overturns.
     *
     * **The reason here used to be *"no ingest schema declares one"*, and that was true of ONE of the two
     * ingest paths.** This file's subject is the ingest ROUTER, so the pull path in `sync/engine.ts` — which
     * validates nothing and `replaceOne`s what it fetched — was outside everything it looked at, and stored
     * the sender's vector for as long as this assertion had been passing. A gate scoped to one mechanism
     * concludes about all of them. `a-local-only-field-is-dropped-on-both-ingest-paths.test.js` is the one
     * that spans both.
     */
    const body = bodyOf(queue, 'enqueueIngestedRecord');
    assert.doesNotMatch(body, /doc\.embedding|Array\.isArray\(vec\)/,
      'the ingest enqueue still skips records that arrived with a vector. No ingest schema can deliver one, '
      + 'so the branch is unreachable — and it documents the opposite of the rule');
  });
});

describe('the record tier of suppression reaches the receiver', () => {
  it('every ingest schema that can embed declares the flag — and only the current spelling', async () => {
    /*
     * A field missing from an `Incoming*` schema is STRIPPED on push, so a record whose author marked it
     * "never embed" arrives unmarked and the receiver embeds it — a record deliberately kept out of
     * meaning-ranked search entering one on every peer.
     *
     * This used to require BOTH spellings, because a pre-3.1.0 peer sends the one it knows. `D-6` removed
     * the old one in 4.0, and the peer floor is what made that safe: a 4.x build refuses every 3.x peer,
     * so no sender can be using the old name. The ABSENCE is asserted as well, because a stray
     * re-declaration would accept a field nothing reads — a push answered 200 for a mark that is then
     * never applied.
     *
     * ## This said "all four" and looped over four of six (`Q-5`)
     *
     * `CLAUDE.md` records the same failure being paid for once already: a gate's hand-written list of four
     * missed `LinkDoc`, "so every assertion ran over the old four and reported clean about a document
     * nobody had checked". This was the identical bug in a different file, and its title made the wider
     * claim while the loop did not.
     *
     * The one it skipped that MATTERS is `IncomingFileMetaDoc`. A file has no `type`, so it has two
     * suppression tiers rather than three — its own record flag or the space setting, nothing in between —
     * which makes the record flag the only per-file switch there is. It declares the flag today, so
     * widening this changed nothing; what changed is that losing it would now be caught.
     */
    const shared = await import('../../server/dist/api/sync/_shared.js');
    for (const [name, schema] of embeddableIncomingSchemas(shared)) {
      const shape = schema.shape ?? {};
      assert.ok(Object.keys(shape).length > 5, `${name} not found — re-anchor this gate`);
      assert.ok(Object.prototype.hasOwnProperty.call(shape, 'suppressEmbeddings'),
        `${name} does not declare 'suppressEmbeddings', so it is stripped on push and the receiver embeds `
        + 'a record its author marked never-embed');
      assert.ok(!Object.prototype.hasOwnProperty.call(shape, 'excludeFromVectorSearch'),
        `${name} still declares the pre-3.1.0 spelling, removed in 4.0 — it would be accepted and never read`);
    }
  });

  it('and the schema that is EXEMPT is exempt for a reason, not by omission', async () => {
    /*
     * The exclusion is the half a hand-written list cannot express. `IncomingLinkDoc` legitimately has no
     * suppression flag — a link is a pair of ids and a label, so there is nothing to embed, and
     * `ingestBrainDoc` is told so out loud: links pass `null` as the record type, which means "this kind
     * has nothing to embed". A missing embed job on an arriving link is correct rather than a bug.
     *
     * Asserted rather than assumed, because the day a link gains embeddable text the exemption becomes the
     * defect above, and nothing else would say so.
     */
    const shared = await import('../../server/dist/api/sync/_shared.js');
    const shape = shared.IncomingLinkDoc?.shape ?? {};
    assert.ok(Object.keys(shape).length > 3, 'IncomingLinkDoc not found — re-anchor this gate');
    assert.ok(!Object.prototype.hasOwnProperty.call(shape, 'suppressEmbeddings'),
      'IncomingLinkDoc declares a suppression flag. Either a link now carries text worth embedding — in '
      + 'which case it belongs in the loop above and `ingestBrainDoc` must stop passing `null` for it — or '
      + 'the field is a switch for something that never happens.');
  });

  it('and the flag is optional, because absent means included', async () => {
    // Requiring it is the mistake this whole family of bugs is made of: `IncomingFactDoc` once required
    // `embedding`, and every suppressed memory was silently dropped from the batch for it.
    const shared = await import('../../server/dist/api/sync/_shared.js');
    const ok = shared.IncomingFactDoc.safeParse({
      _id: '11111111-1111-4111-8111-111111111111',
      spaceId: 'demo',
      fact: 'no flag at all',
      tags: [],
      entityIds: [],
      author: { instanceId: 'i', instanceLabel: 'L' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      seq: 1,
    });
    assert.ok(ok.success, `a record with no suppression flag must parse. Issues: ${JSON.stringify(ok.error?.issues ?? [])}`);
    assert.equal(ok.data.suppressEmbeddings, undefined, 'a default was invented for a field that means "not stated"');
  });

  it('a stated flag survives the parse', async () => {
    // The half that matters: declaring it is pointless if the value does not arrive.
    const shared = await import('../../server/dist/api/sync/_shared.js');
    const r = shared.IncomingEntityDoc.safeParse({
      _id: '22222222-2222-4222-8222-222222222222',
      spaceId: 'demo',
      name: 'Pepper',
      type: 'animal',
      tags: [],
      author: { instanceId: 'i', instanceLabel: 'L' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      seq: 1,
      suppressEmbeddings: true,
    });
    assert.ok(r.success, `Issues: ${JSON.stringify(r.error?.issues ?? [])}`);
    assert.equal(r.data.suppressEmbeddings, true, 'the flag was stripped, so the receiver cannot honour it');
  });
});
