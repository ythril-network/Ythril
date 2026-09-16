/**
 * Link write routes (`/api/brain/spaces/:spaceId/links`).
 *
 * ## What this door is for, and why it is not an edge route
 *
 * A link says one record CONCERNS another — a fact about an entity, a file about a chrono entry. It is the
 * six public array fields (`fact.entityIds`, `chrono.entityIds`/`memoryIds`,
 * `file.entityIds`/`memoryIds`/`chronoIds`) stored as records, so the five adjacency readers have one place
 * to look. It carries no label, no weight, no properties and no type: those are what an EDGE is for, and a
 * link that could carry them would be an edge with a different name.
 *
 * READ is not here. Links are queryable through `/query` like any other collection, so a `GET` on this path
 * would be a second, weaker implementation of a filter grammar that already exists.
 *
 * ## The door writes the ARRAY
 *
 * `addLink` puts the id into the record's array field and lets the ordinary reconcile derive the row — see
 * `brain/links.ts` for why, in one sentence: a row the arrays never claimed is deleted by the next
 * unrelated edit to that record, and nothing anywhere reports it.
 *
 * ## `POST` is an upsert and answers 200, not 201
 *
 * One connection has one derived id for ever, so creating a link that exists is a no-op rather than a
 * conflict or a duplicate. Answering 201 for both would say a record was created when it was not, which
 * matters to a client retrying a request it never saw the answer to.
 */
import { Router } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { addLink, removeLink, LINK_PAIRS, linkLabel } from '../../brain/links.js';
import { assertRefsResolve } from '../../brain/entity-refs.js';
import { REF_KINDS } from '../../config/types-knowledge.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { getConfig } from '../../config/loader.js';
import { resolveWriteTarget, isStrictLinkage, findFirstAcrossMembers } from '../../spaces/proxy.js';
import { unknownFieldWarnings } from './unknown-fields.js';
import { legacyArrayWriters, DEFAULT_WRITER_WINDOW_DAYS } from '../../brain/legacy-array-writers.js';
import { usesLinkRecords } from '../../brain/link-adjacency.js';
import { webhookToken } from './_shared.js';

export const linksRouter = Router();

/**
 * The body keys the create reads — see `unknownFieldWarnings`.
 *
 * Four, and there is no fifth on purpose. A `label` here would be the one degree of freedom the arrays never
 * had, and the label a reader prints is derived from the two kinds (`linkLabel`).
 */
const LINKS_CREATE_BODY_KEYS = ['from', 'fromKind', 'to', 'toKind'];

/** Every legal class as `fact.entityIds`, for a refusal that names what the caller could have sent. */
const PAIR_LABELS = LINK_PAIRS.map(([f, t]) => linkLabel(f, t)).join(', ');

/** A kind parameter that must be present and one of the four. Absent is refused, not defaulted. */
function kindError(name: string, v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return `\`${name}\` string required (one of ${REF_KINDS.join(', ')})`;
  if (!(REF_KINDS as readonly string[]).includes(v)) return `\`${name}\` must be one of ${REF_KINDS.join(', ')}`;
  return null;
}

// POST /api/brain/spaces/:spaceId/links — create one link (upsert; the id is derived from the connection)
linksRouter.post('/spaces/:spaceId/links', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }

  const { from, fromKind, to, toKind } = req.body ?? {};
  if (!from || typeof from !== 'string') { res.status(400).json({ error: '`from` string required' }); return; }
  if (!to || typeof to !== 'string') { res.status(400).json({ error: '`to` string required' }); return; }
  for (const [name, v] of [['fromKind', fromKind], ['toKind', toKind]] as const) {
    const err = kindError(name, v);
    if (err) { res.status(400).json({ error: err }); return; }
  }

  /*
   * The pair check is here as well as in `addLink`, and deliberately so — this one produces the 400 with the
   * list of what IS legal, which is what a caller needs; the one in the writer is what stops a second door
   * from creating an orphan row. Two checks of one rule would normally be the defect this codebase names
   * most, but they are not two copies: both read `LINK_PAIRS`.
   */
  if (!LINK_PAIRS.some(([f, t]) => f === fromKind && t === toKind)) {
    res.status(400).json({ error: `a ${fromKind} cannot link to a ${toKind} — the link classes are: ${PAIR_LABELS}` });
    return;
  }

  if (isStrictLinkage(wt.target)) {
    try {
      await assertRefsResolve(wt.target, 'from', fromKind as RefKind, [from]);
      await assertRefsResolve(wt.target, 'to', toKind as RefKind, [to]);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  let link;
  try {
    link = await addLink(wt.target, from, fromKind as RefKind, to, toKind as RefKind, webhookToken(req));
  } catch (err) {
    // The only failure `addLink` raises that is the caller's fault: the record the link would hang off is
    // not there. A missing `from` is a 404 about the record, not a 400 about the body.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found$/.test(msg)) { res.status(404).json({ error: msg }); return; }
    throw err;
  }

  const result: Record<string, unknown> = { ...link, label: linkLabel(link.fromKind, link.toKind) };
  const warnings = unknownFieldWarnings(req.body, LINKS_CREATE_BODY_KEYS);
  if (warnings.length > 0) result['warnings'] = warnings;
  res.status(200).json(result);
});

// DELETE /api/brain/spaces/:spaceId/links/:id — remove one link by its derived id
linksRouter.delete('/spaces/:spaceId/links/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const removed = await findFirstAcrossMembers(spaceId, mid => removeLink(mid, id, webhookToken(req)));
  if (removed) { res.status(204).end(); return; }
  res.status(404).json({ error: 'Link not found' });
});

/**
 * GET /api/brain/spaces/:spaceId/links/convert-preflight — who is still writing the legacy arrays?
 *
 * Read before running `links:convert`. Conversion sets `completeLinkage`, and from then on the six array
 * fields are refused — correctly, and on the CALLER'S NEXT WRITE rather than at conversion time. Requested
 * by the canary operator (`F-25`): an operator converts and finds out which of their writers still use
 * `entityIds` when one of them breaks. They had five and knew none of them.
 *
 * A GET, and a view of one space's data, so it takes the same `knowledge` area as the link writes at their
 * lowest rung — see the `ROUTE_RIGHTS` row.
 *
 * `since` in the answer is not decoration: a count with no window on it cannot be told apart from a count
 * over a shorter one, and this is read by somebody about to make a decision on it.
 */
linksRouter.get('/spaces/:spaceId/links/convert-preflight', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (!getConfig().spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` }); return;
  }
  const raw = req.query['windowDays'];
  const windowDays = raw === undefined ? DEFAULT_WRITER_WINDOW_DAYS : Number(raw);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    res.status(400).json({ error: '`windowDays` must be a positive number' }); return;
  }
  res.json(await legacyArrayWriters({ spaceId, windowDays, converted: usesLinkRecords(spaceId) }));
});
