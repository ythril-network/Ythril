/**
 * Batch write route (/api/brain/spaces/:spaceId/bulk).
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { requestActor } from '../../auth/request-actor.js';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { bulkWrite, bulkWriteTotal, BULK_BODY_KEYS, type BulkInput } from '../../brain/bulk.js';
import { retiredWriteFieldError } from '../../brain/retired-write-fields.js';
import { unknownBodyFields } from '../../brain/query.js';
import { getConfig } from '../../config/loader.js';
import { resolveWriteTarget } from '../../spaces/proxy.js';
import { emitWebhookEvent } from '../../webhooks/dispatcher.js';
import { webhookToken } from './_shared.js';

export const bulkRouter = Router();


// ── Bulk write ────────────────────────────────────────────────────────────────

/**
 * POST /api/brain/spaces/:spaceId/bulk
 *
 * Batch upsert facts, entities, edges, and chrono entries in a single
 * request.  Processing order: facts → entities → edges → chrono, which matters
 * for records the batch UPDATES: an entity addressed by an existing id is written
 * before an edge in the same batch reads it.
 *
 * It does NOT let a batch reference a record it creates. A supplied `id` addresses an
 * existing record and never becomes a new one's identity — that is minted — so an edge
 * naming an id the caller invented points at nothing, and since references here are
 * shape-checked and never existence-checked it is stored dangling and counted as
 * inserted. A graph takes two calls, with the ids coming from the first one's response.
 *
 * All four arrays are optional.  Entries that fail per-item validation are
 * recorded in `errors` and do not abort the remaining batch items.
 */
bulkRouter.post('/spaces/:spaceId/bulk', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const targetSpace = wt.target;

  /*
   * A NAME THIS DOOR DOES NOT KNOW IS REFUSED, at both levels (`Q-41`).
   *
   * The body used to be spread through a bare cast, so a key `BulkInput` does not declare rode in and was
   * never read by anything downstream: `{"memories":[…]}` answered `207` with nothing inserted and an empty
   * `errors` array — the same answer a body that legitimately wrote nothing gives. Reported by the fleet
   * integrator after about thirty of their builders had been writing into it and seeing success.
   *
   * The retired name is checked FIRST so `memories` is answered with `facts` rather than with the generic
   * "unknown field" sentence: this is the one door where a caller migrating from 4.x lands, and the
   * sentence they need is the replacement, not the inventory.
   *
   * ITEMS are checked too, because the same silence was one level down. `brain/bulk.ts` never mentions
   * `entityIds`, `memoryIds` or `chronoIds`, so an item carrying one was written without its connections —
   * and a batch is where that costs most, since one accepted request can carry hundreds.
   */
  const body = (req.body ?? {}) as Record<string, unknown>;
  const retired = retiredWriteFieldError(body);
  if (retired) { res.status(400).json({ error: retired }); return; }
  const unknown = unknownBodyFields(body, new Set(BULK_BODY_KEYS));
  if (unknown) { res.status(400).json(unknown); return; }
  for (const key of BULK_BODY_KEYS) {
    const items = body[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const itemRetired = retiredWriteFieldError(item);
      if (itemRetired) { res.status(400).json({ error: itemRetired }); return; }
    }
  }

  const result = await bulkWrite(targetSpace, {
    ...(body as BulkInput),
    // `F-25`: who wrote it, for the conversion pre-flight. Spread AFTER the body so a caller cannot
    // supply its own actor and be recorded as somebody else.
  });
  if (bulkWriteTotal(result) > 0) {
    // Bulk suppresses per-item webhooks; emit ONE summary a workflow can inspect.
    emitWebhookEvent({ event: 'bulk.write', spaceId: targetSpace, entry: { inserted: result.inserted, updated: result.updated, errorCount: result.errors.length }, ...webhookToken(req) });
  }
  res.status(207).json(result);
});
