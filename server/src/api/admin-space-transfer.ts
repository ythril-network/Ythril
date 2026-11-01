/**
 * The admin export and import of one space: `GET /api/admin/spaces/:spaceId/export` writes the backup, `POST /api/admin/spaces/:spaceId/import`
 * restores one of any size (bundle-40, Q-267, Q-226, Q-227). Moved out of `app.ts`, which keeps one mount and the parser marker.
 *
 * ## The export
 *
 * One JSON object: the envelope (`exportedAt`, `spaceId`, `spaceName`, `version`, and `instanceId`, the instance that wrote it) then one array
 * per REPLICATED family, by collection name, streamed document by document with backpressure. What this instance derives with its own model,
 * its write guard and its positions are left out (`NOT_CARRIED_BY_BACKUP`); the record tier (retention stamps, `deliveredBy`, `syncBase`,
 * `_resolvedElsewhere`) stays, because a restore of an own backup keeps it. Of the files collection only the rows a backup holds are written
 * (`backupRow`, the rule the import drops by): no chunk, no face row, no legacy spill.
 *
 * ## The import
 *
 * The body never reaches the global JSON parser (`markImportBody`, mounted before it, sets the flag both parsers skip), so a caller is let in
 * before a byte of the body is read, and no 10 MB ceiling stands between a backup and its restore. In order:
 *
 *  1. auth (the route's guard), a JSON content type (else 415) and a known encoding, no other import standing anywhere and no act standing for
 *     the space (409, `space_being_imported` or the standing act's code);
 *  2. the body is inflated by its `Content-Encoding` (gzip, deflate, br) and spooled under `<data root>/import-spool/` (through the master
 *     secret's chunked envelope when one is configured), its INFLATED bytes counted against `importBodyMaxBytes` (413), after a free-disk
 *     check (507);
 *  3. the whole body is read and validated (`indexExportBody`): malformed is 400, over `importMaxDocuments` is 413, and either removes the
 *     spool - no act was registered, nothing was written;
 *  4. only then the act is registered (`spaces/import-act.ts`), and the door waits for it within the runner's budget: 200 with the result,
 *     or 202 queued (the result is then the act's completion row in the audit log).
 *
 * A client that goes away, or a disk that fills, removes the spool and registers nothing.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getConfig } from '../config/loader.js';
import { importBodyMaxBytes, importMaxDocuments } from '../config/body-limits.js';
import { createChunkedEncryptor, deriveKey, resolveMasterSecret } from '../config/secretbox.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireAdminMfaScoped } from '../auth/middleware.js';
import { answeredUnknownSpace, sendLostSpace } from './write-target-answer.js';
import { sendCaughtFailure } from './send-failure.js';
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { NOT_CARRIED_BY_BACKUP, backupRow } from '../sync/local-only-fields.js';
import { REPLICATED_FAMILIES } from '../sync/replicated-families.js';
import { ExportBodyMalformed, ExportBodyTooLarge } from '../sync/export-stream.js';
import { SERVER_VERSION } from '../util/server-version.js';
import { log, peerText } from '../util/log.js';
import { settledWithin } from '../util/time-bound.js';
import { assertSpaceTakesWrites, spaceWriteClosedAnswer } from '../spaces/space-write-gate.js';
import { runSpaceAct, releaseSpaceActWaiter, spaceActAnswerMs, spaceActClosedAnswer } from '../spaces/space-act-runner.js';
import { SPACE_ACT_KINDS } from '../config/types-space-acts.js';
import { ensureSpoolRoot, importStanding, indexSpool, registerImport, removeSpool, spoolPathOf, takeImportResult } from '../spaces/import-act.js';
import type { ImportResult } from './admin-import.js';

/** The import route, as Express matches it: the parser marker and the route are mounted on this one string. */
export const IMPORT_PATH = '/api/admin/spaces/:spaceId/import';

const IMPORT_BODY = Symbol('importBody');

/** Mounted on {@link IMPORT_PATH} BEFORE the global body parsers: marks the request so neither of them reads its body. */
export function markImportBody(req: Request, _res: Response, next: NextFunction): void {
  (req as unknown as Record<symbol, boolean>)[IMPORT_BODY] = true;
  next();
}

/** Is this an import body, which only its own route reads? The global parsers' `type` predicates ask it. */
export function skipsGlobalParsers(req: unknown): boolean {
  return (req as Record<symbol, boolean>)[IMPORT_BODY] === true;
}

export const spaceTransferRouter = express.Router();

// ── the export ──────────────────────────────────────────────────────────────────────────────────────────────────

spaceTransferRouter.get('/api/admin/spaces/:spaceId/export', globalRateLimit, requireAdminMfaScoped('spaceId'), async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) {
    sendLostSpace(req, res, spaceId);
    return;
  }

  // Streamed, never buffered (P7): the whole space on the heap twice (the documents and their JSON) OOM'd a 100k-fact backup, exactly when
  // losing data hurts most. One JSON object, the envelope then one array per replicated family keyed by collection name - the shape the
  // import reads (NDJSON would break the import contract).
  const projection = Object.fromEntries([...NOT_CARRIED_BY_BACKUP].map(f => [f, 0]));
  // What the export wrote so far, per family, for its audit row: written when the response finishes or is cut off (the counts so far).
  const written = REPLICATED_FAMILIES.map(f => ({ field: f.collection, to: 0 }));
  req.auditChangesExplicit = written;

  const write = (chunk: string): Promise<void> =>
    res.write(chunk) ? Promise.resolve() : new Promise<void>(resolve => res.once('drain', resolve));

  /** Stream one collection as a JSON array value; the files collection holds only the rows a backup holds (`backupRow`). */
  const streamArray = async (collName: string, files: boolean, count: { to: number }): Promise<void> => {
    await write('[');
    const cursor = col(collName).find(files ? { ...backupRow.filter } : {}, { projection });
    let first = true;
    for await (const doc of cursor) {
      if (files && !backupRow.predicate(doc as Record<string, unknown>)) continue;
      await write((first ? '' : ',') + JSON.stringify(doc));
      first = false;
      count.to++;
    }
    await write(']');
  };

  try {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Envelope fields first — JSON.stringify each value so escaping is correct.
    await write(
      '{'
      + `"exportedAt":${JSON.stringify(new Date().toISOString())},`
      + `"spaceId":${JSON.stringify(spaceId)},`
      + `"spaceName":${JSON.stringify(space.label)},`
      + `"version":${JSON.stringify(SERVER_VERSION)},`
      + `"instanceId":${JSON.stringify(cfg.instanceId)}`,
    );
    for (const [i, f] of REPLICATED_FAMILIES.entries()) {
      await write(`,${JSON.stringify(f.collection)}:`);
      await streamArray(spaceCollection(spaceId, f.collection), f.collection === 'files', written[i]!);
    }
    await write('}');
    res.end();
  } catch (err) {
    const msg = peerText(err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      sendCaughtFailure(res, 'GET /api/admin/spaces/:spaceId/export', err);
    } else {
      // 200 and part of the body are sent: destroy the socket, so the client sees a cut-off response and never a valid JSON missing documents.
      log.error(`Space export for '${peerText(spaceId)}' failed mid-stream: ${msg}`);
      res.destroy(err instanceof Error ? err : new Error(msg));
    }
  }
});

// ── the import ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The body inflated past `importBodyMaxBytes`. */
class OverCeiling extends Error { override readonly name = 'OverCeiling'; }
/** The client went away before the body ended. */
class ClientGone extends Error { override readonly name = 'ClientGone'; }

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;
const INFLATERS: Readonly<Record<string, (() => Transform) | null>> = {
  identity: null, gzip: () => zlib.createGunzip(), 'x-gzip': () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress(),
};

/** Pass bytes on until `max` have passed, then fail with {@link OverCeiling}. */
function ceilingOf(max: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length;
      if (n > max) done(new OverCeiling(`the body is over importBodyMaxBytes (${max} bytes, inflated)`)); else done(null, chunk);
    },
  });
}

/** What a refused import answers, by what refused it; the spool is already gone. */
function refusalOf(err: unknown, encoding: string): { status: number; error: string } | null {
  if (err instanceof OverCeiling || err instanceof ExportBodyTooLarge) return { status: 413, error: err.message };
  if (err instanceof ExportBodyMalformed) return { status: 400, error: err.message };
  if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC') return { status: 507, error: 'The disk holding the import spool is full; nothing was written.' };
  const code = String((err as { code?: unknown })?.code ?? '');
  if (code.startsWith('Z_') || code.startsWith('ERR__ERROR') || code === 'ERR_BROTLI_DECOMPRESSION_FAILED') {
    return { status: 400, error: `The body could not be inflated as ${encoding}; nothing was written.` };
  }
  return null;
}

/** Spool the request body to `file`: inflated, bounded, encrypted when a master secret is configured. Never destroys the request. */
async function spoolBody(req: Request, file: string, encoding: string, max: number): Promise<void> {
  const inflate = INFLATERS[encoding]!;
  const secret = resolveMasterSecret();
  const head = new Transform({ transform(chunk, _e, done) { done(null, chunk); } });
  const gone = (): void => { if (!req.complete) head.destroy(new ClientGone('the client went away before the body ended')); };
  req.once('close', gone);
  req.pipe(head);
  const stages: Readable[] = [head];
  if (inflate) stages.push(inflate());
  stages.push(ceilingOf(max));
  if (secret) stages.push(createChunkedEncryptor(deriveKey(secret)));
  try {
    await pipeline([...stages, fs.createWriteStream(file, { mode: 0o600, flags: 'wx' })] as unknown as NodeJS.ReadWriteStream[]);
  } finally {
    req.off('close', gone);
    req.unpipe(head);
  }
}

/** Is there room for a body of `declared` bytes under `dir`? A file system that cannot say is not refused. */
function roomFor(dir: string, declared: number): boolean {
  try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize) >= declared; } catch { return true; }
}

/** The counts of a landed import, for its audit row: ids never, totals only. */
function importChanges(result: ImportResult): Array<{ field: string; to: number }> {
  const all = Object.values(result.results);
  const sum = (f: (r: (typeof all)[number]) => number): number => all.reduce((n, r) => n + f(r), 0);
  return [
    { field: 'inserted', to: sum(r => r.inserted) }, { field: 'updated', to: sum(r => r.updated) }, { field: 'refused', to: sum(r => r.errors) },
    { field: 'deletedOnRestore', to: sum(r => r.deletedOnRestoreTotal ?? 0) }, { field: 'due', to: sum(r => r.dueTotal ?? 0) },
  ];
}

spaceTransferRouter.post(IMPORT_PATH, globalRateLimit, requireAdminMfaScoped('spaceId'), async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const where = 'POST /api/admin/spaces/:spaceId/import';
  if (answeredUnknownSpace(req, res, spaceId)) return;
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) {
    res.status(415).json({ error: 'An import body is an export: send it as application/json.' });
    return;
  }
  const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase() || 'identity';
  if (!(encoding in INFLATERS)) {
    res.status(415).json({ error: `Content-Encoding '${peerText(encoding)}' is not one an import inflates (gzip, deflate, br).` });
    return;
  }
  // One import at a time, instance-wide; and none into a space another act holds.
  if (importStanding()) {
    res.status(409).json({ error: `Space '${spaceId}' takes no import now: ${SPACE_ACT_KINDS.import.writeRefusalWhy()}.`, code: SPACE_ACT_KINDS.import.writeRefusalCode });
    return;
  }
  try { assertSpaceTakesWrites(spaceId); } catch (err) {
    const closed = spaceWriteClosedAnswer(err);
    if (closed) { res.status(closed.status).json(closed.body); return; }
    throw err;
  }

  const spoolId = crypto.randomUUID();
  const file = spoolPathOf(spoolId)!;
  let registered = false;
  try {
    const root = ensureSpoolRoot();
    const declared = Number(req.headers['content-length'] ?? 0) || 0;
    if (!roomFor(root, declared)) {
      res.status(507).json({ error: 'The disk holding the import spool has no room for this body; nothing was written.' });
      return;
    }
    const cfg = getConfig();
    await spoolBody(req, file, encoding, importBodyMaxBytes(cfg));
    const index = await indexSpool(file, importMaxDocuments(cfg));
    const entryId = registerImport(spaceId, spoolId, index);
    registered = true;
    const wait = await settledWithin(runSpaceAct(entryId, { waiter: true, via: 'door' }), spaceActAnswerMs());
    releaseSpaceActWaiter(entryId);
    if (!wait.finished) { res.status(202).json({ queued: true, spaceId }); return; }
    const settled = wait.value;
    if (settled.interrupted) { res.status(503).json({ error: 'shutting down; the import resumes after the next start', code: 'shutting_down' }); return; }
    if (!settled.ok) { sendCaughtFailure(res, where, settled.cause ?? new Error(settled.error ?? 'the import did not complete'), { error: settled.error ?? 'The import did not complete; see the log.' }); return; }
    const result = takeImportResult(entryId) ?? { spaceId, results: {} as ImportResult['results'] };
    req.auditChangesExplicit = importChanges(result);
    res.json(result);
  } catch (err) {
    if (!registered) removeSpool(spoolId);
    if (err instanceof ClientGone) return;
    const refused = refusalOf(err, encoding);
    if (refused) {
      // The rest of a body this door will not read is drained, so the answer reaches a client still sending, and the connection then closes.
      res.setHeader('Connection', 'close');
      req.resume();
      res.status(refused.status).json({ error: refused.error });
      return;
    }
    const closed = spaceActClosedAnswer(err);
    if (closed) { res.status(closed.status).json(closed.body); return; }
    sendCaughtFailure(res, where, err, { error: 'The import did not complete; see the log.' });
  }
});
