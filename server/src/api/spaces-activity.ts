/**
 * POST /api/spaces/:id/activity/reset — clear a space's recorded usage.
 *
 * ## Why this is its own module
 *
 * Not preference: `api/spaces.ts` is on the god-file ratchet, and its own entry there says a route belongs
 * beside its mount point rather than inside it once the raises start stacking — which is exactly why
 * `spaces-reembed.ts` exists. Inline, this route was +18 code lines on a file that has already been raised
 * four times. Here it is one import and one call.
 *
 * The route body is unchanged from the inline version; only its address moved.
 */
import type { Router } from 'express';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireAdminMfaScoped } from '../auth/middleware.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { flushSpaceActivity, purgeSpaceActivity } from '../metrics/space-activity-store.js';

export function registerActivityResetRoute(spacesRouter: Router): void {
  /**
   * Clear a space's recorded usage — the number the Overview usage panel reports.
   *
   * ## Why "reset" means DELETE here, and not a window marker
   *
   * The first design for this stored a per-space `usageSince` timestamp and clamped the read window to it, on the
   * reasoning that deleting nothing is always the safer option. That was priced before looking: `purgeSpaceActivity`
   * already existed and was already exercised by the space-delete cascade. A marker would have added a stored
   * field, a merge path and a read-time clamp to reproduce, less well, what one tested call already does.
   *
   * The data justifies it too. These are hourly operational counters with a 90-day TTL — the store deletes them on
   * its own schedule anyway. Clearing them destroys no knowledge, and "reset" is what a reader already understands
   * that to mean. A marker would also leave the panel technically honest and practically confusing: the rows are
   * still there, just not counted, so two operators reading the same instance disagree about what happened.
   *
   * ## Why space ADMIN and not write
   *
   * Clearing a usage record is not a knowledge write — it changes no fact, entity, edge or file. It is an
   * administrative act on the space's own bookkeeping, so it sits with the other destructive space operations
   * behind `requireAdminMfaScoped`, exactly where rebuild-indexes and wipe already are.
   *
   * ## Why it is audited, and why the count is in the response
   *
   * The panel reads zero afterwards either way, so nothing on screen distinguishes "cleared 400 buckets" from
   * "there was nothing to clear". The deleted count is returned so the caller can tell, and the action is audited
   * so the answer survives the request — an operator asking "was the usage panel reset, or has this space really
   * been idle?" has no other way to find out.
   */
  spacesRouter.post('/:id/activity/reset', globalRateLimit, requireAdminMfaScoped('id'), async (req, res) => {
    const spaceId = req.params['id'] as string;
    if (!getConfig().spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }
    try {
      // Flush first. The in-memory counters land in Mongo on a 60 s interval, so a reset that skipped this would
      // leave up to a minute of already-counted traffic to reappear moments later — a panel that un-resets itself.
      await flushSpaceActivity();
      const cleared = await purgeSpaceActivity(spaceId);
      req.auditSnapshots = { before: { activityBuckets: cleared }, after: { activityBuckets: 0 } };
      res.json({ ok: true, spaceId, cleared });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`POST /api/spaces/${spaceId}/activity/reset: ${err}`);
      res.status(500).json({ error: msg });
    }
  });
}
