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
import { peerBoundTo } from '../../auth/peer-bound.js';
import { getAllowedChronoTypes } from '../../spaces/schema-validation.js';
import { getConfig } from '../../config/loader.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { log, logSafe, peerText } from '../../util/log.js';
import { sendCaughtFailure } from '../send-failure.js';
import type { FactDoc, EntityDoc, EdgeDoc, ChronoEntry, LinkDoc } from '../../config/types.js';
import type { FileMetaDoc } from '../../config/types.js';
import { LOCAL_ONLY_EXCLUSION } from '../../sync/local-only-fields.js';
import { readAfterPosition } from '../../util/position-keyset.js';
import { pageAnswer, pushAnswer } from '../../sync/wire-answer.js';
import { parseLimit } from '../../util/pagination.js';
import { MAX_FORK_DEPTH, withAuthoredKeys, syncPositionStart, refusePeerSpace, refusePeerWrite, pushAllowed, withSchemaViolations } from './_shared.js';
import { boundedRows } from '../../brain/write-validation.js';
import type { SchemaViolation } from '../../spaces/schema-validation.js';
import { acceptArrivingPage, type AcceptedFamily } from '../../sync/accept-page.js';
import { LinkageCheck } from '../../sync/linkage-check.js';
import type { ArrivalVerdict } from '../../sync/upsert-plan.js';
import { REPLICATED_FAMILIES, familyOf, familiesAfter, type PayloadKey } from '../../sync/replicated-families.js';

export const syncDocsRouter = Router();

/**
 * What a family's document gets on its way out, beyond the stored row: a file's metadata carries the authored keys this
 * version knows (`Q-256`), so a puller reads an ABSENT key as removed and not as unmentioned. Computed at serve time by
 * every instance — a relay serves what it holds with its own list, so a removal made two hops away still arrives. Applied
 * to a whole document only: a listing is ids and seqs. An older puller strips the key it does not declare and removes
 * nothing, which is the safe direction.
 */
const SERVED_AS: Partial<Record<PayloadKey, <D extends object>(doc: D) => D>> = { filemeta: withAuthoredKeys };

/**
 * ONE paging read for every record family. It was written FOUR times, and `M-2` needed a fifth.
 *
 * The list routes were identical apart from two names — the collection suffix and the document type — and this is the sync CONTRACT: what a page is
 * and where the cursor comes from. A copy that drifts makes replication depend on which record family a peer happened to ask for, which is the defect
 * class `CLAUDE.md` names as this repo's most expensive.
 *
 * ## The rule, now that it is in one place to read
 *
 * A page is everything AFTER the start POSITION, in `(pos, _id)` order (`readAfterPosition`), below the settled cap (a write in flight holds every reader
 * below its position), capped at 500, with ONE extra row fetched so `nextCursor` can be decided without a second query. The start is the opaque `p1.`
 * `cursor` a previous page handed back — a PAIR, so a page that ended inside a run of equal positions (the legacy band, every carried 5.6 seq, has them)
 * continues that run instead of skipping it — or `afterPos`, a whole number. The answer is `{ items, nextCursor, through, head, positions: 1 }`, built by the
 * wire module (`sync/wire-answer.ts`) and by nothing in a route: `through` is where the page is complete, `head` the settled end of the stream. A
 * `sinceSeq` is refused: a 5.6 puller reads its numbers in another space, and a 6.0 server never guesses.
 *
 * Deletions are NOT riders of a family page any more: a tombstone is an item of the same stream and is served by `GET /tombstones`, which a puller reads
 * under the same mark. A listing (`full=false`, ids and seqs) is the same read with a thin projection.
 *
 * `full=true` returns whole documents in one pass; without it a page is ids and seqs only. The pull engine always asks for `full`, because the
 * alternative is N per-document fetches over a WAN. A whole document is served as its family says (`SERVED_AS`): a file's metadata carries
 * `authoredKeys`, the read by id too. The family's own filter (`pushFilter`) narrows what the page serves at all: files serve LIVE FILE ROWS only
 * (`LIVE_FILE_ROW`: no chunk, no soft-deleted audit row) — a chunk is derived from the blob and the receiver makes its own, with its own chunker and
 * model, and a soft delete reaches a peer as the file tombstone, never as its flagged row. It comes from the family row rather than a parameter, so the
 * page, the read by id and the push cannot each be handed a different one.
 */
function pageByPosition<T extends { _id: string; seq: number }>(key: PayloadKey) {
  const { collection, pushFilter: extraFilter = {} } = familyOf(key);
  const serve = SERVED_AS[key];
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { spaceId, networkId, limit, full: fullParam } = req.query as Record<string, unknown>;
      if (typeof spaceId !== 'string' || !spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (refusePeerSpace(res, spaceId, networkId as string | undefined, req.authToken)) return;

      const start = syncPositionStart(req.query as Record<string, unknown>);
      if ('refusal' in start) { res.status(400).json({ error: start.refusal }); return; }
      const pageSize = parseLimit(limit, 100, 500);
      const returnFull = fullParam === 'true';
      // The local fields never leave, which is the SAVING rather than the guarantee — a vector is several hundred floats per record and was the
      // bulk of every page. The guarantee is the receiver's strip (`sync/arrivals.ts`), because a peer decides what it sends and we decide what we store.
      const read = await readAfterPosition<T>(spaceId, collection, start, {
        limit: pageSize + 1, extra: extraFilter, projection: returnFull ? LOCAL_ONLY_EXCLUSION : { _id: 1, seq: 1 },
      });
      res.json(pageAnswer(read, pageSize, returnFull && serve ? serve : undefined));
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
  const serve = SERVED_AS[key];
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { spaceId, networkId } = req.query as Record<string, string>;
      if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (refusePeerSpace(res, spaceId, networkId, req.authToken)) return;

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
      res.json(serve ? serve(doc) : doc);
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
syncDocsRouter.get('/facts', syncRateLimit, requireAuth, pageByPosition<FactDoc>('facts'));
syncDocsRouter.get('/entities', syncRateLimit, requireAuth, pageByPosition<EntityDoc>('entities'));
syncDocsRouter.get('/edges', syncRateLimit, requireAuth, pageByPosition<EdgeDoc>('edges'));
syncDocsRouter.get('/chrono', syncRateLimit, requireAuth, pageByPosition<ChronoEntry>('chrono'));
syncDocsRouter.get('/links', syncRateLimit, requireAuth, pageByPosition<LinkDoc>('links'));
/*
 * A file's METADATA — the sixth family, on the owner's `P-32` ruling.
 *
 * The BYTES still travel through the manifest and `/api/files`; this carries what somebody wrote about
 * them. Before it existed, a file linked to an entity on one instance sent the LINK record and not the
 * array it came from, so the graph on a peer showed the connection and the peer's own Files tab showed
 * none.
 *
 * LIVE FILE ROWS ONLY (`LIVE_FILE_ROW`: no chunk, no soft-deleted audit row): a chunk is derived locally, and a deleted file already has its own
 * tombstone route.
 */
syncDocsRouter.get('/filemeta', syncRateLimit, requireAuth,
  /*
   * `seq` is OPTIONAL on a file meta record, so the type is narrowed here rather than made required on the document.
   *
   * A record written before 4.0 has none, and so no position either (the first carry gives a position to a row that has a seq): an un-stamped
   * record simply does not page to a peer until it is next written. `npm run links:convert` stamps the ones already stored. Making the field
   * required instead would have meant a boot migration over synced data, which `_REFERENCE.md` forbids.
   */
  pageByPosition<FileMetaDoc & { seq: number }>('filemeta'));

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
const pusherOf = (req: Request): string | undefined => peerBoundTo(req.authToken);
const peerOf = (req: Request): string => pusherOf(req) ?? 'unknown';
const forkCapError = (id: string) => ({ error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id '${peerText(id)}'` });
/**
 * The 400 of a malformed fork row, in the words of the rule it broke: its id does not derive from its subject, its seq and its body, or it is its own
 * fork, or an edge changed whether it is one. Bounded by `peerText` because the id is the peer's. The route adds its code (`invalid_fork`) beside it.
 */
const invalidForkError = (id: string) => ({
  error: `Malformed fork row '${peerText(id)}': its _id does not derive from its forkOf, its seq and its body (or it is its own fork, or an edge that changed whether it is one)`,
  id: peerText(id),
});
/**
 * A refused document's 400, in the words of the rule that refused it — the arrival writer's shape check
 * (`arrivalRefusal`: an implausible seq answers `seq N is too close to the protocol ceiling and was refused`, as
 * it always did) or the store's. One source for the text, so a route cannot phrase a refusal of its own.
 */
const refusedError = (r: AcceptedFamily) => ({ error: r.reasons[0] ?? 'the document was refused and was not written' });

/**
 * What a single route answers a sender about the one document it stored: the rows the page accept recorded for it, rendered by the one
 * bounded renderer (`boundedRows`: at most `MAX_ROWS` — a document carrying a hundred undeclared keys answers twenty, the count is in the
 * metric and the history — each `field` and string value bounded). Rows keep their value — they answer the sender about its own
 * document — which is the one sink of the recording that does.
 */
const recordedRows = (r: AcceptedFamily): SchemaViolation[] => boundedRows(r.recorded[0] ?? []);

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
    // Reported on every exit that STORED something: what the page accept recorded for it (`sync/arrival-recording.ts`), which is nothing for
    // a document that was skipped, tombstoned or refused — and for one whose replaced copy already had the same break.
    if (verdict === 'inserted' || verdict === 'updated') { res.status(200).json(pushAnswer(withSchemaViolations({ status: verdict }, recordedRows(facts)))); return; }
    if (verdict === 'forked') { res.status(200).json(pushAnswer(withSchemaViolations({ status: 'forked', forkId: facts.forkIds[0] }, recordedRows(facts)))); return; }
    if (verdict === 'tombstoned') { res.status(200).json(pushAnswer({ status: 'tombstoned' })); return; }
    if (verdict === 'forkRefused') { res.status(400).json(forkCapError(String(doc['_id']))); return; }
    if (verdict === 'invalidFork') { res.status(400).json({ ...invalidForkError(String(doc['_id'])), code: 'invalid_fork' }); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(facts)); return; }
    res.status(200).json(pushAnswer({ status: 'skipped' }));
  } catch (err) {
    if (refusePeerWrite(res, err, req.authToken)) return;
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
    if (verdict === 'forked') { res.status(200).json(pushAnswer(withSchemaViolations({ status: 'forked', forkId: entities.forkIds[0] }, recordedRows(entities)))); return; }
    if (verdict === 'forkRefused') { res.status(400).json(forkCapError(String(doc['_id']))); return; }
    if (verdict === 'invalidFork') { res.status(400).json({ ...invalidForkError(String(doc['_id'])), code: 'invalid_fork' }); return; }
    if (verdict === 'tombstoned') { res.status(200).json(pushAnswer({ status: 'tombstoned' })); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(entities)); return; }
    res.status(200).json(pushAnswer(withSchemaViolations({ status: 'ok' }, recordedRows(entities))));
  } catch (err) {
    if (refusePeerWrite(res, err, req.authToken)) return;
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
    if (verdict === 'forked') { res.status(200).json(pushAnswer(withSchemaViolations({ status: 'forked', forkId: edges.forkIds[0] }, recordedRows(edges)))); return; }
    if (verdict === 'forkRefused') { res.status(400).json(forkCapError(String(doc['_id']))); return; }
    if (verdict === 'invalidFork') { res.status(400).json({ ...invalidForkError(String(doc['_id'])), code: 'invalid_fork' }); return; }
    if (verdict === 'tombstoned') { res.status(200).json(pushAnswer({ status: 'tombstoned' })); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(edges)); return; }
    res.status(200).json(pushAnswer(withSchemaViolations({ status: verdict === 'duplicate' ? 'duplicate' : 'ok' }, recordedRows(edges))));
  } catch (err) {
    if (refusePeerWrite(res, err, req.authToken)) return;
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
    if (verdict === 'forked') { res.status(200).json(pushAnswer(withSchemaViolations({ status: 'forked', forkId: chrono.forkIds[0] }, recordedRows(chrono)))); return; }
    if (verdict === 'forkRefused') { res.status(400).json(forkCapError(String(doc['_id']))); return; }
    if (verdict === 'invalidFork') { res.status(400).json({ ...invalidForkError(String(doc['_id'])), code: 'invalid_fork' }); return; }
    if (verdict === 'tombstoned') { res.status(200).json(pushAnswer({ status: 'tombstoned' })); return; }
    if (verdict === 'rejected') { res.status(400).json(refusedError(chrono)); return; }
    res.status(200).json(pushAnswer(withSchemaViolations({ status: 'ok' }, recordedRows(chrono))));
  } catch (err) {
    if (refusePeerWrite(res, err, req.authToken)) return;
    sendCaughtFailure(res, 'sync POST chrono', err);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// BATCH UPSERT
// ═══════════════════════════════════════════════════════════════════════════

/** Documents per family per request. What is sent past it is counted `rejected`, never dropped unsaid. */
const BATCH_FAMILY_CAP = 500;

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
    // P-21 = C: judged against THIS space's schema, counted, and let in — never refused for it. The count is the page accept's: documents
    // that were STORED carrying something the copy they replaced did not (`sync/arrival-recording.ts`), recounted nowhere.
    const violated = (key: PushKey): number => out[key].recorded.filter(rows => rows !== undefined).length;
    const count = (key: PushKey, v: ArrivalVerdict) => out[key].verdicts.filter(x => x === v).length;
    const rejected = (key: PushKey, ...also: ArrivalVerdict[]) =>
      overflow[key] + count(key, 'rejected') + also.reduce((n, v) => n + count(key, v), 0);

    /*
     * The counters count ITEMS, as processing the page in order counted them. `skipped` is "already current"
     * (benign) and `forkDepthRefused` is a record DROPPED — one counter until 2026-08-19, which is why the lossy
     * one had never been seen. The accept names the dropped ones in the receiver's log.
     */
    // Every family that forks counts `forked`, `forkDepthRefused` (a fork DROPPED at its cap) and `invalidFork` (a malformed fork row, refused and never stored) beside
    // its own counters; `unverifiable` (a fork admitted although its id could not be derived: a legacy fact fork, a redacted chrono fork) is additive, said only when some were.
    const unverifiable = (key: PushKey): { unverifiable?: number } => {
      const n = out[key].unverifiable.filter(Boolean).length;
      return n > 0 ? { unverifiable: n } : {};
    };
    const memStats = { inserted: count('facts', 'inserted'), updated: count('facts', 'updated'), forked: count('facts', 'forked'), skipped: count('facts', 'skipped'), forkDepthRefused: count('facts', 'forkRefused'), invalidFork: count('facts', 'invalidFork'), tombstoned: count('facts', 'tombstoned'), schemaViolations: violated('facts'), ...unverifiable('facts') };
    const entStats = { upserted: count('entities', 'upserted'), forked: count('entities', 'forked'), skipped: count('entities', 'skipped'), forkDepthRefused: count('entities', 'forkRefused'), invalidFork: count('entities', 'invalidFork'), tombstoned: count('entities', 'tombstoned'), schemaViolations: violated('entities'), ...unverifiable('entities') };
    const edgeStats = { upserted: count('edges', 'upserted'), forked: count('edges', 'forked'), skipped: count('edges', 'skipped'), forkDepthRefused: count('edges', 'forkRefused'), invalidFork: count('edges', 'invalidFork'), tombstoned: count('edges', 'tombstoned'), schemaViolations: violated('edges'), duplicateTriplets: count('edges', 'duplicate'), ...unverifiable('edges') };
    const chronoStats = { upserted: count('chrono', 'upserted'), forked: count('chrono', 'forked'), skipped: count('chrono', 'skipped'), forkDepthRefused: count('chrono', 'forkRefused'), invalidFork: count('chrono', 'invalidFork'), tombstoned: count('chrono', 'tombstoned'), schemaViolations: violated('chrono'), unknownType: count('chrono', 'unknownType'), ...unverifiable('chrono') };
    // A link arriving under another id for endpoints already linked IS that link: skipped, never a fault.
    const linkStats = { upserted: count('links', 'upserted'), skipped: count('links', 'skipped') + count('links', 'duplicate'), tombstoned: count('links', 'tombstoned') };
    // `tombstoned` is additive (bundle-51): file metadata a held file tombstone covers — a deletion this instance holds for that
    // version of the path. A sender reads it as delivered (the deletion is the answer); an older receiver omits it, and so does
    // this one when none was covered, so the answer of a page nothing shadowed is the one it always was.
    const fileTombstoned = count('filemeta', 'tombstoned');
    // `converged` is additive the same way: a file row whose drifted timestamp took its author's (`Q-419`) — nothing
    // stored, so not `upserted`, and something written, so not `skipped`. Without it the row was in no counter at all.
    const fileConverged = count('filemeta', 'converged');
    const fileMetaStats = {
      upserted: count('filemeta', 'upserted'), skipped: count('filemeta', 'skipped'),
      ...(fileTombstoned > 0 ? { tombstoned: fileTombstoned } : {}),
      ...(fileConverged > 0 ? { converged: fileConverged } : {}),
    };

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
    res.status(200).json(pushAnswer({
      status: 'ok',
      facts: { ...memStats, rejected: rejected('facts', 'forkRefused') },
      entities: { ...entStats, rejected: rejected('entities', 'forkRefused') },
      edges: { ...edgeStats, rejected: rejected('edges', 'forkRefused') },
      chrono: { ...chronoStats, rejected: rejected('chrono', 'forkRefused', 'unknownType') },
      links: { ...linkStats, rejected: rejected('links', 'underivedId') },
      filemeta: { ...fileMetaStats, rejected: rejected('filemeta') },
    }));
  } catch (err) {
    if (refusePeerWrite(res, err, req.authToken)) return;
    sendCaughtFailure(res, 'sync POST batch-upsert', err);
  }
});
