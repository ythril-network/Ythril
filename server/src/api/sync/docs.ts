/**
 * Peer document sync — the five record families plus batch-upsert.
 *
 * Split out of the api/sync.ts monolith (A17.6). The two READS are now one function each rather than four
 * copies apiece: see `pageBySeq` for what a page is and which tombstones ride in it, and why `M-2`'s fifth
 * family is what forced the extraction.
 */
import { Router, type Request, type Response } from 'express';
import { col, asFilter } from '../../db/mongo.js';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getAllowedChronoTypes } from '../../spaces/schema-validation.js';
import { getConfig } from '../../config/loader.js';
import { listTombstones } from '../../brain/tombstones.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { log, logSafe } from '../../util/log.js';
import { reportServerFailure } from '../../util/report-failure.js';
import { withSeq, bumpSeq, seqRefusal, MAX_INGEST_SEQ } from '../../util/seq.js';
import { readAfterSeq, encodeSeqCursor } from '../../util/seq-keyset.js';
import type { FactDoc, EntityDoc, EdgeDoc, ChronoEntry, LinkDoc, TombstoneDoc, BrainCollection } from '../../config/types.js';
import type { FileMetaDoc } from '../../config/types.js';
import { LOCAL_ONLY_EXCLUSION } from '../../sync/local-only-fields.js';
import { parseLimit } from '../../util/pagination.js';
import { checkEdgeLinkViolations, checkLinkViolations, MAX_FORK_DEPTH, syncReadStart, BAD_SYNC_START, forkChainDepth, rejectImplausibleSeq, callerPeerId, spaceAllowed, isNonPeerSyncWrite, NON_PEER_WRITE_MESSAGE, isDirectionalWriteBlocked, violationsAgainstLocalSchema, withSchemaViolations } from './_shared.js';
import { spaceCollection } from '../../db/space-collection.js';
import { writeArrivals, type ArrivalOutcome, type ArrivalOptions } from '../../sync/arrivals.js';
import { RECORD_TYPE_OF, familyOf, type PayloadKey } from '../../sync/replicated-families.js';
import { forkIdFor, isNewerCopy, tombstoneGoverns, divergesFrom } from '../../sync/upsert-plan.js';
import { parseIncoming } from '../../sync/arrival-shape.js';

export const syncDocsRouter = Router();

/**
 * ONE paging read for every record family. It was written FOUR times, and `M-2` needed a fifth.
 *
 * The four list routes were identical apart from three names — the collection suffix, the document type, and
 * the tombstone `type` string — and this is the sync CONTRACT: what a page is, where the cursor comes from,
 * which tombstones ride along with it. A copy that drifts makes replication depend on which record family a
 * peer happened to ask for, which is the defect class `CLAUDE.md` names as this repo's most expensive.
 *
 * ## The rule, now that it is in one place to read
 *
 * A page is everything AFTER the start position, ordered `(seq, _id)`, capped at 500, with ONE extra row fetched so
 * `nextCursor` can be decided without a second query. The start is the `cursor` a previous page handed back — a
 * PAIR, `(seq, _id)`, so a page that ended inside a run of records sharing a seq (several authors' records keep their
 * author's seq) continues that run instead of skipping it — or `sinceSeq`, a bare seq. The cursor wins: a 5.6 client
 * sends its `sinceSeq` constant beside the cursor it echoes. It is opaque to a caller (`util/seq-keyset.ts`).
 *
 * Tombstones for the same family ride in the same page, as long as the page carries whole documents. Three filters,
 * and each removes a specific way for a deletion to be delivered twice or too early:
 *
 *   - `seq <= pageMaxSeq` — a tombstone with a high seq would otherwise appear on this page AND the next
 *     one, because the cursor only advances to the last ITEM's seq. That was a real duplicate bug.
 *   - not already in `items` — the record is the newer fact, so the deletion is stale within the page.
 *   - `originalSeq > since` — the peer never had the record, so there is nothing to tell it to delete.
 *
 * The riders stay NUMERIC (`seq > since`) beside the pair cursor, and a rider at a seq the page has reached is served
 * once, on the page that reaches it. A listing (`full=false`, ids and seqs) carries none: it pays no tombstone read.
 *
 * `full=true` returns whole documents in one pass; without it a page is ids and seqs only. The pull engine
 * always asks for `full`, because the alternative is N per-document fetches over a WAN.
 */
/**
 * @param tombstoneType the brain tombstone type that rides in this page, or `null` for a collection whose
 *   deletions travel on their own route. A file is the one: a deleted file has a `FileTombstoneDoc` and
 *   `/api/sync/file-tombstones` carries it, which is why `TOMBSTONE_TYPES` has no `file` member. Passing a
 *   type that matches nothing would have been the quiet alternative and it is a lie: it says deletions ride
 *   here and then carries none.
 * The family's own filter (`pushFilter`) narrows what the page serves at all. Files use it to serve PARENTS
 * only — a chunk is derived from the blob and the receiver makes its own, with its own chunker and model.
 * It comes from the family row rather than a parameter, so the page, the read by id and the push cannot
 * each be handed a different one.
 */
function pageBySeq<T extends { _id: string; seq: number }>(key: PayloadKey, tombstoneType: string | null) {
  const { collection, pushFilter: extraFilter = {} } = familyOf(key);
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { spaceId, networkId, sinceSeq, limit, cursor, full: fullParam } = req.query as Record<string, unknown>;
      if (typeof spaceId !== 'string' || !spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (!spaceAllowed(spaceId, networkId as string | undefined, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

      const sinceVal = syncReadStart(sinceSeq, cursor);
      if (sinceVal === undefined) { res.status(400).json({ error: BAD_SYNC_START }); return; }
      const pageSize = parseLimit(limit, 100, 500);
      const returnFull = fullParam === 'true';

      /*
       * Settled seqs only, and ties in `_id` order (`readAfterSeq`): a page that hands out a seq above an unsettled
       * one moves the peer past it (Q-196), and one that ends inside a run of equal seqs must be able to go on.
       *
       * The local-only fields never leave, which is the SAVING rather than the guarantee — a vector is
       * several hundred floats per record and was the bulk of every page. The guarantee is the receiver's
       * arrival writer (`sync/arrivals.ts`), because a peer decides what it sends and we decide what we store.
       */
      const rawDocs = await readAfterSeq<T>(spaceId, collection, sinceVal, {
        limit: pageSize + 1,
        extra: extraFilter,
        projection: returnFull ? LOCAL_ONLY_EXCLUSION : { _id: 1, seq: 1 },
      });

      const hasMore = rawDocs.length > pageSize;
      const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeSeqCursor({ seq: last.seq, id: last._id }) : null;

      const pageMaxSeq = last ? last.seq : sinceVal.seq;
      // No brain tombstones for a collection whose deletions have their own route — see the parameter doc — and none
      // for a listing, which is ids and seqs and pays for no second read.
      const tombstones = tombstoneType === null || !returnFull ? [] : await listTombstones(spaceId, sinceVal.seq, pageSize);
      const itemIds = new Set(items.map(i => i._id));
      const tombs = tombstones
        .filter(t =>
          t.type === tombstoneType &&
          t.seq <= pageMaxSeq &&
          !itemIds.has(t._id) &&
          (t.originalSeq === undefined || t.originalSeq > sinceVal.seq),
        )
        .map(t => ({ _id: t._id, seq: t.seq, deletedAt: t.deletedAt }));

      res.json({ items: [...items, ...tombs].sort((a, b) => a.seq - b.seq), nextCursor });
    } catch (err) {
      reportServerFailure(`sync GET /${collection}`, err);
      res.status(500).json({ error: 'Internal error' });
    }
  };
}

/**
 * One document by id — the other read, written four times for the same reason.
 *
 * A peer reaches this when a page gave it ids and seqs and it wants one specific record. Deliberately not
 * the same thing as `full=true`: that is the bulk path, this answers about a document a peer already knows
 * it needs.
 *
 * **One of the four copies reported its 500 differently, and the stronger one is what shipped here.**
 * `facts/:id` logged `err` through `log.error`, the other three through `reportServerFailure` — which
 * carries the STACK, and exists because an operator on another team once reasoned for ten days from a log
 * that held no line for the 500 they were asking about. The message alone ("Cannot read properties of
 * undefined") sends that reader back to grep source they do not have. Four copies of one rule with the
 * weakest winning is exactly the shape this extraction removes, so it is fixed rather than preserved.
 */
function oneById<T extends { _id: string }>(key: PayloadKey) {
  const { collection, pushFilter: extraFilter = {} } = familyOf(key);
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { spaceId, networkId } = req.query as Record<string, string>;
      if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

      /*
       * The page's own filter and projection, so a read by id serves exactly what a page would (`Q-388`): it
       * served the stored document whole — vector, matched text and retention stamps included — and a file
       * chunk, which the page excludes, was readable here by id.
       */
      const doc = await col<T>(`${spaceId}_${collection}`).findOne(
        asFilter<T>({ ...extraFilter, _id: req.params['id'] as string }),
        { projection: LOCAL_ONLY_EXCLUSION },
      );
      if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(doc);
    } catch (err) {
      reportServerFailure(`sync GET /${collection}/:id`, err);
      res.status(500).json({ error: 'Internal error' });
    }
  };
}

/*
 * The five families, and the fifth is why the four above became one function.
 *
 * A link record replicates like any other document: same page, same cursor, same tombstone rule. What it
 * does not have is a type schema, a fork resolution or an embedding — `IncomingLinkDoc` and the
 * batch-upsert block below carry those differences. A collection missing from this router is one a peer can
 * never fetch, and nothing reports that, because a peer which never receives a link has none to hash either.
 */
syncDocsRouter.get('/facts', syncRateLimit, requireAuth, pageBySeq<FactDoc>('facts', 'fact'));
syncDocsRouter.get('/entities', syncRateLimit, requireAuth, pageBySeq<EntityDoc>('entities', 'entity'));
syncDocsRouter.get('/edges', syncRateLimit, requireAuth, pageBySeq<EdgeDoc>('edges', 'edge'));
syncDocsRouter.get('/chrono', syncRateLimit, requireAuth, pageBySeq<ChronoEntry>('chrono', 'chrono'));
syncDocsRouter.get('/links', syncRateLimit, requireAuth, pageBySeq<LinkDoc>('links', 'link'));
/*
 * A file's METADATA — the sixth family, on the owner's `P-32` ruling.
 *
 * The BYTES still travel through the manifest and `/api/files`; this carries what somebody wrote about
 * them. Before it existed, a file linked to an entity on one instance sent the LINK record and not the
 * array it came from, so the graph on a peer showed the connection and the peer's own Files tab showed
 * none.
 *
 * PARENTS ONLY, and no tombstone rider: a chunk is derived locally, and a deleted file already has its own
 * tombstone route.
 */
syncDocsRouter.get('/filemeta', syncRateLimit, requireAuth,
  /*
   * `seq` is OPTIONAL on a file meta record and required by the pager, so the type is narrowed here rather
   * than made required on the document.
   *
   * A record written before 4.0 has none, and the filter is what makes that safe: `seq: { $gt: n }` never
   * matches a document without one, so an un-stamped record simply does not page to a peer until it is next
   * written. `npm run links:convert` stamps the ones already stored. Making the field required instead would
   * have meant a boot migration over synced data, which `_REFERENCE.md` forbids.
   */
  pageBySeq<FileMetaDoc & { seq: number }>('filemeta', null));

syncDocsRouter.get('/facts/:id', syncRateLimit, requireAuth, oneById<FactDoc>('facts'));
syncDocsRouter.get('/entities/:id', syncRateLimit, requireAuth, oneById<EntityDoc>('entities'));
syncDocsRouter.get('/edges/:id', syncRateLimit, requireAuth, oneById<EdgeDoc>('edges'));
syncDocsRouter.get('/chrono/:id', syncRateLimit, requireAuth, oneById<ChronoEntry>('chrono'));
syncDocsRouter.get('/links/:id', syncRateLimit, requireAuth, oneById<LinkDoc>('links'));
syncDocsRouter.get('/filemeta/:id', syncRateLimit, requireAuth, oneById<FileMetaDoc>('filemeta'));


// ═══════════════════════════════════════════════════════════════════════════
// THE PUSH DOORS — how a pushed document is stored (5.6.2, `Q-218`)
// ═══════════════════════════════════════════════════════════════════════════
/*
 * Every pushed record is stored by the arrival writer (`sync/arrivals.ts`, `writeArrivals`), the one writer of a
 * record produced elsewhere: retagged to this space, the receiver's own vector and stamps carried across the
 * replace, written under the seq guard, the counter moved and the record queued for embedding by THIS instance's
 * rules. The doors below keep 5.6.1's per-document reading of a page — the same statuses, the same counters, the
 * same order — and decide only WHICH documents land; the writer is the only thing here that writes a record.
 *
 * PUSH_CLOCK — each door moves the counter past every plausible seq it received (`Q-198`), in a `finally` AFTER it
 * wrote what it received and BEFORE it answers, the 400s that follow the parse included: a peer told its push landed
 * while this counter is behind lets the next local write sort below a record the peer already holds. It is the ONLY
 * bump of a pushed record: the doors hand the writer `counterMovedByCaller` (and the stored copy their accept read),
 * so a page moves the one counter document of its space once, not once per document (`Q-218` R4).
 *
 * AFTER, never before: on 5.6.x `bumpSeq` also raises the horizon a seq-paged reader is capped at (`settledSeqRange`
 * serves below `maxSeen + 1`), on the assumption that what it bumps over is already committed. Bumped before the
 * write, a concurrent `GET /api/sync/*` page may be served past a seq whose record is not stored yet, and the pulling
 * peer moves its watermark past it for good (`Q-196`). A fork is a local write at a local seq, so it is written
 * after the bump and sorts above the arrival that caused it.
 */

/** What a push door answers, decided before the counter moves and sent after it. */
type Answer = { code: number; body: unknown };

/**
 * One pushed document through the writer, its family's own record type at the call. `handOver` is what a door may
 * pass because it already did that work: the stored copy it read, and the counter it moves itself after the write
 * (`ArrivalOptions.stored`, `counterMovedByCaller` — each says what the door then owes).
 */
async function landOne(
  spaceId: string, family: BrainCollection, doc: object, from: string,
  handOver: Pick<ArrivalOptions, 'stored' | 'counterMovedByCaller'> = {},
): Promise<ArrivalOutcome> {
  return await writeArrivals(spaceId, family, RECORD_TYPE_OF[family], [doc], { from, ...handOver });
}

/** What one document's write came to, read off the writer's outcome. */
type Landing = 'inserted' | 'updated' | 'newer-here' | 'diverged' | 'duplicate' | 'derived' | 'store-refused';
function landingOf(out: ArrivalOutcome, id: string): Landing {
  if (out.inserted.includes(id)) return 'inserted';
  if (out.updated.includes(id)) return 'updated';
  if (out.diverged.includes(id)) return 'diverged';
  if (out.duplicates.includes(id)) return 'duplicate';
  if (out.derived.includes(id)) return 'derived';
  if (out.storeRefused.some(r => r._id === id)) return 'store-refused';
  return 'newer-here';
}
const landed = (l: Landing | null): boolean => l === 'inserted' || l === 'updated';

/**
 * Cut `C3`: a document the STORE refuses is answered on a single route as 5.6.1 answered it — the route's 500
 * `Internal error` — never main's 400 naming the refusal, which is a status no 5.6.1 peer was ever sent.
 */
function failOnStoreRefusal(l: Landing, route: string, id: string): void {
  if (l === 'store-refused') throw new Error(`sync POST ${route}: the store refused '${logSafe(id)}'`);
}

/** The peer identity the request's token PROVES, or undefined for an admin or local token — the push accept's pusher. */
const pusherOf = (req: Request): string | undefined => callerPeerId(req.authToken as Record<string, unknown>);
/** The peer a push came from, for the writer's log lines. */
const pushedBy = (req: Request): string => pusherOf(req) ?? 'unknown peer';

function tombstoneFor(spaceId: string, id: string, type: TombstoneDoc['type']): Promise<TombstoneDoc | null> {
  return col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'))
    .findOne(asFilter<TombstoneDoc>({ _id: id, type })) as Promise<TombstoneDoc | null>;
}

/**
 * `F6`: a stale tombstone is deleted only once the record that supersedes it has LANDED, and only below that
 * record's seq. 5.6.1 deleted it first and then wrote, so a write that failed left the record absent AND its
 * deletion gone, and the next push of an older copy was accepted instead of refused. The stale branch asks the same
 * question of the copy already stored (`Q-253`), so it is the same delete, bounded by that copy's seq.
 */
async function dropSupersededTombstone(spaceId: string, tomb: TombstoneDoc | null, id: string, seq: number): Promise<void> {
  if (!tomb) return;
  await col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'))
    .deleteOne(asFilter<TombstoneDoc>({ _id: id, seq: { $lt: seq } as unknown as number }));
}

/** What the push accept decided for one document, with what it read to decide it. */
type PushVerdict<S> =
  | { kind: 'tombstoned' }
  | { kind: 'land' | 'stale'; tomb: TombstoneDoc | null; stored: S | null };

/** What the push accept reads of an arriving record: its id, its seq, and the instance it names as its author. */
type PushedRecord = { _id: string; seq: number; author?: { instanceId?: string } };

/**
 * THE PUSH ACCEPT for one document — every push door of a record family asks it, the single routes and the batch
 * family loops (file metadata has no tombstone here and is accepted by the writer's own `planArrivalWrites`), so the
 * rule is read in one place (`Q-218` R5: it was written out nine times). A tombstone at or above the incoming seq
 * stands; otherwise the stored copy is read and `isNewerCopy` decides between landing it and leaving it stale.
 *
 * **Whose tombstone governs (bundle-46, 5.6.3).** A held tombstone from a different issuer than the record's author
 * is someone else's statement about an id, so it neither refuses the record nor is cleaned up by it — but ONLY when
 * the PUSHER is proven to be that author. `pusher` is the peer identity the token proves (`callerPeerId`), undefined
 * for an admin or local token, and it is REQUIRED so every door has to say it: the document's `author` field is the
 * sender's text, and without the proof a push naming any other author for a deleted id would resurrect it. It is the
 * mirror of the rule a tombstone itself passes (`applyPeerTombstones`: its issuer must be the delivering peer), asked
 * through the same `tombstoneGoverns`, so a tombstone with no issuer, or a record with no author, still governs.
 *
 * `whole` reads the entire stored copy rather than its seq: a fact needs its text to tell a fork from a re-send.
 */
async function pushVerdict<S extends { seq?: number }>(
  spaceId: string, family: BrainCollection, tombType: TombstoneDoc['type'], incoming: PushedRecord,
  pusher: string | undefined,
  { whole = false }: { whole?: boolean } = {},
): Promise<PushVerdict<S>> {
  const held = await tombstoneFor(spaceId, incoming._id, tombType);
  const author = incoming.author?.instanceId;
  const provenOtherAuthor = held !== null && !tombstoneGoverns(held.instanceId, author)
    && pusher !== undefined && author === pusher;
  const tomb = provenOtherAuthor ? null : held;
  if (tomb && tomb.seq >= incoming.seq) return { kind: 'tombstoned' };
  const stored = await col<{ _id: string }>(spaceCollection(spaceId, family))
    .findOne(asFilter<{ _id: string }>({ _id: incoming._id }), whole ? {} : { projection: { seq: 1 } }) as S | null;
  return { kind: isNewerCopy(incoming.seq, stored?.seq) ? 'land' : 'stale', tomb, stored };
}

/**
 * Carry out a verdict that is not `tombstoned`: `land` goes through the writer — handed the stored copy the verdict
 * just read, so the writer does not read it again, and leaving the counter to the door, which bumps after the write
 * in its `finally` (`PUSH_CLOCK`, `Q-218` R4) — and the tombstone it supersedes goes once it LANDED (`F6`); `stale`
 * keeps 5.6.1's cleanup of a tombstone the STORED copy superseded, bounded by that copy's seq in the delete itself
 * (`Q-253`): the verdict read the tombstone before this runs, and a deletion written for the id in between — at a
 * higher seq — must survive it. Under a divergent fact (a fork) the stored seq equals the incoming one, so the bound
 * is the same. Returns what the write came to, or `null` when nothing was written. A store refusal is returned,
 * never acted on: each door answers it its own way (cut `C3`).
 */
async function applyPushVerdict<S extends { seq?: number }>(
  spaceId: string, family: BrainCollection, verdict: Exclude<PushVerdict<S>, { kind: 'tombstoned' }>,
  incoming: { _id: string; seq: number }, from: string,
): Promise<Landing | null> {
  if (verdict.kind === 'stale') {
    const storedSeq = verdict.stored?.seq;
    if (typeof storedSeq === 'number') await dropSupersededTombstone(spaceId, verdict.tomb, incoming._id, storedSeq);
    return null;
  }
  const stored = new Map(verdict.stored ? [[incoming._id, verdict.stored]] : []);
  const landing = landingOf(await landOne(spaceId, family, incoming, from, { stored, counterMovedByCaller: true }), incoming._id);
  if (landed(landing)) await dropSupersededTombstone(spaceId, verdict.tomb, incoming._id, incoming.seq);
  return landing;
}

/**
 * The id the fork of `incoming` has — one spelling for the fork that is written (`writeFork`) and the fork a re-send
 * looks for (`heldFork`), so the two can never ask about different ids.
 */
const forkIdOf = (incoming: FactDoc): string => forkIdFor(incoming._id, incoming.seq, incoming.fact);

/**
 * Does `incoming` FORK from the copy of its fact stored now — the same seq, other text? The one question both push doors
 * ask of a fact the verdict left unlanded, so the single route and the batch loop cannot judge it differently.
 *
 * The verdict's copy was read before the write, and a write that came back `diverged` found a same-seq copy with other
 * text stored in between (`Q-232`), so the fork rules judge the copy that is there, not the one the race replaced
 * (`verdictCopy` is used only when the write did not say `diverged`). A copy that is gone is no divergence.
 */
async function forksFromStoredCopy(
  spaceId: string, incoming: FactDoc, landing: Landing | null, verdictCopy: FactDoc | null,
): Promise<boolean> {
  const stored = landing === 'diverged'
    ? await col<FactDoc>(spaceCollection(spaceId, 'facts')).findOne(asFilter<FactDoc>({ _id: incoming._id })) as FactDoc | null
    : verdictCopy;
  return divergesFrom(stored, incoming);
}

/**
 * The fork this divergence already made, if it is stored (`Q-218` R9). A fork's id is derived from what it forks
 * (`forkIdFor`), so finding it means the push is a RE-SEND: it answers `forked` with that id and writes nothing new.
 * Asked before either fork cap is counted — the cap refuses new forks, and refusing a re-send tells the sender a
 * record it already delivered was dropped.
 */
async function heldFork(spaceId: string, incoming: FactDoc): Promise<string | null> {
  const id = forkIdOf(incoming);
  const found = await col<FactDoc>(spaceCollection(spaceId, 'facts'))
    .findOne(asFilter<FactDoc>({ _id: id }), { projection: { _id: 1 } });
  return found ? id : null;
}

/**
 * A fork of `incoming`, written by the writer at a LOCAL seq. Its id is DERIVED from the parent, the shared seq and
 * the diverging text (`forkIdFor`), so a push re-sent after its 200 was lost finds the fork it already made
 * (`heldFork`) instead of forking again; two divergent copies in one page upsert the same one.
 */
function writeFork(spaceId: string, incoming: FactDoc, from: string): Promise<{ doc: FactDoc; landing: Landing }> {
  return withSeq(spaceId, async (forkSeq) => {
    // The divergent copy's own `createdAt`/`updatedAt` stay (`Q-361` item 8): a fork holds the text the other peer wrote,
    // when it wrote it. Stamped "now" it was a record whose age was this instance's sync schedule — a fresh retention
    // window however old the text, and two receivers forking one divergence on different days stored two different
    // documents under one derived id. Neither stamp is in the id, so a re-send still finds the fork it made.
    const doc: FactDoc = { ...incoming, _id: forkIdOf(incoming), forkOf: incoming._id, seq: forkSeq };
    return { doc, landing: landingOf(await landOne(spaceId, 'facts', doc, from), doc._id) };
  });
}

/**
 * POST /api/sync/facts?spaceId=&networkId=
 * Upsert a fact received from a peer.
 * Conflict rule: higher seq wins; equal seq forks.
 */
syncDocsRouter.post('/facts', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

    const parsed = parseIncoming('facts', req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid fact document' });
      return;
    }
    const incoming = parsed.data as FactDoc;
    if (rejectImplausibleSeq(spaceId, incoming.seq, res, callerPeerId(req.authToken as Record<string, unknown>))) return;

    // Computed before any store, and reported on every exit that KEPT something. The `tombstoned` and
    // `skipped` exits store nothing, so there is no accepted record for them to describe.
    const violations = violationsAgainstLocalSchema(spaceId, 'fact', incoming as unknown as Record<string, unknown>);

    // Decided and written FIRST; the counter moves in the `finally` below — see `PUSH_CLOCK`.
    let answer: Answer = { code: 200, body: { status: 'skipped' } };
    let toFork = false;
    try {
      // The whole stored copy: its text is what tells a fork from a re-send.
      const verdict = await pushVerdict<FactDoc>(spaceId, 'facts', 'fact', incoming, pusherOf(req), { whole: true });
      // No local copy, or the remote is newer: the writer stores it, guarded against a newer copy written meanwhile.
      // The skip and fork branches keep 5.6.1's cleanup of a stale tombstone.
      const landing = verdict.kind === 'tombstoned' ? null
        : await applyPushVerdict(spaceId, 'facts', verdict, incoming, pushedBy(req));
      // A write that found a same-seq copy with other text stored meanwhile (`diverged`) goes the way a planned fork
      // does, judged against the copy that is stored now — by the same re-send check and the same caps.
      if (verdict.kind === 'tombstoned') {
        answer = { code: 200, body: { status: 'tombstoned' } };
      } else if (landing !== null && landing !== 'diverged') {
        failOnStoreRefusal(landing, 'facts', incoming._id);
        if (landed(landing)) answer = { code: 200, body: withSchemaViolations({ status: landing }, violations) };
      } else if (await forksFromStoredCopy(spaceId, incoming, landing, verdict.stored)) {
        const resent = await heldFork(spaceId, incoming);
        if (resent !== null) {
          answer = { code: 200, body: withSchemaViolations({ status: 'forked', forkId: resent }, violations) };
        } else {
          // Concurrent independent edit — fork; but cap both chain depth and fan-out.
          const depth = await forkChainDepth(spaceId, incoming._id);
          // Also cap fan-out: count how many forks already point to this document.
          const siblingCount = depth >= MAX_FORK_DEPTH ? 0 : await col<FactDoc>(spaceCollection(spaceId, 'facts'))
            .countDocuments(asFilter<FactDoc>({ forkOf: incoming._id }), { limit: MAX_FORK_DEPTH + 1 });
          if (depth >= MAX_FORK_DEPTH || siblingCount >= MAX_FORK_DEPTH) {
            answer = { code: 400, body: { error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id '${logSafe(incoming._id)}'` } };
          } else {
            toFork = true;
          }
        }
      }
    } finally {
      // PUSH_CLOCK: after the write, awaited, before any answer — the fork-cap 400s were received too.
      await bumpSeq(spaceId, incoming.seq);
    }
    if (toFork) {
      // A fork is a LOCAL write at a local seq, so it is written after the counter passed the arrival's seq.
      const fork = await writeFork(spaceId, incoming, pushedBy(req));
      failOnStoreRefusal(fork.landing, 'facts', fork.doc._id);
      answer = { code: 200, body: withSchemaViolations({ status: 'forked', forkId: fork.doc._id }, violations) };
    }
    res.status(answer.code).json(answer.body);
  } catch (err) {
    log.error(`sync POST facts: ${logSafe(String(err))}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// ENTITIES
// ═══════════════════════════════════════════════════════════════════════════





syncDocsRouter.post('/entities', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

    const parsed = parseIncoming('entities', req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid entity document' });
      return;
    }
    const incoming = parsed.data as EntityDoc;
    if (rejectImplausibleSeq(spaceId, incoming.seq, res, callerPeerId(req.authToken as Record<string, unknown>))) return;

    // Before the upsert, so the record reported on is the one the peer sent rather than whatever the
    // store settled on. The `tombstoned` exit keeps nothing and so reports nothing.
    const violations = violationsAgainstLocalSchema(spaceId, 'entity', incoming as unknown as Record<string, unknown>);

    let answer: Answer = { code: 200, body: withSchemaViolations({ status: 'ok' }, violations) };
    try {
      const verdict = await pushVerdict(spaceId, 'entities', 'entity', incoming, pusherOf(req));
      if (verdict.kind === 'tombstoned') {
        answer = { code: 200, body: { status: 'tombstoned' } };
      } else {
        /*
         * New or newer: stored by the writer. This was a raw `$setOnInsert` followed by a replace only when the
         * incoming seq beat the copy just inserted — which it never does — so a NEW entity pushed singly was stored
         * and never queued for embedding. Every outcome still answers `ok`, as it always has.
         */
        const landing = await applyPushVerdict(spaceId, 'entities', verdict, incoming, pushedBy(req));
        if (landing !== null) failOnStoreRefusal(landing, 'entities', incoming._id);
      }
    } finally {
      // PUSH_CLOCK: after the write, awaited, before the answer.
      await bumpSeq(spaceId, incoming.seq);
    }

    res.status(answer.code).json(answer.body);
  } catch (err) {
    log.error(`sync POST entities: ${logSafe(String(err))}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// EDGES
// ═══════════════════════════════════════════════════════════════════════════





syncDocsRouter.post('/edges', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

    const parsed = parseIncoming('edges', req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid edge document' });
      return;
    }
    const incoming = parsed.data as EdgeDoc;
    if (rejectImplausibleSeq(spaceId, incoming.seq, res, callerPeerId(req.authToken as Record<string, unknown>))) return;

    // Before the upsert, so the record reported on is the one the peer sent rather than whatever the
    // store settled on. The `tombstoned` exit keeps nothing and so reports nothing.
    const violations = violationsAgainstLocalSchema(spaceId, 'edge', incoming as unknown as Record<string, unknown>);

    let tombstoned = false;
    let duplicateTriplet = false;
    try {
      const verdict = await pushVerdict(spaceId, 'edges', 'edge', incoming, pusherOf(req));
      // A tombstoned edge: nothing to write, a deletion at or above this seq stands.
      tombstoned = verdict.kind === 'tombstoned';
      if (verdict.kind !== 'tombstoned') {
        /*
         * A duplicate TRIPLET is a 200, not a 500: the writer reads a unique-index collision back as a duplicate
         * (`duplicates`), never a fault.
         *
         * The upsert is keyed on `_id`, which this peer has never seen, so it inserts; the space's unique
         * `{ from, to, label }` index then rejects it because the same relationship already exists locally under
         * a different random id. Letting that reach the route's catch answers 500, and a non-ok push makes the
         * SENDER hold its watermark and re-send the identical batch every cycle — the edges channel to that
         * peer never advances again.
         *
         * Same policy as the pull side: the local copy stands, the incoming one is not applied, and the caller
         * is told which it was rather than left to infer it from a status code. The writer logs it, naming the id.
         */
        const landing = await applyPushVerdict(spaceId, 'edges', verdict, incoming, pushedBy(req));
        if (landing !== null) failOnStoreRefusal(landing, 'edges', incoming._id);
        duplicateTriplet = landing === 'duplicate';
      }
    } finally {
      // PUSH_CLOCK: after the write, awaited, before the answer.
      await bumpSeq(spaceId, incoming.seq);
    }
    if (tombstoned) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }

    // Fire-and-forget: check strict linkage violations after ingest
    const peerInst = (req.authToken as Record<string, unknown>)?.['peerInstanceId'] as string ?? 'unknown';
    checkEdgeLinkViolations(spaceId, incoming, peerInst).catch(() => {});

    // `duplicate` rather than `ok`: the record did NOT land, and a sender that cannot tell the two apart
    // advances its watermark believing it delivered something it did not.
    res.status(200).json(withSchemaViolations(
      { status: duplicateTriplet ? 'duplicate' : 'ok' }, violations,
    ));
  } catch (err) {
    log.error(`sync POST edges: ${logSafe(String(err))}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// CHRONO
// ═══════════════════════════════════════════════════════════════════════════





syncDocsRouter.post('/chrono', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

    const parsed = parseIncoming('chrono', req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid chrono document' });
      return;
    }
    const incoming = parsed.data as ChronoEntry;
    if (rejectImplausibleSeq(spaceId, incoming.seq, res, callerPeerId(req.authToken as Record<string, unknown>))) return;
    /*
     * REPORTED, NOT REFUSED — owner's ruling P-21 = C, 2026-08-29.
     *
     * This 400 was the only schema check anywhere in sync's five ingest paths, and it did the one thing the
     * ruling says not to do: a peer validated this record against ITS schema, which may differ from ours, so
     * rejecting it discards data the sender believes it delivered. The batch path — which is what a real peer
     * uses — never checked at all, so the single check also sat where the traffic is not.
     *
     * Relaxing it is safe from the sender's side: a record that was rejected is now accepted, so nothing
     * breaks and more data flows. The violations travel back in the response so the receiving operator can see
     * what arrived out of shape.
     */
    /*
     * A TYPE NOBODY UNDERSTANDS IS REFUSED; a schema mismatch is reported. Those are different things, and
     * collapsing them was a real over-correction — CI caught it.
     *
     * P-21 = C says a schema violation is reported rather than refused, because a peer validated the record
     * against ITS schema and discarding data over a disagreement is not the receiver's call. That reasoning
     * does not reach a chrono whose `type` is outside the product's own vocabulary AND outside anything this
     * space declared: such a record is not *non-conforming*, it is **meaningless to every reader**, and
     * `IncomingChronoDoc` types the field as any non-empty string so nothing else would catch it.
     *
     * So the vocabulary check stays a refusal — on BOTH paths now, which is what W-4 was about — and the
     * property check reports.
     */
    const allowedTypes = getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta);
    const chronoViolations = violationsAgainstLocalSchema(spaceId, 'chrono', incoming as unknown as Record<string, unknown>);

    // The violations travel back so the receiving operator can see what arrived out of shape. Absent when
    // there are none, so a clean ingest keeps its existing response byte for byte.
    let answer: Answer = { code: 200, body: withSchemaViolations({ status: 'ok' }, chronoViolations) };
    try {
      if (!allowedTypes.has(incoming.type)) {
        answer = { code: 400, body: { error: `\`type\` must be one of: ${[...allowedTypes].join(', ')}` } };
      } else {
        const verdict = await pushVerdict(spaceId, 'chrono', 'chrono', incoming, pusherOf(req));
        if (verdict.kind === 'tombstoned') {
          answer = { code: 200, body: { status: 'tombstoned' } };
        } else {
          const landing = await applyPushVerdict(spaceId, 'chrono', verdict, incoming, pushedBy(req));
          if (landing !== null) failOnStoreRefusal(landing, 'chrono', incoming._id);
        }
      }
    } finally {
      // PUSH_CLOCK: after the write, awaited, before any answer — the unknown-type 400 was received too.
      await bumpSeq(spaceId, incoming.seq);
    }
    res.status(answer.code).json(answer.body);
  } catch (err) {
    log.error(`sync POST chrono: ${logSafe(String(err))}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// BATCH UPSERT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/sync/batch-upsert?spaceId=&networkId=
 * Accept arrays of every replicated family (facts, entities, edges, chrono, links, file metadata) and store
 * them all in one request, each document read in order by the same conflict rules as the individual POST
 * endpoints, and every one written by the arrival writer. Limits: 500 docs per family per request; what a family
 * carries beyond that is dropped and counted nowhere (cut `C2`, as 5.6.1).
 */
syncDocsRouter.post('/batch-upsert', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

    const body = req.body as { facts?: unknown[]; entities?: unknown[]; edges?: unknown[]; chrono?: unknown[]; links?: unknown[]; filemeta?: unknown[] };
    /*
     * A document the schema rejects is REPORTED, never silently removed.
     *
     * This used to be a bare `flatMap` returning `[]` on a failed `safeParse`, under a comment that said "batch
     * ingest already skips invalid documents silently" as though that were harmless. It was not: the
     * document left the batch, was counted in no statistic, and the receiver answered 200 — after which the
     * sender advanced its watermark and never offered the record again. A required `embedding` on
     * `IncomingFactDoc` made that the ordinary fate of every suppressed fact.
     *
     * The schema is fixed; the silence is fixed separately, because the next mismatch between a stored document
     * and its `Incoming*` schema would otherwise lose records the same way and be just as invisible. Same
     * warning shape as the implausible-seq drop below — kind, id, space, peer — so both read alike in a log.
     */
    // Q-59: every record this request carried and the handler neither stored nor already held, per kind — the
    // count the sender subtracts from what it calls pushed. Filled by the two drops below and the in-loop refusals.
    const dropped: Record<string, number> = {};
    const drop = (kind: string) => { dropped[kind] = (dropped[kind] ?? 0) + 1; };
    const parsed = <T>(raw: unknown[], key: PayloadKey, kind: string): T[] =>
      raw.flatMap(d => {
        const r = parseIncoming(key, d);
        if (r.success) return [r.data as T];
        drop(kind);
        const id = (d as { _id?: unknown })?._id;
        // The id, the peer and the issues are a peer's text: `logSafe`, so none can start a log line of its own.
        log.warn(
          `batch-upsert: REJECTED ${logSafe(kind)} '${typeof id === 'string' ? logSafe(id) : '(no id)'}' for space '${logSafe(spaceId)}' `
          + `from peer '${logSafe(callerPeerId(req.authToken as Record<string, unknown>) ?? 'unknown')}' — it did not `
          + `match ${kind === 'fact' ? 'IncomingFactDoc' : `Incoming${logSafe(kind[0]!.toUpperCase())}${logSafe(kind.slice(1))}Doc`}. `
          + `The sender will advance past it and not offer it again. Issues: `
          + `${logSafe(JSON.stringify(r.error?.issues ?? []), { max: 400 })}`,
        );
        return [];
      });

    const factsRaw = parsed<FactDoc>(Array.isArray(body?.facts) ? body.facts.slice(0, 500) : [], 'facts', 'fact');
    const entitiesRaw = parsed<EntityDoc>(Array.isArray(body?.entities) ? body.entities.slice(0, 500) : [], 'entities', 'entity');
    const edgesRaw = parsed<EdgeDoc>(Array.isArray(body?.edges) ? body.edges.slice(0, 500) : [], 'edges', 'edge');
    const chronoRaw = parsed<ChronoEntry>(Array.isArray(body?.chrono) ? body.chrono.slice(0, 500) : [], 'chrono', 'chrono');
    const linksRaw = parsed<LinkDoc>(Array.isArray(body?.links) ? body.links.slice(0, 500) : [], 'links', 'link');
    /*
     * A file's METADATA — the sixth family (`P-32`).
     *
     * A CHUNK sent here is REPORTED by `parsed` rather than stripped, because `IncomingFileMetaDoc` refuses
     * `parentFileId` outright: zod would otherwise drop the key and the chunk would land as a FILE, carrying
     * another instance's passage text under an id ending in `#0`.
     */
    const fileMetaRaw = parsed<FileMetaDoc & { seq: number }>(
      Array.isArray(body?.filemeta) ? body.filemeta.slice(0, 500) : [],
      'filemeta', 'filemeta');

    // Drop documents whose seq is too close to the protocol ceiling — one such
    // doc would otherwise drag the counter toward it via the bumpSeq below (see
    // util/seq.ts). Schema-invalid documents are reported by `parsed` above, so
    // these are dropped on the same footing — a warning naming the record, not fatal.
    // Kept at the door, by the one rule (`seqRefusal`), because 5.6.1's per-family `rejected` counts it and its
    // warning names it; the writer would refuse it as well.
    const plausible = <T extends { seq: number; _id: string }>(docs: T[], kind: string): T[] =>
      docs.filter(d => {
        if (seqRefusal(d.seq, { optional: false }) === null) return true;
        drop(kind);
        log.warn(
          `batch-upsert: dropped ${logSafe(kind)} '${logSafe(d._id)}' with implausible seq ${logSafe(d.seq)} ` +
          `for space '${logSafe(spaceId)}' (max ingest seq ${MAX_INGEST_SEQ}) from peer ` +
          `'${logSafe(callerPeerId(req.authToken as Record<string, unknown>) ?? 'unknown')}'.`,
        );
        return false;
      });
    const facts = plausible(factsRaw, 'fact');
    const entities = plausible(entitiesRaw, 'entity');
    const edges = plausible(edgesRaw, 'edge');
    const chrono = plausible(chronoRaw, 'chrono');
    const links = plausible(linksRaw, 'link');
    const fileMeta = plausible(fileMetaRaw, 'filemeta');

    /*
     * THE PAGE'S CLOCK (`Q-198`, see `PUSH_CLOCK`): the counter past every plausible seq this page carried — all six
     * families, whatever becomes of each document (a tombstoned, a skipped or an unknown-type one is the peer's clock
     * too) — in the `finally` AFTER the six family loops have written what they received, awaited and NOT swallowed,
     * so the sender is never told the page landed while the counter is behind it, and a concurrent pull is never
     * handed a horizon above a record not yet stored. Forks are local writes and are written after it.
     */
    const pageMax = Math.max(0, ...[facts, entities, edges, chrono, links, fileMeta].flatMap(f => f.map(d => d.seq ?? 0)));
    const from = pushedBy(req);
    const pusher = pusherOf(req);
    /** Cut `C3`: documents the STORE refused. The rest of the page is still written; the page then answers 500. */
    const storeRefused: string[] = [];
    /** Divergent facts to fork, in page order — written after the page's clock has moved. */
    const toFork: FactDoc[] = [];
    // `skipped` = the peer is already current (benign). `forkDepthRefused` = a record was DROPPED. They were
    // one counter until 2026-08-19, which is why the lossy one had never been seen.
    const memStats = { inserted: 0, updated: 0, forked: 0, skipped: 0, forkDepthRefused: 0, tombstoned: 0, schemaViolations: 0 };
    const entStats = { upserted: 0, skipped: 0, tombstoned: 0, schemaViolations: 0 };
    const edgeStats = { upserted: 0, skipped: 0, tombstoned: 0, schemaViolations: 0, duplicateTriplets: 0 };
    const chronoStats = { upserted: 0, skipped: 0, tombstoned: 0, schemaViolations: 0, unknownType: 0 };
    const linkStats = { upserted: 0, skipped: 0, tombstoned: 0 };
    const fileMetaStats = { upserted: 0, skipped: 0 };

    try {
    // ── Facts ─────────────────────────────────────────────────────────
    /*
     * VALIDATED, COUNTED, AND LET IN — owner's ruling P-21 = C, 2026-08-29.
     *
     * Sync used to have exactly one check across five ingest paths: the chrono type allowlist on the
     * single-record route, which returned a 400. This path — the one a real peer uses, because a sync cycle
     * ships records in batches — checked nothing at all. So the only check lived where the traffic is not, and
     * it refused, which is the one thing the ruling says not to do: a peer validated these records against ITS
     * schema, and discarding data the sender believes it delivered is not ours to decide.
     *
     * The count goes back in the response rather than into a log line. That was the ruling's stated cost —
     * a report nobody reads is the do-nothing option with extra steps.
     */
    for (const incoming of facts) {
      if (violationsAgainstLocalSchema(spaceId, 'fact', incoming as unknown as Record<string, unknown>).length > 0) memStats.schemaViolations++;
      const verdict = await pushVerdict<FactDoc>(spaceId, 'facts', 'fact', incoming, pusher, { whole: true });
      if (verdict.kind === 'tombstoned') { memStats.tombstoned++; continue; }
      // The skip and fork branches keep 5.6.1's cleanup of a stale tombstone.
      const landing = await applyPushVerdict(spaceId, 'facts', verdict, incoming, from);
      if (landing !== null && landing !== 'diverged') {
        if (landing === 'store-refused') { storeRefused.push(incoming._id); continue; }
        if (landing === 'inserted') memStats.inserted++;
        else if (landing === 'updated') memStats.updated++;
        else memStats.skipped++;
        continue;
      }
      // `diverged`: the write found a same-seq copy with other text stored meanwhile (`Q-232`) — forked by the rules below,
      // judged against the copy stored now (the verdict's was read before the race).
      if (await forksFromStoredCopy(spaceId, incoming, landing, verdict.stored)) {
        // A re-send of a fork already made is delivered, not a new fork: counted before any cap (`Q-218` R9).
        if (await heldFork(spaceId, incoming) !== null) { memStats.forked++; continue; }
        // Cap fork chains to prevent unbounded growth. Depth only on this door — no fan-out cap (cut `C1`, as 5.6.1).
        const depth = await forkChainDepth(spaceId, incoming._id);
        if (depth >= MAX_FORK_DEPTH) {
          /*
           * A DROPPED RECORD, and it used to be counted as `skipped` alongside "I already have this".
           *
           * Those two outcomes could not be more different. The common `skipped` — `existing.seq >=
           * incoming.seq` — means the peer is already current: nothing is lost and the sender is right to
           * advance past it. THIS one means divergent content at the same seq that cannot fork any deeper,
           * so the incoming version is discarded. Sharing one integer made the lossy case unobservable; the
           * sender now subtracts `rejected` from what it calls pushed (`sync/push-refusals.ts`, `Q-59`), but it
           * still advances its watermark past the record and never sends it again.
           *
           * Counted apart and logged HERE because this is the side that knows why. It does not change
           * delivery: holding the watermark back would re-push a record the peer will refuse identically
           * every cycle. The fix is visibility, exactly as the media-worker swallow was.
           */
          memStats.forkDepthRefused++;
          log.warn(`sync batch-upsert: DROPPED fact ${logSafe(incoming._id)} in '${logSafe(spaceId)}' — divergent content at `
            + `seq ${logSafe(incoming.seq)} and the fork chain is already ${logSafe(depth)} deep (MAX_FORK_DEPTH=${MAX_FORK_DEPTH}). `
            + 'The sender will not offer it again. Resolve the fork chain to accept it.');
          continue;
        }

        toFork.push(incoming);
      } else {
        memStats.skipped++;
      }
    }

    // ── Entities ─────────────────────────────────────────────────────────
    for (const incoming of entities) {
      if (violationsAgainstLocalSchema(spaceId, 'entity', incoming as unknown as Record<string, unknown>).length > 0) entStats.schemaViolations++;
      const verdict = await pushVerdict(spaceId, 'entities', 'entity', incoming, pusher);
      if (verdict.kind === 'tombstoned') { entStats.tombstoned++; continue; }
      const landing = await applyPushVerdict(spaceId, 'entities', verdict, incoming, from);
      if (landing === 'store-refused') { storeRefused.push(incoming._id); continue; }
      if (landed(landing)) entStats.upserted++;
      else entStats.skipped++;
    }

    // ── Edges ─────────────────────────────────────────────────────────────
    for (const incoming of edges) {
      if (violationsAgainstLocalSchema(spaceId, 'edge', incoming as unknown as Record<string, unknown>).length > 0) edgeStats.schemaViolations++;
      const verdict = await pushVerdict(spaceId, 'edges', 'edge', incoming, pusher);
      if (verdict.kind === 'tombstoned') { edgeStats.tombstoned++; continue; }
      // The same absorption as the single-record route above. Worse here if it were missing: one duplicate
      // triplet anywhere in a 500-record page would 500 the WHOLE batch, so every other record in it is
      // discarded too — and the sender re-sends that identical page for ever. The writer reads the collision
      // back as a duplicate and logs it by id; the local copy is kept and the incoming one is not applied.
      const landing = await applyPushVerdict(spaceId, 'edges', verdict, incoming, from);
      if (landing === 'store-refused') { storeRefused.push(incoming._id); continue; }
      if (landing === 'duplicate') edgeStats.duplicateTriplets++;
      else if (landed(landing)) edgeStats.upserted++;
      else edgeStats.skipped++;
    }

    // ── Chrono ─────────────────────────────────────────────────────────────────
    const allowedChronoTypes = getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta);
    for (const incoming of chrono) {
      if (violationsAgainstLocalSchema(spaceId, 'chrono', incoming as unknown as Record<string, unknown>).length > 0) chronoStats.schemaViolations++;
      /*
       * The vocabulary check the single-record path has always had, now here too — this is the W-4 defect:
       * the same rule applied on one path and not the other, with the batch path being the one a real peer
       * uses. Skipped rather than 400d, because one bad record must not abandon the rest of a batch.
       */
      if (!allowedChronoTypes.has(incoming.type)) { chronoStats.unknownType++; continue; }
      const verdict = await pushVerdict(spaceId, 'chrono', 'chrono', incoming, pusher);
      if (verdict.kind === 'tombstoned') { chronoStats.tombstoned++; continue; }
      const landing = await applyPushVerdict(spaceId, 'chrono', verdict, incoming, from);
      if (landing === 'store-refused') { storeRefused.push(incoming._id); continue; }
      if (landed(landing)) chronoStats.upserted++;
      else chronoStats.skipped++;
    }

    /*
     * ── Links ────────────────────────────────────────────────────────────
     *
     * The shortest of the five blocks, and every absence is a decision rather than an omission:
     *
     *   - **No schema violations.** A link has no type schema to check it against, so there is nothing to
     *     record. `RECORD_TYPE` in the importer says the same thing with a `null`.
     *   - **No fork resolution.** A fork exists because two peers can write different CONTENT under one id
     *     at one seq. A link has no content — it is two endpoints and their kinds — so two peers writing
     *     "these two records are connected" have written the same fact, and the newer seq simply wins.
     *   - **No embedding.** `RECORD_TYPE_OF['links']` is `null`, which is the writer's way of saying this kind
     *     has nothing to embed — an argument at the call rather than a second writer for links.
     *
     * The tombstone check IS here, and unchanged: a delete that has already been applied must not be undone
     * by a stale copy of the record arriving afterwards.
     *
     * A link arriving under another id for endpoints already linked here is the SAME link, so the writer's
     * duplicate is counted `skipped` — on 5.6.1 it reached the catch and the whole page answered 500 (`F9`).
     */
    for (const incoming of links) {
      const verdict = await pushVerdict(spaceId, 'links', 'link', incoming, pusher);
      if (verdict.kind === 'tombstoned') { linkStats.tombstoned++; continue; }
      const landing = await applyPushVerdict(spaceId, 'links', verdict, incoming, from);
      if (landing === 'store-refused') { storeRefused.push(incoming._id); continue; }
      if (!landed(landing)) { linkStats.skipped++; continue; }
      /*
       * THE LINK VIOLATION CHECK LIVES HERE NOW, on the arriving LINK.
       *
       * It used to read the six arrays off an arriving fact or chrono entry. 5.0 removed them and links
       * replicate as their own documents, so the subject moved with the data — a link whose `to` names
       * nothing is exactly what an operator needs told, and reading a record's fields for it would now
       * find nothing and report clean for ever.
       *
       * Still only RECORDS, per `P-21`: sync ingest is validated, counted and let in, and a refusal here
       * would hold the watermark and stop the channel making progress.
       */
      const peerInst = (req.authToken as Record<string, unknown>)?.['peerInstanceId'] as string ?? 'unknown';
      checkLinkViolations(spaceId, incoming, peerInst).catch(() => {});
      linkStats.upserted++;
    }

    /*
     * ── A file's metadata ────────────────────────────────────────────────
     *
     * Last-writer-wins by seq, like every other family — the writer's accept, where a record stamped before 4.0
     * (no seq) is overwritten by anything that arrives. What is NOT like the others is the write itself: the
     * writer hands it to `ingestFileMeta`, which sets the authored keys instead of replacing the document,
     * because the receiver derived `sizeBytes`, `sha256`, the excerpt and the vector from bytes it holds. A legacy
     * read spill is never stored and is counted `skipped`, as 5.6.0 promised (cut `C8`).
     *
     * No tombstone check here. A deleted file has a `FileTombstoneDoc` and `/api/sync/file-tombstones`
     * carries it, which is why `TOMBSTONE_TYPES` has no `file` member; looking in the brain tombstones for
     * one would find nothing, every time, and look like a check.
     */
    for (const incoming of fileMeta) {
      // The page's clock moves the counter (below), so the writer does not, once per document (`Q-218` R4).
      const landing = landingOf(await landOne(spaceId, 'files', incoming, from, { counterMovedByCaller: true }), incoming._id);
      if (landing === 'store-refused') { storeRefused.push(incoming._id); continue; }
      if (landed(landing)) fileMetaStats.upserted++;
      else fileMetaStats.skipped++;
    }
    } finally {
      // The page's clock, after all six families were written and before any answer — see above; not swallowed.
      if (pageMax > 0) await bumpSeq(spaceId, pageMax);
    }

    // Forks, now that the counter is past the page: each takes a local seq above every arrival that caused it.
    for (const incoming of toFork) {
      const fork = await writeFork(spaceId, incoming, from);
      if (fork.landing === 'store-refused') { storeRefused.push(fork.doc._id); continue; }
      memStats.forked++;
    }

    /*
     * X-20 instrumentation, the RECEIVER half — and it is the half that matters now.
     *
     * The sender's side is answered: with `DEBUG` on, its log shows it pushing the record and advancing its
     * watermark, so it is not stalling. Reproduced under CPU contention 2026-08-20 (2 runs in 10): A pushes the
     * fact at seq 2, gets a 200, moves its watermark to 2 — and B never serves that id, so the record is
     * marked sent and will never be offered again.
     *
     * **A 200 says the batch was accepted, not that a record was stored**, and this handler has four ways to
     * accept one and keep nothing: an existing tombstone at or above its seq (`tombstoned`), an already-current
     * record (`skipped`), a fork chain at its cap (`forkDepthRefused`), and the same for the other three
     * collections. Every one of those is COUNTED here and none of them was logged, so the decision existed and
     * was thrown away with the response.
     *
     * The seq range is included because the counters alone cannot say WHICH records a number refers to, and the
     * question is always about one specific id at one specific seq.
     */
    const range = (docs: { seq?: number }[]): string =>
      docs.length === 0 ? '-' : `${Math.min(...docs.map(d => d.seq ?? 0))}..${Math.max(...docs.map(d => d.seq ?? 0))}`;
    log.debug(`Batch-upsert accepted for space '${logSafe(spaceId)}': `
      + `facts ${logSafe(JSON.stringify(memStats))} seq ${logSafe(range(facts))}; `
      + `entities ${logSafe(JSON.stringify(entStats))} seq ${logSafe(range(entities))}; `
      + `edges ${logSafe(JSON.stringify(edgeStats))} seq ${logSafe(range(edges))}; `
      + `chrono ${logSafe(JSON.stringify(chronoStats))} seq ${logSafe(range(chrono))}; `
      + `links ${logSafe(JSON.stringify(linkStats))} seq ${logSafe(range(links))} `
      + `filemeta ${logSafe(JSON.stringify(fileMetaStats))} seq ${logSafe(range(fileMeta))}`);

    /*
     * ALL SIX FAMILIES, and `filemeta` was the one missing.
     *
     * Six arrays go in and five sets of counters came out, so a sender had no way to tell whether its file
     * metadata landed — the receiver counted it and only logged it. `push-refusals.ts` reads these
     * counters off the response, so a family absent here is a family whose refusals are silent at both
     * ends.
     */
    /*
     * `rejected` per family (Q-59): what the sender must NOT count as delivered — schema-invalid, implausible seq,
     * a fact whose fork chain is at its cap, a chrono entry of a type this space does not declare. Each was already
     * counted or logged; none was in one number a sender could subtract, so a push this instance refused whole was
     * reported by the sender as `pushed chrono: 50`, `status: success`.
     */
    const rejected = (kind: string, extra = 0) => (dropped[kind] ?? 0) + extra;

    /*
     * Cut `C3`: a document the STORE refused is not counted in `rejected` and is not answered 200 — 5.6.1 answered
     * such a page 500, and a 5.6.1 peer reads a new `rejected` cause as a contract it never agreed to. Unlike 5.6.1
     * the REST of the page has been written, so the sender's re-send of it is idempotent (same seqs, the writer's
     * guard, a fork id derived from what it forks) and lands the same records again.
     */
    if (storeRefused.length > 0) {
      // The documents are named once, by the writer's own summary (`warnArrivalsNotStored`); this says what it costs.
      log.error(`sync POST batch-upsert: the store refused ${storeRefused.length} document(s) in space '${logSafe(spaceId)}'; `
        + 'every other document of the page was written, and the page answers 500 so the sender keeps its watermark.');
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    res.status(200).json({
      status: 'ok',
      facts: { ...memStats, rejected: rejected('fact', memStats.forkDepthRefused) },
      entities: { ...entStats, rejected: rejected('entity') },
      edges: { ...edgeStats, rejected: rejected('edge') },
      chrono: { ...chronoStats, rejected: rejected('chrono', chronoStats.unknownType) },
      links: { ...linkStats, rejected: rejected('link') },
      filemeta: { ...fileMetaStats, rejected: rejected('filemeta') },
    });
  } catch (err) {
    log.error(`sync POST batch-upsert: ${logSafe(String(err))}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
