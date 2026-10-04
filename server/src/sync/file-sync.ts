/**
 * File sync for one member and one space: tombstones both ways, then the manifest diff, then the bytes.
 *
 * Moved out of `sync/engine.ts` whole (no behaviour change in the move) because the engine is frozen by
 * `no-new-god-files.test.js` and file sync kept growing inside it: Q-68 (the peer's local id for the plain file
 * routes) and the conflict rule that follows it both belong here, beside the transfer they change.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDataRoot } from '../config/loader.js';
import type { NetworkMember, ConflictDoc, FileMetaDoc } from '../config/types.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { boundedJson } from '../util/bounded-read.js';
import { toSafeRelPath } from '../util/paths.js';
import { log, peerText } from '../util/log.js';
import { buildFileManifest } from '../files/manifest.js';
import { readStored, writeStored, deleteStored } from '../files/stored-bytes.js';
import { resolveSafePathChecked } from '../files/sandbox.js';
import { deleteFileMeta, recordArrivedFile } from '../files/file-meta.js';
import { publishedFileTombstones } from '../files/tombstones.js';
import { peerSafeFetch, transferInit, PEER_TRANSFER_TIMEOUT_MS } from './peer-fetch.js';
import { recordFileTombstoneAck, ackedPositionFrom } from './file-tombstone-ack.js';
import { decideFilePull, decideFilePush, conflictCopyPath, isInstanceLocalFile } from './file-conflict.js';
import { peerFileSpaceId } from './space-map.js';

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
      const tsResp = await peerSafeFetch(
        `${member.url}/api/sync/file-tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`,
        opts(),
      );
      if (tsResp.ok) {
        const { tombstones } = await boundedJson<{ tombstones: { path: string }[] }>(tsResp, 'sync peer');
        const spaceDataRoot = getDataRoot();
        const spaceFiles = path.resolve(spaceDataRoot, 'files', spaceId);
        for (const ts of tombstones) {
          try {
            // Normalise to prevent path traversal (sandbox-safe relative path).
            const rel = toSafeRelPath(ts.path);
            const abs = path.join(spaceFiles, rel);
            if (!abs.startsWith(spaceFiles + path.sep) && abs !== spaceFiles) continue;
            await deleteStored(abs).catch(() => { /* already gone — ignore */ });
            await deleteFileMeta(spaceId, rel).catch(() => { /* best-effort */ });
          } catch { /* ignore per-file errors */ }
        }
      } else {
        log.warn(`File tombstones from ${peerText(member.label)}: ${tsResp.status}`);
      }
    } catch (err) {
      // Tombstone fetch is best-effort; continue with manifest sync.
      log.warn(`File tombstone fetch from ${peerText(member.label)}: ${peerText(err)}`);
    }

    // ── 1b. Push our file tombstones to the peer ──────────────────────────
    // Files we deleted locally must be propagated to the peer so they disappear there too.
    if (doPush) try {
      // Published ones only: a tombstone whose act has not happened is pushed to no peer (bundle-30 I15).
      const ourTombstones = await publishedFileTombstones(spaceId);
      if (ourTombstones.length > 0) {
        const ackResp = await peerSafeFetch(
          `${member.url}/api/sync/file-tombstones?networkId=${encodeURIComponent(networkId)}`,
          {
            ...opts(),
            method: 'POST',
            body: JSON.stringify({ spaceId: remoteSpaceId, tombstones: ourTombstones }),
          },
        );
        // A 200 is a real acknowledgement, and it used to be thrown away. The peer upserts every tombstone it
        // receives and re-propagates it onward, so a 200 proves this peer now holds them — which is what lets us
        // drop ours (see `sync/file-tombstone-ack.ts`). The position is taken from the array we actually SENT,
        // never from a fresh query: a file deleted between building this body and reading the response was not in
        // the payload, and counting it as delivered would drop a tombstone no peer has seen.
        //
        // Anything other than 200 acknowledges nothing. A 403 means a direction-blocked peer that will never
        // accept our tombstones, and pruning on a rejected push is precisely how a deleted file comes back.
        if (ackResp.ok) {
          recordFileTombstoneAck(member.instanceId, spaceId, ackedPositionFrom(ourTombstones));
        } else {
          log.debug(`Push file tombstones to ${peerText(member.label)}: ${ackResp.status} — position not advanced`);
        }
      }
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
    const bases = await syncBasesFor(spaceId, member.instanceId);

    const dataRoot = getDataRoot();
    const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

    if (doPull) for (const remote of manifest) {
      if (isInstanceLocalFile(remote.path)) continue; // a peer's conflict copy or schema snapshot is the peer's own
      const local = oursMap.get(remote.path);
      // See ./file-conflict.ts — a file has no `seq`, so a differing hash cannot be resolved by last-writer-wins the way
      // records are. When ours is still the version this peer and we last agreed on, theirs replaces it (Q-66);
      // otherwise ours is kept and theirs lands beside it as a conflict copy.
      const action = decideFilePull(local, remote, bases.get(remote.path));
      if (action === 'skip') {
        if (bases.get(remote.path) !== remote.sha256) await recordSyncBase(spaceId, remote.path, member.instanceId, remote.sha256);
        continue;
      }

      try {
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
          { timeoutMs: PEER_TRANSFER_TIMEOUT_MS },
        );
        if (!dl.ok) { log.warn(`DL file ${peerText(remote.path)} from ${peerText(member.label)}: ${dl.status}`); continue; }
        const buf = Buffer.from(await dl.arrayBuffer());
        const sha = createHash('sha256').update(buf).digest('hex');
        if (sha !== remote.sha256) { log.warn(`SHA mismatch for ${peerText(remote.path)} from ${peerText(member.label)}`); continue; }

        pulledFiles++;
        if (!local || action === 'replace') {
          // New here, or changed only on the peer since we last agreed: write it over the original path.
          // The PEER's path, so it is resolved through the sandbox: a plain join let a manifest entry such as
          // `../../other-space/x` write outside this space (the tombstone branch above always checked; this did not).
          const absPath = await resolveSafePathChecked(spaceId, remote.path);
          // The bytes on the wire are plaintext; the receiver stores them by its OWN rules — encrypted at rest
          // when it has a master secret — under the path lock the migration job also takes (F-43).
          await writeStored(absPath, buf);
          // An ARRIVAL, not an upload: size and hash only, and no seq stamp that would outrank the peer's metadata (Q-143).
          await recordArrivedFile(spaceId, remote.path, buf.length, sha, { instanceId: member.instanceId, instanceLabel: member.label })
            .catch(() => { /* best-effort */ });
          await recordSyncBase(spaceId, remote.path, member.instanceId, remote.sha256);
          if (action === 'replace') log.info(`FILE_REPLACED: '${peerText(remote.path)}' changed only on peer '${peerText(member.label)}' since the last agreed version; took theirs.`);
          pulledPaths.push(remote.path);
        } else {
          // File exists locally with a different hash — keep local, save incoming
          // under a conflict-copy name so the user can decide which version to keep.
          // The peer's label reaches a filesystem path, so it is sanitised there — see
          // ./file-conflict.ts for why that is an allowlist rather than a strip-list.
          const conflictRelPath = conflictCopyPath(remote.path, member.label, new Date());
          const absConflictPath = await resolveSafePathChecked(spaceId, conflictRelPath);
          await writeStored(absConflictPath, buf);

          // Persist a conflict record so the UI can surface it to the user
          const conflictDoc: ConflictDoc = {
            _id: uuidv4(),
            spaceId,
            originalPath: remote.path,
            conflictPath: conflictRelPath,
            peerInstanceId: member.instanceId,
            peerInstanceLabel: member.label,
            detectedAt: new Date().toISOString(),
          };
          await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts')).insertOne(asDoc<ConflictDoc>(conflictDoc));

          log.warn(
            `FILE_CONFLICT: '${peerText(remote.path)}' from peer '${peerText(member.label)}' differs from local copy. ` +
            `Conflict copy saved as '${peerText(conflictRelPath)}'. Resolve in Settings → Conflicts.`,
          );
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
      if (decideFilePush(localEntry, peerManifestMap.get(localPath), bases.get(localPath)) === 'skip') continue;
      try {
        const absPath = path.join(spaceRoot, localPath);
        // Plaintext on the wire, whatever this instance keeps at rest: the peer applies its own rules (F-43).
        const bytes = await readStored(absPath);
        const pushResp = await peerSafeFetch(
          `${member.url}/api/files/${encodeURIComponent(fileSpaceId)}?path=${encodeURIComponent(localPath)}`,
          {
            method: 'POST',
            headers: {
              Authorization: headers['Authorization'],
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.length),
            },
            body: bytes,
            // Whole-file body: BATCH_FETCH_TIMEOUT_MS is a control-plane budget and would abort any
            // upload slower than a minute. Same reasoning as the download below-- see
            // PEER_TRANSFER_TIMEOUT_MS.
            signal: AbortSignal.timeout(PEER_TRANSFER_TIMEOUT_MS),
          },
        );
        if (!pushResp.ok) {
          log.warn(`Push file '${peerText(localPath)}' to ${peerText(member.label)}: HTTP ${pushResp.status}`);
        } else {
          pushedFiles++;
          await recordSyncBase(spaceId, localPath, member.instanceId, localEntry.sha256);
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

async function syncBasesFor(spaceId: string, peerId: string): Promise<Map<string, string>> {
  const key = `syncBase.${peerId}`;
  const docs = await col<SyncedFileMeta>(spaceCollection(spaceId, 'files'))
    .find(asFilter<SyncedFileMeta>({ [key]: { $exists: true } }), { projection: { _id: 1, [key]: 1 } }).toArray();
  return new Map(docs.map(d => [String(d._id), String(d.syncBase?.[peerId] ?? '')]));
}

/** Record that this instance and `peerId` now both hold `sha256` for the file at `filePath`. */
async function recordSyncBase(spaceId: string, filePath: string, peerId: string, sha256: string): Promise<void> {
  await col<SyncedFileMeta>(spaceCollection(spaceId, 'files'))
    .updateOne(asFilter<SyncedFileMeta>({ _id: filePath }), asUpdate<SyncedFileMeta>({ $set: { [`syncBase.${peerId}`]: sha256 } }))
    .catch(err => log.warn(`recordSyncBase ${peerText(filePath)}: ${peerText(err)}`));
}
