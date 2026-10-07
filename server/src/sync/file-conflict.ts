/**
 * What to do with a peer's copy of a file, and where a conflicting copy is written.
 *
 * Extracted from `syncFiles` in `sync/engine.ts` (god-file split, slice 2b). Both decisions are pure;
 * the engine keeps the downloads and the disk writes.
 *
 * ── The naming half handles peer-controlled input ────────────────────────────────────────────────
 *
 * A conflict copy's filename embeds the PEER'S LABEL, and a peer's label is whatever that instance's
 * operator typed. It reaches a filesystem path, so it is untrusted input in the only sense that
 * matters here: a label containing `../`, a drive letter, a colon, or a NUL would otherwise produce a
 * path that escapes the space directory or simply cannot be created on Windows.
 *
 * The sanitiser is an ALLOWLIST — `[A-Za-z0-9_-]`, everything else becomes `_` — rather than a list of
 * dangerous characters to strip. Same reasoning as the audit change allowlist: forgetting an entry in
 * a denylist is a hole, forgetting one in an allowlist is a slightly uglier filename.
 *
 * The timestamp is a parameter rather than read from the clock, so the result is a pure function of
 * its inputs and a test can assert the exact name.
 */
import path from 'node:path';
import { spillIdFromPath } from '../brain/spill-path.js';

/** The minimum a manifest entry needs for this decision. */
export interface ManifestEntry {
  path: string;
  sha256: string;
}

/**
 * What a peer's version of a file means for us.
 *
 *   skip           we already have exactly these bytes
 *   write          we do not have this file — take it
 *   conflict-copy  we have this path with DIFFERENT bytes; keep ours, save theirs alongside
 *
 * The third case is the whole reason this is a decision rather than an overwrite. Sync elsewhere is
 * last-writer-wins by `seq`, but a file has no seq — there is no way to tell which side is newer, so
 * silently taking the peer's bytes would destroy local work with nothing to recover from.
 */
export type FilePullAction = 'skip' | 'write' | 'replace' | 'conflict-copy';

/**
 * What to do with a peer's file. `base` is the hash this instance and that peer last both held (`syncBase` on the
 * local file's metadata): when ours still IS that version, only the peer changed it and theirs replaces ours (`Q-66`).
 * Without a base — nothing agreed yet — a difference cannot be told from an edit on both sides, so it stays a conflict.
 * Owner, 2026-09-27: auto-accept the incoming copy when the local one was not touched since.
 */
export function decideFilePull(local: ManifestEntry | undefined, remote: ManifestEntry, base?: string): FilePullAction {
  if (!local) return 'write';
  if (local.sha256 === remote.sha256) return 'skip';
  if (base !== undefined && local.sha256 === base) return 'replace';   // only the peer changed it
  if (base !== undefined && remote.sha256 === base) return 'skip';     // only WE changed it: our push carries it
  return 'conflict-copy';
}

/**
 * Whether to push our file over the peer's: the same question as `decideFilePull`, asked from the other side. With a
 * base, only when the PEER's copy is still the agreed version — otherwise the peer edited it too, and its own pull
 * raises the conflict instead of our push erasing its edit. The push decided by modification time alone, so which of
 * two edits survived depended on whose clock was later. Without a base (nothing agreed yet, e.g. data from before
 * this rule) the old newer-wins order stands, so an upgrade does not turn every existing file into a conflict.
 *
 * `toldTombstoned` is the peer's own answer to an earlier upload of exactly these bytes (`200 { tombstoned: true }`,
 * `sync/told-tombstoned.ts`): it holds a tombstone that erased them, so they are not sent again while our hash for the path
 * is unchanged. It is read FIRST, because the peer having no copy of the path — what sends the push below — is exactly
 * what that tombstone is the reason for.
 */
export function decideFilePush(
  local: ManifestEntry & { modifiedAt: string },
  peer: (ManifestEntry & { modifiedAt: string }) | undefined,
  base?: string,
  toldTombstoned = false,
): 'push' | 'skip' {
  if (toldTombstoned) return 'skip';
  if (!peer) return 'push';
  if (local.sha256 === peer.sha256) return 'skip';
  if (base !== undefined) return peer.sha256 === base ? 'push' : 'skip';
  return local.modifiedAt > peer.modifiedAt ? 'push' : 'skip';
}

/**
 * Make a peer label safe to embed in a filename.
 *
 * Allowlist, not denylist. Capped at 20 characters so a long label cannot push the whole filename past
 * a filesystem's limit, which would turn a conflict copy into a write error.
 */
/**
 * Files an instance derives for ITSELF, which never travel in either direction (`Q-66`):
 * - a CONFLICT COPY, named by `conflictCopyPath` (`<base>_<ISO time>_<peer label><ext>`): it is this instance's half of
 *   an open conflict, and replicated it landed on the peer as a copy of the peer's own conflict;
 * - a SCHEMA SNAPSHOT, `schemas/<space>_<entity|fact|edge|chrono>_<type>.json` (`spaces/_shared.ts` syncSchemaFiles):
 *   each instance writes it from its OWN effective meta, so every schema change conflicted on every member.
 * - a LEGACY READ SPILL, `_tmp/graph-<uuid>.json` / `_tmp/results-<uuid>.json` at the root (`Q-92`): one caller's
 *   search result, written into the space by versions before 5.6.0. Spills now live outside every space; the copies
 *   older versions wrote are swept locally, and the ones older peers still offer are refused here.
 * Matched by name, so a copy an older peer still offers is refused on pull as well.
 */
const CONFLICT_COPY = /_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[A-Za-z0-9_-]{1,20}(\.[^/]*)?$/;
const SCHEMA_SNAPSHOT = /^schemas\/[a-z0-9][a-z0-9-]*_(entity|fact|edge|chrono)_[A-Za-z0-9_-]+\.json$/;
export function isInstanceLocalFile(relPath: string): boolean {
  return CONFLICT_COPY.test(relPath) || SCHEMA_SNAPSHOT.test(relPath) || isLegacyReadSpill(relPath);
}

/**
 * The spill half of `isInstanceLocalFile`, for the file-METADATA arrivals (the arrival writer and the stray drain):
 * a legacy read spill's metadata is refused there as its bytes are here. Named for its question, so the three
 * near-copies that spelled `spillIdFromPath` at a writer are one predicate (bundle-30 `R8`). Whether those arrivals
 * should refuse a conflict copy's or a schema snapshot's metadata as well is a behaviour change, filed, not folded in.
 */
export function isLegacyReadSpill(relPath: string): boolean {
  return spillIdFromPath(relPath) !== null;
}

export function safePeerLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20);
}

/**
 * Where a conflicting incoming file is written, relative to the space's file root.
 *
 * `<dir>/<base>_<timestamp>_<peer><ext>` — the original extension is preserved so the copy still opens
 * in whatever the file is, and the directory is preserved so it lands beside the file it conflicts
 * with rather than in some quarantine nobody looks in.
 *
 * Colons and dots are replaced in the timestamp because a colon is illegal in a Windows filename and a
 * bare ISO string would otherwise make every conflict copy unwritable there.
 */
export function conflictCopyPath(remotePath: string, peerLabel: string, when: Date): string {
  const ext = path.extname(remotePath);
  const base = path.basename(remotePath, ext);
  const dir = path.dirname(remotePath);
  const ts = when.toISOString().replace(/:/g, '-').replace(/\./g, '-');
  const name = `${base}_${ts}_${safePeerLabel(peerLabel)}${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}
