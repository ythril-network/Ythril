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
import { sendSyncWriteFailure } from './write-failure.js';
import { withAllocatedSeqs, settledSeqRange } from '../../util/seq.js';
import { advanceCounterPast } from '../../sync/counter-after-page.js';
import { withinWriteBound } from '../../db/write-bound.js';
import type { FactDoc, EntityDoc, EdgeDoc, ChronoEntry, LinkDoc } from '../../config/types.js';
import type { FileMetaDoc } from '../../config/types.js';
import { LOCAL_ONLY_EXCLUSION } from '../../sync/local-only-fields.js';
import { checkEdgeLinkViolations, checkLinkViolations, MAX_FORK_DEPTH, IncomingFactDoc, IncomingEntityDoc, IncomingEdgeDoc, IncomingChronoDoc, IncomingLinkDoc, IncomingFileMetaDoc, encodeCursor, decodeCursor, callerPeerId, spaceAllowed, pushAllowed, violationsAgainstLocalSchema, withSchemaViolations } from './_shared.js';
import { writeArrivals, arrivalRefusal, arrivalId, warnArrivalsNotStored, type ArrivalOptions, type ArrivalOutcome, type ArrivalRefusal } from '../../sync/arrivals.js';
import { planPushArrivals, type PushDoc, type PushFamily, type PushVerdict } from '../../sync/upsert-plan.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF, type PayloadKey, type ReplicatedFamily } from '../../sync/replicated-families.js';
import { TOMBSTONE_TYPE_OF, KNOWLEDGE_TYPES, type KnowledgeType } from '../../config/types.js';
import { readPageTombstones, readPushStored, readForkContext, deleteSupersededTombstones } from '../../sync/push-reads.js';

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
 * A page is `seq > since`, ordered by `seq`, capped at 500, with ONE extra row fetched so `nextCursor` can
 * be decided without a second query.
 *
 * Tombstones for the same family ride in the same page. Three filters, and each removes a specific way for a
 * deletion to be delivered twice or too early:
 *
 *   - `seq <= pageMaxSeq` — a tombstone with a high seq would otherwise appear on this page AND the next
 *     one, because the cursor only advances to the last ITEM's seq. That was a real duplicate bug.
 *   - not already in `items` — the record is the newer fact, so the deletion is stale within the page.
 *   - `originalSeq > since` — the peer never had the record, so there is nothing to tell it to delete.
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
 * @param extraFilter narrows what the page serves at all. Files use it to serve PARENTS only — a chunk is
 *   derived from the blob and the receiver makes its own, with its own chunker and its own model.
 */
function pageBySeq<T extends { _id: string; seq: number }>(
  collection: string,
  tombstoneType: string | null,
  extraFilter: Record<string, unknown> = {},
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { spaceId, networkId, sinceSeq = '0', limit = '100', cursor, full: fullParam } = req.query as Record<string, string>;
      if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

      const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
      const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
      const returnFull = fullParam === 'true';

      // Settled seqs only: a page that hands out a seq above an unsettled one moves the peer past it (Q-196).
      const found = col<T>(`${spaceId}_${collection}`)
        .find(asFilter<T>({ seq: await settledSeqRange(spaceId, sinceVal), ...extraFilter })).sort({ seq: 1 }).limit(pageSize + 1);
      /*
       * The local-only fields never leave, which is the SAVING rather than the guarantee — a vector is
       * several hundred floats per record and was the bulk of every page. The guarantee is the receiver's
       * strip in `sync/engine.ts`, because a peer decides what it sends and we decide what we store.
       */
      const rawDocs = returnFull
        ? await found.project(LOCAL_ONLY_EXCLUSION).toArray() as T[]
        : await found.project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

      const hasMore = rawDocs.length > pageSize;
      const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
      const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

      const pageMaxSeq = items.length > 0 ? (items[items.length - 1] as { seq: number }).seq : sinceVal;
      // No brain tombstones for a collection whose deletions have their own route — see the parameter doc.
      const tombstones = tombstoneType === null ? [] : await listTombstones(spaceId, sinceVal, pageSize);
      const itemIds = new Set(items.map(i => (i as { _id: string })._id));
      const tombs = tombstones
        .filter(t =>
          t.type === tombstoneType &&
          t.seq <= pageMaxSeq &&
          !itemIds.has(t._id) &&
          (t.originalSeq === undefined || t.originalSeq > sinceVal),
        )
        .map(t => ({ _id: t._id, seq: t.seq, deletedAt: t.deletedAt }));

      res.json({ items: [...items, ...tombs].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq), nextCursor });
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
function oneById<T extends { _id: string }>(collection: string) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { spaceId, networkId } = req.query as Record<string, string>;
      if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

      const doc = await col<T>(`${spaceId}_${collection}`).findOne(asFilter<T>({ _id: req.params['id'] as string }));
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
  pageBySeq<FileMetaDoc & { seq: number }>('files', null, { parentFileId: { $exists: false } }));

syncDocsRouter.get('/facts/:id', syncRateLimit, requireAuth, oneById<FactDoc>('facts'));
syncDocsRouter.get('/entities/:id', syncRateLimit, requireAuth, oneById<EntityDoc>('entities'));
syncDocsRouter.get('/edges/:id', syncRateLimit, requireAuth, oneById<EdgeDoc>('edges'));
syncDocsRouter.get('/chrono/:id', syncRateLimit, requireAuth, oneById<ChronoEntry>('chrono'));
syncDocsRouter.get('/links/:id', syncRateLimit, requireAuth, oneById<LinkDoc>('links'));
syncDocsRouter.get('/filemeta/:id', syncRateLimit, requireAuth, oneById<FileMetaDoc>('files'));

// ═══════════════════════════════════════════════════════════════════════════
// THE PUSH DOOR — every POST below stores what it was sent through one page accept
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The push families, DERIVED: every replicated family, by its batch-upsert body key (`REPLICATED_FAMILIES`).
 * `PLANNED` is NOT ALL BRAIN COLLECTIONS: the families whose deletions ride as brain tombstones are planned
 * against what is stored; file metadata (no tombstone type — a deleted file has its own route) is merged
 * instead. Each family's record type and tombstone type come from `RECORD_TYPE_OF` / `TOMBSTONE_TYPE_OF`, so a
 * seventh family is carried here by being declared there.
 */
type PushKey = PayloadKey;
const FAMILY_BY_KEY = new Map<PushKey, ReplicatedFamily>(REPLICATED_FAMILIES.map(f => [f.payloadKey, f]));
const familyOf = (key: PushKey): ReplicatedFamily => FAMILY_BY_KEY.get(key)!;
const PLANNED = REPLICATED_FAMILIES.filter(f => TOMBSTONE_TYPE_OF[f.collection] !== undefined)
  .map(f => ({ key: f.payloadKey, kind: f.collection as PushFamily, tombstone: TOMBSTONE_TYPE_OF[f.collection]! }));
const MERGED = REPLICATED_FAMILIES.filter(f => TOMBSTONE_TYPE_OF[f.collection] === undefined).map(f => f.payloadKey);

type Pushed = Record<string, unknown> & PushDoc;
interface PushedFamilyResult {
  /** One per document handed in, in order: what sequential processing would have answered. */
  verdicts: PushVerdict[];
  forkIds: Array<string | undefined>;
  /** Why each `rejected` document was refused — the shape rule's words or the store's, for the single routes' 400. */
  reasons: Array<string | undefined>;
  /** The links that landed, for the strict-linkage check. */
  landed: Pushed[];
}

/**
 * Store one family's arrivals through the arrival writer, the record type given at the call from the family's own
 * row of `RECORD_TYPE_OF` — `null` only for links, which carry nothing to embed (CLAUDE.md, "What a receiver does
 * after the write").
 */
async function writePushed(spaceId: string, key: PushKey, docs: readonly Pushed[], opts: ArrivalOptions): Promise<ArrivalOutcome> {
  const { collection } = familyOf(key);
  return await writeArrivals(spaceId, collection, RECORD_TYPE_OF[collection], docs, opts);
}

/**
 * Accept a pushed page — the one path behind `batch-upsert` AND the four single routes, which are a page of one
 * document (`Q-107` part 1 §3, §4). Each route maps the verdicts to the answer it has always given.
 *
 * ## The order, and why each step is where it is
 *
 *  1. **Shape** (`arrivalRefusal`): a document that is not a string id and a seq the counter can carry is
 *     `rejected` on its own, never planned and never bumped over.
 *  2. **Plan** each brain family against what is stored (`planPushArrivals`, pure): one tombstone read for the
 *     request, one stored read per family, and fork reads only for facts that may fork.
 *  3. **Write** the winners through `writeArrivals`. A winner whose write fails (a unique-index duplicate, a store
 *     refusal) is replaced by the version the page accepted before it, so the outcome stays the sequential one.
 *     A stale tombstone is deleted only once its record has LANDED.
 *  4. **Bump** the counter over every plausible seq RECEIVED, awaited, in a `finally`, before anything answers. The
 *     writer bumps over every document it is HANDED; this bump exists only for the ones the planner never hands it
 *     — tombstoned, already current, an unknown chrono type, a fork refused at its cap, the earlier copies of an
 *     id the page collapsed. The counter follows the peer's clock, and a bump over only what landed leaves it
 *     behind exactly where a re-created record is then refused.
 *  5. **Forks**, last: a fork is a LOCAL write and takes a local seq, allocated from a counter that is already past
 *     everything this page carried — so it sorts above the arrival that caused it. The seq hold covers the fork
 *     write alone; its embed jobs are queued after the hold is released.
 */
async function acceptPushedPage(
  spaceId: string, page: Partial<Record<PushKey, Pushed[]>>, pusher: string | undefined,
): Promise<Record<PushKey, PushedFamilyResult>> {
  /*
   * Every operation of the page is bounded (bundle-30 `B2`), not only the fork's inside its hold: a stalled lock on
   * a record or on the counter row would otherwise hang the request with no bound at all, so the door could never
   * answer the retryable 503 a stall is. The fork's hold, nested inside, keeps whichever deadline is sooner.
   */
  return withinWriteBound(async () => {
    // `pusher` is the peer identity the token PROVES (undefined for an admin or local token); `from` names it in logs.
    const from = pusher ?? 'unknown';
    const results = {} as Record<PushKey, PushedFamilyResult>;
    const sound = {} as Record<PushKey, Array<{ index: number; doc: Pushed }>>;
    const refusedAt = {} as Record<PushKey, ArrivalRefusal[]>;
    let maxReceived = 0;
    for (const { payloadKey: key } of REPLICATED_FAMILIES) {
      const docs = page[key] ?? [];
      results[key] = { verdicts: docs.map(() => 'rejected' as PushVerdict), forkIds: docs.map(() => undefined),
        reasons: docs.map(() => undefined), landed: [] };
      sound[key] = [];
      refusedAt[key] = [];
      docs.forEach((doc, index) => {
        const why = arrivalRefusal(doc, { seqOptional: false });
        if (why) { refusedAt[key].push({ _id: arrivalId(doc), reason: why }); results[key].reasons[index] = why; return; }
        sound[key].push({ index, doc });
        if (doc.seq > maxReceived) maxReceived = doc.seq;
      });
      warnArrivalsNotStored(`sync push from ${from}`, spaceId, key, 'refused', refusedAt[key]);
    }

    const forks: Array<{ key: PushKey; index: number; doc: Pushed }> = [];
    let failure: { err: unknown } | undefined;
    try {
      const tombstones = await readPageTombstones(spaceId,
        PLANNED.flatMap(f => sound[f.key].map(s => s.doc._id)));
      const allowedChrono = getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta);
      for (const { key, kind, tombstone } of PLANNED) {
        const items = sound[key];
        if (items.length === 0) continue;
        const docs = items.map(s => s.doc);
        const stored = await readPushStored(spaceId, kind, docs);
        const plan = planPushArrivals(docs, {
          kind, stored, tombstones: tombstones.get(tombstone) ?? new Map(), deliveredBy: pusher,
          allowedTypes: kind === 'chrono' ? allowedChrono : undefined,
          ...(kind === 'facts' ? await readForkContext(spaceId, docs, stored) : {}),
        });
        const res = results[key];
        plan.verdicts.forEach((v, k) => { res.verdicts[items[k]!.index] = v; res.forkIds[items[k]!.index] = plan.forkIds[k]; });
        for (const f of plan.forks) forks.push({ key, index: items[f.index]!.index, doc: f.doc });

        // The winners, then — for any whose write failed — the version accepted before it, until each id lands
        // or runs out of versions.
        let pending = [...plan.accepts.values()].map(list => [...list]);
        const cleanups: Array<{ id: string; below: number }> = [];
        while (pending.length > 0) {
          const out = await writePushed(spaceId, key, pending.map(l => l.at(-1)!.doc), { from });
          const newer = new Set(out.newerLocal);
          const dup = new Set(out.duplicates);
          const refused = new Map(out.refused.map(r => [r._id, r.reason]));
          const next: typeof pending = [];
          for (const list of pending) {
            const top = list.at(-1)!;
            const id = top.doc._id;
            if (newer.has(id)) { for (const a of list) res.verdicts[items[a.index]!.index] = 'skipped'; continue; }
            if (dup.has(id) || refused.has(id)) {
              res.verdicts[items[top.index]!.index] = dup.has(id) ? 'duplicate' : 'rejected';
              res.reasons[items[top.index]!.index] = refused.get(id);
              list.pop();
              if (list.length > 0) next.push(list);
              continue;
            }
            const clean = plan.tombstoneCleanups.get(id);
            if (clean?.onLanding) cleanups.push({ id, below: top.doc.seq });
            if (RECORD_TYPE_OF[kind] === null) res.landed.push(top.doc);
          }
          pending = next;
        }
        for (const [id, c] of plan.tombstoneCleanups) if (!c.onLanding) cleanups.push({ id, below: c.below });
        await deleteSupersededTombstones(spaceId, tombstone, cleanups);
      }

      // A file's metadata: merged, never replaced, and per document until `Q-107` part 2. No tombstone rides here
      // — a deleted file has its own route (`/api/sync/file-tombstones`).
      for (const key of MERGED) {
        if (sound[key].length === 0) continue;
        const out = await writePushed(spaceId, key, sound[key].map(s => s.doc), { from });
        const verdictOf = new Map<string, PushVerdict>();
        for (const id of [...out.inserted, ...out.updated]) verdictOf.set(id, 'upserted');
        for (const id of [...out.newerLocal, ...out.derived]) verdictOf.set(id, 'skipped');
        for (const r of out.refused) verdictOf.set(r._id, 'rejected');
        const why = new Map(out.refused.map(r => [r._id, r.reason]));
        for (const s of sound[key]) {
          results[key].verdicts[s.index] = verdictOf.get(s.doc._id) ?? 'skipped';
          results[key].reasons[s.index] = why.get(s.doc._id);
        }
      }
    } catch (err) {
      failure = { err };
    }
    // Step 4, whatever became of the write — and the write's own error is the one thrown (`Q-224`): a bump that
    // threw from a `finally` replaced it, so a page that failed on its records was reported as a counter fault.
    const behind = await advanceCounterPast(spaceId, maxReceived, `sync push from ${from}`);
    if (failure) throw failure.err;
    if (behind) throw behind;

    if (forks.length > 0) {
      const now = new Date().toISOString();
      let forkOut: ArrivalOutcome | undefined;
      await withAllocatedSeqs(spaceId, forks.length, async (first) => {
        forkOut = await writePushed(spaceId, 'facts',
          forks.map((f, k) => ({ ...f.doc, seq: first + k, createdAt: now, updatedAt: now })), { from, deferEnqueue: true });
      }, 'sync.push.fork');
      await forkOut?.enqueue();
      const failed = new Set([...(forkOut?.refused.map(r => r._id) ?? []), ...(forkOut?.duplicates ?? [])]);
      for (const f of forks) {
        if (!failed.has(f.doc._id)) continue;
        results[f.key].verdicts[f.index] = 'rejected';
        results[f.key].forkIds[f.index] = undefined;
      }
    }
    return results;
  });
}

/** The peer identity the request's token proves, or undefined (an admin or local token). */
const pusherOf = (req: Request): string | undefined => callerPeerId(req.authToken as Record<string, unknown>);
const peerOf = (req: Request): string => pusherOf(req) ?? 'unknown';
const forkCapError = (id: string) => ({ error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id '${id}'` });
/**
 * A refused document's 400, in the words of the rule that refused it — the arrival writer's shape check
 * (`arrivalRefusal`: an implausible seq answers `seq N is too close to the protocol ceiling and was refused`, as
 * it always did) or the store's. One source for the text, so a route cannot phrase a refusal of its own.
 */
const refusedError = (r: PushedFamilyResult) => ({ error: r.reasons[0] ?? 'the document was refused and was not written' });

/**
 * POST /api/sync/facts?spaceId=&networkId=
 * Upsert a fact received from a peer: a page of one through `acceptPushedPage`.
 * Conflict rule: higher seq wins; equal seq with different text forks; the fork caps answer 400.
 */
syncDocsRouter.post('/facts', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const parsed = IncomingFactDoc.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid fact document' }); return; }
    const incoming = parsed.data as unknown as Pushed;
    // Reported on every exit that KEPT something; `tombstoned` and `skipped` store nothing to describe.
    const violations = violationsAgainstLocalSchema(spaceId, 'fact', incoming);

    const { facts } = await acceptPushedPage(spaceId, { facts: [incoming] }, pusherOf(req));
    const verdict = facts.verdicts[0];
    if (verdict === 'inserted' || verdict === 'updated') { res.status(200).json(withSchemaViolations({ status: verdict }, violations)); return; }
    if (verdict === 'forked') { res.status(200).json(withSchemaViolations({ status: 'forked', forkId: facts.forkIds[0] }, violations)); return; }
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'forkRefused') { res.status(400).json(forkCapError(incoming._id)); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(facts)); return; }
    res.status(200).json({ status: 'skipped' });
  } catch (err) {
    sendSyncWriteFailure(res, 'sync POST facts', err);
  }
});

/**
 * POST /api/sync/entities — `ok` whether the copy was applied or was older than what is held; `tombstoned`
 * when a deletion at or above it is held. A NEW entity is written and queued for embedding like any other
 * arrival: it used to be inserted by a raw `$setOnInsert` that never reached the embedder.
 */
syncDocsRouter.post('/entities', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const parsed = IncomingEntityDoc.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid entity document' }); return; }
    const incoming = parsed.data as unknown as Pushed;
    const violations = violationsAgainstLocalSchema(spaceId, 'entity', incoming);

    const { entities } = await acceptPushedPage(spaceId, { entities: [incoming] }, pusherOf(req));
    const verdict = entities.verdicts[0];
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(entities)); return; }
    res.status(200).json(withSchemaViolations({ status: 'ok' }, violations));
  } catch (err) {
    sendSyncWriteFailure(res, 'sync POST entities', err);
  }
});

/**
 * POST /api/sync/edges — `ok`, `tombstoned`, or `duplicate` when the edge's triplet is already held here under
 * another id: the record did NOT land, and a sender that cannot tell the two apart advances its watermark
 * believing it delivered something it did not. A duplicate is a 200, never a 500, or the sender would re-send
 * the identical push for ever.
 */
syncDocsRouter.post('/edges', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const parsed = IncomingEdgeDoc.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid edge document' }); return; }
    const incoming = parsed.data as unknown as Pushed;
    const violations = violationsAgainstLocalSchema(spaceId, 'edge', incoming);

    const { edges } = await acceptPushedPage(spaceId, { edges: [incoming] }, pusherOf(req));
    const verdict = edges.verdicts[0];
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(edges)); return; }
    // Records, never blocks: what the edge points at that is not here (strict linkage only).
    checkEdgeLinkViolations(spaceId, incoming as unknown as EdgeDoc, peerOf(req)).catch(() => {});
    res.status(200).json(withSchemaViolations({ status: verdict === 'duplicate' ? 'duplicate' : 'ok' }, violations));
  } catch (err) {
    sendSyncWriteFailure(res, 'sync POST edges', err);
  }
});

/**
 * POST /api/sync/chrono — `ok` or `tombstoned`; a `type` outside this space's vocabulary is a 400.
 *
 * A TYPE NOBODY UNDERSTANDS IS REFUSED; a schema mismatch is reported (P-21 = C). A peer validated the record
 * against ITS schema, so a property mismatch is not the receiver's to refuse — but a chrono whose `type` is in
 * neither the product's vocabulary nor anything this space declared is meaningless to every reader, and
 * `IncomingChronoDoc` types the field as any string. The refusal is the planner's `unknownType`, the same rule the
 * batch door counts, so the two cannot drift; the counter is still bumped over its seq, because it was received.
 */
syncDocsRouter.post('/chrono', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const parsed = IncomingChronoDoc.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid chrono document' }); return; }
    const incoming = parsed.data as unknown as Pushed;
    const violations = violationsAgainstLocalSchema(spaceId, 'chrono', incoming);

    const { chrono } = await acceptPushedPage(spaceId, { chrono: [incoming] }, pusherOf(req));
    const verdict = chrono.verdicts[0];
    if (verdict === 'unknownType') {
      const allowed = getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta);
      res.status(400).json({ error: `\`type\` must be one of: ${[...allowed].join(', ')}` });
      return;
    }
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(chrono)); return; }
    res.status(200).json(withSchemaViolations({ status: 'ok' }, violations));
  } catch (err) {
    sendSyncWriteFailure(res, 'sync POST chrono', err);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// BATCH UPSERT
// ═══════════════════════════════════════════════════════════════════════════

/** Documents per family per request. What is sent past it is counted `rejected`, never dropped unsaid. */
const BATCH_FAMILY_CAP = 500;

type SafeParser = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } };

/**
 * The `Incoming*` schema each family is validated against — the one hand-written family table here, because a
 * schema is a fact about the wire that no registry can derive. Keyed by the DERIVED family list, and checked at
 * load against it, so a family added to `REPLICATED_FAMILIES` without a schema stops the server rather than being
 * dropped with a 200 at the boundary.
 */
const BATCH_SCHEMAS: Readonly<Partial<Record<PushKey, { schema: SafeParser; name: string }>>> = {
  facts: { schema: IncomingFactDoc, name: 'IncomingFactDoc' },
  entities: { schema: IncomingEntityDoc, name: 'IncomingEntityDoc' },
  edges: { schema: IncomingEdgeDoc, name: 'IncomingEdgeDoc' },
  chrono: { schema: IncomingChronoDoc, name: 'IncomingChronoDoc' },
  links: { schema: IncomingLinkDoc, name: 'IncomingLinkDoc' },
  filemeta: { schema: IncomingFileMetaDoc, name: 'IncomingFileMetaDoc' },
};
{
  const keys: readonly string[] = REPLICATED_FAMILIES.map(f => f.payloadKey);
  const missing = keys.filter(k => !(k in BATCH_SCHEMAS));
  const extra = Object.keys(BATCH_SCHEMAS).filter(k => !keys.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`batch-upsert schemas do not match the replicated families: missing [${missing}], extra [${extra}]`);
  }
}

/** The knowledge type a family's documents are checked against in this space's schema, or none (links, files). */
const schemaKindOf = (key: PushKey): KnowledgeType | undefined => {
  const rt = RECORD_TYPE_OF[familyOf(key).collection];
  return rt !== null && (KNOWLEDGE_TYPES as readonly string[]).includes(rt) ? rt as KnowledgeType : undefined;
};

/**
 * POST /api/sync/batch-upsert?spaceId=&networkId=
 * Arrays of up to 500 documents per family, all six families, one page accept. Same conflict rules as the single
 * routes — they ARE the same code — and every family answers its counters.
 */
syncDocsRouter.post('/batch-upsert', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const peer = peerOf(req);
    const body = req.body as Partial<Record<PushKey, unknown[]>>;
    /*
     * A document the schema rejects is REPORTED, never silently removed — the count goes back in `rejected`,
     * which the sender subtracts from what it calls pushed, and a warning names it. So does everything past the
     * 500 cap: it used to be sliced off before counting, so the sender advanced its watermark past it.
     */
    const dropped = {} as Record<PushKey, number>;
    const page = {} as Record<PushKey, Pushed[]>;
    const raw = Object.fromEntries(REPLICATED_FAMILIES.map(({ payloadKey: k }) =>
      [k, Array.isArray(body?.[k]) ? body[k]! : []])) as Record<PushKey, unknown[]>;
    for (const { payloadKey: key } of REPLICATED_FAMILIES) {
      const { schema, name } = BATCH_SCHEMAS[key]!;
      const overflow = Math.max(0, raw[key].length - BATCH_FAMILY_CAP);
      dropped[key] = overflow;
      if (overflow > 0) {
        log.warn(`batch-upsert: ${overflow} ${key} document(s) past the ${BATCH_FAMILY_CAP}-per-family cap for space `
          + `'${spaceId}' from peer '${logSafe(peer)}' were REJECTED; the sender offers them again in its next page.`);
      }
      const misfits: ArrivalRefusal[] = [];
      page[key] = raw[key].slice(0, BATCH_FAMILY_CAP).flatMap((d) => {
        const parsed = schema.safeParse(d);
        if (parsed.success) return [parsed.data as Pushed];
        dropped[key]++;
        misfits.push({ _id: arrivalId(d), reason: `not ${name}: ${JSON.stringify(parsed.error?.issues ?? []).slice(0, 200)}` });
        return [];
      });
      // One warning per page, the shape every door logs a refusal in — never a line per document.
      warnArrivalsNotStored(`sync batch-upsert from ${peer}`, spaceId, key, 'REJECTED by the wire schema (the sender '
        + 'advances past them)', misfits);
    }
    // P-21 = C: validated against THIS space's schema, counted, and let in — never refused for it.
    const violated = (key: PushKey): number => {
      const kind = schemaKindOf(key);
      return kind === undefined ? 0 : page[key].filter(d => violationsAgainstLocalSchema(spaceId, kind, d).length > 0).length;
    };

    const out = await acceptPushedPage(spaceId, page, pusherOf(req));

    const count = (key: PushKey, v: PushVerdict) => out[key].verdicts.filter(x => x === v).length;
    const rejected = (key: PushKey, ...also: PushVerdict[]) =>
      dropped[key] + count(key, 'rejected') + also.reduce((n, v) => n + count(key, v), 0);
    for (const link of out.links.landed) checkLinkViolations(spaceId, link as never, peer).catch(() => {});

    /*
     * The counters count ITEMS, as processing the page in order counted them. `skipped` is "already current"
     * (benign) and `forkDepthRefused` is a record DROPPED — one counter until 2026-08-19, which is why the lossy
     * one had never been seen.
     */
    const memStats = { inserted: count('facts', 'inserted'), updated: count('facts', 'updated'), forked: count('facts', 'forked'), skipped: count('facts', 'skipped'), forkDepthRefused: count('facts', 'forkRefused'), tombstoned: count('facts', 'tombstoned'), schemaViolations: violated('facts') };
    const entStats = { upserted: count('entities', 'upserted'), skipped: count('entities', 'skipped'), tombstoned: count('entities', 'tombstoned'), schemaViolations: violated('entities') };
    const edgeStats = { upserted: count('edges', 'upserted'), skipped: count('edges', 'skipped'), tombstoned: count('edges', 'tombstoned'), schemaViolations: violated('edges'), duplicateTriplets: count('edges', 'duplicate') };
    const chronoStats = { upserted: count('chrono', 'upserted'), skipped: count('chrono', 'skipped'), tombstoned: count('chrono', 'tombstoned'), schemaViolations: violated('chrono'), unknownType: count('chrono', 'unknownType') };
    // A link arriving under another id for endpoints already linked IS that link: skipped, never a fault.
    const linkStats = { upserted: count('links', 'upserted'), skipped: count('links', 'skipped') + count('links', 'duplicate'), tombstoned: count('links', 'tombstoned') };
    const fileMetaStats = { upserted: count('filemeta', 'upserted'), skipped: count('filemeta', 'skipped') };

    /*
     * A DROPPED RECORD is logged HERE, because this is the side that knows why: divergent content at an equal
     * seq that cannot fork any further, so the incoming version is discarded — and the sender advances past it.
     * Holding the watermark back would re-push a record refused identically every cycle; the fix is visibility.
     */
    const droppedForks = page.facts.filter((_, i) => out.facts.verdicts[i] === 'forkRefused').map(d => d._id);
    warnArrivalsNotStored(`sync batch-upsert from ${peer}`, spaceId, 'facts', 'DROPPED — divergent content at an '
      + `equal seq whose fork chain or fan-out is at its cap (MAX_FORK_DEPTH=${MAX_FORK_DEPTH}); the sender will not `
      + 'offer them again. Resolve the fork chain to accept them', droppedForks);

    // X-20: a 200 says the batch was accepted, not that a record was stored. What each document became is in the
    // counters, and the seq range says WHICH records they refer to — with DEBUG on, beside the sender's own line.
    const range = (docs: Pushed[]): string => (docs.length === 0 ? '-'
      : `${Math.min(...docs.map(d => d.seq))}..${Math.max(...docs.map(d => d.seq))}`);
    log.debug(`Batch-upsert accepted for space '${spaceId}': facts ${JSON.stringify(memStats)} seq ${range(page.facts)}; `
      + `entities ${JSON.stringify(entStats)} seq ${range(page.entities)}; edges ${JSON.stringify(edgeStats)} seq ${range(page.edges)}; `
      + `chrono ${JSON.stringify(chronoStats)} seq ${range(page.chrono)}; links ${JSON.stringify(linkStats)} seq ${range(page.links)}; `
      + `filemeta ${JSON.stringify(fileMetaStats)} seq ${range(page.filemeta)}`);

    /*
     * ALL SIX FAMILIES answer, with `rejected` per family (Q-59): what the sender must NOT count as delivered —
     * schema-invalid, past the 500 cap, an implausible seq, a store refusal, a fork at its cap, a chrono type this
     * space does not declare. `push-refusals.ts` reads it off the response, so a family absent here is a family
     * whose refusals are silent at both ends.
     */
    res.status(200).json({
      status: 'ok',
      facts: { ...memStats, rejected: rejected('facts', 'forkRefused') },
      entities: { ...entStats, rejected: rejected('entities') },
      edges: { ...edgeStats, rejected: rejected('edges') },
      chrono: { ...chronoStats, rejected: rejected('chrono', 'unknownType') },
      links: { ...linkStats, rejected: rejected('links') },
      filemeta: { ...fileMetaStats, rejected: rejected('filemeta') },
    });
  } catch (err) {
    sendSyncWriteFailure(res, 'sync POST batch-upsert', err);
  }
});
