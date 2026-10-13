/**
 * `POST /api/files/:spaceId/mkdir` — create a directory, in its own module.
 *
 * It left `api/files.ts` (a frozen god-file, G-4) the way the upload route did: attached to the file-store router by
 * `registerMkdirRoute`, so the path prefix and the router's middleware order stay in one place, and sharing the request helpers
 * through `files-request.ts` rather than copying them. It left when it gained the destination check, because a frozen file grows
 * only after a concern has moved out of it.
 *
 * A directory whose path runs through a regular file is refused before anything is created (`assertDestinationReachable`), `409`,
 * the answer every door gives (`files/act-answers.ts`, sent by `sendCaughtFailure`).
 */

import type { Router } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { createDir } from '../files/files.js';
import { assertDestinationReachable } from '../files/destination.js';
import { requireWritePath } from './files-request.js';
import { sendCaughtFailure } from './send-failure.js';

/** Attach `POST /:spaceId/mkdir` to the file-store router. */
export function registerMkdirRoute(mkdirRouter: Router): void {
  mkdirRouter.post(
    '/:spaceId/mkdir',
    globalRateLimit,
    requireSpaceAuth,
    denyReadOnly,
    async (req, res) => {
      const request = requireWritePath(req, res);
      if (request === null) return;
      const { targetSpace, path: dirPath } = request;

      try {
        await assertDestinationReachable(targetSpace, dirPath);
        await createDir(targetSpace, dirPath);
        res.status(201).json({ created: dirPath });
      } catch (err) {
        if (err instanceof RangeError) {
          res.status(400).json({ error: err.message });
          return;
        }
        sendCaughtFailure(res, `createDir for space ${targetSpace}, path ${dirPath}`, err, { error: 'Failed to create directory' });
      }
    },
  );
}
