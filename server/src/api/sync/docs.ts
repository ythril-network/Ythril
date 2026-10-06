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
import { log, logSafe, peerText } from '../../util/log.js';
import { sendCaughtFailure } from '../send-failure.js';
import { settledSeqRange } from '../../util/seq.js';
import type { FactDoc, EntityDoc, EdgeDoc, ChronoEntry, LinkDoc } from '../../config/types.js';
import type { FileMetaDoc } from '../../config/types.js';
import { LOCAL_ONLY_EXCLUSION } from '../../sync/local-only-fields.js';
import { parseLimit } from '../../util/pagination.js';
import { MAX_FORK_DEPTH, encodeCursor, syncReadStart, BAD_SYNC_START, callerPeerId, spaceAllowed, pushAllowed, violationsAgainstLocalSchema, withSchemaViolations } from './_shared.js';
import { acceptArrivingPage, type AcceptedFamily } from '../../sync/accept-page.js';
import { LinkageCheck } from '../../sync/linkage-check.js';
import type { ArrivalVerdict } from '../../sync/upsert-plan.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF, familyOf, familiesAfter, type PayloadKey } from '../../sync/replicated-families.js';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '../../config/types.js';

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
      sendCaughtFailure(res, `sync GET /${collection}`, err);
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
      sendCaughtFailure(res, `sync GET /${collection}/:id`, err);
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
// THE PUSH DOOR — every POST below stores what it was sent through one page accept
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Every POST here hands what it was sent to `acceptArrivingPage` (`sync/accept-page.ts`) — the one accept the pull
 * uses too (`Q-204`): the wire schema per document, the plan, the write, the counter, the forks. Each route maps the
 * verdicts to the answer it has always given; the single routes are a page of one document.
 */
type PushKey = PayloadKey;

/** The peer identity the request's token proves, or undefined (an admin or local token). */
const pusherOf = (req: Request): string | undefined => callerPeerId(req.authToken as Record<string, unknown>);
const peerOf = (req: Request): string => pusherOf(req) ?? 'unknown';
const forkCapError = (id: string) => ({ error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id '${peerText(id)}'` });
/**
 * A refused document's 400, in the words of the rule that refused it — the arrival writer's shape check
 * (`arrivalRefusal`: an implausible seq answers `seq N is too close to the protocol ceiling and was refused`, as
 * it always did) or the store's. One source for the text, so a route cannot phrase a refusal of its own.
 */
const refusedError = (r: AcceptedFamily) => ({ error: r.reasons[0] ?? 'the document was refused and was not written' });

/**
 * One document through the page accept, for a single route: its family's result, or `null` once the route has
 * answered — a document its wire schema refuses is a `400` in the route's own words (`Invalid <kind> document`), as
 * it always was, and the schema is the shared step's (`sync/arrival-shape.ts`), not a parse of the route's own.
 */
async function acceptOne(req: Request, res: Response, key: PushKey, kind: string): Promise<{ r: AcceptedFamily; doc: Record<string, unknown> } | null> {
  const { spaceId } = req.query as Record<string, string>;
  // Its references are checked once it has landed (bundle-30 I8), with every family the sender pushes after this one
  // still to come — and the answer does not wait for the check (bundle-30 I13, `LinkageCheck.start`).
  const linkage = new LinkageCheck(spaceId, pusherOf(req) ?? 'unknown');
  const r = (await acceptArrivingPage(spaceId, { [key]: [req.body] }, { door: 'push', deliveredBy: pusherOf(req), linkage }))[key];
  linkage.start({ stillToCome: familiesAfter([key]) });
  if (r.invalid[0]) { res.status(400).json({ error: `Invalid ${kind} document` }); return null; }
  return { r, doc: r.docs[0] ?? {} };
}

/**
 * POST /api/sync/facts?spaceId=&networkId=
 * Upsert a fact received from a peer: a page of one through the page accept.
 * Conflict rule: higher seq wins; equal seq with different text forks; the fork caps answer 400.
 */
syncDocsRouter.post('/facts', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const one = await acceptOne(req, res, 'facts', 'fact');
    if (!one) return;
    const { r: facts, doc } = one;
    const verdict = facts.verdicts[0];
    // Reported on every exit that KEPT something; `tombstoned` and `skipped` store nothing to describe.
    const violations = () => violationsAgainstLocalSchema(spaceId, 'fact', doc);
    if (verdict === 'inserted' || verdict === 'updated') { res.status(200).json(withSchemaViolations({ status: verdict }, violations())); return; }
    if (verdict === 'forked') { res.status(200).json(withSchemaViolations({ status: 'forked', forkId: facts.forkIds[0] }, violations())); return; }
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'forkRefused') { res.status(400).json(forkCapError(String(doc['_id']))); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(facts)); return; }
    res.status(200).json({ status: 'skipped' });
  } catch (err) {
    sendCaughtFailure(res, 'sync POST facts', err);
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
    const one = await acceptOne(req, res, 'entities', 'entity');
    if (!one) return;
    const { r: entities, doc } = one;
    const verdict = entities.verdicts[0];
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(entities)); return; }
    res.status(200).json(withSchemaViolations({ status: 'ok' }, violationsAgainstLocalSchema(spaceId, 'entity', doc)));
  } catch (err) {
    sendCaughtFailure(res, 'sync POST entities', err);
  }
});

/**
 * POST /api/sync/edges — `ok`, `tombstoned`, or `duplicate` when the edge's triplet is already held here under
 * another id: the record did NOT land, and a sender that cannot tell the two apart advances its watermark
 * believing it delivered something it did not. A duplicate is a 200, never a 500, or the sender would re-send
 * the identical push for ever. What a landed edge points at that is not here is recorded by the accept itself.
 */
syncDocsRouter.post('/edges', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const one = await acceptOne(req, res, 'edges', 'edge');
    if (!one) return;
    const { r: edges, doc } = one;
    const verdict = edges.verdicts[0];
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(edges)); return; }
    res.status(200).json(withSchemaViolations({ status: verdict === 'duplicate' ? 'duplicate' : 'ok' },
      violationsAgainstLocalSchema(spaceId, 'edge', doc)));
  } catch (err) {
    sendCaughtFailure(res, 'sync POST edges', err);
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
 * On PULL the same record is stored: the planner's one stated door difference (`planArrivals`).
 */
syncDocsRouter.post('/chrono', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    const one = await acceptOne(req, res, 'chrono', 'chrono');
    if (!one) return;
    const { r: chrono, doc } = one;
    const verdict = chrono.verdicts[0];
    if (verdict === 'unknownType') {
      const allowed = getAllowedChronoTypes(getConfig().spaces.find(sp => sp.id === spaceId)?.meta);
      res.status(400).json({ error: `\`type\` must be one of: ${[...allowed].join(', ')}` });
      return;
    }
    if (verdict === 'tombstoned') { res.status(200).json({ status: 'tombstoned' }); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(chrono)); return; }
    res.status(200).json(withSchemaViolations({ status: 'ok' }, violationsAgainstLocalSchema(spaceId, 'chrono', doc)));
  } catch (err) {
    sendCaughtFailure(res, 'sync POST chrono', err);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// BATCH UPSERT
// ═══════════════════════════════════════════════════════════════════════════

/** Documents per family per request. What is sent past it is counted `rejected`, never dropped unsaid. */
const BATCH_FAMILY_CAP = 500;

/** The knowledge type a family's documents are checked against in this space's schema, or none (links, files). */
const schemaKindOf = (key: PushKey): KnowledgeType | undefined => {
  const family = familyOf(key);
  const rt = RECORD_TYPE_OF[family.collection];
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
     * A document the wire schema rejects is REPORTED, never silently removed — the count goes back in `rejected`,
     * which the sender subtracts from what it calls pushed, and the accept names it in one warning per page. So
     * does everything past the 500 cap: it used to be sliced off before counting, so the sender advanced its
     * watermark past it.
     */
    const overflow = {} as Record<PushKey, number>;
    const page = {} as Record<PushKey, unknown[]>;
    for (const { payloadKey: key } of REPLICATED_FAMILIES) {
      const sent = Array.isArray(body?.[key]) ? body[key]! : [];
      overflow[key] = Math.max(0, sent.length - BATCH_FAMILY_CAP);
      if (overflow[key] > 0) {
        log.warn(`batch-upsert: ${overflow[key]} ${key} document(s) past the ${BATCH_FAMILY_CAP}-per-family cap for space `
          + `'${peerText(spaceId)}' from peer '${logSafe(peer)}' were REJECTED; the sender offers them again in its next page.`);
      }
      page[key] = sent.slice(0, BATCH_FAMILY_CAP);
    }

    // Every family of the request lands before its references are checked, once (bundle-30 I8). A sender pushes one
    // family per request, so a target in a family it pushes AFTER this request's is still to come (bundle-30 I13). The
    // answer does not wait for the check: this door's bound promises a stalled push a 503 before the sender gives up.
    const linkage = new LinkageCheck(spaceId, pusherOf(req) ?? 'unknown');
    const out = await acceptArrivingPage(spaceId, page, { door: 'push', deliveredBy: pusherOf(req), linkage });
    linkage.start({ stillToCome: familiesAfter(REPLICATED_FAMILIES.map(f => f.payloadKey).filter(k => page[k].length > 0)) });

    const parsed = (key: PushKey) => out[key].docs.filter((d): d is NonNullable<typeof d> => d !== undefined);
    // P-21 = C: validated against THIS space's schema, counted, and let in — never refused for it.
    const violated = (key: PushKey): number => {
      const kind = schemaKindOf(key);
      return kind === undefined ? 0 : parsed(key).filter(d => violationsAgainstLocalSchema(spaceId, kind, d).length > 0).length;
    };
    const count = (key: PushKey, v: ArrivalVerdict) => out[key].verdicts.filter(x => x === v).length;
    const rejected = (key: PushKey, ...also: ArrivalVerdict[]) =>
      overflow[key] + count(key, 'rejected') + also.reduce((n, v) => n + count(key, v), 0);

    /*
     * The counters count ITEMS, as processing the page in order counted them. `skipped` is "already current"
     * (benign) and `forkDepthRefused` is a record DROPPED — one counter until 2026-08-19, which is why the lossy
     * one had never been seen. The accept names the dropped ones in the receiver's log.
     */
    const memStats = { inserted: count('facts', 'inserted'), updated: count('facts', 'updated'), forked: count('facts', 'forked'), skipped: count('facts', 'skipped'), forkDepthRefused: count('facts', 'forkRefused'), tombstoned: count('facts', 'tombstoned'), schemaViolations: violated('facts') };
    const entStats = { upserted: count('entities', 'upserted'), skipped: count('entities', 'skipped'), tombstoned: count('entities', 'tombstoned'), schemaViolations: violated('entities') };
    const edgeStats = { upserted: count('edges', 'upserted'), skipped: count('edges', 'skipped'), tombstoned: count('edges', 'tombstoned'), schemaViolations: violated('edges'), duplicateTriplets: count('edges', 'duplicate') };
    const chronoStats = { upserted: count('chrono', 'upserted'), skipped: count('chrono', 'skipped'), tombstoned: count('chrono', 'tombstoned'), schemaViolations: violated('chrono'), unknownType: count('chrono', 'unknownType') };
    // A link arriving under another id for endpoints already linked IS that link: skipped, never a fault.
    const linkStats = { upserted: count('links', 'upserted'), skipped: count('links', 'skipped') + count('links', 'duplicate'), tombstoned: count('links', 'tombstoned') };
    const fileMetaStats = { upserted: count('filemeta', 'upserted'), skipped: count('filemeta', 'skipped') };

    // X-20: a 200 says the batch was accepted, not that a record was stored. What each document became is in the
    // counters, and the seq range says WHICH records they refer to — with DEBUG on, beside the sender's own line.
    const range = (key: PushKey): string => {
      const seqs = parsed(key).map(d => d.seq);
      return seqs.length === 0 ? '-' : `${Math.min(...seqs)}..${Math.max(...seqs)}`;
    };
    log.debug(`Batch-upsert accepted for space '${peerText(spaceId)}': facts ${peerText(JSON.stringify(memStats))} seq ${peerText(range('facts'))}; `
      + `entities ${peerText(JSON.stringify(entStats))} seq ${peerText(range('entities'))}; edges ${peerText(JSON.stringify(edgeStats))} seq ${peerText(range('edges'))}; `
      + `chrono ${peerText(JSON.stringify(chronoStats))} seq ${peerText(range('chrono'))}; links ${peerText(JSON.stringify(linkStats))} seq ${peerText(range('links'))}; `
      + `filemeta ${peerText(JSON.stringify(fileMetaStats))} seq ${peerText(range('filemeta'))}`);

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
    sendCaughtFailure(res, 'sync POST batch-upsert', err);
  }
});
