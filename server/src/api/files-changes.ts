/**
 * `GET /api/files/:spaceId/changes?cursor=&prefix=&limit=` — the client file change feed's REST door (bundle-255, Q-724). The read itself is
 * `files/file-changes.ts`, shared with the MCP tool `file_changes`; this file is the door: rights (the `ROUTE_RIGHTS` row, files read on the space),
 * the shared refusal of a view id and a peer-bound token, the existence check, the query's validation and the answer.
 *
 * Its own file, beside the file router, for the reason `files-mkdir.ts` is: `api/files.ts` is held at its size.
 */
import type { Router } from 'express';
import { requireSpaceAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { peerBoundTo } from '../auth/peer-bound.js';
import { FileChangesQuery, fileChangesSpaceRefusal, readFileChanges } from '../files/file-changes.js';
import { answeredUnknownSpace } from './write-target-answer.js';
import { sendCaughtFailure } from './send-failure.js';
import { refusalOfParse } from '../util/log.js';

/** Attach `GET /:spaceId/changes` to the file-store router. */
export function registerFileChangesRoute(changesRouter: Router): void {
  changesRouter.get('/:spaceId/changes', globalRateLimit, requireSpaceAuth, async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    // A view id is an unknown space here (one cursor is one space's stream), and a peer's token is refused: asked first, by the helper the tool asks too.
    const refusal = fileChangesSpaceRefusal(spaceId, peerBoundTo(req.authToken as object | undefined));
    if (refusal) { res.status(refusal.status).json(refusal.body); return; }
    if (answeredUnknownSpace(req, res, spaceId)) return;
    // The three parameters, read by name (so the route's accepted set is its own source), and every other key kept for the strict parse: a parameter
    // the feed does not take is refused, never ignored, so `cursor[$ne]=x` is a 400, not a read from the start.
    const other = Object.fromEntries(Object.entries(req.query as Record<string, unknown>).filter(([k]) => k !== 'cursor' && k !== 'prefix' && k !== 'limit'));
    const parsed = FileChangesQuery.safeParse({ ...other, cursor: req.query['cursor'], prefix: req.query['prefix'], limit: req.query['limit'] });
    if (!parsed.success) { res.status(400).json(refusalOfParse(parsed.error)); return; }
    try {
      const outcome = await readFileChanges(spaceId, parsed.data);
      res.status(outcome.ok ? 200 : outcome.status).json(outcome.body);
    } catch (err) {
      sendCaughtFailure(res, `file change feed of space ${spaceId}`, err, { error: 'Failed to read the file change feed' });
    }
  });
}
