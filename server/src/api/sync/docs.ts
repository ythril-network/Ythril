/**
 * Peer document sync — the five record families plus batch-upsert.
 *
 * Split out of the api/sync.ts monolith (A17.6). The two READS are now one function each rather than four
 * copies apiece: see `pageBySeq` for what a page is and which tombstones ride in it, and why `M-2`'s fifth
 * family is what forced the extraction.
 */
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { col, asFilter, asDoc, asUpdate } from '../../db/mongo.js';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getAllowedChronoTypes } from '../../spaces/schema-validation.js';
import { getConfig } from '../../config/loader.js';
import { listTombstones } from '../../brain/tombstones.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { log } from '../../util/log.js';
import { reportServerFailure } from '../../util/report-failure.js';
import { nextSeq, bumpSeq, isSeqImplausible, MAX_INGEST_SEQ } from '../../util/seq.js';
import type { FactDoc, EntityDoc, EdgeDoc, ChronoEntry, LinkDoc, TombstoneDoc } from '../../config/types.js';
import type { FileMetaDoc } from '../../config/types.js';
import { LOCAL_ONLY_EXCLUSION } from '../../sync/local-only-fields.js';
import { checkEdgeLinkViolations, checkLinkViolations, MAX_FORK_DEPTH, IncomingFactDoc, IncomingEntityDoc, IncomingEdgeDoc, IncomingChronoDoc, IncomingLinkDoc, IncomingFileMetaDoc, ingestFileMeta, encodeCursor, decodeCursor, forkChainDepth, rejectImplausibleSeq, callerPeerId, spaceAllowed, isNonPeerSyncWrite, NON_PEER_WRITE_MESSAGE, isDirectionalWriteBlocked, violationsAgainstLocalSchema, withSchemaViolations, isDuplicateKeyOnly, ingestBrainDoc } from './_shared.js';

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

      const found = col<T>(`${spaceId}_${collection}`)
        .find(asFilter<T>({ seq: { $gt: sinceVal }, ...extraFilter })).sort({ seq: 1 }).limit(pageSize + 1);
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
 * `memories/:id` logged `err` through `log.error`, the other three through `reportServerFailure` — which
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
syncDocsRouter.get('/memories', syncRateLimit, requireAuth, pageBySeq<FactDoc>('facts', 'fact'));
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

syncDocsRouter.get('/memories/:id', syncRateLimit, requireAuth, oneById<FactDoc>('facts'));
syncDocsRouter.get('/entities/:id', syncRateLimit, requireAuth, oneById<EntityDoc>('entities'));
syncDocsRouter.get('/edges/:id', syncRateLimit, requireAuth, oneById<EdgeDoc>('edges'));
syncDocsRouter.get('/chrono/:id', syncRateLimit, requireAuth, oneById<ChronoEntry>('chrono'));
syncDocsRouter.get('/links/:id', syncRateLimit, requireAuth, oneById<LinkDoc>('links'));
syncDocsRouter.get('/filemeta/:id', syncRateLimit, requireAuth, oneById<FileMetaDoc>('files'));


/**
 * GET /api/sync/memories/:id?spaceId=
 * Fetch a single full memory document.
 */


/**
 * POST /api/sync/memories?spaceId=&networkId=
 * Upsert a memory received from a peer.
 * Conflict rule: higher seq wins; equal seq forks.
 */
syncDocsRouter.post('/memories', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

    const parsed = IncomingFactDoc.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid memory document' });
      return;
    }
    const incoming = parsed.data as FactDoc;
    if (rejectImplausibleSeq(spaceId, incoming.seq, res, callerPeerId(req.authToken as Record<string, unknown>))) return;

    // Computed before any store, and reported on every exit that KEPT something. The `tombstoned` and
    // `skipped` exits store nothing, so there is no accepted record for them to describe.
    const violations = violationsAgainstLocalSchema(spaceId, 'fact', incoming as unknown as Record<string, unknown>);

    // Check for tombstone — if a tombstone with >= seq exists, skip
    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'fact' })) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }
    // Clean up stale tombstone superseded by the incoming document
    if (tombstone) {
      await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));
    }

    const existing = await col<FactDoc>(`${spaceId}_facts`)
      .findOne(asFilter<FactDoc>({ _id: incoming._id })) as FactDoc | null;

    if (!existing) {
      // No local copy — insert directly
      await ingestBrainDoc<FactDoc>(spaceId, 'fact', 'facts', incoming);
      const peerInst = (req.authToken as Record<string, unknown>)?.['peerInstanceId'] as string ?? 'unknown';
      checkLinkViolations(spaceId, incoming._id, 'fact', incoming, peerInst).catch(() => {});
      res.status(200).json(withSchemaViolations({ status: 'inserted' }, violations));
      return;
    }

    if (incoming.seq > existing.seq) {
      // Remote is newer — overwrite
      await ingestBrainDoc<FactDoc>(spaceId, 'fact', 'facts', incoming);
      const peerInst = (req.authToken as Record<string, unknown>)?.['peerInstanceId'] as string ?? 'unknown';
      checkLinkViolations(spaceId, incoming._id, 'fact', incoming, peerInst).catch(() => {});
      res.status(200).json(withSchemaViolations({ status: 'updated' }, violations));
      return;
    }

    if (incoming.seq === existing.seq && incoming.fact !== existing.fact) {
      // Concurrent independent edit — fork; but cap both chain depth and fan-out.
      const depth = await forkChainDepth(spaceId, incoming._id);
      if (depth >= MAX_FORK_DEPTH) {
        res.status(400).json({ error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id '${incoming._id}'` });
        return;
      }
      // Also cap fan-out: count how many forks already point to this document.
      const siblingCount = await col<FactDoc>(`${spaceId}_facts`)
        .countDocuments(asFilter<FactDoc>({ forkOf: incoming._id }), { limit: MAX_FORK_DEPTH + 1 });
      if (siblingCount >= MAX_FORK_DEPTH) {
        res.status(400).json({ error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id '${incoming._id}'` });
        return;
      }
      const forkSeq = await nextSeq(spaceId);
      const fork: FactDoc = {
        ...incoming,
        _id: uuidv4(),
        forkOf: incoming._id,
        seq: forkSeq,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await ingestBrainDoc<FactDoc>(spaceId, 'fact', 'facts', fork);
      res.status(200).json(withSchemaViolations({ status: 'forked', forkId: fork._id }, violations));
      return;
    }

    res.status(200).json({ status: 'skipped' });
  } catch (err) {
    log.error(`sync POST facts: ${err}`);
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

    const parsed = IncomingEntityDoc.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid entity document' });
      return;
    }
    const incoming = parsed.data as EntityDoc;
    if (rejectImplausibleSeq(spaceId, incoming.seq, res, callerPeerId(req.authToken as Record<string, unknown>))) return;

    // Before the upsert, so the record reported on is the one the peer sent rather than whatever the
    // store settled on. The `tombstoned` exit keeps nothing and so reports nothing.
    const violations = violationsAgainstLocalSchema(spaceId, 'entity', incoming as unknown as Record<string, unknown>);

    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'entity' })) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }
    if (tombstone) {
      await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));
    }

    await col<EntityDoc>(`${spaceId}_entities`).updateOne(
      asFilter<EntityDoc>({ _id: incoming._id }),
      asUpdate<EntityDoc>({ $setOnInsert: incoming }),
      { upsert: true },
    );

    // Merge tags on conflict
    const existing = await col<EntityDoc>(`${spaceId}_entities`).findOne(asFilter<EntityDoc>({ _id: incoming._id })) as EntityDoc;
    if (existing && incoming.seq > existing.seq) {
      await ingestBrainDoc<EntityDoc>(spaceId, 'entity', 'entities', incoming);
    }

    res.status(200).json(withSchemaViolations({ status: 'ok' }, violations));
  } catch (err) {
    log.error(`sync POST entities: ${err}`);
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

    const parsed = IncomingEdgeDoc.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid edge document' });
      return;
    }
    const incoming = parsed.data as EdgeDoc;
    if (rejectImplausibleSeq(spaceId, incoming.seq, res, callerPeerId(req.authToken as Record<string, unknown>))) return;

    // Before the upsert, so the record reported on is the one the peer sent rather than whatever the
    // store settled on. The `tombstoned` exit keeps nothing and so reports nothing.
    const violations = violationsAgainstLocalSchema(spaceId, 'edge', incoming as unknown as Record<string, unknown>);

    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'edge' })) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }
    if (tombstone) {
      await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));
    }

    const existing = await col<EdgeDoc>(`${spaceId}_edges`).findOne(asFilter<EdgeDoc>({ _id: incoming._id })) as EdgeDoc | null;
    let duplicateTriplet = false;
    if (!existing || incoming.seq > existing.seq) {
      /*
       * A duplicate TRIPLET is a 200, not a 500 — see `isDuplicateKeyOnly`.
       *
       * The upsert is keyed on `_id`, which this peer has never seen, so it inserts; the space's unique
       * `{ from, to, label }` index then rejects it because the same relationship already exists locally under
       * a different random id. Letting that reach the route's catch answers 500, and a non-ok push makes the
       * SENDER hold its watermark and re-send the identical batch every cycle — the edges channel to that
       * peer never advances again.
       *
       * Same policy as the pull side: the local copy stands, the incoming one is not applied, and the caller
       * is told which it was rather than left to infer it from a status code.
       */
      try {
        await ingestBrainDoc<EdgeDoc>(spaceId, 'edge', 'edges', incoming);
      } catch (err) {
        if (!isDuplicateKeyOnly(err)) throw err;
        duplicateTriplet = true;
        log.warn(
          `sync POST edges: '${incoming._id}' duplicates an existing triplet `
          + `(${incoming.from} -[${incoming.label}]-> ${incoming.to}) in space '${spaceId}'. The local copy is `
          + 'kept and the incoming one is not applied.',
        );
      }
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
    log.error(`sync POST edges: ${err}`);
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

    const parsed = IncomingChronoDoc.safeParse(req.body);
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
    if (!getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta).has(incoming.type)) {
      res.status(400).json({ error: `\`type\` must be one of: ${[...getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta)].join(', ')}` });
      return;
    }
    const chronoViolations = violationsAgainstLocalSchema(spaceId, 'chrono', incoming as unknown as Record<string, unknown>);

    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'chrono' })) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }
    if (tombstone) {
      await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));
    }

    const existing = await col<ChronoEntry>(`${spaceId}_chrono`).findOne(asFilter<ChronoEntry>({ _id: incoming._id })) as ChronoEntry | null;
    if (!existing || incoming.seq > existing.seq) {
      await ingestBrainDoc<ChronoEntry>(spaceId, 'chrono', 'chrono', incoming);
    }

    // Fire-and-forget: check strict linkage violations after ingest
    const peerInst = (req.authToken as Record<string, unknown>)?.['peerInstanceId'] as string ?? 'unknown';
    checkLinkViolations(spaceId, incoming._id, 'chrono', incoming, peerInst).catch(() => {});

    // The violations travel back so the receiving operator can see what arrived out of shape. Absent when
    // there are none, so a clean ingest keeps its existing response byte for byte.
    res.status(200).json(withSchemaViolations({ status: 'ok' }, chronoViolations));
  } catch (err) {
    log.error(`sync POST chrono: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// BATCH UPSERT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/sync/batch-upsert?spaceId=&networkId=
 * Accept arrays of memories, entities and/or edges and upsert them all in one
 * request.  Same conflict rules as the individual POST endpoints.
 * Limits: 500 docs per type per request to cap payload size.
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
     * This used to be a bare `flatMap` returning `[]` on a failed `safeParse`, and the comment below still says
     * "batch ingest already skips invalid documents silently" as though that were harmless. It was not: the
     * document left the batch, was counted in no statistic, and the receiver answered 200 — after which the
     * sender advanced its watermark and never offered the record again. A required `embedding` on
     * `IncomingFactDoc` made that the ordinary fate of every suppressed memory.
     *
     * The schema is fixed; the silence is fixed separately, because the next mismatch between a stored document
     * and its `Incoming*` schema would otherwise lose records the same way and be just as invisible. Same
     * warning shape as the implausible-seq drop below — kind, id, space, peer — so both read alike in a log.
     */
    const parsed = <T>(raw: unknown[], schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } }, kind: string): T[] =>
      raw.flatMap(d => {
        const r = schema.safeParse(d);
        if (r.success) return [r.data as T];
        const id = (d as { _id?: unknown })?._id;
        log.warn(
          `batch-upsert: REJECTED ${kind} '${typeof id === 'string' ? id : '(no id)'}' for space '${spaceId}' `
          + `from peer '${callerPeerId(req.authToken as Record<string, unknown>) ?? 'unknown'}' — it did not `
          + `match ${kind === 'fact' ? 'IncomingFactDoc' : `Incoming${kind[0]!.toUpperCase()}${kind.slice(1)}Doc`}. `
          + `The sender will advance past it and not offer it again. Issues: `
          + `${JSON.stringify(r.error?.issues ?? []).slice(0, 400)}`,
        );
        return [];
      });

    const memoriesRaw = parsed<FactDoc>(Array.isArray(body?.facts) ? body.facts.slice(0, 500) : [], IncomingFactDoc, 'fact');
    const entitiesRaw = parsed<EntityDoc>(Array.isArray(body?.entities) ? body.entities.slice(0, 500) : [], IncomingEntityDoc, 'entity');
    const edgesRaw = parsed<EdgeDoc>(Array.isArray(body?.edges) ? body.edges.slice(0, 500) : [], IncomingEdgeDoc, 'edge');
    const chronoRaw = parsed<ChronoEntry>(Array.isArray(body?.chrono) ? body.chrono.slice(0, 500) : [], IncomingChronoDoc, 'chrono');
    const linksRaw = parsed<LinkDoc>(Array.isArray(body?.links) ? body.links.slice(0, 500) : [], IncomingLinkDoc, 'link');
    /*
     * A file's METADATA — the sixth family (`P-32`).
     *
     * A CHUNK sent here is REPORTED by `parsed` rather than stripped, because `IncomingFileMetaDoc` refuses
     * `parentFileId` outright: zod would otherwise drop the key and the chunk would land as a FILE, carrying
     * another instance's passage text under an id ending in `#0`.
     */
    const fileMetaRaw = parsed<FileMetaDoc & { seq: number }>(
      Array.isArray(body?.filemeta) ? body.filemeta.slice(0, 500) : [],
      IncomingFileMetaDoc as never, 'filemeta');

    // Drop documents whose seq is too close to the protocol ceiling — one such
    // doc would otherwise drag the counter toward it via the bumpSeq below (see
    // util/seq.ts). Schema-invalid documents are reported by `parsed` above, so
    // these are dropped on the same footing — a warning naming the record, not fatal.
    const plausible = <T extends { seq: number; _id: string }>(docs: T[], kind: string): T[] =>
      docs.filter(d => {
        if (!isSeqImplausible(d.seq)) return true;
        log.warn(
          `batch-upsert: dropped ${kind} '${d._id}' with implausible seq ${d.seq} ` +
          `for space '${spaceId}' (max ingest seq ${MAX_INGEST_SEQ}) from peer ` +
          `'${callerPeerId(req.authToken as Record<string, unknown>) ?? 'unknown'}'.`,
        );
        return false;
      });
    const memories = plausible(memoriesRaw, 'fact');
    const entities = plausible(entitiesRaw, 'entity');
    const edges = plausible(edgesRaw, 'edge');
    const chrono = plausible(chronoRaw, 'chrono');
    const links = plausible(linksRaw, 'link');
    const fileMeta = plausible(fileMetaRaw, 'filemeta');

    // ── Memories ─────────────────────────────────────────────────────────
    // `skipped` = the peer is already current (benign). `forkDepthRefused` = a record was DROPPED. They were
    // one counter until 2026-08-19, which is why the lossy one had never been seen.
    const memStats = { inserted: 0, updated: 0, forked: 0, skipped: 0, forkDepthRefused: 0, tombstoned: 0, schemaViolations: 0 };
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
    for (const incoming of memories) {
      if (violationsAgainstLocalSchema(spaceId, 'fact', incoming as unknown as Record<string, unknown>).length > 0) memStats.schemaViolations++;
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'fact' })) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { memStats.tombstoned++; continue; }
      if (tomb) await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));

      const existing = await col<FactDoc>(`${spaceId}_facts`)
        .findOne(asFilter<FactDoc>({ _id: incoming._id })) as FactDoc | null;
      if (!existing) {
        await ingestBrainDoc<FactDoc>(spaceId, 'fact', 'facts', incoming);
        memStats.inserted++;
      } else if (incoming.seq > existing.seq) {
        await ingestBrainDoc<FactDoc>(spaceId, 'fact', 'facts', incoming);
        memStats.updated++;
      } else if (incoming.seq === existing.seq && incoming.fact !== existing.fact) {
        // Cap fork chains to prevent unbounded growth
        const depth = await forkChainDepth(spaceId, incoming._id);
        if (depth >= MAX_FORK_DEPTH) {
          /*
           * A DROPPED RECORD, and it used to be counted as `skipped` alongside "I already have this".
           *
           * Those two outcomes could not be more different. The common `skipped` — `existing.seq >=
           * incoming.seq` — means the peer is already current: nothing is lost and the sender is right to
           * advance past it. THIS one means divergent content at the same seq that cannot fork any deeper,
           * so the incoming version is discarded. Sharing one integer made the lossy case unobservable, and
           * `sync/engine.ts` reads only `resp.ok` — so the sender advances its watermark past it and never
           * sends it again.
           *
           * Counted apart and logged HERE because this is the side that knows why. It does not change
           * delivery: holding the watermark back would re-push a record the peer will refuse identically
           * every cycle. The fix is visibility, exactly as the media-worker swallow was.
           */
          memStats.forkDepthRefused++;
          log.warn(`sync batch-upsert: DROPPED memory ${incoming._id} in '${spaceId}' — divergent content at `
            + `seq ${incoming.seq} and the fork chain is already ${depth} deep (MAX_FORK_DEPTH=${MAX_FORK_DEPTH}). `
            + 'The sender will not offer it again. Resolve the fork chain to accept it.');
          continue;
        }

        const forkSeq = await nextSeq(spaceId);
        const fork: FactDoc = {
          ...incoming, _id: uuidv4(), forkOf: incoming._id, seq: forkSeq,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        await ingestBrainDoc<FactDoc>(spaceId, 'fact', 'facts', fork);
        memStats.forked++;
      } else {
        memStats.skipped++;
      }
    }

    // ── Entities ─────────────────────────────────────────────────────────
    const entStats = { upserted: 0, skipped: 0, tombstoned: 0, schemaViolations: 0 };
    for (const incoming of entities) {
      if (violationsAgainstLocalSchema(spaceId, 'entity', incoming as unknown as Record<string, unknown>).length > 0) entStats.schemaViolations++;
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'entity' })) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { entStats.tombstoned++; continue; }
      if (tomb) await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));

      const existing = await col<EntityDoc>(`${spaceId}_entities`)
        .findOne(asFilter<EntityDoc>({ _id: incoming._id })) as EntityDoc | null;
      if (!existing || incoming.seq > existing.seq) {
        await ingestBrainDoc<EntityDoc>(spaceId, 'entity', 'entities', incoming);
        entStats.upserted++;
      } else {
        entStats.skipped++;
      }
    }

    // ── Edges ─────────────────────────────────────────────────────────────
    const edgeStats = { upserted: 0, skipped: 0, tombstoned: 0, schemaViolations: 0, duplicateTriplets: 0 };
    for (const incoming of edges) {
      if (violationsAgainstLocalSchema(spaceId, 'edge', incoming as unknown as Record<string, unknown>).length > 0) edgeStats.schemaViolations++;
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'edge' })) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { edgeStats.tombstoned++; continue; }
      if (tomb) await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));

      const existing = await col<EdgeDoc>(`${spaceId}_edges`)
        .findOne(asFilter<EdgeDoc>({ _id: incoming._id })) as EdgeDoc | null;
      if (!existing || incoming.seq > existing.seq) {
        // The same absorption as the single-record route above. Worse here if it were missing: one duplicate
        // triplet anywhere in a 500-record page would 500 the WHOLE batch, so every other record in it is
        // discarded too — and the sender re-sends that identical page for ever.
        try {
          await ingestBrainDoc<EdgeDoc>(spaceId, 'edge', 'edges', incoming);
          edgeStats.upserted++;
        } catch (err) {
          if (!isDuplicateKeyOnly(err)) throw err;
          edgeStats.duplicateTriplets++;
          log.warn(
            `sync batch-upsert: edge '${incoming._id}' duplicates an existing triplet `
            + `(${incoming.from} -[${incoming.label}]-> ${incoming.to}) in space '${spaceId}'. The local copy `
            + 'is kept and the incoming one is not applied.',
          );
        }
      } else {
        edgeStats.skipped++;
      }
    }

    // ── Chrono ─────────────────────────────────────────────────────────────────
    const chronoStats = { upserted: 0, skipped: 0, tombstoned: 0, schemaViolations: 0, unknownType: 0 };
    const allowedChronoTypes = getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta);
    for (const incoming of chrono) {
      if (violationsAgainstLocalSchema(spaceId, 'chrono', incoming as unknown as Record<string, unknown>).length > 0) chronoStats.schemaViolations++;
      /*
       * The vocabulary check the single-record path has always had, now here too — this is the W-4 defect:
       * the same rule applied on one path and not the other, with the batch path being the one a real peer
       * uses. Skipped rather than 400d, because one bad record must not abandon the rest of a batch.
       */
      if (!allowedChronoTypes.has(incoming.type)) { chronoStats.unknownType++; continue; }
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'chrono' })) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { chronoStats.tombstoned++; continue; }
      if (tomb) await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));

      const existing = await col<ChronoEntry>(`${spaceId}_chrono`)
        .findOne(asFilter<ChronoEntry>({ _id: incoming._id })) as ChronoEntry | null;
      if (!existing || incoming.seq > existing.seq) {
        await ingestBrainDoc<ChronoEntry>(spaceId, 'chrono', 'chrono', incoming);
        chronoStats.upserted++;
      } else {
        chronoStats.skipped++;
      }
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
     *   - **No embedding.** `ingestBrainDoc` is passed `null` for the record type, which is that function's
     *     way of saying this kind has nothing to embed. See its docblock for why that is an argument rather
     *     than a second ingest function.
     *
     * The tombstone check IS here, and unchanged: a delete that has already been applied must not be undone
     * by a stale copy of the record arriving afterwards.
     */
    const linkStats = { upserted: 0, skipped: 0, tombstoned: 0 };
    for (const incoming of links) {
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne(asFilter<TombstoneDoc>({ _id: incoming._id, type: 'link' })) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { linkStats.tombstoned++; continue; }
      if (tomb) await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id: incoming._id }));

      const existing = await col<LinkDoc>(`${spaceId}_links`)
        .findOne(asFilter<LinkDoc>({ _id: incoming._id })) as LinkDoc | null;
      if (!existing || incoming.seq > existing.seq) {
        await ingestBrainDoc<LinkDoc>(spaceId, null, 'links', incoming);
        linkStats.upserted++;
      } else {
        linkStats.skipped++;
      }
    }

    /*
     * ── A file's metadata ────────────────────────────────────────────────
     *
     * Last-writer-wins by seq, like every other family. What is NOT like the others is the write itself:
     * `ingestFileMeta` sets the authored keys instead of replacing the document, because the receiver
     * derived `sizeBytes`, `sha256`, the excerpt and the vector from bytes it holds — see that function.
     *
     * No tombstone check here. A deleted file has a `FileTombstoneDoc` and `/api/sync/file-tombstones`
     * carries it, which is why `TOMBSTONE_TYPES` has no `file` member; looking in the brain tombstones for
     * one would find nothing, every time, and look like a check.
     */
    const fileMetaStats = { upserted: 0, skipped: 0 };
    for (const incoming of fileMeta) {
      const existing = await col<FileMetaDoc>(`${spaceId}_files`)
        .findOne(asFilter<FileMetaDoc>({ _id: incoming._id }), { projection: { seq: 1 } }) as { seq?: number } | null;
      // `?? -1` so a record stamped before 4.0 — which has no seq — is overwritten by anything that arrives,
      // rather than winning for ever against every peer by comparing `undefined`.
      if (!existing || incoming.seq > (existing.seq ?? -1)) {
        await ingestFileMeta(spaceId, incoming as never);
        fileMetaStats.upserted++;
      } else {
        fileMetaStats.skipped++;
      }
    }

    /*
     * X-20 instrumentation, the RECEIVER half — and it is the half that matters now.
     *
     * The sender's side is answered: with `DEBUG` on, its log shows it pushing the record and advancing its
     * watermark, so it is not stalling. Reproduced under CPU contention 2026-08-20 (2 runs in 10): A pushes the
     * memory at seq 2, gets a 200, moves its watermark to 2 — and B never serves that id, so the record is
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
    log.debug(`Batch-upsert accepted for space '${spaceId}': `
      + `memories ${JSON.stringify(memStats)} seq ${range(memories)}; `
      + `entities ${JSON.stringify(entStats)} seq ${range(entities)}; `
      + `edges ${JSON.stringify(edgeStats)} seq ${range(edges)}; `
      + `chrono ${JSON.stringify(chronoStats)} seq ${range(chrono)}; `
      + `links ${JSON.stringify(linkStats)} seq ${range(links)} `
      + `filemeta ${JSON.stringify(fileMetaStats)} seq ${range(fileMeta)}`);

    /*
     * ALL SIX FAMILIES, and `filemeta` was the one missing.
     *
     * Six arrays go in and five sets of counters came out, so a sender had no way to tell whether its file
     * metadata landed — the receiver counted it and only logged it. `push-refusals.ts` reads these
     * counters off the response, so a family absent here is a family whose refusals are silent at both
     * ends.
     */
    res.status(200).json({
      status: 'ok',
      facts: memStats, entities: entStats, edges: edgeStats, chrono: chronoStats, links: linkStats,
      filemeta: fileMetaStats,
    });

    // Bump the local seq counter so future local writes always get a seq higher
    // than any document received via push.  Fire-and-forget after the response.
    const allSeqs = [
      ...facts.map(m => m.seq ?? 0),
      ...entities.map(e => e.seq ?? 0),
      ...edges.map(e => e.seq ?? 0),
      ...chrono.map(c => c.seq ?? 0),
    ];
    const maxIncoming = Math.max(0, ...allSeqs);
    if (maxIncoming > 0) bumpSeq(spaceId, maxIncoming).catch(() => {});
  } catch (err) {
    log.error(`sync POST batch-upsert: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
