/**
 * File sync for one member and one space: tombstones both ways, then the manifest diff, then the bytes.
 *
 * Moved out of `sync/engine.ts` whole (no behaviour change in the move) because the engine is frozen by
 * `no-new-god-files.test.js` and file sync kept growing inside it: Q-68 (the peer's local id for the plain file
 * routes) and the conflict rule that follows it both belong here, beside the transfer they change.
 */
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { v4 as uuidv4 } from 'uuid';
import { getDataRoot } from '../config/loader.js';
import type { NetworkMember, ConflictDoc, FileMetaDoc } from '../config/types.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { boundedJson } from '../util/bounded-read.js';
import { log, logSafe, peerText } from '../util/log.js';
import { StreamVerificationError } from '../util/sha256-tap.js';
import { ISO_START_CURSOR, ISO_READ_START, type IsoPosition } from '../util/seq-keyset.js';
import {
  stageStored, commitStaged, statStored, bytesPresent, isMissingPath, type StagedStoredFile,
} from '../files/stored-bytes.js';
import { resolveSafePathChecked, fileKeyOf } from '../files/sandbox.js';
import { buildFileManifest, seedFileHash, type ManifestEntry } from '../files/manifest.js';
import { recordArrivedBytes, countFileArrival, type FileRepairReason } from '../files/bytes-arrived.js';
import { resolveInputFormat } from '../files/converters/pipeline.js';
import { removeUnrecordedBytes } from '../files/unrecorded-bytes.js';
import { checkQuota, QuotaError, REPEATED_CHECK_USAGE_WINDOW_MS } from '../quota/quota.js';
import { withinHousekeepingBound } from '../db/write-bound.js';
import { reportSpaceFailure, reportSpaceRecovered } from '../util/space-failure.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import {
  publishedFileTombstonePage, settledFileTombstones, fileTombstoneOnTheWire, decideArrivals,
  LEGACY_FILE_TOMBSTONE_LIMIT,
} from '../files/tombstones.js';
import { applyPeerFileTombstones } from '../files/peer-tombstone-apply.js';
import { peerSafeFetch, transferInit, PEER_TRANSFER_TIMEOUT_MS } from './peer-fetch.js';
import { recordFileTombstoneAck, ackedPositionFrom } from './file-tombstone-ack.js';
import { decideFilePull, decideFilePush, conflictCopyPath, isInstanceLocalFile } from './file-conflict.js';
import { peerFileSpaceId } from './space-map.js';
import { deliveryOfMember } from './deletion-authority.js';
import { declinedCountOf, refusedCountOf, sayPeerDeclined, sayPeerRefused } from './decline-report.js';
import { serverCursorOf } from './seq-run-pager.js';
import { MAX_TRANSFER_PAGES, stopAtPageBound, type TransferOutcome } from './watermark.js';
import { noteToldTombstoned, wasToldTombstoned, noteRefusedUpload, wasRefusedUpload } from './told-tombstoned.js';
import { pushStoredFile, type SendUpload } from './file-push.js';

/**
 * The most files whose held bytes are looked at for a repair, per space per sync cycle: a row that names another hash than the
 * disk's, processing that never ran on a class that processes (the record is brought up to date), or no row at all (the bytes are
 * taken back and delivered again) — `repairReasonOf`. A file an earlier release pulled — bytes and row, no conversion — is repaired
 * LAZILY, a few a cycle, never by a walk at boot: every repair is a document queued for conversion, and one cycle that queued the
 * whole backlog of a space would be a boot-sized job inside a request-sized one, with the receiver's own models (and, where
 * consented, an external one) paying for it at once. The rest wait their turn; a file is repaired once, because the repair leaves
 * it with a state that is not a reason.
 *
 * A candidate counts the moment it is looked at, whatever the verdict: one a held tombstone shadows, or that cannot be looked at,
 * cost its read too, and a space holding many of them must not pay that read for every one of them every cycle.
 */
export const MAX_FILE_REPAIRS_PER_CYCLE = 25;

/** The names a failure of the pull's record, quota, repair and body-verification steps is reported under: once per space and path per window. */
const RECORD_STEP = declareStep('File pull record');
const QUOTA_STEP = declareStep('File pull quota');
const REPAIR_STEP = declareStep('File pull repair');
const BODY_STEP = declareStep('File pull body');

/**
 * What the pull reads of a space's top-level file row, once per cycle (`heldRowsFor`): the hash and processing state the row
 * records, whether it is soft-deleted, and the hash this instance and the peer last both held.
 */
interface HeldRow { sha256?: string; embeddingStatus?: string; deletedAt?: string; syncBase?: Record<string, string> }

/**
 * Why the bytes already on disk at `key` (hash `diskSha256`) need their record brought up to date — or `null` when they do not.
 * Pure. The three reasons are the three ways an arrival leaves a file half-recorded: a row that says another hash than the disk
 * (the write that records the arrival failed and was swallowed, or an older release stored the row and not the new bytes'), no row
 * at all (the bytes are there and nothing names them: they are taken back, never recorded, because a row made here for them
 * would name this instance their author and deliverer), and a class that processes with no processing state (a release before
 * the pull dispatched). A soft-deleted row is not repaired: the file is deleted here, and what is on disk is not its bytes.
 */
export function repairReasonOf(row: HeldRow | undefined, diskSha256: string, key: string): FileRepairReason | null {
  if (!row) return 'missing_row';
  if (row.deletedAt !== undefined) return null;
  if (row.sha256 !== diskSha256) return 'stale_row';
  if (row.embeddingStatus === undefined && resolveInputFormat(key) !== 'text') return 'unprocessed';
  return null;
}

/**
 * The top-level file rows of a space as the pull needs them, by id, read ONCE per call of `syncFiles` (the base of each path, the
 * hash and state the row records) and replacing the per-peer base query that was the only read it made. Chunk and sidecar
 * rows (`parentFileId`) are not files here. A full cursor, projected, under the store bound: a read that hangs ends at the bound
 * and is the space's failure, reported by the caller's catch.
 */
async function heldRowsFor(spaceId: string, peerId: string): Promise<Map<string, HeldRow>> {
  const baseKey = `syncBase.${peerId}`;
  return withinHousekeepingBound(async () => {
    const docs = await col<SyncedFileMeta>(spaceCollection(spaceId, 'files'))
      .find(asFilter<SyncedFileMeta>({ parentFileId: { $exists: false } }),
        { projection: { _id: 1, sha256: 1, embeddingStatus: 1, deletedAt: 1, [baseKey]: 1 } }).toArray();
    return new Map(docs.map(d => [String(d._id), {
      ...(d.sha256 !== undefined ? { sha256: d.sha256 } : {}),
      ...(d.embeddingStatus !== undefined ? { embeddingStatus: d.embeddingStatus } : {}),
      ...(d.deletedAt !== undefined ? { deletedAt: d.deletedAt } : {}),
      ...(d.syncBase?.[peerId] !== undefined ? { syncBase: { [peerId]: String(d.syncBase[peerId]) } } : {}),
    } satisfies HeldRow]));
  });
}

/**
 * Say, once per window per space and path, that a pulled file was not recorded or could not be fetched (a quota refusal, a failed
 * record write), through the shared reporter — never a line of the pull's own, which would say the same fact every cycle for as
 * long as it lasts (`util/space-failure.ts`). The reporter counts every call, says the line once, and bounds the memory the
 * peer's paths could otherwise grow. A store that is not answering is the step's stop line, not this space's.
 *
 * A file that then succeeds at the step says so with `reportSpaceRecovered(step, spaceId, key)`: its next failure is news again.
 * Scoped to the PATH (the reporter's `unit`), because a recovery of the whole (step, space) after any one file succeeded would
 * forget a still-failing sibling's line, and it would be said again every cycle.
 */
function sayPullFailure(step: string, spaceId: string, key: string, err: unknown): void {
  reportSpaceFailure(step, spaceId, err, { unit: key, when: 'next cycle', ...(storeIsNotAnswering(err) ? { kind: 'store-down' as const } : {}) });
}

/**
 * Whether the disk still holds what the pull decided on, asked under the path lock right before the rename (`commitStaged`): for a
 * file new here, that nothing has appeared at the path; for one the peer's change replaces, that it is still the file the manifest
 * described (the plaintext size and the modification time the manifest published), so a local edit that landed while the body was
 * being fetched is never overwritten by the peer's version — it is a conflict, and the caller writes the bytes beside it.
 */
async function diskStillHolds(abs: string, local: ManifestEntry | undefined): Promise<boolean> {
  if (!local) return !(await bytesPresent(abs));
  const stat = await statStored(abs).catch((err: unknown) => { if (isMissingPath(err)) return null; throw err; });
  return stat !== null && stat.size === local.size && stat.mtime.toISOString() === local.modifiedAt;
}

/**
 * Hand the manifest's hash cache the hash the pull's tap just took, so the next manifest build does not read the whole file again to
 * learn it (as the at-rest migration does for what it encrypts). A saving and never a rule: a failure leaves the cache as it was and
 * the next build hashes the file.
 */
async function seedManifestHash(spaceId: string, key: string, abs: string, sha256: string, plainSize: number): Promise<void> {
  try {
    const stat = await statStored(abs);
    await seedFileHash(spaceId, key, { size: stat.onDiskSize, mtimeMs: stat.mtimeMs, sha256, plainSize });
  } catch (err) {
    log.debug(`seed hash ${peerText(key)}: ${peerText(err)}`);
  }
}

export async function syncFiles(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  headers: Record<string, string>,
  opts: () => RequestInit,
  doPull = true,
  doPush = true,
): Promise<{ pulledFiles: number; pushedFiles: number; pulledPaths: string[] }> {
  let pulledFiles = 0, pushedFiles = 0;
  const pulledPaths: string[] = [];
  try {
    // ── 1. Apply peer's file tombstones (deletions) first ─────────────────
    // Fetch tombstones before the manifest so that files deleted on the peer
    // are removed locally before the manifest comparison runs.
    if (doPull) try {
      await pullFileTombstones(member, spaceId, remoteSpaceId, networkId, opts);
    } catch (err) {
      // Tombstone fetch is best-effort; continue with manifest sync.
      log.warn(`File tombstone fetch from ${peerText(member.label)}: ${peerText(err)}`);
    }

    // ── 1b. Push our file tombstones to the peer ──────────────────────────
    // Files we deleted locally must be propagated to the peer so they disappear there too.
    if (doPush) try {
      // In pages of at most FILE_TOMBSTONE_PAGE, each acknowledged on its own: one body carrying the whole set outgrew the
      // request limit and then failed every cycle for ever, since the set only shrinks once a peer acknowledges it (Q-396).
      const sentTo = `Push file tombstones to ${peerText(member.label)}`;
      const endpoint = `${member.url}/api/sync/file-tombstones?networkId=${encodeURIComponent(networkId)}`;
      const outcome: TransferOutcome = { deliveredThrough: 0, truncated: false };
      let after: IsoPosition = ISO_READ_START;
      let refused = 0;
      let declined = 0;
      for (let pages = 1; ; pages++) {
        // Published ones only: a tombstone whose act has not happened is pushed to no peer (bundle-30 I15). The page names the
        // row past it (`peek`), to know whether it ends inside a run of rows at one position, and whether there is a next one.
        const { rows: sent, next, peek } = await publishedFileTombstonePage(spaceId, after);
        if (sent.length === 0) break;
        const ackResp = await peerSafeFetch(endpoint, {
          ...opts(),
          method: 'POST',
          body: JSON.stringify({ spaceId: remoteSpaceId, tombstones: sent.map(fileTombstoneOnTheWire) }),
        });
        // A 200 is a real acknowledgement, and it used to be thrown away. The peer judges every tombstone it receives and
        // re-propagates the ones it keeps, so a 200 proves this peer has dealt with them — which is what lets us
        // drop ours (see `sync/file-tombstone-ack.ts`). The position is taken from the array we actually SENT,
        // never from a fresh query: a file deleted between building this body and reading the response was not in
        // the payload, and counting it as delivered would drop a tombstone no peer has seen. Rows of a run the page ends in
        // are not proven yet: the rest of the run goes in the next page.
        //
        // Anything other than 200 acknowledges nothing, and stops the pages: nothing after a page the peer did not
        // acknowledge is counted. A 403 means a direction-blocked peer that will never accept our tombstones, and pruning
        // on a rejected push is precisely how a deleted file comes back.
        const ourTombstones = settledFileTombstones(sent, peek);
        if (ackResp.ok) {
          recordFileTombstoneAck(member.instanceId, spaceId, ackedPositionFrom(ourTombstones));
          // `refused` and `declined` are additive: an older peer sends neither. A re-send is refused or declined again, so the
          // position advances past them, as the record push's does, and the lines below are what tell an operator. (A
          // declined file tombstone met a row somebody authored: a row only arriving bytes created is authorless to the
          // receiver's authority, `fileTargetOf`, Q-405, so the origin's deletion of it is applied.)
          const body = await boundedJson<{ refused?: unknown; declined?: unknown }>(ackResp, 'sync peer')
            .catch(() => ({}) as { refused?: unknown; declined?: unknown });
          refused += refusedCountOf(body);
          declined += declinedCountOf(body);
        } else {
          log.debug(`${sentTo}: ${ackResp.status} — position not advanced`);
          break;
        }
        if (next === null) break;
        const last = sent[sent.length - 1]!;
        after = { at: last.positionAt, id: last._id };
        if (stopAtPageBound(outcome, (why) => log.warn(`${sentTo} stopped: ${logSafe(why)}; the rest is sent next cycle.`), pages, MAX_TRANSFER_PAGES)) break;
      }
      sayPeerRefused('file tombstones', member.label, spaceId, refused);
      sayPeerDeclined('file tombstones', member.label, spaceId, declined);
    } catch (err) {
      log.warn(`Push file tombstones to ${peerText(member.label)}: ${peerText(err)}`);
    }

    // ── 2. Fetch peer manifest and download new/changed files ─────────────
    // Only fetch the peer manifest if we need to pull or push (manifest comparison
    // drives both directions). When neither direction needs manifest, skip entirely.
    if (!doPull && !doPush) return { pulledFiles, pushedFiles, pulledPaths };
    const resp = await peerSafeFetch(`${member.url}/api/sync/manifest?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`, opts());
    if (!resp.ok) { log.warn(`File manifest from ${peerText(member.label)}: ${resp.status}`); return { pulledFiles, pushedFiles, pulledPaths }; }
    const { manifest, spaceId: peerSpaceId } = await boundedJson<{ manifest: { path: string; sha256: string; size: number; modifiedAt: string }[]; spaceId?: string }>(resp, 'sync peer');
    const fileSpaceId = peerFileSpaceId(peerSpaceId, remoteSpaceId); // Q-68: the plain file routes know only the peer's local id

    // Build our manifest for comparison
    const ours = await buildFileManifest(spaceId);
    const oursMap = new Map(ours.map(e => [e.path, e]));
    // One read of the space's top-level rows per call: the agreed hash of each path (`syncBase.<peer>`, Q-66) and what each row
    // records of its bytes (`repairReasonOf`). Replaces the read that returned the bases alone.
    const held = await heldRowsFor(spaceId, member.instanceId);
    const bases = { get: (path: string): string | undefined => held.get(path)?.syncBase?.[member.instanceId] };
    // Bytes this cycle has written, for the quota question of the next fetch: a cached measurement does not see them yet.
    let pulledBytes = 0;
    let repairs = 0;

    const dataRoot = getDataRoot();
    const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

    // A peer's entry is a spelling of a path until it is resolved (Q-404): every lookup below — the local manifest, the sync
    // base, the held tombstones, the file row — is made by the KEY, as the write is made at the resolved path. The peer's own
    // text is used for one thing, asking the peer for the bytes it advertised under it. The key is derived lexically, with no
    // disk (`fileKeyOf`): every entry of every manifest is keyed every cycle, and the symlink check is made by the write below,
    // which is the only thing here that touches the filesystem, and only for an entry that is actually fetched.
    const arriving: { remote: (typeof manifest)[number]; key: string }[] = [];
    if (doPull) for (const remote of manifest) {
      try {
        arriving.push({ remote, key: fileKeyOf(spaceId, remote.path).key });
      } catch (err) {
        // An entry that leaves the space (`../../other-space/x`) is skipped and touches nothing.
        log.warn(`File sync error for ${peerText(remote.path)}: ${peerText(err)}`);
      }
    }

    // The bytes a tombstone erased are not downloaded again (Q-229, Q-348): asked ONCE for every entry that would be fetched,
    // by the same predicate every other arrival of a file's bytes asks (`decideArrivals`). An entry it could not decide (the
    // path of a pending delete cannot be looked at) waits for the next cycle, as a shadowed one is not fetched.
    const wanted = (a: { remote: (typeof manifest)[number]; key: string }): boolean =>
      !isInstanceLocalFile(a.key) && decideFilePull(oursMap.get(a.key), a.remote, bases.get(a.key)) !== 'skip';
    const verdicts = await decideArrivals(spaceId, arriving.filter(wanted)
      .map(a => ({ id: a.key, path: a.key, kind: 'bytes' as const, sha256: a.remote.sha256 })));
    const notNow = new Set([...verdicts.shadowed, ...verdicts.undecided]);

    // The files the skip branch below would bring up to date (held here with the peer's hash, their row stale, missing or never
    // processed) are asked the same deletion question ONCE, together, before any is repaired: a path a delete is waiting to
    // publish, or one that cannot be looked at, is not recorded again — repairing it would bring back a file the operator deleted.
    // Asked one by one, every such path cost its own read every cycle, and enough of them that stay shadowed used up the cycle's
    // repair budget before a repairable file was reached, so it never was.
    const repairable = arriving.filter(a => {
      const onDisk = oursMap.get(a.key);
      return onDisk && !isInstanceLocalFile(a.key) && decideFilePull(onDisk, a.remote, bases.get(a.key)) === 'skip'
        && repairReasonOf(held.get(a.key), onDisk.sha256, a.key) !== null;
    });
    const repairVerdicts = repairable.length > 0
      ? await decideArrivals(spaceId, repairable.map(a => ({ id: a.key, path: a.key, kind: 'bytes' as const, sha256: oursMap.get(a.key)!.sha256 })))
      : { shadowed: new Set<string>(), undecided: new Set<string>() };
    const notRepairedNow = new Set([...repairVerdicts.shadowed, ...repairVerdicts.undecided]);

    for (const { remote, key } of arriving) {
      if (isInstanceLocalFile(key)) continue; // a peer's conflict copy or schema snapshot is the peer's own
      const local = oursMap.get(key);
      // See ./file-conflict.ts — a file has no `seq`, so a differing hash cannot be resolved by last-writer-wins the way
      // records are. When ours is still the version this peer and we last agreed on, theirs replaces it (Q-66);
      // otherwise ours is kept and theirs lands beside it as a conflict copy.
      const action = decideFilePull(local, remote, bases.get(key));
      if (action === 'skip') {
        if (bases.get(key) !== remote.sha256) await recordSyncBase(spaceId, key, member.instanceId, remote.sha256);
        // The bytes are here, and "the same hash on both sides" is not "recorded": a file an earlier cycle (or release) stored and
        // did not record, or recorded and never processed, is brought up to date from what is on disk, a few per cycle.
        // A candidate the deletion question above shadowed or could not decide is not repaired and does not use the budget.
        const reason = local && repairs < MAX_FILE_REPAIRS_PER_CYCLE && !notRepairedNow.has(key)
          ? repairReasonOf(held.get(key), local.sha256, key) : null;
        if (local && reason) {
          try {
            repairs++;
            if (reason === 'missing_row') {
              // Bytes with no row and a peer that offers the path: bytes whose record failed (today's pull takes such bytes back; an
              // earlier release swallowed the failure and left them). A row inserted for them here would name this instance as
              // their author and their deliverer, which a peer's file must never be (the derived-description guard and the
              // authorless-placeholder test both read `author == this instance`). So they are taken back, and the next cycle delivers
              // them as an ordinary arrival, with its true deliverer.
              if (await removeUnrecordedBytes(spaceId, key)) countFileArrival('pull', 'repaired_missing_row');
              continue;
            }
            // A row exists, so the author and deliverer it already has stay: only its size, hash and processing are brought up to date.
            await recordArrivedBytes(spaceId, key, { sizeBytes: local.size, sha256: local.sha256, door: 'pull', repair: reason });
            reportSpaceRecovered(REPAIR_STEP, spaceId, key);
          } catch (err) {
            sayPullFailure(REPAIR_STEP, spaceId, key, err);   // counted as `record_failed` by the recorder; tried again next cycle
          }
        }
        continue;
      }
      if (notNow.has(key)) continue;

      try {
        // The one place this entry's path meets the disk: resolved WITH the symlink check, before a byte is fetched for a path
        // the write would refuse (the key above is lexical).
        const abs = await resolveSafePathChecked(spaceId, key);
        // The space quota, asked BEFORE the body is fetched, on the size the manifest declares: a pull used to fetch and write
        // whatever the space held. The measurement may be a few seconds old, so the bytes this call has already written are added.
        // A refusal is not a delivery: no base is written, and the file is asked for again once there is room.
        try {
          await checkQuota('files', pulledBytes + remote.size, { maxAgeMs: REPEATED_CHECK_USAGE_WINDOW_MS });
        } catch (err) {
          if (!(err instanceof QuotaError)) throw err;
          countFileArrival('pull', 'quota');
          sayPullFailure(QUOTA_STEP, spaceId, key, err);
          continue;
        }
        reportSpaceRecovered(QUOTA_STEP, spaceId, key);
        /*
         * Whole-file body, so it gets the TRANSFER budget — and until now it did not, whatever this
         * comment said.
         *
         * `opts()` is the control-plane request init and already carries `signal:
         * AbortSignal.timeout(FETCH_TIMEOUT_MS)`. `peerSafeFetch` resolves `init.signal ??
         * AbortSignal.timeout(opts.timeoutMs)`, so the caller's signal WON and the transfer budget beside
         * it was dead code. The effective ceiling was ten seconds — not the thirty this comment assumed —
         * so any file whose body took longer than that aborted, logged, and was retried identically on
         * every cycle, for ever. Large files simply never replicated.
         *
         * `transferInit` strips the control-plane deadline, and it lives in `peer-fetch.ts` because that
         * file owns what each budget is for — stripping it by hand here would be a second copy of the
         * decision that was wrong the first time.
         */
        const dl = await peerSafeFetch(
          `${member.url}/api/files/${encodeURIComponent(fileSpaceId)}?path=${encodeURIComponent(remote.path)}`,
          transferInit(opts()),
          { timeoutMs: PEER_TRANSFER_TIMEOUT_MS, streamBody: true },
        );
        if (!dl.ok) {
          await dl.body?.cancel().catch(() => undefined);   // a body nobody reads holds the connection until the signal fires
          log.warn(`DL file ${peerText(remote.path)} from ${peerText(member.label)}: ${dl.status}`);
          continue;
        }
        /*
         * The body STREAMS: through one tap, capped at the size the manifest DECLARED and checked against the hash it declared, into
         * a temp file outside the path lock (`stageStored`). A peer chooses its body, and the cost of this pull was its to set when
         * the whole body was read before it was looked at: now a body past its declared size is stopped at that size, a body that
         * is not the declared hash fails in the tap's `flush`, and either leaves the stored file, its row and the temp dir as they
         * were. Nothing reaches the tree before the re-check and the commit below.
         */
        let staged: StagedStoredFile;
        try {
          staged = await stageStored(abs, dl.body ? Readable.fromWeb(dl.body as WebReadableStream<Uint8Array>) : Readable.from([]), {
            expect: { sha256: remote.sha256, size: remote.size },
          });
        } catch (err) {
          if (err instanceof StreamVerificationError) {
            // A body that is not what the manifest declared (another hash, past its size, short of it): nothing was stored, the peer
            // is asked again next cycle. Counted every time and said once per window, as the quota refusal and the record failure are:
            // a peer that serves wrong bodies is otherwise a line per cycle for ever, and invisible on the counter.
            countFileArrival('pull', 'refused_body');
            sayPullFailure(BODY_STEP, spaceId, key, err);
            continue;
          }
          throw err;
        }
        reportSpaceRecovered(BODY_STEP, spaceId, key);
        try {
          // The download took time, and a delete here may have begun since the cycle's first read: asked again, for this one path,
          // right before the bytes are written (one indexed read). Decided or not, a path a deletion covers is not written.
          const again = await decideArrivals(spaceId, [{ id: key, path: key, kind: 'bytes', sha256: remote.sha256 }]);
          if (again.shadowed.has(key) || again.undecided.has(key)) continue;

          // New here, or changed only on the peer since we last agreed: renamed over the original path (`abs`: the resolved
          // and symlink-checked path — a plain join let a manifest entry such as `../../other-space/x` write outside this space).
          // The bytes on the wire are plaintext; the receiver stores them by its OWN rules — encrypted at rest when it has a master
          // secret — and commits under the path lock the migration job also takes (F-43). Under that lock the path is resolved
          // again and the disk is asked whether it still holds what this pull decided on: the stage took as long as the peer did,
          // so a local edit may have landed meanwhile, and then the peer's bytes are a conflict, not a replacement.
          const committed = (!local || action === 'replace')
            && await commitStaged(abs, staged, { stillValid: async () => (await resolveSafePathChecked(spaceId, key)) === abs && await diskStillHolds(abs, local) });
          if (committed) {
            pulledBytes += staged.size;
            try {
              // An ARRIVAL, not an upload: size and hash only, and no seq stamp that would outrank the peer's metadata (Q-143) —
              // and the file is DISPATCHED by this instance's own rules, as an upload to the door is (Q-260).
              await recordArrivedBytes(spaceId, key, {
                sizeBytes: staged.size, sha256: staged.sha256, door: 'pull', from: { instanceId: member.instanceId, instanceLabel: member.label },
              });
            } catch (err) {
              // Bytes with no row naming them are skipped for ever by the next cycle (the same hash on both sides), and a row
              // inserted later for them would credit this peer with a file it may never have sent. So the bytes this call wrote
              // are removed (`removeUnrecordedBytes`, the one answer every door that writes bytes gives: it keeps them only when a
              // live row still names the path, an overwrite, or the lookup could not say), no base is written, and the next cycle delivers the file again with
              // its true deliverer (Q-254).
              await removeUnrecordedBytes(spaceId, key);
              sayPullFailure(RECORD_STEP, spaceId, key, err);   // counted `record_failed` by the recorder
              continue;
            }
            pulledFiles++;
            reportSpaceRecovered(RECORD_STEP, spaceId, key);
            await seedManifestHash(spaceId, key, abs, staged.sha256, staged.size);
            await recordSyncBase(spaceId, key, member.instanceId, remote.sha256);
            if (action === 'replace') log.info(`FILE_REPLACED: '${peerText(key)}' changed only on peer '${peerText(member.label)}' since the last agreed version; took theirs.`);
            pulledPaths.push(key);
          } else {
            // File exists locally with a different hash (or came to exist while the body was being fetched) — keep local, save
            // incoming under a conflict-copy name so the user can decide which version to keep.
            // The peer's label reaches a filesystem path, so it is sanitised there — see
            // ./file-conflict.ts for why that is an allowlist rather than a strip-list.
            const conflictRelPath = conflictCopyPath(key, member.label, new Date());
            const absConflictPath = await resolveSafePathChecked(spaceId, conflictRelPath);
            await commitStaged(absConflictPath, staged);
            pulledBytes += staged.size;
            pulledFiles++;

            // Persist a conflict record so the UI can surface it to the user
            const conflictDoc: ConflictDoc = {
              _id: uuidv4(),
              spaceId,
              originalPath: key,
              conflictPath: conflictRelPath,
              peerInstanceId: member.instanceId,
              peerInstanceLabel: member.label,
              detectedAt: new Date().toISOString(),
            };
            await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts')).insertOne(asDoc<ConflictDoc>(conflictDoc));

            log.warn(
              `FILE_CONFLICT: '${peerText(key)}' from peer '${peerText(member.label)}' differs from local copy. ` +
              `Conflict copy saved as '${peerText(conflictRelPath)}'. Resolve in Settings → Conflicts.`,
            );
          }
        } finally {
          await staged.discard();   // every exit: shadowed, committed (nothing left), refused, failed
        }
      } catch (err) {
        log.warn(`File sync error for ${peerText(remote.path)}: ${peerText(err)}`);
      }
    }

    // ── 3. Push our files the peer does not have, or holds only in the version we last agreed on ─
    // decideFilePush (./file-conflict.ts): a peer copy changed since that agreement is left for the peer's own pull to
    // raise as a conflict; with no agreement recorded yet, the newer file wins as before.
    if (doPush) {
    const peerManifestMap = new Map(manifest.map(e => [e.path, e]));
    for (const [localPath, localEntry] of oursMap) {
      // Taken from this peer a moment ago: `localEntry` predates that write, so pushing it would undo it (Q-66).
      if (pulledPaths.includes(localPath) || isInstanceLocalFile(localPath)) continue;
      // Push only over a copy the peer has not changed since we last agreed; see decideFilePush.
      // A path the peer has told us it holds a tombstone for is not sent again while our hash for it is unchanged.
      // Two answers a peer has already given to exactly these bytes, and does not need asking again for: that it holds a tombstone
      // that erased them, and that it refused them (`sync/told-tombstoned.ts`).
      const answered = wasToldTombstoned(member.instanceId, spaceId, localPath, localEntry.sha256)
        || wasRefusedUpload(member.instanceId, spaceId, localPath, localEntry.sha256);
      if (decideFilePush(localEntry, peerManifestMap.get(localPath), bases.get(localPath), answered) === 'skip') continue;
      try {
        const absPath = path.join(spaceRoot, localPath);
        // One request to the peer's upload door for THIS file. Whole-file body: BATCH_FETCH_TIMEOUT_MS is a control-plane budget
        // and would abort any upload slower than a minute. Same reasoning as the download above — see PEER_TRANSFER_TIMEOUT_MS.
        // What goes in it (one streamed body, or ranges under the peer's limit) is `pushStoredFile`'s to decide.
        const send: SendUpload = async ({ headers: extra, body }) => {
          const pushResp = await peerSafeFetch(
            `${member.url}/api/files/${encodeURIComponent(fileSpaceId)}?path=${encodeURIComponent(localPath)}`,
            {
              method: 'POST',
              headers: { Authorization: headers['Authorization'], 'Content-Type': 'application/octet-stream', ...extra },
              body: body as unknown as BodyInit,
              duplex: 'half',
              signal: AbortSignal.timeout(PEER_TRANSFER_TIMEOUT_MS),
            } as RequestInit,
          );
          const json = await boundedJson<Record<string, unknown>>(pushResp, 'sync peer').catch(() => ({}) as Record<string, unknown>);
          return { status: pushResp.status, json: json !== null && typeof json === 'object' ? json : {} };
        };
        // Plaintext on the wire, whatever this instance keeps at rest: the peer applies its own rules (F-43).
        const outcome = await pushStoredFile({ peerId: member.instanceId, abs: absPath, size: localEntry.size, sha256: localEntry.sha256, send });
        if (outcome.kind === 'tombstoned') {
          // `200 { tombstoned: true }`: the peer holds a tombstone for exactly these bytes and stored nothing. Not a failure
          // (an older sender would read one as such and upload again), and not a delivery either — remembered, so the
          // next cycle does not send the same bytes to be refused the same way (`sync/told-tombstoned.ts`).
          noteToldTombstoned(member.instanceId, spaceId, localPath, localEntry.sha256);
        } else if (outcome.kind === 'delivered') {
          pushedFiles++;
          await recordSyncBase(spaceId, localPath, member.instanceId, localEntry.sha256);
        } else {
          log.warn(`Push file '${peerText(localPath)}' to ${peerText(member.label)}: HTTP ${outcome.status}${outcome.error !== undefined ? `: ${peerText(outcome.error)}` : ''}`);
          // A refusal of the BYTES is remembered: the same bytes of the same path would be refused again, after the whole file had been sent.
          if (outcome.kind === 'refused') noteRefusedUpload(member.instanceId, spaceId, localPath, localEntry.sha256);
        }
      } catch (err) {
        log.warn(`Push file '${peerText(localPath)}' to ${peerText(member.label)}: ${peerText(err)}`);
      }
    }
    } // end doPush
  } catch (err) {
    log.warn(`syncFiles for ${peerText(member.label)} space ${peerText(spaceId)}: ${peerText(err)}`);
  }
  return { pulledFiles, pushedFiles, pulledPaths };
}

/**
 * The hash of each file this instance and `peerId` last both held, by path (`Q-66`). Kept on the local file's metadata
 * as `syncBase.<peer instance id>`: LOCAL state, never replicated (the ingest schema does not declare it, so
 * `fileMetaForWire` drops it) and never hashed (`FILE_HASH_PROJECTION` is an inclusion list).
 */
type SyncedFileMeta = FileMetaDoc & { syncBase?: Record<string, string> };

/**
 * Pull the peer's file tombstones, a page at a time, to the end, applying each page through the one apply
 * (`applyPeerFileTombstones`) with the page's `Delivery`: the peer pulled from is the authenticated source, and whether it is
 * this space's upstream is this instance's own knowledge (`sync/deletion-authority.ts`), never the peer's say-so.
 *
 * The first request carries the cursor of the start of time: a server with the paged mode answers 500 rows and a `nextCursor`,
 * which is echoed until it is `null`. An older server ignores `cursor`, answers one answer with no `nextCursor` and is read
 * once — and when that answer is as long as such a server ever answers, it may have been cut, which is said, because rows
 * past it are not reachable by an older server's own contract. The pull is still never filtered by `since` (see
 * `sync/file-tombstone-ack.ts`). A stop at the page bound of one cycle is said, and the rest is read next cycle.
 */
async function pullFileTombstones(
  member: NetworkMember, spaceId: string, remoteSpaceId: string, networkId: string, opts: () => RequestInit,
): Promise<void> {
  const peer = peerText(member.label);
  const delivery = deliveryOfMember(spaceId, member);
  const where = `sync pull file-tombstones from ${member.label}`;
  const outcome: TransferOutcome = { deliveredThrough: 0, truncated: false };
  let cursor: string = ISO_START_CURSOR;
  for (let pages = 1; ; pages++) {
    const tsResp = await peerSafeFetch(
      `${member.url}/api/sync/file-tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}&cursor=${cursor}`,
      opts(),
    );
    if (!tsResp.ok) {
      await tsResp.body?.cancel().catch(() => {});
      log.warn(`File tombstones from ${peer}: ${tsResp.status}`);
      return;
    }
    const data = await boundedJson<{ tombstones?: unknown; nextCursor?: unknown }>(tsResp, 'sync peer');
    const page = Array.isArray(data?.tombstones) ? data.tombstones : [];
    await applyPeerFileTombstones(spaceId, page, delivery, where);
    const next = serverCursorOf(data?.nextCursor);
    if (next === undefined) {
      if (page.length >= LEGACY_FILE_TOMBSTONE_LIMIT) {
        log.warn(`File tombstones from ${peer}: a full answer of ${page.length} with no nextCursor — an older server's answer may be truncated, `
          + 'and the deletions past it are not read until it is upgraded.');
      }
      return;
    }
    if (next === null) return;
    if (next === cursor) { log.warn(`File tombstones from ${peer}: the peer answered the cursor it was given; stopped.`); return; }
    if (stopAtPageBound(outcome, (why) => log.warn(`File tombstones from ${peer} stopped: ${logSafe(why)}; the rest is read next cycle.`), pages, MAX_TRANSFER_PAGES)) return;
    cursor = next;
  }
}

/** Record that this instance and `peerId` now both hold `sha256` for the file at `filePath`. */
async function recordSyncBase(spaceId: string, filePath: string, peerId: string, sha256: string): Promise<void> {
  await col<SyncedFileMeta>(spaceCollection(spaceId, 'files'))
    .updateOne(asFilter<SyncedFileMeta>({ _id: filePath }), asUpdate<SyncedFileMeta>({ $set: { [`syncBase.${peerId}`]: sha256 } }))
    .catch(err => log.warn(`recordSyncBase ${peerText(filePath)}: ${peerText(err)}`));
}
