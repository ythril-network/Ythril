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
import { writeFileBytes } from '../files/files.js';
import { decodeContent } from '../files/content-encoding.js';
import { upsertFileMeta } from '../files/file-meta.js';
import { parseContentRange, storeChunk, assembleChunks } from '../files/chunks.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { dispatchFileProcessing } from '../files/dispatch.js';
import { isMediaFormat, type InputFormat } from '../files/converters/pipeline.js';
import { resolveWriteTarget } from '../spaces/proxy.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { log } from '../util/log.js';
import { primitivePropertyError } from '../brain/property-values.js';
import { webhookToken, parseTtlDaysQuery, requireQueryPath, enforceSizeLimit } from './files-request.js';

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
            targetSpace, filePath, req.body, range.start, range.end, range.total,
          );

          if (complete) {
            // Assemble final file (symlink-checked before writing the target).
            const absTarget = resolveSafePath(targetSpace, filePath);
            await assertNoSymlinkEscape(targetSpace, absTarget);
            const sha256 = await assembleChunks(targetSpace, filePath, range.total, absTarget);
            await upsertFileMeta(targetSpace, filePath, range.total, { ttlDays: parseTtlDaysQuery(req), sha256 }).catch(err => {
              log.warn(`upsertFileMeta error for space ${targetSpace}, path ${filePath}: ${err}`);
            });

            // Resolve format, record media state, and enqueue the async embedding job (same path as
            // the single-request upload). Previously the media branch here only recorded `pending` —
            // `disabled`/`skipped` states were dropped; the shared helper records all three.
            const { resolvedFormat: resolvedFmt, embeddingStatus: chunkedEmbeddingStatus } =
              await dispatchFileProcessing(targetSpace, filePath, { bytes: range.total, contentType: req.headers['content-type'], sha256 });

            emitWebhookEvent({ event: 'file.created', spaceId: targetSpace, entry: { path: filePath, sha256 }, ...webhookToken(req) });
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
          log.warn(`Chunked upload error for space ${targetSpace}, path ${filePath}: ${err}`);
          res.status(500).json({ error: 'Chunked upload failed' });
        }
        return;
      }

      // ── Single-request upload ────────────────────────────────────────────
      try {
        let sha256: string;
        let incomingBytes = 0;
        let decoded: Buffer | undefined;

        if (Buffer.isBuffer(req.body)) {
          incomingBytes = req.body.length;
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
          incomingBytes = decoded.length;
        } else {
          res
            .status(400)
            .json({
              error:
                'Send file content as a raw body (any Content-Type) or JSON { content: string, encoding?: "utf8"|"base64" }',
            });
          return;
        }

        // Storage quota check — rejects with 507 if hard limit exceeded
        let quotaResult;
        try {
          quotaResult = await checkQuota('files', incomingBytes);
        } catch (err) {
          if (err instanceof QuotaError) {
            res.status(507).json({ error: err.message, storageExceeded: true });
            return;
          }
          throw err;
        }

        ({ sha256 } = await writeFileBytes(targetSpace, filePath, Buffer.isBuffer(req.body) ? req.body : decoded!));

        // Persist file metadata to MongoDB
        const metaOpts: { description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; ttlDays?: number; sha256?: string } = {};
        if (typeof req.body?.description === 'string') metaOpts.description = req.body.description;
        if (Array.isArray(req.body?.tags)) metaOpts.tags = req.body.tags as string[];
        // The CREATE door for a file's properties, and it silently DROPPED a malformed bag rather than
        // refusing it — so an upload carrying a nested value answered 2xx with the file stored and its
        // properties gone, saying nothing.
        //
        // Refused now, matching the other three file-meta doors and every entity door. An upload is not a
        // cheap request to repeat, which is exactly why a caller has to be told rather than left to
        // discover it on a later read.
        //
        // LINE comments, not a block, and that is not a style choice: this file contains `'*/*'` as a
        // content-type string, and every comment stripper in the test suite is string-blind — it reads
        // that as a comment START and deletes everything up to the next `*/`. A block comment here moves
        // where that swallowed region ends, so a gate reading this file sees less than it thinks. Filed.
        const propErr = primitivePropertyError(req.body?.properties);
        if (propErr) { res.status(400).json({ error: propErr }); return; }
        if (req.body?.properties != null) {
          metaOpts.properties = req.body.properties as Record<string, string | number | boolean>;
        }
        const ttlDaysQ = parseTtlDaysQuery(req);
        if (ttlDaysQ !== undefined) metaOpts.ttlDays = ttlDaysQ;
        metaOpts.sha256 = sha256;
        await upsertFileMeta(targetSpace, filePath, incomingBytes, metaOpts).catch(err => {
          log.warn(`upsertFileMeta error for space ${targetSpace}, path ${filePath}: ${err}`);
        });

        // Resolve format, record media state, and enqueue the async embedding job (media or document).
        const inputFormat = typeof req.body?.inputFormat === 'string' ? req.body.inputFormat as InputFormat : 'auto';
        const { resolvedFormat, embeddingStatus: embeddingStatusForResponse } = await dispatchFileProcessing(
          targetSpace, filePath, { bytes: incomingBytes, contentType: req.headers['content-type'], inputFormat, sha256 },
        );

        const response: { path: string; sha256: string; storageWarning?: boolean; embeddingStatus?: string } = { path: filePath, sha256 };
        if (quotaResult.softBreached) response.storageWarning = true;
        if (embeddingStatusForResponse !== undefined) response.embeddingStatus = embeddingStatusForResponse;
        emitWebhookEvent({ event: 'file.created', spaceId: targetSpace, entry: { path: filePath, sha256 }, ...webhookToken(req) });
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
        log.warn(`writeFile error for space ${targetSpace}, path ${filePath}: ${err}`);
        res.status(500).json({ error: 'Failed to write file' });
      }
    },
  );
}
