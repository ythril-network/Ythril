/**
 * Audit log endpoints.
 *
 * GET /api/admin/audit-log         — admin-only, paginated, filterable
 * GET /api/admin/audit-log/export  — the same filters, streamed as NDJSON, no row cap
 */

import { Router } from 'express';
import { requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { queryAuditLog, streamAuditEntries, type AuditQueryParams } from '../audit/audit.js';
import { getConfig } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { caughtFailureText } from '../brain/store-failure.js';

export const auditRouter = Router();

/** Filters from the query string. Shared so the export and the table can never interpret one differently. */
function paramsFrom(query: Record<string, unknown>): AuditQueryParams {
  const str = (k: string): string | undefined => (typeof query[k] === 'string' ? query[k] as string : undefined);
  const int = (k: string): number | undefined => {
    const raw = str(k);
    if (raw === undefined) return undefined;
    const n = parseInt(raw, 10);
    return isNaN(n) ? undefined : n;
  };
  return {
    after: str('after'),
    before: str('before'),
    // Applies to the paged endpoint AND the export, because both build their filter from this — an operator
    // who wants one request's row and one who wants it out of a script are asking the same question.
    requestId: str('requestId'),
    tokenId: str('tokenId'),
    oidcSubject: str('oidcSubject'),
    spaceId: str('spaceId'),
    operation: str('operation'),
    ip: str('ip'),
    status: int('status'),
    limit: int('limit'),
    offset: int('offset'),
  };
}

auditRouter.get('/', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const result = await queryAuditLog(paramsFrom(req.query as Record<string, unknown>));
    const retentionDays = getConfig().audit?.retentionDays ?? 90;
    res.json({ ...result, retentionDays });
  } catch (err) {
    res.status(500).json({ error: caughtFailureText(err, 'query the audit log') });
  }
});

/**
 * The whole matching record as NDJSON — one entry per line, oldest first.
 *
 * ## Why this exists
 *
 * The paged endpoint caps at 1,000 rows, because a browser table has to stop somewhere. That cap is what made
 * "produce everything you hold about this person's activity" a paging script rather than a request: the filters
 * were already there (`oidcSubject`, `tokenId`, `ip`), only the way out was missing.
 *
 * ## Why it requires MFA, and why it is audited
 *
 * `requireAdminMfa`, not merely `requireAdmin`. Paging through the log on screen and taking a copy of the entire
 * who-did-what record are different acts, and the second one is what someone covering their tracks does first —
 * so it sits behind the same second factor as a database backup.
 *
 * It is also the one path under `/api/admin/audit-log` that the audit middleware does **not** skip. That skip
 * exists so reading the log does not write to the log on every page of every scroll; applied to an export it
 * would mean the single most sensitive read of the audit log is the one read it never records.
 *
 * ## Streaming
 *
 * Backpressure-aware, like the space export: pause the cursor walk when the socket buffer is full, so a slow
 * client cannot make the response buffer grow without bound. NDJSON rather than a JSON array precisely because
 * there is no cap — a consumer can process it a line at a time and never hold the whole thing.
 */
auditRouter.get('/export', globalRateLimit, requireAdminMfa, async (req, res) => {
  const params = paramsFrom(req.query as Record<string, unknown>);
  // A limit/offset means nothing here and would be quietly misleading if it looked like it applied.
  delete params.limit;
  delete params.offset;

  const write = (chunk: string): Promise<void> =>
    res.write(chunk) ? Promise.resolve() : new Promise<void>(resolve => res.once('drain', resolve));

  let count = 0;
  try {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    // The date is the operator's anchor for which export a file is; the extension tells their tooling.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="ythril-audit-${stamp}.ndjson"`);

    for await (const entry of streamAuditEntries(params)) {
      await write(JSON.stringify(entry) + '\n');
      count++;
    }
    res.end();
    log.info(`Audit log export: ${count} entries`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: caughtFailureText(err, 'export the audit log') });
      return;
    }
    // 200 and a partial body are already sent, so the status cannot be changed. Destroying the socket makes the
    // client see a TRUNCATED response rather than a well-formed file that is silently missing entries — which for
    // an audit record is the worst possible failure, because it looks complete.
    log.error(`Audit log export failed after ${count} entries: ${peerText(msg)}`);
    res.destroy(err instanceof Error ? err : new Error(msg));
  }
});
