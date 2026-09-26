/**
 * File sync for one member and one space: tombstones both ways, then the manifest diff, then the bytes.
 *
 * Moved out of `sync/engine.ts` whole (no behaviour change in the move) because the engine is frozen by
 * `no-new-god-files.test.js` and file sync kept growing inside it: Q-68 (the peer's local id for the plain file
 * routes) and the conflict rule that follows it both belong here, beside the transfer they change.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDataRoot } from '../config/loader.js';
import type { NetworkMember, FileTombstoneDoc, ConflictDoc } from '../config/types.js';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { boundedJson } from '../util/bounded-read.js';
import { toSafeRelPath } from '../util/paths.js';
import { log } from '../util/log.js';
import { buildFileManifest } from '../files/manifest.js';
import { deleteFileMeta, upsertFileMeta } from '../files/file-meta.js';
import { peerSafeFetch, transferInit, PEER_TRANSFER_TIMEOUT_MS } from './peer-fetch.js';
import { recordFileTombstoneAck, ackedPositionFrom } from './file-tombstone-ack.js';
import { decideFilePull, conflictCopyPath } from './file-conflict.js';
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
            await fs.unlink(abs).catch(() => { /* already gone — ignore */ });
            await deleteFileMeta(spaceId, rel).catch(() => { /* best-effort */ });
          } catch { /* ignore per-file errors */ }
        }
      } else {
        log.warn(`File tombstones from ${member.label}: ${tsResp.status}`);
      }
    } catch (err) {
      // Tombstone fetch is best-effort; continue with manifest sync.
      log.warn(`File tombstone fetch from ${member.label}: ${err}`);
    }

    // ── 1b. Push our file tombstones to the peer ──────────────────────────
    // Files we deleted locally must be propagated to the peer so they disappear there too.
    if (doPush) try {
      const ourTombstones = await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones'))
        .find(asFilter<FileTombstoneDoc>({ spaceId }))
        .toArray();
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
          log.debug(`Push file tombstones to ${member.label}: ${ackResp.status} — position not advanced`);
        }
      }
    } catch (err) {
      log.warn(`Push file tombstones to ${member.label}: ${err}`);
    }

    // ── 2. Fetch peer manifest and download new/changed files ─────────────
    // Only fetch the peer manifest if we need to pull or push (manifest comparison
    // drives both directions). When neither direction needs manifest, skip entirely.
    if (!doPull && !doPush) return { pulledFiles, pushedFiles, pulledPaths };
    const resp = await peerSafeFetch(`${member.url}/api/sync/manifest?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`, opts());
    if (!resp.ok) { log.warn(`File manifest from ${member.label}: ${resp.status}`); return { pulledFiles, pushedFiles, pulledPaths }; }
    const { manifest, spaceId: peerSpaceId } = await boundedJson<{ manifest: { path: string; sha256: string; size: number; modifiedAt: string }[]; spaceId?: string }>(resp, 'sync peer');
    const fileSpaceId = peerFileSpaceId(peerSpaceId, remoteSpaceId); // Q-68: the plain file routes know only the peer's local id

    // Build our manifest for comparison
    const ours = await buildFileManifest(spaceId);
    const oursMap = new Map(ours.map(e => [e.path, e]));

    const dataRoot = getDataRoot();
    const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

    if (doPull) for (const remote of manifest) {
      const local = oursMap.get(remote.path);
      // See ./file-conflict.ts — a file has no `seq`, so a differing hash cannot be resolved by
      // last-writer-wins the way records are. Ours is kept and theirs lands beside it.
      const action = decideFilePull(local, remote);
      if (action === 'skip') continue;

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
        if (!dl.ok) { log.warn(`DL file ${remote.path} from ${member.label}: ${dl.status}`); continue; }
        const buf = Buffer.from(await dl.arrayBuffer());
        const sha = createHash('sha256').update(buf).digest('hex');
        if (sha !== remote.sha256) { log.warn(`SHA mismatch for ${remote.path} from ${member.label}`); continue; }

        pulledFiles++;
        if (!local) {
          // File is new locally — write directly to the original path
          const absPath = path.join(spaceRoot, remote.path);
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, buf);
          await upsertFileMeta(spaceId, remote.path, buf.length).catch(() => { /* best-effort */ });
          pulledPaths.push(remote.path);
        } else {
          // File exists locally with a different hash — keep local, save incoming
          // under a conflict-copy name so the user can decide which version to keep.
          // The peer's label reaches a filesystem path, so it is sanitised there — see
          // ./file-conflict.ts for why that is an allowlist rather than a strip-list.
          const conflictRelPath = conflictCopyPath(remote.path, member.label, new Date());
          const absConflictPath = path.join(spaceRoot, conflictRelPath);
          await fs.mkdir(path.dirname(absConflictPath), { recursive: true });
          await fs.writeFile(absConflictPath, buf);

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
            `FILE_CONFLICT: '${remote.path}' from peer '${member.label}' differs from local copy. ` +
            `Conflict copy saved as '${conflictRelPath}'. Resolve in Settings → Conflicts.`,
          );
        }
      } catch (err) {
        log.warn(`File sync error for ${remote.path}: ${err}`);
      }
    }

    // ── 3. Push our files that the peer doesn't have or that we have updated ─
    // • Peer doesn't have the file at all → push new
    // • Peer has an older version (our modifiedAt > peer modifiedAt) → push update
    // • Peer is at same version or newer → skip (pull step handled that)
    if (doPush) {
    const peerManifestMap = new Map(manifest.map(e => [e.path, e]));
    for (const [localPath, localEntry] of oursMap) {
      const peerEntry = peerManifestMap.get(localPath);
      if (peerEntry) {
        if (localEntry.sha256 === peerEntry.sha256) continue; // already in sync
        if (localEntry.modifiedAt <= peerEntry.modifiedAt) continue; // peer is same age or newer
        // fall through — our version is newer, push the update
      }
      try {
        const absPath = path.join(spaceRoot, localPath);
        const bytes = await fs.readFile(absPath);
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
          log.warn(`Push file '${localPath}' to ${member.label}: HTTP ${pushResp.status}`);
        } else {
          pushedFiles++;
        }
      } catch (err) {
        log.warn(`Push file '${localPath}' to ${member.label}: ${err}`);
      }
    }
    } // end doPush
  } catch (err) {
    log.warn(`syncFiles for ${member.label} space ${spaceId}: ${err}`);
  }
  return { pulledFiles, pushedFiles, pulledPaths };
}
