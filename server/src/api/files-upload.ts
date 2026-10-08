/**
 * `POST /api/files/:spaceId` — write a file, in its own module.
 *
 * G-4: `api/files.ts` is a frozen god-file at 642 code lines, and this route is 196 of them — by far its
 * largest body, and the one with the most going on: raw bytes or JSON, chunked uploads with a Content-Range,
 * a quota check, a proxy-space write target, a TTL, a media dispatch and a webhook. Nothing else in the file
 * references it, which is what makes a route the easiest thing there to move.
 *
 * The precedent is `spaces-reembed.ts`, and the division is the same: this module is the HTTP shape —
 * validate, delegate, report — while the writing, chunk assembly, quota and dispatch stay one layer out in
 * `files/`.
 *
 * The four request helpers it shares with the routes that stayed went SIDEWAYS into `files-request.ts` rather
 * than travelling with it. Taking them would have left a copy behind, and one rule with two implementations
 * is the defect this repo produces most.
 */

import type { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireSpaceAuth, denyReadOnly } from '../auth/middleware.js';
import { getConfig } from '../config/loader.js';
import { resolveSafePath, assertNoSymlinkEscape } from '../files/sandbox.js';
import { decodeContent } from '../files/content-encoding.js';
import { parseContentRange, storeChunk, assembleChunks, hashStagedChunks, discardStagedChunks } from '../files/chunks.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { storeFile, recordStoredFile, peerBytesShadowed, type StoreFileMeta } from '../files/store-file.js';
import { isMediaFormat, type InputFormat } from '../files/converters/pipeline.js';
import { resolveWriteTarget } from '../spaces/proxy.js';
import { primitivePropertyError } from '../brain/property-values.js';
import { webhookToken, parseTtlDaysQuery, requireQueryPath, enforceSizeLimit } from './files-request.js';
import { callerPeerAuthor } from './sync/_shared.js';
import { tagsError } from '../util/request-bounds.js';
import { sendCaughtFailure } from './send-failure.js';

/**
 * Attach the upload route to the file-store router.
 *
 * Registered by `api/files.ts` rather than exporting a router of its own, so the path prefix and the router's
 * middleware order stay in one place — a second router mounted at the same prefix is how two routes come to
 * disagree about which guards ran.
 */
export function registerUploadRoute(router: Router): void {
  // Write a file. Accepts raw bytes (any non-JSON Content-Type) or
  // JSON { content: string, encoding?: 'utf8' | 'base64' }.
  router.post(
    '/:spaceId',
    globalRateLimit,
    requireSpaceAuth,
    denyReadOnly,
    enforceSizeLimit,
    // Raw-body capture for non-JSON content types
    (req: Request, res: Response, next: NextFunction): void => {
      if (req.is('application/json')) { next(); return; }
      express.raw({ type: '*/*', limit: getConfig().maxUploadBodyBytes ?? '50mb' })(req, res, next);
    },
    async (req, res) => {
      const spaceId = req.params['spaceId'] as string;
      const cfg = getConfig();
      if (!cfg.spaces.some(s => s.id === spaceId)) {
        res.status(404).json({ error: `Space '${spaceId}' not found` });
        return;
      }

      const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
      if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
      const targetSpace = wt.target;

      const filePath = requireQueryPath(req, res);
      if (filePath === null) return;
      // A peer pushing a file it holds (sync/file-sync.ts) delivers an ARRIVAL, recorded as the peer's — see
      // `arrivedFrom` in files/store-file.ts. Both branches below pass it.
      const arrivedFrom = callerPeerAuthor(req.authToken as Record<string, unknown> | undefined);

      // ── Chunked upload (Content-Range) ───────────────────────────────────
      const range = parseContentRange(req.headers['content-range'] as string | undefined);
      if (range) {
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: 'Chunked upload requires raw bytes (not JSON)' });
          return;
        }
        const expectedLen = range.end - range.start + 1;
        if (req.body.length !== expectedLen) {
          res.status(400).json({ error: `Chunk size mismatch: Content-Range says ${expectedLen} bytes but body is ${req.body.length}` });
          return;
        }

        // Bound the declared assembled size — Content-Range totals were previously
        // unlimited, letting a client stage arbitrarily large uploads.
        const maxChunkedTotal = cfg.maxChunkedUploadBytes ?? 10 * 1024 ** 3;
        if (range.total > maxChunkedTotal) {
          res.status(413).json({ error: `Declared upload size ${range.total} exceeds the maximum of ${maxChunkedTotal} bytes` });
          return;
        }

        // Storage quota check on every chunk (mirrors the single-request path —
        // each chunk is its own POST). The FIRST chunk projects the full declared
        // total against an EXACT measurement for precise early rejection; later chunks
        // project their own size and may read a cached usage (P1) — the full-total
        // check on chunk 0 already validated the whole upload fits, so re-walking the
        // files tree per chunk is pure overhead.
        const firstChunk = range.start === 0;
        try {
          await checkQuota(
            'files',
            firstChunk ? range.total : req.body.length,
            firstChunk ? {} : { maxAgeMs: 10_000 },
          );
        } catch (err) {
          if (err instanceof QuotaError) {
            res.status(507).json({ error: err.message, storageExceeded: true });
            return;
          }
          throw err;
        }

        try {
          const { received, complete } = await storeChunk(
            targetSpace, filePath, req.body, range.start, range.total,
          );

          if (complete) {
            // Assemble final file (symlink-checked before writing the target).
            const absTarget = resolveSafePath(targetSpace, filePath);
            await assertNoSymlinkEscape(targetSpace, absTarget);
            // A peer's bytes that a tombstone erased are not kept (Q-229, Q-348), and are DECIDED BEFORE the target is written: the
            // staged chunks are hashed in one streaming pass (only when a tombstone for the path carries a hash to compare), and
            // on a shadow they are discarded and the answer is the one the single upload gives (`peerBytesShadowed`). Assembled
            // first and removed after, an upload over a LIVE file overwrote it and then deleted it. A person's upload is never asked.
            if (arrivedFrom && await peerBytesShadowed(targetSpace, filePath, { sha256Of: () => hashStagedChunks(targetSpace, filePath, range.total) })) {
              await discardStagedChunks(targetSpace, filePath, range.total);
              res.status(200).json({ tombstoned: true });
              return;
            }
            const sha256 = await assembleChunks(targetSpace, filePath, range.total, absTarget);
            // Metadata, the processing queue and the webhook — the same sequence as every other door
            // (files/store-file.ts); the bytes are already assembled on disk.
            const ttlDays = parseTtlDaysQuery(req);
            const { resolvedFormat: resolvedFmt, embeddingStatus: chunkedEmbeddingStatus } = await recordStoredFile(
              targetSpace, filePath, range.total, sha256, {
                meta: ttlDays !== undefined ? { ttlDays } : {},
                ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
                actor: webhookToken(req) as Record<string, unknown>,
                ...(arrivedFrom ? { arrivedFrom } : {}),
              });
            const isDocFormat = resolvedFmt !== 'text' && !isMediaFormat(resolvedFmt);
            const chunkedStatusCode = (chunkedEmbeddingStatus === 'pending' && isDocFormat) ? 202 : 201;
            const chunkedResponse: Record<string, unknown> = { path: filePath, sha256 };
            if (chunkedEmbeddingStatus !== undefined) chunkedResponse['embeddingStatus'] = chunkedEmbeddingStatus;
            res.status(chunkedStatusCode).json(chunkedResponse);
          } else {
            res.status(202).json({ path: filePath, received });
          }
        } catch (err) {
          if (err instanceof RangeError) {
            res.status(400).json({ error: (err as Error).message });
            return;
          }
          sendCaughtFailure(res, `Chunked upload error for space ${targetSpace}, path ${filePath}`, err, { error: 'Chunked upload failed' });
        }
        return;
      }

      // ── Single-request upload ────────────────────────────────────────────
      try {
        let sha256: string;
        let decoded: Buffer | undefined;

        // A raw body is already bytes; a JSON body carries them as a string to decode.
        if (Buffer.isBuffer(req.body)) {
          decoded = req.body;
        } else if (req.body && typeof req.body === 'object' && typeof req.body.content === 'string') {
          // DECODED ONCE, up here, and the buffer is what gets written below.
          //
          // This measured the size with `Buffer.byteLength(content, encoding)` and decoded again after the
          // quota check, which is two readings of one string and only the second of them produced bytes. The
          // `write_file` tool then needed the same rule and there was nothing to call — so the decode, the
          // encoding vocabulary and the base64 validation moved into `files/content-encoding.ts` and both
          // doors read it from there.
          try {
            decoded = decodeContent(req.body.content as string, req.body.encoding);
          } catch (err) {
            res.status(400).json({ error: (err as Error).message });
            return;
          }
        } else {
          res
            .status(400)
            .json({
              error:
                'Send file content as a raw body (any Content-Type) or JSON { content: string, encoding?: "utf8"|"base64" }',
            });
          return;
        }

        // The CREATE door for a file's properties refuses a malformed bag rather than dropping it — an upload
        // is not a cheap request to repeat, so a caller has to be told rather than left to find the properties
        // gone on a later read. Checked before anything is written. (LINE comments: this file contains a
        // content-type string that every comment stripper in the suite reads as a block-comment start.)
        const propErr = primitivePropertyError(req.body?.properties);
        if (propErr) { res.status(400).json({ error: propErr }); return; }
        // Tags by the one rule every record's tags follow (Q-108), checked before anything is written.
        if (req.body?.tags !== undefined) {
          const tagErr = tagsError(req.body.tags);
          if (tagErr) { res.status(400).json({ error: tagErr }); return; }
        }
        const metaOpts: StoreFileMeta = {};
        if (typeof req.body?.description === 'string') metaOpts.description = req.body.description;
        if (Array.isArray(req.body?.tags)) metaOpts.tags = req.body.tags as string[];
        if (req.body?.properties != null) metaOpts.properties = req.body.properties as Record<string, string | number | boolean>;
        const ttlDaysQ = parseTtlDaysQuery(req);
        if (ttlDaysQ !== undefined) metaOpts.ttlDays = ttlDaysQ;
        // A peer's bytes that a held file tombstone erased are stored nowhere and answered `200 { tombstoned: true }`
        // (Q-229, `peerBytesShadowed`): checked before quota and before any write. A person's upload is never asked.
        if (arrivedFrom && await peerBytesShadowed(targetSpace, filePath, decoded!)) {
          res.status(200).json({ tombstoned: true });
          return;
        }
        const inputFormat = typeof req.body?.inputFormat === 'string' ? req.body.inputFormat as InputFormat : 'auto';

        // Quota, bytes, metadata, the processing queue and the webhook — one sequence for every door
        // (files/store-file.ts). A metadata write that fails is no longer swallowed into a 2xx.
        let stored;
        try {
          stored = await storeFile(targetSpace, filePath, decoded!, {
            meta: metaOpts, inputFormat,
            ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
            actor: webhookToken(req) as Record<string, unknown>,
            ...(arrivedFrom ? { arrivedFrom } : {}),
          });
        } catch (err) {
          if (err instanceof QuotaError) { res.status(507).json({ error: err.message, storageExceeded: true }); return; }
          throw err;
        }
        sha256 = stored.sha256;
        const quotaResult = stored.quota;
        const embeddingStatusForResponse = stored.embeddingStatus;
        const resolvedFormat = stored.resolvedFormat;

        const response: { path: string; sha256: string; storageWarning?: boolean; embeddingStatus?: string } = { path: filePath, sha256 };
        if (quotaResult.softBreached) response.storageWarning = true;
        if (embeddingStatusForResponse !== undefined) response.embeddingStatus = embeddingStatusForResponse;
        // Return 202 Accepted for document uploads so the HTTP client gets an
        // immediate response before the background embedding worker completes.
        // Media files and unknown-format files keep 201 (no async work or already
        // established contract for media).
        const isDocFormat = resolvedFormat !== 'text' && !isMediaFormat(resolvedFormat);
        const statusCode = (embeddingStatusForResponse === 'pending' && isDocFormat) ? 202 : 201;
        res.status(statusCode).json(response);
      } catch (err) {
        if (err instanceof RangeError) {
          res.status(400).json({ error: err.message });
          return;
        }
        sendCaughtFailure(res, `writeFile error for space ${targetSpace}, path ${filePath}`, err, { error: 'Failed to write file' });
      }
    },
  );
}
