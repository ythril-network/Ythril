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
import { REF_KINDS, isRefKind } from '../../config/types-knowledge.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { isStrictLinkage } from '../../spaces/space-lookup.js';
import { writeSpaceOf, answeredUnknownSpace } from '../write-target-answer.js';
import { applyJudgment } from './_judged-write.js';
import { answerUnknownWriteFields } from '../../contract/write-accepts.js';
import { webhookToken } from './_shared.js';
import { sendReadFailure } from './_read-failure.js';
import { refusalText } from '../../brain/store-failure.js';
import { connectionRefusalAnswer } from '../../brain/write-validation.js';

export const linksRouter = Router();

// What a body may carry is `acceptedWriteKeys('link.create')`: four keys, and there is no fifth on purpose. A `label` here would be the
// one degree of freedom the arrays never had, and the label a reader prints is derived from the two kinds (`linkLabel`). The seven shared
// write options (`ttlDays`, `checkDuplicates` …) are not among them: this route never read them, and they are unknown keys here.

/** Every legal class as `fact.entityIds`, for a refusal that names what the caller could have sent. */
const PAIR_LABELS = LINK_PAIRS.map(([f, t]) => linkLabel(f, t)).join(', ');

/** A kind parameter that must be present and one of the four. Absent is refused, not defaulted. */
function kindError(name: string, v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return `\`${name}\` string required (one of ${REF_KINDS.join(', ')})`;
  if (!isRefKind(v)) return `\`${name}\` must be one of ${REF_KINDS.join(', ')}`;
  return null;
}

// POST /api/brain/spaces/:spaceId/links — create one link (upsert; the id is derived from the connection)
linksRouter.post('/spaces/:spaceId/links', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  if (writeSpaceOf(req, res, spaceId) === null) return;
  // The unknown-field judge: after the target is resolved and before any other check (see `_judged-write.ts`).
  if (applyJudgment(res, answerUnknownWriteFields(req.body, 'link.create', spaceId, 'rest'))) return;

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

  if (isStrictLinkage(spaceId)) {
    try {
      await assertRefsResolve(spaceId, 'from', fromKind as RefKind, [from]);
      await assertRefsResolve(spaceId, 'to', toKind as RefKind, [to]);
    } catch (err) {
      // A missing reference is the caller's 400; a store failure under the lookup is the store's (bundle-30 I12).
      sendReadFailure(res, 'brain POST /spaces/:spaceId/links (reference check)', err);
      return;
    }
  }

  let link;
  try {
    link = await addLink(spaceId, from, fromKind as RefKind, to, toKind as RefKind, webhookToken(req));
  } catch (err) {
    // The only failure `addLink` raises that is the caller's fault: the record the link would hang off is
    // not there. A missing `from` is a 404 about the record, not a 400 about the body.
    // The store's failure is not this route's to word: `refusalText` rethrows it before the wording is read, so a
    // driver text that ends in "not found" is a 503 and not a 404 (bundle-53 G7, Q-335).
    const msg = refusalText(err);
    if (/not found$/.test(msg)) { res.status(404).json({ error: msg }); return; }
    // The entity the link points at was deleted or merged while it was written (Q-305): 409 `link_target_removed`, as every door answers it.
    const refused = connectionRefusalAnswer(err, 'create');
    if (refused) { res.status(refused.status).json(refused.body); return; }
    throw err;
  }

  // The unknown-field rows, if the body carried any, are put on this answer (and every other) by the judge's decoration.
  res.status(200).json({ ...link, label: linkLabel(link.fromKind, link.toKind) });
});

// DELETE /api/brain/spaces/:spaceId/links/:id — remove one link by its derived id
linksRouter.delete('/spaces/:spaceId/links/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  // ONE space, resolved as every write resolves its target; see `DELETE …/edges/:id`.
  const target = writeSpaceOf(req, res, spaceId);
  if (target === null) return;
  const removed = await removeLink(target, id, webhookToken(req));
  if (removed) { res.status(204).end(); return; }
  res.status(404).json({ error: 'Link not found' });
});
