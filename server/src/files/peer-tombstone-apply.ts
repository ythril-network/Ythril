/**
 * THE ONE APPLY of a file tombstone a peer delivered — by push (`POST /api/sync/file-tombstones`) or by pull
 * (`syncFiles`, `sync/file-sync.ts`). Bundle-51: Q-242, Q-96, Q-229's loop.
 *
 * ## Why one function, and what each door used to do
 *
 * Each door had its own loop over the page, and each deleted the file a peer's tombstone NAMED, asking nobody whether the peer
 * could be believed: any peer able to push to a space erased any file in it. They differed in everything else — the push
 * route unlinked the bytes and left the row, the pull removed bytes and row and left the chunks, the media job and the
 * cached hash — and in the guard on the path (two hand copies of a normalisation that STRIPPED `../` and so turned an
 * escape into a delete inside the space). A tombstone also carried no version, so a file re-created at a deleted path was
 * deleted again on every later cycle and downloaded again by the next manifest pull, for as long as the tombstone was held.
 * It lives here, apart from `files/tombstones.ts` — which is the only module that opens the collection — because this one
 * reaches into the arrival writer's shape rules (`sync/arrivals.ts`), which that module must not import (a runtime cycle).
 *
 * ## The rule, in order, per element
 *
 *  1. **Shape**: a `_id`, a bounded `path`, a comparable `deletedAt`, an `issuer` that is text and a `rowSeq` that is a
 *     seq. A malformed element is refused ALONE and counted; the page goes on. A `deletedAt` in the future is CLAMPED to now
 *     (an older receiver positions by it, and a far-future one would sit above every acknowledgement for ever).
 *  2. **The path** is resolved through the sandbox by the one resolver of a peer's path (`peerFileKey`, which every door that
 *     looks a peer's path up shares, Q-404): a path that leaves the space, or goes through a link that does, is refused and
 *     touches nothing — never normalised into the tree. The row it names is keyed by the RESOLVED path, never by the
 *     sender's text. **A path this instance keeps for itself** (`isInstanceLocalFile`: a sidecar under a derived tree, a
 *     conflict copy, a schema snapshot) is IGNORED — counted in `ignored`, never applied, stored or relayed: each instance
 *     derives its own, so a peer's deletion of its copy says nothing about this one's.
 *  3. **An id already held is a no-op.** The pull reads every tombstone every cycle; one this instance holds has been
 *     applied, and applied again it deletes the file a peer has since re-created (which the next manifest pull downloads,
 *     which the next read deletes: a loop for as long as the tombstone is held).
 *  4. **Authorised**, by the one authority (`authorises`, `sync/deletion-authority.ts`) over the page's `Delivery`: the
 *     issuer is the delivering peer and wrote the file (or the file names no author), or the deliverer is this space's
 *     direct upstream and the row carries ITS delivery stamp. An issuer-less tombstone (an older peer's) is read as issued
 *     by its deliverer. A declined one is NOT stored; it is counted, named by reason in the answer's `declined`, and said
 *     once per (peer, space, reason) window. A file this instance holds no row for is stored and deletes nothing — a deletion
 *     may arrive before its file, and storing it lets this node relay it.
 *  5. **The version**: a row the tombstone's issuer re-created at a seq above the tombstone's `rowSeq` is a RE-CREATION of the path
 *     and is kept — the question every arrival door asks (`recreatedSince`, `files/tombstone-shadow.ts`; a tombstone that arrives
 *     carries no content hash, so only its version half speaks). A seq above `rowSeq` that ANOTHER author wrote says nothing about
 *     the erased content coming back (two instances' counters are not one clock), so that row goes (Q-409). A tombstone with no
 *     `rowSeq` keeps today's behaviour: the file at the path goes.
 *  6. **Removed completely** (`removeFileHere`): the bytes, then the job, the conversion artefacts and chunk rows, the cached
 *     hash, the usage figure and the row — the steps of the local delete, so a peer's deletion leaves what the owner's does.
 *     No webhook: a peer's deletion is not an act of a user here.
 *  7. **Kept only to be passed on**: a relayed tombstone is stored — with its ISSUER (so the next hop judges it as that
 *     issuer's; an issuer-less one is stored with its deliverer), positioned by the RECEIVE time, and carrying the hash of the
 *     row it erased here — only when this instance serves the space to someone else. A leaf applies and does not keep the
 *     file's name.
 *
 * ## Why the tombstone is stored AFTER the removal, which is not the order a local delete takes
 *
 * A local delete writes its tombstone first, because a crash between the unlink and the write leaves bytes gone with no
 * tombstone and nothing to repair it (bundle-30 I13). Here the sender repairs it: a page that did not land is sent again, and
 * an id this instance does not hold is applied again — and finding the row and the bytes already gone, it stores the
 * tombstone then. The other order has no such repair: a tombstone stored before a removal that then failed is HELD, and a
 * held id is never applied again, so the file would stay for ever with its deletion on record.
 *
 * What it does not do: the row's delete does not carry `deleteBound` as a record's does — a file's bytes go first and cannot
 * be bound by a predicate, so a row replaced between the read and the delete is judged by the page's own read.
 */
import { z } from 'zod';
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { getConfig } from '../config/loader.js';
import type { FileMetaDoc } from '../config/types.js';
import { isComparableIso } from '../util/comparable-iso.js';
import { MAX_CURSOR_ID_LENGTH } from '../util/seq-keyset.js';
import { seqRefusal, arrivalId, refusedFieldsOf, warnArrivalsNotStored, type ArrivalRefusal } from '../sync/arrivals.js';
import { authorises, fileTargetOf, MAX_ISSUER, type Delivery, type DeletionGround } from '../sync/deletion-authority.js';
import { recordDecline, sayDeclines, saidDeletions } from '../sync/decline-report.js';
import { servesOnward } from '../sync/served-watermark.js';
import { syncTombstonesAppliedTotal } from '../metrics/registry.js';
import { peerFileKey, PathNamesTheSpaceError } from './sandbox.js';
import { deleteStoredIfPresent } from './stored-bytes.js';
import { removeFileHere } from './remove-file-here.js';
import { recreatedSince } from './tombstone-shadow.js';
import { isInstanceLocalFile } from '../sync/file-conflict.js';
import { heldFileTombstoneIds, storeRelayedFileTombstones, type RelayedFileTombstone } from './tombstones.js';

/** The longest path a tombstone may name. A path is a peer's text, and it reaches the file system and the database. */
const MAX_TOMBSTONE_PATH = 4096;

/** The wire shape of one file tombstone. Unknown keys are stripped, so what is stored is only what is declared here. */
const FileTombstoneShape = z.object({
  _id: z.string().min(1).max(MAX_CURSOR_ID_LENGTH),
  path: z.string().min(1).max(MAX_TOMBSTONE_PATH),
  deletedAt: z.string().refine(isComparableIso, 'not an ISO timestamp'),
  issuer: z.string().max(MAX_ISSUER).optional(),
  rowSeq: z.number().optional(),
});

/** One element that passed shape and path: what the rest of the apply reads. */
interface Admitted {
  id: string;
  /** The file row's key: the RESOLVED path, relative to the space, never the sender's text. */
  key: string;
  abs: string;
  deletedAt: string;
  issuer: string | undefined;
  rowSeq: number | undefined;
}

/** What a page came to. */
export interface FileTombstoneApplyOutcome {
  /** Elements that passed shape and path — what the door admitted, whatever authorisation then decided. */
  applied: number;
  /** Elements refused on shape or path, each on its own. */
  refused: ArrivalRefusal[];
  /** Admitted elements the deletion authority declined: NOT stored, nothing deleted. */
  declined: ArrivalRefusal[];
  /** Elements at a path this instance keeps for itself (`isInstanceLocalFile`): neither applied nor stored nor an error. */
  ignored: number;
}

/** The row of a file as the apply reads it: what authority reads, the version and the content hash it erases. */
type HeldFile = Pick<FileMetaDoc, 'author' | 'seq' | 'sha256' | 'deletedAt'> & { deliveredBy?: string };

/**
 * One element's admission: shape, seq, then the path through the sandbox. A refusal names the element by its id, never by
 * its path (a path is often personal in itself, and a refusal is logged).
 */
async function admit(raw: unknown, localSpaceId: string, now: string): Promise<{ ok: Admitted } | { refused: ArrivalRefusal } | { ignored: true }> {
  const parsed = FileTombstoneShape.safeParse(raw);
  if (!parsed.success) return { refused: { _id: arrivalId(raw), reason: `not a file tombstone (${refusedFieldsOf(parsed.error)})` } };
  const t = parsed.data;
  const why = seqRefusal(t.rowSeq, { optional: true });
  if (why) return { refused: { _id: t._id, reason: `rowSeq: ${why}` } };
  let resolved: { abs: string; key: string };
  try {
    resolved = await peerFileKey(localSpaceId, t.path);
  } catch (err) {
    // A path that leaves the space (a `RangeError`) is refused, and so is one that names the space itself. Any other failure to
    // look at it is that element's too: one path the file system will not resolve must not stop the page, and nothing was touched.
    const reason = err instanceof PathNamesTheSpaceError ? 'its path names the space itself'
      : err instanceof RangeError ? 'its path leaves the space' : 'its path cannot be resolved here';
    return { refused: { _id: t._id, reason } };
  }
  // A path this instance keeps for ITSELF (`isInstanceLocalFile`: a sidecar under a derived tree, a conflict copy, a schema
  // snapshot) is no peer's to delete: each instance derives its own, so a peer's tombstone for one says nothing about this one's.
  // Ignored — not stored, not relayed, not an error: an older sender still publishes the deletion of its own sidecars.
  if (isInstanceLocalFile(resolved.key)) return { ignored: true };
  return { ok: { id: t._id, key: resolved.key, abs: resolved.abs, deletedAt: t.deletedAt > now ? now : t.deletedAt, issuer: t.issuer, rowSeq: t.rowSeq } };
}

/**
 * Apply a page of file tombstones a peer delivered, to the space the door ADMITTED — see the module docblock.
 *
 * @param localSpaceId the local space the door admitted (the body's `spaceId` after the alias middleware, or the space the
 *   sync cycle is on) — never a tombstone's own `spaceId`
 * @param raw the elements as they arrived, unvalidated
 * @param delivery who delivered the page, from `deliveryOf` — what the deletion authority reads
 * @param where names the door and the peer, for the log lines only
 */
export async function applyPeerFileTombstones(
  localSpaceId: string, raw: readonly unknown[], delivery: Delivery, where: string,
): Promise<FileTombstoneApplyOutcome> {
  const out: FileTombstoneApplyOutcome = { applied: 0, refused: [], declined: [], ignored: 0 };
  const now = new Date().toISOString();
  // Keyed in a Map, because an id is a peer's text; a repeated id in one page is applied once.
  const page = new Map<string, Admitted>();
  for (const r of raw) {
    const a = await admit(r, localSpaceId, now);
    if ('refused' in a) { out.refused.push(a.refused); continue; }
    if ('ignored' in a) { out.ignored += 1; continue; }
    if (!page.has(a.ok.id)) page.set(a.ok.id, a.ok);
  }
  out.applied = page.size;
  warnArrivalsNotStored(where, localSpaceId, 'file tombstone', 'refused', out.refused);
  if (page.size === 0) return out;

  // An id already held is applied: skipped here, neither counted nor stored again.
  const held = await heldFileTombstoneIds(localSpaceId, [...page.keys()]);
  const fresh = [...page.values()].filter(a => !held.has(a.id));
  const rows = await readStoredById<HeldFile & { deliveredBy?: string }>(
    spaceCollection(localSpaceId, 'files'), fresh.map(a => a.key),
    { author: 1, deliveredBy: 1, seq: 1, sha256: 1, deletedAt: 1 });

  const cfg = getConfig();
  const selfId = cfg.instanceId;
  const relay = servesOnward(cfg, localSpaceId, delivery.peerInstanceId);
  const ledger = { declined: out.declined, declinedBy: new Map<string, ArrivalRefusal[]>() };
  const keep: RelayedFileTombstone[] = [];
  const removed: Record<DeletionGround, number> = { issuer: 0, upstream: 0 };
  let failure: unknown;
  let failed = false;
  try {
    for (const a of fresh) {
      // An older peer's tombstone names no issuer: it is read as issued by its deliverer.
      const issuer = a.issuer ?? delivery.peerInstanceId;
      const row = rows.get(a.key);
      // A row a soft delete already flagged is a deletion already recorded: nothing here is left to judge or to remove.
      // A placeholder that arriving bytes created has no author to speak for it (`fileTargetOf`, Q-405).
      const target = row !== undefined && row.deletedAt === undefined ? fileTargetOf(row) : null;
      const verdict = authorises(delivery, issuer, target, selfId);
      if (!verdict.ok) {
        recordDecline(ledger, { id: a.id, reason: verdict.reason, kind: 'file', what: 'file', issuer, delivery, target: target ?? undefined });
        continue;
      }
      const kept: RelayedFileTombstone = { _id: a.id, path: a.key, deletedAt: a.deletedAt, ...(issuer !== undefined ? { issuer } : {}), ...(a.rowSeq !== undefined ? { rowSeq: a.rowSeq } : {}) };
      // Nothing held, or a row that is a RE-CREATION of the path (a newer version by the tombstone's issuer, `recreatedSince`: the
      // one answer every arrival door gives, never a seq compared across authors): nothing to remove.
      // The deletion is still passed on — it is true of the older version, and a peer below may still hold it.
      if (verdict.ground === 'absent' || target === null || recreatedSince({ issuer, rowSeq: a.rowSeq }, target)) {
        keep.push(kept);
        continue;
      }
      // The bytes when there are some and they are a FILE: a peer's tombstone is for ONE path and never takes a tree with it.
      await deleteStoredIfPresent(a.abs, { skipDirectory: true });
      await removeFileHere(localSpaceId, a.key, { failure: 'throw' });
      rows.delete(a.key); // a second tombstone for the path in this page finds it gone
      removed[verdict.ground] += 1;
      syncTombstonesAppliedTotal.labels({ kind: 'file', ground: verdict.ground }).inc();
      keep.push({ ...kept, ...(typeof target.sha256 === 'string' && target.sha256 !== '' ? { contentHash: target.sha256 } : {}),
        ...(verdict.ground === 'upstream' && delivery.peerInstanceId ? { storedVia: delivery.peerInstanceId } : {}) });
    }
    // After the removals, never before (see the module docblock); and only where there is someone to pass them on to.
    if (relay) await storeRelayedFileTombstones(localSpaceId, keep);
    saidDeletions(where, 'file', localSpaceId, removed);
  } catch (err) {
    failed = true;
    failure = err;
  }
  sayDeclines(where, localSpaceId, 'file tombstone', delivery, ledger.declinedBy);
  if (failed) throw failure;
  return out;
}
