/**
 * A schema version's text, and what this release can read of it (bundle-267, Q-741/Q-742; design r2 "Texts", r3 §2).
 *
 * ## The questions it answers
 *
 * - {@link versionMetaOf}: what does this canonical text say, as this release reads a schema it STORED? The stored reader's tolerance
 *   (`readStoredMeta`: a rule that no longer compiles is kept, a type that no longer parses is left out, an unknown key is left out), with
 *   every place that tolerance dropped named in `unread`. A text this server holds was verified when it arrived (`verifySnapshot`, the strict
 *   path for arriving texts); reading it again must never refuse it, so the two are separate functions.
 * - {@link versionText} / {@link versionTexts}: which text does a fingerprint name in a space, and does this server hold it at all?
 * - {@link heldVersionsKept}: does this server hold these fingerprints, how and since when, for a reader that needs no schema? It reads no text.
 *
 * ## What it prevents
 *
 * - **"Same" for what was not read.** A comparison of two read metas that dropped a newer release's key would answer two different texts as
 *   equal. `unread` carries every dropped place, so the diff (`spaces/schema-diff.ts`) answers such a pair as unclassified.
 * - **A lagging row read as the current version.** The current text comes from the config (`variationOf`), never from its row: a row can lag
 *   a schema edit by milliseconds, or until housekeeping while an act stands. Each network layer of the current variation is read from the
 *   config too, and the empty schema has no row on any instance and is held everywhere.
 * - **A failed read answered as "not held".** A fingerprint with no row is `null`; a read the store fails throws, so a caller never tells a
 *   peer a version is unknown because the store did not answer.
 */
import { readStoredMeta, isPlainObject } from '@ythril-network/schema/internal';
import { readStoredById } from '../db/read-by-id.js';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { spaceCollection } from '../db/space-collection.js';
import { EMPTY_SCHEMA_FINGERPRINT, EMPTY_SCHEMA_STAMP } from './schema-stamp.js';
import { snapshotBodyOf, SNAPSHOT_TEXT_KEYS, type ServableRow } from './schema-snapshot.js';
import { owedOf, type SnapshotRow } from './schema-snapshot-store.js';

/** The schema a version text holds, as this release reads it. */
export interface VersionSchema {
  readonly typeSchemas: Record<string, Record<string, unknown>>;
  readonly rules: Record<string, unknown>;
}

/** What {@link versionMetaOf} answers: the schema read, every place the stored reader's tolerance left out, and which records those stand over. */
export interface VersionMeta {
  readonly meta: VersionSchema;
  readonly unread: readonly string[];
  readonly reach: UnreadReach;
}

/**
 * The records a version's unread places stand over: every record of the version (`all`: an envelope key, an unknown meta key, a rules map
 * that did not read, a bounded-names tail), or per kind every record of it (`'all'`: the kind's map did not read, or a place under it names
 * no type the text declares) or the records of the named types (a type the reader skipped, an unknown field inside a type).
 */
export interface UnreadReach {
  readonly all: boolean;
  readonly kinds: ReadonlyMap<string, ReadonlySet<string> | 'all'>;
}

const TYPES_KEY = 'typeSchemas';

/** Where each of `unread` stands, read against the type names `declared` (the text's own `typeSchemas`, as written). */
function unreadReachOf(unread: readonly string[], declared: unknown): UnreadReach {
  const kinds = new Map<string, Set<string> | 'all'>();
  let all = false;
  const add = (kind: string, type: string | 'all'): void => {
    const held = kinds.get(kind);
    if (held === 'all') return;
    if (type === 'all') kinds.set(kind, 'all');
    else if (held) held.add(type);
    else kinds.set(kind, new Set([type]));
  };
  const namesOf = (kind: string): string[] => {
    const defs = isPlainObject(declared) ? declared[kind] : undefined;
    return isPlainObject(defs) ? Object.keys(defs) : [];
  };
  for (const place of unread) {
    // The stored reader names a skipped type `kind:name` and a skipped kind map `typeSchemas.kind`; an unknown field inside a type
    // `typeSchemas.kind.name.field`. A kind is one of the four, which hold no `.` or `:`.
    const colon = place.indexOf(':');
    const skippedKind = colon > 0 ? place.slice(0, colon) : '';
    if ((KNOWLEDGE_TYPES as readonly string[]).includes(skippedKind)) { add(skippedKind, place.slice(colon + 1)); continue; }
    const [head, kind, ...rest] = place.split('.');
    if (head !== TYPES_KEY || kind === undefined || !(KNOWLEDGE_TYPES as readonly string[]).includes(kind)) { all = true; continue; }
    const inside = rest.join('.');
    const type = inside === '' ? undefined : namesOf(kind).find(n => inside === n || inside.startsWith(`${n}.`));
    add(kind, type ?? 'all');
  }
  return { all, kinds };
}

/** Does `reach` stand over a record of `kind` whose type field holds `type`? An untyped record is under its kind's `'all'` only. */
export function unreadCovers(reach: UnreadReach, kind: string, type: unknown): boolean {
  if (reach.all) return true;
  const types = reach.kinds.get(kind);
  return types === 'all' || (types !== undefined && typeof type === 'string' && types.has(type));
}

/**
 * The schema `text` holds, read as a stored schema is read, with the places that read dropped. `null` only for a text that is not JSON or
 * not format 1: never for a text this server stored, which the stored reader always reads.
 */
export function versionMetaOf(text: string): VersionMeta | null {
  const parsed = snapshotBodyOf(text);
  if (!parsed) return null;
  const unread = Object.keys(parsed).filter(k => !SNAPSHOT_TEXT_KEYS.has(k));
  const read = readStoredMeta({ typeSchemas: parsed[TYPES_KEY] ?? {}, rules: parsed['rules'] ?? {} });
  unread.push(...read.unknown, ...read.skipped);
  const typeSchemas = isPlainObject(read.meta[TYPES_KEY]) ? read.meta[TYPES_KEY] as VersionSchema['typeSchemas'] : {};
  const rules = isPlainObject(read.meta['rules']) ? read.meta['rules'] as VersionSchema['rules'] : {};
  return { meta: { typeSchemas, rules }, unread, reach: unreadReachOf(unread, parsed[TYPES_KEY]) };
}

/**
 * One version this server holds: its text, and how it came to hold it - what `servableTo` decides on (`kept`, absent for the empty schema,
 * which every instance holds and serves to anyone) and, for a row, when it was kept (`since`).
 */
export interface HeldVersion extends HeldProvenance {
  readonly text: string;
}

/** How this server holds a version, without its text: what {@link heldVersionsKept} answers for a reader that needs no schema. */
export interface HeldProvenance {
  readonly kept?: ServableRow;
  readonly since?: string;
}

/**
 * The versions the config holds for `spaceId` now: the empty schema's, and what the variation keeps (`owedOf`: each network layer's, and the
 * current variation's unless it is one of them), by fingerprint. Read from `owedOf`, never built again: a current version equal to a layer's is
 * that layer here exactly as the sync door keeps and serves its row, so the list, read and diff doors decide what a peer may have as it does.
 */
export function configuredVersions(spaceId: string): Map<string, HeldVersion> {
  const out = new Map<string, HeldVersion>([[EMPTY_SCHEMA_FINGERPRINT, { text: EMPTY_SCHEMA_STAMP.text }]]);
  for (const [stamp, kept] of owedOf(spaceId)) out.set(stamp.fp, { text: stamp.text, kept });
  return out;
}

/** A snapshot row as {@link heldVersions} and {@link heldVersionsKept} read it (`text` by the first only). */
type HeldRow = { _id: string; text?: unknown } & Partial<Pick<SnapshotRow, 'origin' | 'networkId' | 'links' | 'at'>>;

/** What a row says of how it is held; its text is the caller's. */
const PROVENANCE_FIELDS = { origin: 1, networkId: 1, links: 1, at: 1 } as const;

/**
 * Each of `fps` this server holds in `spaceId`, as `rows` (one batched read of the rows that hold a string text, by the caller) and the config
 * say: the config's first (current, a layer, the empty schema), whose text wins over a row's (a row can lag), and a held row lends the
 * config's version its `since`. A fingerprint with no row is absent.
 */
async function holdingsOf(spaceId: string, fps: readonly string[], textFields: Readonly<Record<string, 1>>): Promise<Map<string, HeldProvenance & { text?: string }>> {
  const configured = configuredVersions(spaceId);
  const wanted = [...new Set(fps)];
  const toRead = wanted.filter(fp => fp !== EMPTY_SCHEMA_FINGERPRINT);
  // Only a row whose text is a string holds a version: asked of the store, so a reader that leaves the text out answers the same set.
  const rows = toRead.length === 0 ? new Map<string, HeldRow>()
    : await readStoredById<HeldRow>(spaceCollection(spaceId, 'schemaSnapshots'), toRead, { ...textFields, ...PROVENANCE_FIELDS },
      { filter: { text: { $type: 'string' } } });
  const out = new Map<string, HeldProvenance & { text?: string }>();
  for (const fp of wanted) {
    const row = rows.get(fp);
    const since = typeof row?.at === 'string' ? row.at : undefined;
    const fromConfig = configured.get(fp);
    if (fromConfig) { out.set(fp, { ...fromConfig, ...(since !== undefined ? { since } : {}) }); continue; }
    if (!row || row.origin === undefined) continue;
    const kept: ServableRow = { origin: row.origin, links: row.links ?? null, ...(row.networkId !== undefined ? { networkId: row.networkId } : {}) };
    out.set(fp, { ...(typeof row.text === 'string' ? { text: row.text } : {}), kept, ...(since !== undefined ? { since } : {}) });
  }
  return out;
}

/** Each of `fps` this server holds in `spaceId`, with its text ({@link holdingsOf}). A failed read throws. */
export async function heldVersions(spaceId: string, fps: readonly string[]): Promise<Map<string, HeldVersion>> {
  const out = new Map<string, HeldVersion>();
  for (const [fp, v] of await holdingsOf(spaceId, fps, { text: 1 })) if (typeof v.text === 'string') out.set(fp, { ...v, text: v.text });
  return out;
}

/**
 * Each of `fps` this server holds in `spaceId`, WITHOUT its text: the rows are read with a projection that leaves `text` out (a text can
 * reach the snapshot cap), for a reader that asks only whether a version is held, how, and since when (the version list, the filter's
 * held checks). A failed read throws.
 */
export async function heldVersionsKept(spaceId: string, fps: readonly string[]): Promise<Map<string, HeldProvenance>> {
  const out = new Map<string, HeldProvenance>();
  for (const [fp, v] of await holdingsOf(spaceId, fps, {})) out.set(fp, { ...(v.kept ? { kept: v.kept } : {}), ...(v.since !== undefined ? { since: v.since } : {}) });
  return out;
}

/** The text each of `fps` names in `spaceId`, for those this server holds ({@link heldVersions}). A failed read throws. */
export async function versionTexts(spaceId: string, fps: readonly string[]): Promise<Map<string, string>> {
  const held = await heldVersions(spaceId, fps);
  return new Map([...held].map(([fp, v]) => [fp, v.text]));
}

/** The text `fp` names in `spaceId`, or `null` when this server holds none. A failed read throws; it is never "not held". */
export async function versionText(spaceId: string, fp: string): Promise<string | null> {
  return (await versionTexts(spaceId, [fp])).get(fp) ?? null;
}
