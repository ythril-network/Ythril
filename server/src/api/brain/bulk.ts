/**
 * Batch write route (/api/brain/spaces/:spaceId/bulk).
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { bulkWrite, bulkWriteTotal, bulkSizeRefusal, bulkBodyRefusal, BULK_BODY_KEYS, type BulkInput } from '../../brain/bulk.js';
import { getConfig } from '../../config/loader.js';
import { resolveWriteTarget } from '../../spaces/proxy.js';
import { emitWebhookEvent } from '../../webhooks/dispatcher.js';
import { webhookToken } from './_shared.js';

export const bulkRouter = Router();


// ── Bulk write ────────────────────────────────────────────────────────────────

/**
 * POST /api/brain/spaces/:spaceId/bulk
 *
 * Batch upsert facts, entities, edges, and chrono entries in a single request. Processing order:
 * facts → entities → chrono → EDGES LAST, so a correlation key can name a record of any kind.
 *
 * A record this call creates is referenced by a `$ref` key rather than by an id: identities are
 * minted here, so an id the caller invents addresses an existing record or nothing at all.
 *
 * An ITEM carries its own relationships — the `link*` fields its kind can hold, and `edges` — through
 * the same module every single-record door calls (`Q-44`). Those name records that already exist; a
 * `$ref` belongs to the top-level `edges` array, which runs late enough to resolve one.
 *
 * All four arrays are optional. Entries that fail per-item validation are recorded in `errors` and do
 * not abort the remaining batch items.
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

  // A name this door does not know is refused, at both levels — the same check the MCP tool runs
  // (`bulkBodyRefusal`, which says why).
  const body = (req.body ?? {}) as Record<string, unknown>;
  const refusal = bulkBodyRefusal(body, new Set(BULK_BODY_KEYS));
  if (refusal) { res.status(400).json(refusal); return; }

  const tooLarge = bulkSizeRefusal(body);
  if (tooLarge) { res.status(400).json({ error: tooLarge }); return; }

  const result = await bulkWrite(targetSpace, {
    ...(body as BulkInput),
    // `F-25`: who wrote it, for the conversion pre-flight. Spread AFTER the body so a caller cannot
    // supply its own actor and be recorded as somebody else.
  });
  if (bulkWriteTotal(result) > 0) {
    // Bulk suppresses per-item webhooks; emit ONE summary a workflow can inspect.
    emitWebhookEvent({ event: 'bulk.write', spaceId: targetSpace, entry: { inserted: result.inserted, updated: result.updated, connections: result.connections, errorCount: result.errors.length }, ...webhookToken(req) });
  }
  res.status(207).json(result);
});
