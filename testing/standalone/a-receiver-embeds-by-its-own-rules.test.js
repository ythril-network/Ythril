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
 * So the check is structural: **no raw write into a record collection** in any of the three files that store
 * what arrived — the push router, the pull engine (`sync/engine.ts`) and the importer (`api/admin-import.ts`).
 * The write and the enqueue happen together in `writeArrivals` (`sync/arrivals.ts`, `Q-107` part 1), which is
 * the only thing that may write one, and that is what makes forgetting impossible rather than merely unlikely.
 * That the doors REACH no other writer is `an-arrival-is-written-by-one-writer.test.js`; this file holds the
 * embedding half.
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
import { stripComments, blankComments } from './_strip-comments.mjs';
import { argumentsOf, bodyOf } from './_structural-window.mjs';
import { moduleIndex } from './_call-graph.mjs';
import { recordWrites } from './_record-writes.mjs';
import { suppressionResolvers, resolverCallPattern } from './_suppression-resolvers.mjs';
import { embeddableIncomingSchemas } from '../_shared/incoming-sync-schemas.mjs';

const { BRAIN_COLLECTIONS, KNOWLEDGE_TYPES, COLLECTION_SUFFIX } = await import('../../server/dist/config/types-knowledge.js');

const DOCS = 'server/src/api/sync/docs.ts';
/** The three files that store what arrived from elsewhere: the push router, the pull engine, the importer. */
const INGEST_FILES = [DOCS, 'server/src/sync/engine.ts', 'server/src/api/admin-import.ts'];
const QUEUE_FILE = 'server/src/brain/embed-queue.ts';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const INDEX = moduleIndex('server/src');
const RECORDS = recordWrites(INDEX, { collections: BRAIN_COLLECTIONS, floors: { space: 150 }, recordFloor: 50 });

/** Every `writeArrivals(` call in the ingest files, with its arguments; comments blanked so a line is the real line. */
const WRITER_CALLS = INGEST_FILES.flatMap((file) => {
  const code = blankComments(readFileSync(file, 'utf8'));
  const out = [];
  for (const m of code.matchAll(/(?<![\w.$])writeArrivals\s*(?:<[^>(]*>)?\s*\(/g)) {
    const before = code.slice(code.lastIndexOf('\n', m.index) + 1, m.index);
    if (/\bfunction\s*$/.test(before)) continue;
    const paren = m.index + m[0].length - 1;
    out.push({ file, line: code.slice(0, m.index).split('\n').length, args: argumentsOf(code, paren, `${file}: writeArrivals(`) });
  }
  return out;
});

/**
 * The enqueue functions an ARRIVAL goes through — every exported `enqueueIngested…` of the embed queue, derived.
 * Since `Q-107` part 1 there are two: the single record (`enqueueIngestedRecord`, file metadata's) and the
 * batched twin the arrival writer queues a landed chunk with (`enqueueIngestedRecords`). A rule asserted of one
 * of them by name is a rule the other is free to break.
 */
const QUEUE_CODE = src(QUEUE_FILE);
const INGEST_ENQUEUES = [...QUEUE_CODE.matchAll(/^export\s+async\s+function\s+(enqueueIngested\w*)\s*[<(]/gm)].map(m => m[1]);
/** The enqueue doors that never throw into their caller: an exported `enqueue…EmbedJob(s)` whose body catches. */
const ENQUEUE_DOORS = [...QUEUE_CODE.matchAll(/^export\s+async\s+function\s+(enqueue\w*EmbedJobs?)\s*\(/gm)].map(m => m[1]);
const SWALLOWING_DOORS = ENQUEUE_DOORS.filter(d => /\bcatch\b/.test(bodyOf(QUEUE_CODE, d)));

describe('nothing writes an arriving record without offering it to the embedder', () => {
  it('the ingest files are the ones this gate thinks they are', () => {
    // Floors every assertion below: a moved file would read as an empty string and pass everything.
    const s = src(DOCS);
    assert.ok(s.includes('IncomingFactDoc'), `${DOCS} is not the sync ingest router any more — re-anchor`);
    assert.ok(s.length > 10_000, 'the ingest router is suspiciously small — re-anchor this gate');
    for (const f of INGEST_FILES) assert.ok(INDEX.files.includes(f), `${f} is gone — re-anchor this gate`);
  });

  it('the sweep finds the arrival writes, so it cannot pass by finding nothing', () => {
    /*
     * The floor, and it is here because its absence has already cost something. The rule used to be a COUNT:
     * every `.replaceOne(`/`.insertOne(` into a synced brain collection matched by an enqueue somewhere in the
     * file. Thirteen of each, and it worked — until the write was extracted into one helper, at which point
     * nought equalled nought and the check passed by looking at nothing.
     *
     * Now per FILE: each of the three ingest files — the push router, the pull engine, the importer — stores
     * what it was handed through the one arrival writer (`Q-107` part 1). A file with none is a door that
     * either stopped storing records or stores them some other way, and the next case cannot tell which.
     */
    for (const f of INGEST_FILES) {
      const n = WRITER_CALLS.filter(c => c.file === f).length;
      assert.ok(n >= 1, `${f} makes no writeArrivals call — it stores arriving records some other way, or this gate is stale`);
    }
  });

  it('no raw write into a record collection survives in the ingest files', () => {
    /*
     * The whole mechanism. Thirteen sites wrote the document and then queued it as a separate following
     * statement, which works for exactly as long as everyone writing the fourteenth remembers the second line.
     * One writer does both now, so a new site cannot be written wrong: there is no way to write the document
     * without queueing it.
     *
     * Scoped from the SHAPE of a write, through `_record-writes.mjs` — the scanner the other write gates use,
     * which resolves an alias, a helper and a computed collection name back to what they open. It replaced a
     * one-line regex over `docs.ts` that named `memories` two releases after the collection became `facts`: it
     * was looking for a spelling nothing wrote any more, and passed. And it covered one of the three ingest
     * files; the pull engine's `bulkWrite` was outside it for as long as it existed.
     */
    const files = new Set(INGEST_FILES);
    const raw = [...RECORDS.sites, ...RECORDS.orphans]
      .filter(s => files.has(s.file))
      .map(s => `${s.file}:${s.line} ${s.op} (${s.collection ?? s.why})`);
    assert.deepEqual([...new Set(raw)], [],
      'a raw write into a record collection is in an ingest file. Use writeArrivals, which writes the document AND '
      + 'queues its embedding — a record written without the queue is stored, listed, traversable, and absent from '
      + 'every meaning-ranked search on that peer, with no error to find it by');
  });

  it('and every record type reaches it, named at the call — null only for links', async () => {
    /*
     * Per type, because the types are written by different code paths and "it is handled" has been true of
     * three out of four before now. The types are `KNOWLEDGE_TYPES`, derived; the record-type argument is the
     * third, read structurally from the call rather than by a windowed search.
     *
     * `null` means "this kind has nothing to embed", and only a link may say it: a link is a pair of ids and a
     * label. A `null` on any other family is a record kind silently excluded from recall on every receiver.
     */
    /*
     * Re-anchored for the duplicated-rule pass of `Q-107` part 1: every door now passes the record type out of the
     * ONE derived table, `RECORD_TYPE_OF[<the family's collection>]`, rather than a literal per family — so "named
     * at the call" means the call reads the family's own row, keyed by the same expression it passes as the family,
     * and the table is checked here to name each knowledge type and to hold `null` for links alone. A literal is
     * still allowed; a record type that is neither a literal nor the family's own row is the defect. Seen red by
     * mutation, restored by hand: `RECORD_TYPE_OF[collection]` passed as `null` in the push door.
     */
    const short = WRITER_CALLS.filter(c => c.args.length < 4).map(c => `${c.file}:${c.line}`);
    assert.deepEqual(short, [], 'a writeArrivals call omits the record type — it is an explicit argument, null for links');
    const own = (c) => c.args[2] === `RECORD_TYPE_OF[${c.args[1]}]`;
    const literal = (a) => /^'(\w+)'$/.exec(a ?? '')?.[1] ?? null;
    const loose = WRITER_CALLS.filter(c => !own(c) && literal(c.args[2]) === null && c.args[2] !== 'null')
      .map(c => `${c.file}:${c.line} (${c.args[1]} -> ${c.args[2]})`);
    assert.deepEqual(loose, [], 'a writeArrivals call passes a record type that is not the family\'s own row of '
      + 'RECORD_TYPE_OF, nor a literal — a family could be stored under another kind\'s embed rules');
    const nulls = WRITER_CALLS.filter(c => c.args[2] === 'null' && !/\blinks\b/.test(c.args[1] ?? ''))
      .map(c => `${c.file}:${c.line} (${c.args[1]})`);
    assert.deepEqual(nulls, [], 'a writeArrivals call passes null as the record type for a family that is not links');

    const { RECORD_TYPE_OF } = await import('../../server/dist/sync/replicated-families.js');
    for (const kind of KNOWLEDGE_TYPES) {
      assert.equal(RECORD_TYPE_OF[COLLECTION_SUFFIX[kind]], kind,
        `RECORD_TYPE_OF does not name '${kind}' for ${COLLECTION_SUFFIX[kind]}, so a synced record of it is not queued by its kind`);
    }
    const nullRows = Object.entries(RECORD_TYPE_OF).filter(([, t]) => t === null).map(([c]) => c);
    assert.deepEqual(nullRows, ['links'], 'RECORD_TYPE_OF holds null for a family that is not links');
    assert.ok(WRITER_CALLS.some(own), 'no writeArrivals call reads the family\'s row of RECORD_TYPE_OF — re-anchor');
  });
});

describe('and the receiver decides whether to embed it', () => {
  it('the ingest enqueues were found — the single record and its batched twin (floor)', () => {
    for (const name of ['enqueueIngestedRecord', 'enqueueIngestedRecords']) {
      assert.ok(INGEST_ENQUEUES.includes(name),
        `${QUEUE_FILE} exports no ${name} — ${name === 'enqueueIngestedRecords'
          ? 'the arrival writer has no batched enqueue to queue a landed chunk with'
          : 're-anchor this gate'}`);
    }
    assert.ok(SWALLOWING_DOORS.length >= 1, `no enqueue door of ${QUEUE_FILE} catches — the derivation is broken`);
  });

  it('every ingest enqueue consults the receiver\'s own suppression resolution', () => {
    /*
     * `embeddingSuppressedFor` reads the record, then the type schema, then the space — the last two from the
     * receiver's own configuration. Consulting it here is what makes "the receiver applies its rules" true of
     * the arriving record rather than only of records written locally.
     *
     * Asserted on the CALL, not on the identifier appearing in the file: a mention in a comment is exactly
     * what a gate like this passes on if it is written lazily. And on a resolver DERIVED from
     * `_suppression-resolvers.mjs`, so a batched twin that resolves the space once and asks a wrapper per
     * record counts, and one that asks nothing does not.
     */
    const resolvers = suppressionResolvers();
    for (const name of INGEST_ENQUEUES) {
      const body = bodyOf(QUEUE_CODE, name).replace(/^[^\n]*\n/, '');
      assert.ok(body.length > 40, `${name} is empty — re-anchor this gate`);
      assert.match(body, resolverCallPattern(resolvers),
        `${name} does not ask whether the receiver wants these records embedded, so a record its author `
        + 'suppressed — or one in a space or type this instance suppresses — is queued anyway');
    }
  });

  it('and no ingest enqueue throws into the write it announces', () => {
    /*
     * The records are stored by the time they are queued. An enqueue that throws turns a delayed search hit
     * into a failed push — a 500 the sender retries for ever, over records this instance already holds. So
     * each ingest enqueue either catches itself or queues only through a door that does (`enqueueEmbedJob`,
     * `enqueueWriteEmbedJobs`); `enqueueEmbedJobs` THROWS by design (a sweep must not report work it did not
     * queue), and a bare call of it here is the defect.
     */
    for (const name of INGEST_ENQUEUES) {
      const body = bodyOf(QUEUE_CODE, name).replace(/^[^\n]*\n/, '');
      if (/\btry\s*\{[\s\S]*\bcatch\b/.test(body)) continue;
      const called = ENQUEUE_DOORS.filter(d => new RegExp(`(?<![\\w.$])${d}\\s*\\(`).test(body));
      assert.ok(called.length >= 1, `${name} queues through no enqueue door — re-anchor this gate`);
      const throwing = called.filter(d => !SWALLOWING_DOORS.includes(d));
      assert.deepEqual(throwing, [],
        `${name} queues through ${throwing.join(', ')}, which throws, outside any try — a failed enqueue fails the arrival`);
    }
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
    for (const name of INGEST_ENQUEUES) {
      const body = bodyOf(QUEUE_CODE, name);
      assert.doesNotMatch(body, /\.embedding\b|Array\.isArray\(vec\)/,
        `${name} still skips records that arrived with a vector. No ingest schema can deliver one, `
        + 'so the branch is unreachable — and it documents the opposite of the rule');
    }
  });
});

describe('a merged file is queued in one place', () => {
  it('ingestFileMeta queues a file, and the arrival writer never queues one beside it', () => {
    /*
     * Dup pass: a restored file was queued twice — by `ingestFileMeta` when its blob was here, and by the writer
     * for every restore. Idempotent at the jobs collection, so nothing failed; two owners of one decision is the
     * shape that drifts. Seen red by mutation, restored by hand: the writer's `family === 'files'` exclusion
     * narrowed back to `!restore`.
     */
    const shared = src('server/src/api/sync/_shared.ts');
    assert.match(bodyOf(shared, 'ingestFileMeta'), /if \(haveBytes \|\| restore\) await enqueueIngestedRecord\(spaceId, 'file', incoming\);/,
      'ingestFileMeta no longer decides when a merged file is queued');
    const writer = bodyOf(src('server/src/sync/arrivals.ts'), 'writeArrivals');
    assert.match(writer, /if \(recordType === null \|\| queued\.length === 0 \|\| family === 'files'\) return;/,
      'the arrival writer queues file metadata itself, beside ingestFileMeta');
    assert.match(writer, /ingestFileMeta\([^;]*\{ restore \}\)/, 'the writer does not tell ingestFileMeta it is a restore');
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
      // That no schema still declares the pre-3.1.0 spelling is asserted in
      // `the-legacy-suppression-spelling-is-gone.test.js`, the one home of that rule (`Q-45.4`).
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
