/**
 * `POST /api/spaces/:id/file-stamp-report` — its own module, for the reason `spaces-reembed.ts` is: `api/spaces.ts` is a
 * frozen god-file, and a route is the easiest thing in it to attach from outside.
 *
 * Kept thin on purpose. The space, the body, the single flight, the heavy-call rail and the report are
 * `beginFileStampReport`, the module the MCP `file_stamp_report` tool calls too; this file is the HTTP shape: guard,
 * delegate, report.
 *
 * Instance admin, with the second factor and the token's space allowlist: the report names peers and spends this instance's
 * credentials for them, which is the same standing as the manual network sync, and no area rung says that. Its
 * `NOT_AREA_SCOPED` row (`auth/space-rights.ts`) carries the reason.
 */
import type { Router } from 'express';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireAdminMfaScoped } from '../auth/middleware.js';
import { beginFileStampReport } from '../spaces/file-stamp-report-door.js';
import { sendCaughtFailure } from './send-failure.js';

/** Mounted from `api/spaces.ts` so the route path stays `/api/spaces/:id/file-stamp-report`. */
export function registerFileStampReportRoute(spacesRouter: Router): void {
  spacesRouter.post('/:id/file-stamp-report', globalRateLimit, requireAdminMfaScoped('id'), async (req, res) => {
    const spaceId = req.params['id'] as string;
    try {
      const r = await beginFileStampReport(spaceId, req.body, req.authToken?.id ?? req.ip ?? '');
      if (r.status === 200) { res.json(r.answer); return; }
      res.status(r.status).json({ error: r.error });
    } catch (err) {
      sendCaughtFailure(res, `POST /api/spaces/${spaceId}/file-stamp-report`, err, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
