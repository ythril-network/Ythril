/**
 * What LOCAL cache is keyed by a file's path — the one answer every remover and every relocator of file rows asks (bundle-111, Q-459).
 *
 * ## What it prevents
 *
 * A file row is not the only thing keyed by a file's path. The manifest's hash cache (`<space>_file_hashes`, `files/manifest.ts`) is
 * too, and every act that took rows away or moved them had to remember it by hand. The delete did; the move did not, so the old path's
 * entry stayed for ever and the moved bytes were hashed again at the new one; the spill sweep, the unrecorded-bytes removal and the
 * directory delete each spelled the forget their own way. Here the list of path-keyed caches is written once, so a second cache is
 * added once and every caller reaches it.
 *
 * ## The two steps, and what each keeps inside so no caller can drop it
 *
 *  - {@link forgetPathKeyedCache}: the entries of paths whose bytes are gone (by ids, under a directory, or every path of a space). **A
 *    row id is mapped to the keys the manifest would spell it with**: the cache is keyed by the ON-DISK spelling (`manifest.ts`, the
 *    walk's `relPath`) and a row by `toDocId` (NFC), so a file whose name is stored decomposed (NFD) has a cache key no row id equals.
 *    A forget by row id that skipped the mapping reached only the NFC spelling and left the entry.
 *  - {@link carryPathKeyedCache}: the entries of moved rows, re-keyed INSIDE the caller's transaction (the session it hands over), so the
 *    rows and their entries commit together. **Every destination key is treated as replaced**: a manifest build that ran between the
 *    byte move and this carry upserted an entry at the destination, and refusing it would keep the move owed for ever over an advisory
 *    cache (the rule `rekeyJobsForMove` follows for the jobs). The carried entry keeps its size and mtime — a rename keeps both — so the
 *    next manifest reuses the hash instead of reading the moved bytes again.
 *
 * The cache is advisory (every read checks size and mtime) and never synced: a stale entry costs a re-hash, never a wrong answer —
 * which is why a carry that finds nothing to carry is not an error, and why rowless files under a moved directory are forgotten rather
 * than carried (`files/move-cascade.ts`).
 */
import type { ClientSession } from 'mongodb';
import { col, asFilter } from '../db/mongo.js';
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { escapeRegex } from '../util/redos.js';
import { toDocId } from '../util/paths.js';
import { rekeyRows, StaleRekeyPlan, type RowMove } from './rekey-rows.js';

/**
 * How a removal of EVERYTHING a space holds in a collection is issued: by the caller, which is bounded per operation (a wipe's batches).
 * The module names the collection, so the caller cannot leave one out.
 */
export type RemoveBy = (collName: string, filter: Record<string, unknown>) => Promise<unknown>;

/** Which paths' entries a remover forgets: ids (files) and the trees under directories, or every path of the space (a wipe, in its batches). */
export type PathsForgotten = { ids?: readonly string[]; under?: readonly string[] } | { everyPath: RemoveBy };

/** The most spellings one id is mapped to: two per component that has a decomposed form, which a real path has few of. */
const MAX_SPELLINGS = 16;

/**
 * The cache keys a path could be stored under: `p` with each component in the spelling it was given, composed (NFC) or decomposed (NFD)
 * — the spellings a file system that keeps names as written can hold for one row id (premise P2, bundle-111). Exported for the move's
 * batch budget and the tests; a caller forgetting or carrying passes ids and never spells this itself.
 */
export function cacheKeysOf(p: string): string[] {
  let out: string[] = [];
  for (const part of p.split('/')) {
    const forms = [...new Set([part, part.normalize('NFC'), part.normalize('NFD')])];
    out = out.length === 0 ? forms : out.flatMap(o => forms.map(f => `${o}/${f}`));
    out = out.slice(0, MAX_SPELLINGS);
  }
  return out;
}

/** The bytes a cache entry carried with a row can add to its batch (`files/move-plan.ts` counts them): its key in every spelling, and the fixed fields. */
export function cacheEntryBytesOf(id: string): number {
  return Buffer.byteLength(id) * 2 + 160;
}

/**
 * Forget the cache entries of paths whose bytes are gone, so the cache never advertises a path nothing holds — what every remover of a
 * file's rows does (`removeFileHere`, the directory delete, the sidecars a conversion leaves, the spill sweep, a wipe). A full manifest
 * walk prunes the same entries on its next round; this is the remover saying so itself, which an incremental walk never does.
 *
 * A tree is matched by its path and a `/`, regex-escaped, so `my.dir` never forgets `myXdir/` nor `my.dir2/`; an empty path matches
 * nothing rather than everything — only `everyPath` names the whole space.
 */
export async function forgetPathKeyedCache(spaceId: string, paths: PathsForgotten): Promise<void> {
  if ('everyPath' in paths) { await paths.everyPath(spaceCollection(spaceId, 'fileHashes'), {}); return; }
  const cache = col<{ _id: string }>(spaceCollection(spaceId, 'fileHashes'));
  const keys = [...new Set((paths.ids ?? []).filter(id => id !== '').flatMap(cacheKeysOf))];
  for (const chunk of inChunks(keys, ROWS_PER_BULK_COMMAND)) await cache.deleteMany(asFilter<{ _id: string }>({ _id: { $in: chunk } }));
  const trees = [...new Set((paths.under ?? []).map(d => toDocId(d).replace(/\/+$/, '')).filter(Boolean).flatMap(cacheKeysOf))];
  if (trees.length > 0) await cache.deleteMany(asFilter<{ _id: string }>({ $or: trees.map(t => ({ _id: { $regex: `^${escapeRegex(`${t}/`)}` } })) }));
}

/**
 * The key an entry stored under `key` (a spelling of the row id `from`) has once the row is at `to`: the components the move did not
 * rename keep the entry's own spelling — the bytes kept their name on disk — and the rest are `to`'s, which is the spelling the move
 * wrote them under.
 */
function carriedKey(key: string, from: string, to: string): string {
  const k = key.split('/');
  const f = from.split('/');
  const t = to.split('/');
  let kept = 0;
  while (kept < f.length && kept < t.length && f[f.length - 1 - kept] === t[t.length - 1 - kept]) kept++;
  return [...t.slice(0, t.length - kept), ...k.slice(k.length - kept)].join('/');
}

/**
 * Carry the cache entries of the rows `moves` re-keys onto their new paths, inside `session` — the caller's transaction, beside the
 * rows (see the module docblock). Returns how many entries moved; a row with no entry has nothing to carry.
 */
export async function carryPathKeyedCache(spaceId: string, session: ClientSession, moves: readonly RowMove[]): Promise<number> {
  const cacheColl = spaceCollection(spaceId, 'fileHashes');
  const byKey = new Map<string, RowMove>();
  for (const m of moves) for (const k of cacheKeysOf(m.from)) byKey.set(k, m);
  const stored = await readStoredById<{ _id: string }>(cacheColl, [...byKey.keys()], { _id: 1 }, { session });
  if (stored.size === 0) return 0;
  // One entry per new key: a row whose path the cache holds under two spellings carries the first, and the other is forgotten (replaced).
  const entryMoves: RowMove[] = [];
  const taken = new Set<string>();
  const extra: string[] = [];
  for (const key of [...stored.keys()].sort()) {
    const m = byKey.get(key)!;
    const to = carriedKey(key, m.from, m.to);
    if (taken.has(to)) { extra.push(key); continue; }
    taken.add(to);
    entryMoves.push({ from: key, to });
  }
  const moving = new Set(entryMoves.map(m => m.from));
  // Every destination key is replaced, in every spelling: an entry a manifest build wrote there is never a refusal (module docblock).
  const replaced = [...new Set([...extra, ...entryMoves.map(m => m.to), ...moves.flatMap(m => cacheKeysOf(m.to))])].filter(k => !moving.has(k));
  return rekeyRows<{ _id: string }>(cacheColl, session, {
    moves: entryMoves,
    rebuild: (entry, to) => ({ ...entry, _id: to }),
    refuse: (to) => new StaleRekeyPlan(`two cache entries were to be carried onto '${to}'`),
    replacements: { replaced },
  });
}
