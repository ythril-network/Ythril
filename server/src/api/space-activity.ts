/**
 * Admin: every space's usage side by side.
 *
 * The per-space endpoint (`GET /api/brain/spaces/:id/activity`) answers "is THIS space useful". This one
 * answers the question the owner actually asked — *which spaces are how useful* — and that is a comparison, so
 * it has to arrive in one response.
 *
 * One route rather than letting the Spaces page call the per-space endpoint once per row: that would be a
 * front-end N+1, which the performance lens that ran the day before this shipped names explicitly as a red
 * flag. Sixty-five spaces would be sixty-five requests to render one table.
 *
 * Admin-only, because it is inherently cross-space: a space-scoped token has no business learning how heavily
 * every other space is used, and the per-space route exists for it.
 */
import { Router } from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { isConfiguredSpace } from '../spaces/space-lookup.js';
import { summariseActivity, ACTIVITY_RETENTION_DAYS } from '../metrics/space-activity-store.js';

export const spaceActivityRouter = Router();

/**
 * GET /api/admin/space-activity?hours=168
 *
 * Returns one row per space that saw traffic in the window, busiest first. A space with no traffic is absent
 * rather than zero-filled: the caller knows which spaces exist (it is rendering them) and cannot know which
 * ones the window covers, so the absence is the useful half of the answer.
 */
spaceActivityRouter.get('/', globalRateLimit, requireAdmin, async (req, res) => {
  // Clamped, not rejected: this drives a dashboard, and an out-of-range window has an obviously correct
  // reading. The ceiling is the bucket retention — asking for more would silently return less than requested,
  // which is the kind of quiet shortfall that gets mistaken for a drop in usage.
  const raw = Number(req.query['hours'] ?? 24 * 7);
  const maxHours = ACTIVITY_RETENTION_DAYS * 24;
  const hours = Number.isFinite(raw) ? Math.max(1, Math.min(maxHours, Math.floor(raw))) : 24 * 7;

  // Configured spaces only: rows stored by earlier releases for ids no space has (the 90-day tail of what an unauthenticated request's path
  // segment made, Q-606) are not a space and are not listed. They age out with the retention window.
  const spaces = (await summariseActivity(hours)).filter(s => isConfiguredSpace(s.space));
  res.json({ hours, retentionDays: ACTIVITY_RETENTION_DAYS, spaces });
});
