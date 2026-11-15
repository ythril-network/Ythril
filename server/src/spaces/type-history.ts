/**
 * A type's history: the definitions its records were saved under, in keeping order, with when each held and where it came from (bundle-268,
 * Q-744 design r2 §0 and §2.2, r3 §5 and §7.3, r4 §1 R4, §4.1 and §5.2).
 *
 * ## The questions it answers
 *
 * - {@link groupDefinitions}: *"which of these versions define the type alike?"* A definition is a class of the diff's per-type sameness
 *   (`F ~T G`: the diff names neither T nor T's kind `all`, and the pair is classified), an equivalence (E1), found by chaining neighbours in
 *   keeping order, then comparing each run's representative with the classes found so far, the most recently matched first (E2: the result is
 *   union-find's partition).
 * - {@link typeHistoryOf}: *"what is T's history in this space, for this caller?"* The stamps T's records carry (R4) that the caller may have,
 *   plus the current version when T is declared, grouped, with spans and origins.
 * - {@link mayReadRecordFacts}: *"may this caller be told facts read from the records?"* (the older mark, the record-only names, the Open links).
 *
 * ## What it prevents
 *
 * - **Unbounded work.** {@link CLASS_MAX} classes and {@link COMPARE_MAX} representative comparisons per history; past either the rest is not
 *   listed and the answer says `cut`. Their records stay reachable through `older`, which never depends on the grouping.
 * - **A history recomputed per page.** The grouping, spans and origins are kept in the class memo, keyed by everything they depend on (the
 *   space, kind, type, current version, caller scope and the ordered stamps), so a later page makes no diff and reads no text.
 * - **A fetched version dating a definition.** A version this instance fetched was kept when it was fetched, not when it was defined: it is a
 *   member of its class, but it sets no span and cuts no other class's span.
 * - **"Edited here" claimed blind.** When an own definitions text the origin needs is no longer held, `edited` is `null`, never a guess.
 */
import { createHash } from 'node:crypto';
import type { TokenRights } from '../config/rights-shape.js';
import { holdsRung } from '../auth/reachable-spaces.js';
import { COLLECTION_SUFFIX, type KnowledgeType } from '../config/types-knowledge.js';
import { getConfig } from '../config/loader.js';
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { LruMap } from '../util/lru-map.js';
import { isPlainObject } from '@ythril-network/schema/internal';
import { variationOf, type SnapshotLinks } from './schema-stamp.js';
import { layersFor } from './network-layers.js';
import { heldVersionsKept, versionTexts, versionMetaOf, type HeldProvenance } from './schema-version-text.js';
import { typesDifferingBetween, type TypesDiffering } from './schema-diff.js';
import { fingerprintsOfType, unnamedFingerprintsIn, stampIndexMayHoldArrays, type StampedCollection } from './schema-snapshot-carried.js';
import { busyOnTimeout, mayHave, notSameStanding, scopeKeyOf, standingsOf, TEXT_CHUNK, type PassScope } from './type-standing.js';

/** The most classes one history lists; the 64th is drawn, a run that matches none of them is not. */
export const CLASS_MAX = 64;
/** The most representative comparisons one history makes (about 7 s of diffs at 19 KB texts, under the pass's deadline). */
export const COMPARE_MAX = 4_096;

/** How two versions stand for one (kind, type): alike, different, or not classifiable (a place either text could not read). */
export type PairStanding = 'same' | 'differs' | 'unclassified';

/** What {@link groupDefinitions} answers. */
export interface Grouping {
  /** The classes, current's first (its `rep` is current); every other `rep` is the newest member of its class. Members in keeping order. */
  readonly classes: { rep: string; members: string[] }[];
  /** The versions not classifiable against current: in no class. */
  readonly unclassified: string[];
  /** A run was left out: past `classMax` classes or `compareMax` comparisons. */
  readonly cut: boolean;
}

/**
 * The definitions among `order` (the versions, in keeping order, oldest first, each once) against `current` (the anchor, in `order` or not;
 * `null` for a type no current schema declares: then there is no current class). `compare(a, b)` answers a pair for the (kind, type) asked,
 * sync or async. Bounded by `opts.classMax` ({@link CLASS_MAX}) and `opts.compareMax` ({@link COMPARE_MAX}) representative comparisons; the
 * comparisons against current and between neighbours are not counted (a history makes at most n - 1 of the latter).
 */
export async function groupDefinitions(
  order: readonly string[], current: string | null, compare: (a: string, b: string) => PairStanding | Promise<PairStanding>,
  opts: { classMax?: number; compareMax?: number } = {},
): Promise<Grouping> {
  const classMax = opts.classMax ?? CLASS_MAX;
  const compareMax = opts.compareMax ?? COMPARE_MAX;
  const seq = [...new Set(order)];
  const unclassified: string[] = [];
  const currentMembers: string[] = [];
  const differs: string[] = [];
  for (const fp of seq) {
    if (fp === current) { currentMembers.push(fp); continue; }
    if (current === null) { differs.push(fp); continue; }
    const s = await compare(fp, current);
    if (s === 'unclassified') unclassified.push(fp);
    else if (s === 'same') currentMembers.push(fp);
    else differs.push(fp);
  }
  // Runs: neighbours in keeping order that are alike. Each run's representative is its newest member.
  const runs: string[][] = [];
  for (const fp of differs) {
    const last = runs[runs.length - 1];
    if (last && (await compare(last[last.length - 1]!, fp)) === 'same') last.push(fp); else runs.push([fp]);
  }
  // Newest run first, so a cut leaves out the earliest definitions; each run is compared with the classes the most recently matched first.
  const classes: { rep: string; members: string[] }[] = [];
  let comparisons = 0;
  let cut = false;
  const room = classMax - (current === null ? 0 : 1);
  runs: for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r]!;
    const rep = run[run.length - 1]!;
    for (let c = 0; c < classes.length; c++) {
      if (comparisons >= compareMax) { cut = true; break runs; }
      comparisons++;
      if ((await compare(rep, classes[c]!.rep)) === 'same') {
        const [hit] = classes.splice(c, 1);
        hit!.members.push(...run);
        classes.unshift(hit!);
        continue runs;
      }
    }
    if (classes.length >= room) { cut = true; continue; }
    classes.unshift({ rep, members: [...run] });
  }
  const position = new Map(seq.map((fp, i) => [fp, i]));
  const at = (fp: string): number => position.get(fp) ?? Number.MAX_SAFE_INTEGER;
  const inOrder = (members: string[]): string[] => [...members].sort((a, b) => at(a) - at(b));
  const out = classes.map(c => ({ rep: c.rep, members: inOrder(c.members) }));
  // Current's class holds current even when no record of the type carries it yet.
  if (current !== null) out.unshift({ rep: current, members: inOrder(currentMembers.includes(current) ? currentMembers : [...currentMembers, current]) });
  return { classes: out, unclassified, cut };
}

/** May `rights` be told facts read from `spaceId`'s records (the older mark, record-only names, Open links)? `knowledge: read` or an administrator. */
export function mayReadRecordFacts(rights: TokenRights | null | undefined, spaceId: string): boolean {
  if (!rights) return false;
  if (rights.instanceAdmin) return true;
  return holdsRung(rights, spaceId, 'knowledge', 'read');
}

/** Where a definition's oldest version came from, as it is held now. */
export interface DefinitionOrigin {
  readonly edited: boolean | null;
  readonly networks: string[];
  readonly fetched: boolean;
}

/** One definition of a type's history. `members` stays server side: an answer names a definition by its `rep`. */
export interface Definition {
  readonly rep: string;
  readonly members: readonly string[];
  readonly current: boolean;
  readonly since?: string;
  readonly until?: string;
  readonly origin: DefinitionOrigin;
}

/** What a type is in the current schema: the space's own, only a network layer's, or no current schema's. */
export type Declared = 'own' | 'layer' | 'none';

/** A type's history. */
export interface TypeHistory {
  readonly declared: Declared;
  readonly current: string;
  readonly definitions: readonly Definition[];
  readonly cut: boolean;
}

/** The type names a meta (a space's own, its effective one, a network layer's) declares for `kind`; none for anything that is not a meta. */
export function declaredTypeNamesOf(meta: unknown, kind: KnowledgeType): string[] {
  const types = isPlainObject(meta) && isPlainObject(meta['typeSchemas']) ? meta['typeSchemas'][kind] : undefined;
  return isPlainObject(types) ? Object.keys(types) : [];
}

/** What the current schema says of `type`: declared by the space's own definitions, by a layer only (with which networks), or not at all. */
export function declaredOf(spaceId: string, kind: KnowledgeType, type: string): { declared: Declared; networks: string[] } {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  const has = (meta: unknown): boolean => declaredTypeNamesOf(meta, kind).includes(type);
  if (has(space?.ownMeta ?? space?.meta)) return { declared: 'own', networks: [] };
  const networks = layersFor(cfg, spaceId).filter(l => has(l.meta)).map(l => l.networkId);
  if (networks.length > 0 && has(space?.meta)) return { declared: 'layer', networks };
  return { declared: 'none', networks: [] };
}

/** The class memo: a type's history per everything it depends on. 256 entries, weighted at 72 bytes per member, 8 MiB. */
const classMemo = new LruMap<string, TypeHistory>(256, undefined, {
  weigh: h => Math.max(1, h.definitions.reduce((n, d) => n + 72 * Math.max(1, d.members.length), 0)),
  maxWeight: 8 * 1024 * 1024,
});

/** One version of the history as the spans and origins read it. */
interface Kept {
  readonly fp: string;
  readonly at?: string;
  readonly fetched: boolean;
  readonly held: HeldProvenance;
}

/** Keeping order: `at` ascending, ties by `_id` descending (the version list's order reversed); a version with no row is kept last. */
function keepingOrder(a: Kept, b: Kept): number {
  if (a.at !== b.at) {
    if (a.at === undefined) return 1;
    if (b.at === undefined) return -1;
    return a.at < b.at ? -1 : 1;
  }
  return a.fp < b.fp ? 1 : a.fp > b.fp ? -1 : 0;
}

/** Does `td` say a record of (kind, type) sees the pair differently? */
const namesType = (td: TypesDiffering, kind: string, type: string): boolean => {
  const k = td.kinds.get(kind);
  return k === 'all' || (k instanceof Set && k.has(type));
};

/** A pass-local reader of version texts: chunked, each text read once while it fits in 16 MiB. */
function textReader(spaceId: string, timeLeft: () => number): { prefetch: (fps: readonly string[]) => Promise<void>; text: (fp: string) => Promise<string | undefined> } {
  const cache = new LruMap<string, string>(100_000, undefined, { weigh: t => Math.max(1, t.length), maxWeight: 16 * 1024 * 1024 });
  const missing = new Set<string>();
  const read = async (fps: readonly string[]): Promise<void> => {
    const want = fps.filter(fp => cache.peek(fp) === undefined && !missing.has(fp));
    for (let i = 0; i < want.length; i += TEXT_CHUNK) {
      const chunk = want.slice(i, i + TEXT_CHUNK);
      const texts = await versionTexts(spaceId, chunk, { timeLeft });
      for (const fp of chunk) { const t = texts.get(fp); if (t === undefined) missing.add(fp); else cache.set(fp, t); }
    }
  };
  return {
    prefetch: read,
    text: async (fp) => {
      const held = cache.get(fp);
      if (held !== undefined || missing.has(fp)) return held;
      await read([fp]);
      return cache.get(fp);
    },
  };
}

/** The own row kept just before `at` on this space's own line, or none. */
function ownBefore(own: readonly { fp: string; at: string; links: SnapshotLinks | null }[], at: string | undefined, fp: string): { fp: string; at: string; links: SnapshotLinks | null } | undefined {
  let found: { fp: string; at: string; links: SnapshotLinks | null } | undefined;
  for (const row of own) {
    if (row.fp === fp) continue;
    if (at !== undefined && row.at >= at) break;
    found = row;
  }
  return found;
}

/**
 * The history of (`kind`, `type`) in `spaceId` for the caller `scope` names: the stamps T's records carry (R4), the ones the caller may have and
 * that are classifiable against current (R2's unnamed stamps are not), plus the current version when T is declared, grouped into definitions,
 * each with its span and origin. Memoised. Throws on any failure: `SchemaIndexBuilding`, `SchemaVersionsBusy`.
 */
export async function typeHistoryOf(spaceId: string, kind: KnowledgeType, type: string, scope: PassScope): Promise<TypeHistory> {
  return busyOnTimeout(spaceId, async () => {
    const collection = COLLECTION_SUFFIX[kind] as StampedCollection;
    const variation = variationOf(spaceId);
    if (!variation) throw new Error(`space '${spaceId}' is not configured`);
    const current = variation.stamp.fp;
    const { declared } = declaredOf(spaceId, kind, type);
    const mayHoldArrays = await stampIndexMayHoldArrays(spaceId, collection);
    const carried = await fingerprintsOfType(spaceId, collection, type, scope.timeLeft, { mayHoldArrays });
    const candidates = [...new Set([...carried, ...(declared !== 'none' ? [current] : [])])];
    const held = await heldVersionsKept(spaceId, candidates, { timeLeft: scope.timeLeft });
    const unnamed = new Set(await unnamedFingerprintsIn(spaceId, collection, carried.filter(fp => held.has(fp)), scope.timeLeft, { mayHoldArrays }));
    const kept: Kept[] = [];
    for (const fp of candidates) {
      const v = held.get(fp);
      if (!v || !mayHave(v, scope.shared) || unnamed.has(fp)) continue;
      kept.push({ fp, ...(v.since !== undefined ? { at: v.since } : {}), fetched: v.kept?.origin === 'fetched', held: v });
    }
    kept.sort(keepingOrder);
    const order = kept.map(k => k.fp);
    const memoKey = `${spaceId}|${kind}|${type}|${current}|${declared}|${scopeKeyOf(scope.shared)}|${createHash('sha256').update(order.join(',')).digest('hex')}`;
    const memoised = classMemo.get(memoKey);
    if (memoised) return memoised;

    const anchor = declared !== 'none' ? current : null;
    const standings = anchor === null ? undefined : (await standingsOf(spaceId, collection, anchor, 'any', scope, order)).fps;
    const texts = textReader(spaceId, scope.timeLeft);
    const compare = async (a: string, b: string): Promise<PairStanding> => {
      const other = anchor !== null && b === anchor ? a : anchor !== null && a === anchor ? b : undefined;
      if (other !== undefined && standings) {
        const s = standings.get(other);
        if (s === undefined || s === 'notHeld' || s === 'unclassified') return 'unclassified';
        return notSameStanding(s, type) ? 'differs' : 'same';
      }
      scope.timeLeft();
      const [ta, tb] = [await texts.text(a), await texts.text(b)];
      if (ta === undefined || tb === undefined) return 'unclassified';
      const td = typesDifferingBetween({ fp: a, text: ta }, { fp: b, text: tb }, 'any');
      if (td.unclassified) return 'unclassified';
      return namesType(td, kind, type) ? 'differs' : 'same';
    };
    await texts.prefetch(order.filter(fp => fp !== anchor));
    const grouping = await groupDefinitions(order, anchor, compare);

    const byFp = new Map(kept.map(k => [k.fp, k]));
    const classOf = new Map<string, number>();
    grouping.classes.forEach((c, i) => { for (const m of c.members) classOf.set(m, i); });
    // The dated line: every kept, classified, non-fetched version in keeping order (a cut run is a class of its own here).
    const dated = kept.filter(k => !k.fetched && k.at !== undefined && !grouping.unclassified.includes(k.fp));
    const classIdOf = (fp: string): string => (classOf.has(fp) ? `c${classOf.get(fp)}` : `x${fp}`);
    const own = await ownLineOf(spaceId, scope.timeLeft);
    const definitions: Definition[] = [];
    for (const [i, c] of grouping.classes.entries()) {
      const isCurrent = anchor !== null && i === 0;
      const mine = dated.filter(k => classOf.get(k.fp) === i);
      let since: string | undefined;
      let until: string | undefined;
      if (mine.length > 0) {
        if (isCurrent) {
          // The start of its newest run on the dated line; none when the newest dated version is another class's (a whole-text revert).
          let j = dated.length - 1;
          if (j >= 0 && classOf.get(dated[j]!.fp) === i) {
            while (j > 0 && classOf.get(dated[j - 1]!.fp) === i) j--;
            since = dated[j]!.at;
          }
        } else {
          since = mine[0]!.at;
          const newest = dated.indexOf(mine[mine.length - 1]!);
          const next = dated.slice(newest + 1).find(k => classIdOf(k.fp) !== `c${i}`);
          until = next?.at;
        }
      }
      const oldest = byFp.get(c.members[0]!);
      definitions.push({
        rep: c.rep, members: c.members, current: isCurrent,
        ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}),
        origin: oldest ? await originOf(kind, type, oldest, own, scope, texts.text) : { edited: null, networks: [], fetched: false },
      });
    }
    // Current first; then the dated ones by their newest member's keeping, newest first; then the undated ones, newest kept first.
    const newestAt = (d: Definition): string => {
      const ats = d.members.map(m => byFp.get(m)).filter(k => k && !k.fetched && k.at !== undefined).map(k => k!.at!);
      return ats.length > 0 ? ats.sort()[ats.length - 1]! : '';
    };
    const newestKept = (d: Definition): string => d.members.map(m => byFp.get(m)?.at ?? '').sort().pop() ?? '';
    const [first, ...rest] = anchor !== null ? definitions : [undefined, ...definitions];
    rest.sort((a, b) => {
      const da = newestAt(a!), db = newestAt(b!);
      if ((da === '') !== (db === '')) return da === '' ? 1 : -1;
      if (da !== db) return da < db ? 1 : -1;
      const ka = newestKept(a!), kb = newestKept(b!);
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
    const history: TypeHistory = { declared, current, definitions: [...(first ? [first] : []), ...rest.map(d => d!)], cut: grouping.cut };
    classMemo.set(memoKey, history);
    return history;
  });
}

/** This space's own line: every own row, `at` ascending, with its links (no text). */
async function ownLineOf(spaceId: string, timeLeft: () => number): Promise<{ fp: string; at: string; links: SnapshotLinks | null }[]> {
  const rows = await col<{ _id: string; at?: unknown; links?: SnapshotLinks | null }>(spaceCollection(spaceId, 'schemaSnapshots'))
    .find({ origin: 'own' }, { projection: { _id: 1, at: 1, links: 1 }, sort: { at: 1, _id: -1 }, maxTimeMS: timeLeft() }).toArray();
  return rows.filter(r => typeof r.at === 'string').map(r => ({ fp: String(r._id), at: r.at as string, links: r.links ?? null }));
}

/**
 * The network layers whose version changed (kind, type) between the own version holding `before` and the one holding `now`: a layer new
 * since declares the type, a layer kept differs where the type differs between its two texts; a text no longer held counts as no change.
 */
async function layersChangingType(
  kind: KnowledgeType, type: string, now: SnapshotLinks | null, before: SnapshotLinks | null, textOf: (fp: string) => Promise<string | undefined>,
): Promise<string[]> {
  const networks: string[] = [];
  for (const layer of now?.layers ?? []) {
    const wasFp = before?.layers.find(l => l.networkId === layer.networkId)?.fp;
    if (wasFp === layer.fp) continue;
    const text = await textOf(layer.fp);
    if (text === undefined) continue;
    if (wasFp === undefined) {
      if (declaredTypeNamesOf(versionMetaOf(text)?.meta, kind).includes(type)) networks.push(layer.networkId);
      continue;
    }
    const was = await textOf(wasFp);
    if (was === undefined) continue;
    const td = typesDifferingBetween({ fp: wasFp, text: was }, { fp: layer.fp, text }, 'any');
    if (!td.unclassified && namesType(td, kind, type)) networks.push(layer.networkId);
  }
  return networks;
}

/**
 * Where a definition began, as it is held now (amend 2): fetched from a member; a network layer's row; or own, then `edited` when the type
 * differs between the own definitions of the version where the definition began and those of the own version kept just before it (none
 * before: the own definitions declare the type), `null` when either own definitions text is no longer held, and `networks` each layer whose
 * version changed the type between the two. Network ids are cut to the caller's shared set.
 *
 * A definition's members are only the versions records carry, so its oldest member `x` is not necessarily where it began: records written
 * after another type changed carry a later stamp than the one that changed this type. The origin is therefore read at the own version where
 * the definition began. From `x`, while an own version `y` is kept before it, both own texts are held, the type does not differ between `y`
 * and the version reached, and no layer changed the type between them, the walk steps back to `y`; a text not held stops it with `null`
 * ("Edited here" is never claimed blind). The walk is bounded: every step moves strictly earlier on the own line (so by its length, read
 * once), every text goes through the pass's memoised reader, and each step asks `scope.timeLeft()`, which throws when the pass's time
 * budget is spent. It prevents an older definition answering "not edited" (no origin line) because only another type changed after it began.
 */
async function originOf(
  kind: KnowledgeType, type: string, x: Kept, own: readonly { fp: string; at: string; links: SnapshotLinks | null }[],
  scope: PassScope, textOf: (fp: string) => Promise<string | undefined>,
): Promise<DefinitionOrigin> {
  const cut = (ids: string[]): string[] => (scope.shared ? ids.filter(id => scope.shared!.has(id)) : ids);
  const kept = x.held.kept;
  if (x.fetched) return { edited: false, networks: [], fetched: true };
  if (kept?.origin === 'layer') return { edited: false, networks: cut(kept.networkId !== undefined ? [kept.networkId] : []), fetched: false };
  const ownFpOf = (fp: string, l: SnapshotLinks | null): string => l?.own ?? fp;
  let at = x.at;
  let fp = x.fp;
  let links = kept?.links ?? null;
  let xOwn = ownFpOf(fp, links);
  let xText = await textOf(xOwn);
  let y = ownBefore(own, at, fp);
  let yOwn: string | undefined;
  let yText: string | undefined;
  while (xText !== undefined && y) {
    yOwn = ownFpOf(y.fp, y.links);
    yText = await textOf(yOwn);
    if (yText === undefined) break;
    const td = typesDifferingBetween({ fp: yOwn, text: yText }, { fp: xOwn, text: xText }, 'any');
    if (td.unclassified || namesType(td, kind, type)) break;
    if ((await layersChangingType(kind, type, links, y.links, textOf)).length > 0) break;
    scope.timeLeft();
    ({ fp, at, links } = y);
    xOwn = yOwn;
    xText = yText;
    y = ownBefore(own, at, fp);
    yOwn = yText = undefined;
  }
  let edited: boolean | null;
  if (xText === undefined) edited = null;
  else if (!y) {
    edited = declaredTypeNamesOf(versionMetaOf(xText)?.meta, kind).includes(type);
  } else if (yText === undefined) edited = null;
  else {
    const td = typesDifferingBetween({ fp: yOwn!, text: yText }, { fp: xOwn, text: xText }, 'any');
    edited = td.unclassified ? null : namesType(td, kind, type);
  }
  return { edited, networks: cut(await layersChangingType(kind, type, links, y?.links ?? null, textOf)), fetched: false };
}
