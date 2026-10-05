/**
 * `POST /api/spaces/:id/reembed` — its own module, because `api/spaces.ts` is a frozen god-file.
 *
 * Adding this route inline took that file from 847 to 875 code lines, one PR after it was raised from 844 for
 * `suppressEmbeddings`. Two raises in two PRs is the pattern the ratchet exists to report, and `config/types.ts`
 * is the cautionary tale: four individually-correct raises in two days, each one answered by raising it again.
 *
 * A route is the easiest thing in that file to move, since nothing else references it. The sweep, the suppression
 * check and the bounding live one layer further out again in `brain/reembed.ts` — this module is only the HTTP
 * shape: validate, delegate, report.
 */

import type { Router } from 'express';
import { RECORD_TYPES } from '../config/types.js';
import { z } from 'zod';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireSpaceAuthMfaScoped, denyReadOnly } from '../auth/middleware.js';

import { getConfig } from '../config/loader.js';
import { reembedSpace, REEMBED_MAX_LIMIT } from '../brain/reembed.js';
import { log, peerText } from '../util/log.js';
import { caughtFailureText } from '../brain/store-failure.js';

/**
 * Body for the re-embed backfill. Every field optional — `POST` with no body sweeps everything at the default
 * limit, which is the common case.
 *
 * `.strict()` so a misspelled `kind` is a 400 rather than a silent full sweep. A caller who meant to narrow and
 * got everything would be told they had narrowed it, which is the failure mode worth a rejection.
 */
const ReembedBody = z.object({
  kinds: z.array(z.enum(RECORD_TYPES)).min(1).optional(),
  limit: z.number().int().positive().max(REEMBED_MAX_LIMIT).optional(),
}).strict();

/** Mounted from `api/spaces.ts` so the route path stays `/api/spaces/:id/reembed`. */
export function registerReembedRoute(spacesRouter: Router): void {
  // POST /api/spaces/:id/reembed — queue embeddings for records that have none.
  //
  // The way back from `suppressEmbeddings`. Kept thin on purpose: the sweep, the suppression check and the
  // bounding all live in `brain/reembed.ts`, because `api/spaces.ts` is already a frozen god-file and a route
  // body is the wrong place for a rule the write path also has to agree with.
  spacesRouter.post('/:id/reembed', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, async (req, res) => {
    const spaceId = req.params['id'] as string;
    if (!getConfig().spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }
    const parsed = ReembedBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    try {
      // Awaited, unlike `rebuild-indexes`: this only ENQUEUES, so it returns in the time it takes to scan, and
      // the counts it reports are the point. A fire-and-forget version could not tell the operator whether
      // anything was found — which is the one question they are asking.
      const out = await reembedSpace(spaceId, {
        ...(parsed.data.kinds !== undefined ? { kinds: parsed.data.kinds } : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      res.json(out);
    } catch (err) {
      log.error(`POST /api/spaces/${peerText(spaceId)}/reembed: ${peerText(err)}`);
      res.status(500).json({ error: caughtFailureText(err, 'reembed a space') });
    }
  });
}
