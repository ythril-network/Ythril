/**
 * File sync for one member and one space: tombstones both ways, then the manifest diff, then the bytes.
 *
 * Moved out of `sync/engine.ts` whole (no behaviour change in the move) because the engine is frozen by
 * `no-new-god-files.test.js` and file sync kept growing inside it: Q-68 (the peer's local id for the plain file
 * routes) and the conflict rule that follows it both belong here, beside the transfer they change.
 */
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDataRoot } from '../config/loader.js';
import type { NetworkMember, ConflictDoc, FileMetaDoc } from '../config/types.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { boundedJson } from '../util/bounded-read.js';
import { log, logSafe, peerText } from '../util/log.js';
import { sha256Hex } from '../util/sha256-hex.js';
import { ISO_START_CURSOR, ISO_READ_START, type IsoPosition } from '../util/seq-keyset.js';
import { buildFileManifest } from '../files/manifest.js';
import { readStored, writeStored } from '../files/stored-bytes.js';
import { resolveSafePathChecked, peerFileKey } from '../files/sandbox.js';
import { recordArrivedFile } from '../files/file-meta.js';
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
import { noteToldTombstoned, wasToldTombstoned } from './told-tombstoned.js';

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
    const bases = await syncBasesFor(spaceId, member.instanceId);

    const dataRoot = getDataRoot();
    const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

    // A peer's entry is a spelling of a path until it is resolved (Q-404): every lookup below — the local manifest, the sync
    // base, the held tombstones, the file row — is made by the KEY, as the write is made at the resolved path. The peer's own
    // text is used for one thing, asking the peer for the bytes it advertised under it.
    const arriving: { remote: (typeof manifest)[number]; key: string; abs: string }[] = [];
    if (doPull) for (const remote of manifest) {
      try {
        arriving.push({ remote, ...await peerFileKey(spaceId, remote.path) });
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

    for (const { remote, key, abs } of arriving) {
      if (isInstanceLocalFile(key)) continue; // a peer's conflict copy or schema snapshot is the peer's own
      const local = oursMap.get(key);
      // See ./file-conflict.ts — a file has no `seq`, so a differing hash cannot be resolved by last-writer-wins the way
      // records are. When ours is still the version this peer and we last agreed on, theirs replaces it (Q-66);
      // otherwise ours is kept and theirs lands beside it as a conflict copy.
      const action = decideFilePull(local, remote, bases.get(key));
      if (action === 'skip') {
        if (bases.get(key) !== remote.sha256) await recordSyncBase(spaceId, key, member.instanceId, remote.sha256);
        continue;
      }
      if (notNow.has(key)) continue;

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
        const sha = sha256Hex(buf);
        if (sha !== remote.sha256) { log.warn(`SHA mismatch for ${peerText(remote.path)} from ${peerText(member.label)}`); continue; }

        // The download took time, and a delete here may have begun since the cycle's first read: asked again, for this one path,
        // right before the bytes are written (one indexed read). Decided or not, a path a deletion covers is not written.
        const again = await decideArrivals(spaceId, [{ id: key, path: key, kind: 'bytes', sha256: remote.sha256 }]);
        if (again.shadowed.has(key) || again.undecided.has(key)) continue;

        pulledFiles++;
        if (!local || action === 'replace') {
          // New here, or changed only on the peer since we last agreed: write it over the original path (`abs`: the resolved
          // path — a plain join let a manifest entry such as `../../other-space/x` write outside this space).
          // The bytes on the wire are plaintext; the receiver stores them by its OWN rules — encrypted at rest
          // when it has a master secret — under the path lock the migration job also takes (F-43).
          await writeStored(abs, buf);
          // An ARRIVAL, not an upload: size and hash only, and no seq stamp that would outrank the peer's metadata (Q-143).
          await recordArrivedFile(spaceId, key, buf.length, sha, { instanceId: member.instanceId, instanceLabel: member.label })
            .catch(() => { /* best-effort */ });
          await recordSyncBase(spaceId, key, member.instanceId, remote.sha256);
          if (action === 'replace') log.info(`FILE_REPLACED: '${peerText(key)}' changed only on peer '${peerText(member.label)}' since the last agreed version; took theirs.`);
          pulledPaths.push(key);
        } else {
          // File exists locally with a different hash — keep local, save incoming
          // under a conflict-copy name so the user can decide which version to keep.
          // The peer's label reaches a filesystem path, so it is sanitised there — see
          // ./file-conflict.ts for why that is an allowlist rather than a strip-list.
          const conflictRelPath = conflictCopyPath(key, member.label, new Date());
          const absConflictPath = await resolveSafePathChecked(spaceId, conflictRelPath);
          await writeStored(absConflictPath, buf);

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
      const told = wasToldTombstoned(member.instanceId, spaceId, localPath, localEntry.sha256);
      if (decideFilePush(localEntry, peerManifestMap.get(localPath), bases.get(localPath), told) === 'skip') continue;
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
        } else if ((await boundedJson<{ tombstoned?: unknown }>(pushResp, 'sync peer').catch(() => ({}) as { tombstoned?: unknown })).tombstoned === true) {
          // `200 { tombstoned: true }`: the peer holds a tombstone for exactly these bytes and stored nothing. Not a failure
          // (an older sender would read one as such and upload again), and not a delivery either — remembered, so the
          // next cycle does not send the same bytes to be refused the same way (`sync/told-tombstoned.ts`).
          noteToldTombstoned(member.instanceId, spaceId, localPath, localEntry.sha256);
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
