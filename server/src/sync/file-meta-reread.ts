/**
 * The RE-READ of a peer's file rows after a merkle check finds the roots differ — what makes the equal-seq convergence of
 * `Q-419` actually run.
 *
 * ## What it repairs
 *
 * Two instances can hold one file row at the same seq with different `updatedAt` values (a 5.6 move of a peer's file
 * re-stamped the timestamp alone). The row converges when its AUTHOR delivers it again at that seq
 * (`convergesOnAuthorStamp`, `sync/upsert-plan.ts`) — but an ordinary pull starts at the receive watermark, and a drifted
 * row is behind it, so nothing ever delivers it again and `MERKLE_DIVERGENCE` is logged every cycle for a space where
 * nobody disagrees. So, armed by a divergence, the member's file rows are read once more from the start, through the same
 * pull and the same accept (`pullFamily`).
 *
 * ## The state: `fileMetaRereadAt[space]` on the member row
 *
 *   absent        not owed
 *   `k:<seq>`     owed: attempt k, reading from <seq>
 *   `k:done`      attempt k read to the end; the next merkle check judges it
 *   `spent`       the cap's attempts all read to the end and the roots still differ; said once, kept until a match
 *
 * `nextFileMetaRereadState` is the one fold, with two event sources: what a merkle check concluded, and how a re-read
 * ended. It is held by a hand-written truth table (`the-file-meta-re-read-state-is-one-fold.test.js`).
 *
 * ## What it prevents
 *
 *  - **A cost nobody opted into.** Unlike the tombstone re-read, absent means NOT owed: nothing is read until a check with
 *    `merkle: true` says the roots differ, so an instance with merkle off pays nothing.
 *  - **A livelock.** The mark carries its own cursor and completes only when a read reaches the end. It cannot share
 *    `lastSeqReceived` — one number across six families — and it never moves it: a repair is not a position in the record
 *    stream, and the ordinary pull's place must survive a re-read that stops.
 *  - **A re-read for ever.** Some differences a re-read cannot fix — the author left the network, the row names no author,
 *    a real divergence. After `FILE_META_REREAD_CAP` attempts that each read to the end with the roots still differing, the
 *    mark is `spent`: said ONCE, and not read again until a match clears it, so a new drift can arm it afresh.
 *  - **A silent stall.** `ythril_sync_file_meta_rereads_owed` counts the marks with a read owed; a re-read that throws is
 *    the space's failure, reported once per window by the shared reporter, and stays owed.
 *
 * Stated limits: convergence is opt-in with `merkle: true`; a push-only member is never re-read (this instance does not
 * pull from it) and converges when it next pulls from us.
 */
import { getConfig } from '../config/loader.js';
import type { Config, NetworkMember } from '../config/types.js';
import { setFileMetaRereadsOwedProvider } from '../metrics/registry.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { log, peerText } from '../util/log.js';
import { parseSeqText } from '../util/seq-keyset.js';
import { LinkageCheck } from './linkage-check.js';
import { foldRepairMark, readMemberSpaceMark } from './member-space-mark.js';
import type { MerkleComparison } from './merkle-check.js';
import { pullFamily } from './pull-family.js';
import { familyOf } from './replicated-families.js';

/** How many full re-reads a divergence may cost before it is said and left alone. */
export const FILE_META_REREAD_CAP = 3;

const STEP = 'sync file-row re-read';
const SPENT = 'spent';

type Parsed = { owed: true; attempt: number; from: number } | { owed: false; attempt: number } | null;

/** Read a mark: `k:<seq>` owed, `k:done` finished, anything else (absent, `spent`, unreadable) neither. */
function parse(state: string | undefined): Parsed {
  const m = state === undefined ? null : /^([1-9]\d*):(.*)$/.exec(state);
  if (!m) return null;
  const attempt = Math.min(Number(m[1]), FILE_META_REREAD_CAP);
  if (m[2] === 'done') return { owed: false, attempt };
  // A cursor that is not a seq reads again from the start, never skips: a guess here is the one place rows could be lost.
  return { owed: true, attempt, from: parseSeqText(m[2]!) ?? 0 };
}

/**
 * The mark after one event: a merkle check's verdict, or how a re-read ended. Pure; `undefined` means not owed.
 *
 * A match always clears — the roots agree, so nothing is owed, and a later drift may arm again. A mismatch arms the first
 * attempt from nothing, the next attempt from a finished one, and `spent` from the last; mid-read it changes nothing, since
 * a difference is expected until the read ends. An unknown verdict changes nothing. A re-read's ending moves only an owed
 * mark: to `k:done` when it read to the end, to its cursor when it progressed, nowhere when it stopped.
 */
export function nextFileMetaRereadState(
  state: string | undefined,
  event: { merkle: MerkleComparison } | { reread: { complete: boolean; cursor?: string; stopped?: boolean } },
): string | undefined {
  const p = parse(state);
  if ('merkle' in event) {
    if (event.merkle === 'match') return undefined;
    if (event.merkle === 'unknown' || state === SPENT || p?.owed) return state;
    if (!p) return '1:0';
    return p.attempt >= FILE_META_REREAD_CAP ? SPENT : `${p.attempt + 1}:0`;
  }
  if (!p?.owed) return state;
  const end = event.reread;
  if (end.complete) return `${p.attempt}:done`;
  if (end.stopped || end.cursor === undefined) return state;
  return `${p.attempt}:${end.cursor}`;
}

/** Where an owed mark says to read from; `null` when nothing is owed. */
export function fileMetaRereadStart(state: string | undefined): number | null {
  const p = parse(state);
  return p?.owed ? p.from : null;
}

/**
 * How many re-reads are owed: (peer, space) pairs whose mark has a read still to make. Read from the config alone — it is
 * what `ythril_sync_file_meta_rereads_owed` reports, so a scrape never touches the store.
 */
export function fileMetaRereadsOwed(cfg: Pick<Config, 'networks'>): number {
  const owed = new Set<string>();
  for (const net of cfg.networks ?? []) {
    for (const m of net.members ?? []) {
      for (const [space, state] of Object.entries(m.fileMetaRereadAt ?? {})) {
        if (fileMetaRereadStart(state) !== null) owed.add(`${m.instanceId}\n${space}`);
      }
    }
  }
  return owed.size;
}

// Registered where the count lives, so the gauge cannot be left reading 0 by a start path that forgot to wire it.
setFileMetaRereadsOwedProvider(() => fileMetaRereadsOwed(getConfig()));

/**
 * Fold a merkle check's verdict into the member's mark. The cap's end is said here, once: only the check that moves the
 * mark INTO `spent` speaks, so a mark that stays spent is not said again every cycle.
 */
export function recordFileMetaMerkleComparison(member: NetworkMember, spaceId: string, verdict: MerkleComparison): void {
  const seen = foldRepairMark(member.instanceId, spaceId, 'fileMetaRereadAt', (s) => nextFileMetaRereadState(s, { merkle: verdict }));
  if (seen && seen.after === SPENT && seen.before !== SPENT) {
    log.warn(`File-row re-read for space '${peerText(spaceId)}' with peer ${peerText(member.label ?? member.instanceId)}: `
      + `${FILE_META_REREAD_CAP} full re-reads did not make the merkle roots agree, so it is not re-read again until they do. `
      + 'What remains is not a drifted timestamp this instance can take from its author: a row whose author has left or is not '
      + 'named, or a real difference in content.');
  }
}

/**
 * Re-read `member`'s file rows for `spaceId` when its mark says a read is owed. Called once per member and space from the
 * pull step, after the ordinary pull. Never throws, and never moves `lastSeqReceived`.
 */
export async function rereadFileMeta(o: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  requestInit: () => RequestInit;
}): Promise<void> {
  const { member, spaceId, remoteSpaceId, networkId, requestInit } = o;
  const start = fileMetaRereadStart(readMemberSpaceMark(networkId, member.instanceId, spaceId, 'fileMetaRereadAt'));
  if (start === null) return;
  try {
    // Its own linkage check: a file row is a target, so what it lands is checked like any other pull, never skipped.
    const linkage = new LinkageCheck(spaceId, member.instanceId);
    const res = await pullFamily({
      family: familyOf('filemeta'), member, spaceId, remoteSpaceId, networkId, sinceSeq: start, requestInit, linkage,
    });
    await linkage.run();
    const complete = !res.truncated;
    const progressed = res.deliveredThrough > start;
    foldRepairMark(member.instanceId, spaceId, 'fileMetaRereadAt', (s) => nextFileMetaRereadState(s, {
      reread: { complete, ...(progressed ? { cursor: String(res.deliveredThrough) } : {}), stopped: !complete && !progressed },
    }));
    if (complete) {
      log.info(`Re-read of the file rows of peer ${peerText(member.label ?? member.instanceId)} for space '${peerText(spaceId)}' `
        + `finished: ${res.count} row(s) read, ${res.converged} converged on their author's timestamp.`);
    }
  } catch (err) {
    // The space's failure: said once per window, and the re-read stays owed. Never thrown — a repair must not fail the cycle.
    reportSpaceFailure(STEP, spaceId, err, { when: 'next cycle' });
  }
}
