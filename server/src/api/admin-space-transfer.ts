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
 * (`backupRow`, the rule the import drops by): no chunk, no face row, no legacy spill. After the families, `schemaSnapshots`: the schema
 * snapshots the written records carry and those they link, `{ fp, text, links }` each (`sync/schema-snapshot-export.ts`).
 *
 * ## The import
 *
 * The body never reaches the global JSON parser (`markImportBody`, mounted before it, sets the flag both parsers skip), so a caller is let in
 * before a byte of the body is read, and no 10 MB ceiling stands between a backup and its restore. In order:
 *
 *  1. auth (the route's guard), a JSON content type (else 415) and a known encoding, no other import standing anywhere and no other door
 *     importing (409, `space_being_imported`, held until this door answered); an act already standing for the space runs first, the import
 *     waiting behind it in the space's queue;
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
import { SNAPSHOTS_EXPORT_KEY, exportedSnapshotIds, noteCarried, writeJsonArray, writeSnapshotElements, type SnapshotsWritten } from '../sync/schema-snapshot-export.js';
import { SERVER_VERSION } from '../util/server-version.js';
import { log, peerText } from '../util/log.js';
import { settledWithin } from '../util/time-bound.js';
import { runSpaceAct, releaseSpaceActWaiter, spaceActAnswerMs, spaceActClosedAnswer } from '../spaces/space-act-runner.js';
import { SPACE_ACT_KINDS } from '../config/types-space-acts.js';
import { ImportBusyError, ensureSpoolRoot, holdImportDoor, indexSpool, registerImport, removeSpool, spoolPathOf, takeImportResult } from '../spaces/import-act.js';
import { importTotals, type ImportResult } from '../sync/space-import.js';
import { UploadGone, UploadStalled, UploadTooSlow, uploadReadable } from '../util/upload-reader.js';
import { uploadCallerKey, uploadCooldown } from '../util/upload-cooldown.js';
import { closeUnreadBody } from './rdf-upload-refusal.js';

/** The import route's full path, for the parser marker `app.ts` mounts before the global parsers (the router serves it under its mount). */
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

/** Mounted by `app.ts` at `/api/admin/spaces` (a literal there, which the route scans read). */
export const spaceTransferRouter = express.Router();

// ── the export ──────────────────────────────────────────────────────────────────────────────────────────────────

spaceTransferRouter.get('/:spaceId/export', globalRateLimit, requireAdminMfaScoped('spaceId'), async (req, res) => {
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
  const snapshotCounts: SnapshotsWritten = { written: { to: 0 }, omitted: { to: 0 } };
  req.auditChangesExplicit = [
    ...written,
    Object.assign(snapshotCounts.written, { field: SNAPSHOTS_EXPORT_KEY }),
    Object.assign(snapshotCounts.omitted, { field: 'schemaSnapshotsOmitted' }),
  ];
  // The fingerprints the written records carry: the snapshots the export then holds are exactly theirs (and what those link).
  const carried = new Set<string>();

  const write = (chunk: string): Promise<void> =>
    res.write(chunk) ? Promise.resolve() : new Promise<void>(resolve => res.once('drain', resolve));

  /** One family's cursor, not yet sent; the files collection holds only the rows a backup holds (`backupRow`). */
  const cursorOf = (collection: (typeof REPLICATED_FAMILIES)[number]['collection']) =>
    col(spaceCollection(spaceId, collection)).find(collection === 'files' ? { ...backupRow.filter } : {}, { projection });

  /** Stream one family's cursor as a JSON array value. */
  const streamArray = (cursor: ReturnType<typeof cursorOf>, files: boolean, count: { to: number }): Promise<void> => writeJsonArray((async function* () {
    for await (const doc of cursor) {
      if (files && !backupRow.predicate(doc as Record<string, unknown>)) continue;
      yield JSON.stringify(doc);
      noteCarried(carried, doc);
      count.to++;
    }
  })(), write);

  try {
    // The store is asked BEFORE the 200 is committed: the first family's first batch is read while the status can still change, so a store
    // that fails answers 503 like every door (`sendCaughtFailure`). Asked after the envelope, the failure could only destroy a response whose
    // status line and envelope still sat in the compressor and the corked socket: the client got no answer at all (bundle-40 CI, Q-267).
    // A HEAD is answered the export's status and type and nothing is read for it: Express runs this GET route for it and Node drops the body, so
    // the walk below would serialise the whole space to send nothing, and the audit row would count its documents as written. The row it
    // leaves holds the zero counts set above.
    const head = req.method === 'HEAD';
    const cursors = head ? [] : REPLICATED_FAMILIES.map(f => cursorOf(f.collection));
    await cursors[0]?.hasNext();
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (head) { res.end(); return; }
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
      await streamArray(cursors[i]!, f.collection === 'files', written[i]!);
    }
    // After the families: the schema snapshots the written records use, and those they link (`sync/schema-snapshot-export.ts`).
    await write(`,${JSON.stringify(SNAPSHOTS_EXPORT_KEY)}:`);
    await writeSnapshotElements(spaceId, await exportedSnapshotIds(spaceId, carried), write, snapshotCounts);
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

/** An upload that sent nothing for the upload's idle bound (408; the connection is closed after the answer). */
export const SPACE_IMPORT_UPLOAD_STALLED = 'space_import_upload_stalled';
/** An upload that sent less than the least rate over a window of the reader's waiting (408; the connection is closed after the answer). */
export const SPACE_IMPORT_UPLOAD_TOO_SLOW = 'space_import_upload_too_slow';
/** A caller refused for its upload's pace, importing again within one window (429 with `Retry-After`; the body is not read). */
export const SPACE_IMPORT_UPLOAD_COOLDOWN = 'space_import_upload_cooldown';
/** An import the closed runner interrupted (503). */
export const SPACE_IMPORT_SHUTTING_DOWN = 'shutting_down';
/**
 * Every code the import door answers. Its older refusals (400, 413, 415, 507) answer none and are named so in the admin guide; the
 * door's busy answer is the import act kind's code.
 */
export const SPACE_IMPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  SPACE_ACT_KINDS.import.writeRefusalCode, SPACE_IMPORT_SHUTTING_DOWN, SPACE_IMPORT_UPLOAD_STALLED, SPACE_IMPORT_UPLOAD_TOO_SLOW, SPACE_IMPORT_UPLOAD_COOLDOWN,
]);
/** The callers this door refused for their upload's pace, answered 429 for one window (`util/upload-cooldown.ts`). */
const importCooldown = uploadCooldown();
/** The statuses of an upload's pace: the body did not arrive in time (RFC 9110 section 15.5.9), and a cooled-down caller. */
const PACE_STATUS = { REQUEST_TIMEOUT: 408, TOO_MANY_REQUESTS: 429 } as const;
const MS_PER_SECOND = 1_000;

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

/** What a refused import answers, by what refused it; the spool is already gone. Only an upload's pace is answered with a code. */
function refusalOf(err: unknown, encoding: string): { status: number; error: string; code?: string } | null {
  if (err instanceof UploadStalled) {
    return { status: PACE_STATUS.REQUEST_TIMEOUT, error: `The upload sent nothing for ${Math.round(err.idleMs / MS_PER_SECOND)} seconds and was cut off; nothing was written: send the body again, without pauses.`, code: SPACE_IMPORT_UPLOAD_STALLED };
  }
  if (err instanceof UploadTooSlow) {
    return { status: PACE_STATUS.REQUEST_TIMEOUT, error: `The upload sent less than ${err.minBytesPerSecond} bytes a second over ${Math.round(err.windowMs / MS_PER_SECOND)} seconds and was cut off; nothing was written: send the body again over a faster link.`, code: SPACE_IMPORT_UPLOAD_TOO_SLOW };
  }
  if (err instanceof OverCeiling || err instanceof ExportBodyTooLarge) return { status: 413, error: err.message };
  if (err instanceof ExportBodyMalformed) return { status: 400, error: err.message };
  if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC') return { status: 507, error: 'The disk holding the import spool is full; nothing was written.' };
  const code = String((err as { code?: unknown })?.code ?? '');
  if (code.startsWith('Z_') || code.startsWith('ERR__ERROR') || code === 'ERR_BROTLI_DECOMPRESSION_FAILED') {
    return { status: 400, error: `The body could not be inflated as ${encoding}; nothing was written.` };
  }
  return null;
}

/**
 * Spool the request body to `file`: read at the upload's pace (`util/upload-reader.ts`: a stall or a trickle is refused), inflated, bounded,
 * encrypted when a master secret is configured. Never destroys the request: a later stage's failure aborts the reader's wait and leaves the
 * request to the door, which answers and drains it.
 */
async function spoolBody(req: Request, file: string, encoding: string, max: number): Promise<void> {
  const inflate = INFLATERS[encoding]!;
  const secret = resolveMasterSecret();
  const head = uploadReadable(req, { door: 'space-import' });
  const gone = (): void => { if (!req.complete) head.destroy(new ClientGone('the client went away before the body ended')); };
  req.once('close', gone);
  const stages: Readable[] = [head];
  if (inflate) stages.push(inflate());
  stages.push(ceilingOf(max));
  if (secret) stages.push(createChunkedEncryptor(deriveKey(secret)));
  try {
    await pipeline([...stages, fs.createWriteStream(file, { mode: 0o600, flags: 'wx' })] as unknown as NodeJS.ReadWriteStream[]);
  } finally {
    req.off('close', gone);
  }
}

/** The bytes free under `dir`, or null when its file system cannot say. */
type FreeSpaceReader = (dir: string) => number | null;
const statfsFree: FreeSpaceReader = (dir) => {
  try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch { return null; }
};
let freeSpaceOf: FreeSpaceReader = statfsFree;

/** Replace the free-space reader the door asks before it spools (a test fills the disk without filling it); null restores `statfs`. */
export function setImportFreeSpaceForTest(reader: FreeSpaceReader | null): void {
  freeSpaceOf = reader ?? statfsFree;
}

/** Is there room for a body of `declared` bytes under `dir`? A file system that cannot say is not refused. */
function roomFor(dir: string, declared: number): boolean {
  const free = freeSpaceOf(dir);
  return free === null || free >= declared;
}

/** The counts of a landed import, for its audit row: ids never, totals only. */
function importChanges(result: ImportResult): Array<{ field: string; to: number }> {
  return Object.entries(importTotals(result)).map(([field, to]) => ({ field, to }));
}

spaceTransferRouter.post('/:spaceId/import', globalRateLimit, requireAdminMfaScoped('spaceId'), async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  const caller = uploadCallerKey(req);
  const wait = importCooldown.retryAfterSeconds(caller);
  if (wait !== undefined) {
    // Answered before the body is read: the rest is drained and the connection ends.
    closeUnreadBody(req, res);
    res.setHeader('Retry-After', String(wait));
    res.status(PACE_STATUS.TOO_MANY_REQUESTS).json({ error: `Your last upload here was too slow or stalled: send the body again in ${wait} seconds, without pauses.`, code: SPACE_IMPORT_UPLOAD_COOLDOWN });
    return;
  }
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) {
    closeUnreadBody(req, res);
    res.status(415).json({ error: 'An import body is an export: send it as application/json.' });
    return;
  }
  const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase() || 'identity';
  if (!(encoding in INFLATERS)) {
    closeUnreadBody(req, res);
    res.status(415).json({ error: `Content-Encoding '${peerText(encoding)}' is not one an import inflates (gzip, deflate, br).` });
    return;
  }
  // One import at a time, instance-wide, held from before the body is spooled until the door answered (`holdImportDoor`). An act already
  // standing for the space runs first: the import waits behind it in the space's queue.
  const busy = (): void => {
    closeUnreadBody(req, res);
    res.status(409).json({ error: `Space '${spaceId}' takes no import now: ${SPACE_ACT_KINDS.import.writeRefusalWhy()}.`, code: SPACE_ACT_KINDS.import.writeRefusalCode });
  };
  const door = await holdImportDoor(() => importThroughDoor(req, res, spaceId, encoding, busy, () => importCooldown.note(caller)));
  if (!door.held) busy();
});

/**
 * The import door past its one-at-a-time check: spool, validate, register, wait and answer. Never throws. `refusedForPace` is called when the
 * upload is refused for its pace (the caller's cooldown).
 */
async function importThroughDoor(
  req: Request, res: Response, spaceId: string, encoding: string, busy: () => void, refusedForPace: () => void,
): Promise<void> {
  const where = 'POST /api/admin/spaces/:spaceId/import';
  const spoolId = crypto.randomUUID();
  const file = spoolPathOf(spoolId)!;
  let registered = false;
  try {
    const root = ensureSpoolRoot();
    const declared = Number(req.headers['content-length'] ?? 0) || 0;
    if (!roomFor(root, declared)) {
      closeUnreadBody(req, res);
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
    if (settled.interrupted) { res.status(503).json({ error: 'shutting down; the import resumes after the next start', code: SPACE_IMPORT_SHUTTING_DOWN }); return; }
    if (!settled.ok) { sendCaughtFailure(res, where, settled.cause ?? new Error(settled.error ?? 'the import did not complete'), { error: settled.error ?? 'The import did not complete; see the log.' }); return; }
    const result = takeImportResult(entryId) ?? { spaceId, results: {} as ImportResult['results'] };
    req.auditChangesExplicit = importChanges(result);
    res.json(result);
  } catch (err) {
    if (!registered) removeSpool(spoolId);
    // A client that went away is answered nothing and is no failure of ours (the stage's own refusal, the reader's, or the socket's error).
    if (err instanceof ClientGone || err instanceof UploadGone || (req.destroyed && !req.complete)) return;
    // Whatever answers from here (a refusal, a closed runner, a fault): the rest of a body this door will not read is drained, so the answer
    // reaches a client still sending, and the connection then closes.
    closeUnreadBody(req, res);
    if (err instanceof ImportBusyError) { busy(); return; }
    const refused = refusalOf(err, encoding);
    if (refused) {
      if (err instanceof UploadStalled || err instanceof UploadTooSlow) refusedForPace();
      res.status(refused.status).json({ error: refused.error, ...(refused.code ? { code: refused.code } : {}) });
      return;
    }
    const closed = spaceActClosedAnswer(err);
    if (closed) { res.status(closed.status).json(closed.body); return; }
    sendCaughtFailure(res, where, err, { error: 'The import did not complete; see the log.' });
  }
}
