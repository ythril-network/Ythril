/**
 * The body hash: what a record SAYS, as one text and one hash, so two copies of a record at one version can be told apart (Q-624, design
 * rev 4 sections 2 and 3). THE HASH LEAF.
 *
 * ## The question this module answers
 *
 * *"Do these two copies of one record, at one version, say the same thing?"* Before Q-624 only a fact could be asked: the planner compared
 * the `fact` text, and an entity, an edge or a chrono entry at an equal seq was skipped whatever it said, so two instances that edited one
 * record at one version each kept their own edit for ever and the space hash called them different for ever. Now every forking family is asked
 * through here, and so are the fork id (`forkIdFor(forkOf, seq, authoredContentHash(family, row).text)`), the fork list, the keep-writer and the
 * client's field list.
 *
 * ## The rule, inside `authoredContentHash` so no caller can drop it
 *
 *  1. The document is projected to the family's body fields and the version metadata.
 *  2. It is parsed with the family's `Incoming*` schema, so defaults apply alike to both copies (`tags` default `[]`, `properties` default `{}`) and a
 *     nested key the schema does not declare is dropped, as replication drops it. A copy that fails its schema is hashed RAW instead (the projection,
 *     steps 1, 3 and 4), and says so (`normalised: false`).
 *  3. The version metadata (and `blank`) is removed at the TOP LEVEL only: a `properties` key spelled `author`, `seq` or `pos` is content.
 *  4. The text is the canonical JSON of what is left, and the hash is its SHA-256.
 *
 * **No hash is ever undefined.** An unparseable copy compared against itself must be equal, so the comparison of two copies uses the normalised hash
 * when BOTH parse and the raw one of both when either does (`bodiesDiffer`). A stored copy at an equal seq whose body was never read is a programming
 * error, `BodyNotRead`, and never "different".
 *
 * ## Why it is a leaf
 *
 * It imports the schema leaf and the canonical text and nothing else that loads a store, the space hash or the planner. The space hash imports neither
 * (`docLeaf` needs only its derived fields), the planner, the writer, the fork module and the client's field list import this one, and there is no
 * registration and nothing that throws on load order. `the-schema-leaf-imports-no-sync-machinery` holds it; `every-server-entry-module-loads` holds what
 * a cycle would do.
 */
import { INCOMING_SCHEMA_OF } from './incoming-schemas.js';
import { canonicalJson } from '../util/canonical-json.js';
import { sha256Hex } from '../util/sha256-hex.js';
import { REDACTED_CHRONO_FIELDS } from '../brain/redacted-chrono-fields.js';

/**
 * What says WHEN and WHO and WHICH VERSION a copy is, not what it says: removed at the top level before a body is hashed. `forkOf` is here because a
 * fork row and the copy it was made from say the same thing, and the link between them is not part of what either says.
 */
export const VERSION_META = Object.freeze(['_id', 'spaceId', 'seq', 'createdAt', 'updatedAt', 'author', 'forkOf', 'forkAt'] as const);

/**
 * Per family that forks: the keys of its body, DERIVED from its `Incoming*` schema less the version metadata. The families are the ones whose schema
 * declares `forkOf` (the planner's `FORKING_FAMILIES` is checked against this set at its own load, so the two cannot say different things).
 * `_resolvedElsewhere` is a local mark and is on no schema, so it is never body.
 */
export const BODY_FIELDS_OF: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(
  Object.entries(INCOMING_SCHEMA_OF)
    .filter(([, entry]) => entry !== undefined && 'forkOf' in entry.schema.shape)
    .map(([family, entry]) => [family, Object.freeze(Object.keys(entry!.schema.shape).filter(k => !(VERSION_META as readonly string[]).includes(k)))]),
));

/** What the hash of a copy answers: the text, its hash, and what it takes to compare it with another copy's. */
export interface AuthoredContent {
  /** The canonical text of the body: what a fork id is derived from. */
  readonly text: string;
  /** The hash of `text`. */
  readonly hash: string;
  /** True when the body was parsed by its schema. False: `text` and `hash` are of the raw projection. */
  readonly normalised: boolean;
  /** The hash of the RAW projection, always: what two copies are compared by when either fails its schema. */
  readonly rawHash: string;
  /** True for a chrono entry carrying `contentRedacted`: a lapsed retention window took its detail, which says how it was lapsed and not what it says. */
  readonly carriesRedaction: boolean;
  /** For chrono: the same body with the redaction's fields and marks blanked, which is what a redacted copy is compared by. Absent for the other families. */
  readonly redacted?: AuthoredContent;
}

/** What a stored copy being compared must carry at an equal seq: the hash of its body, read by the door. */
export class BodyNotRead extends Error {
  override readonly name = 'BodyNotRead';
  readonly code = 'body_not_read';
  constructor(family: string, id: unknown) {
    super(`a stored ${family} copy at an equal seq was handed to the fork rule without its body hash (id ${JSON.stringify(String(id)).slice(0, 80)}): the door must read the body of a copy it compares`);
  }
}

/** The fields a redacted chrono entry loses or gains: blanked from both copies when either carries the redaction. Read from the retention module, never copied. */
const REDACTION_BLANK: readonly string[] = Object.freeze([...REDACTED_CHRONO_FIELDS, 'contentRedacted', 'contentRedactedAt']);

function bodyFieldsOf(family: string): readonly string[] {
  const fields = BODY_FIELDS_OF[family];
  if (!fields) throw new Error(`authoredContentHash: '${family}' is not a family that forks`);
  return fields;
}

/** The inclusion projection a read of a stored copy's body needs: the body fields and the version metadata its schema requires to parse. */
export function bodyProjectionOf(family: string): Record<string, 1> {
  return Object.fromEntries([...bodyFieldsOf(family), ...VERSION_META].map(k => [k, 1 as const]));
}

function withoutTopLevel(doc: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !fields.includes(k)));
}

/** Steps 1 to 4, for one set of blanked fields. */
function hashed(family: string, doc: Record<string, unknown>, blank: readonly string[]): Omit<AuthoredContent, 'carriesRedaction' | 'redacted'> {
  const keys = [...bodyFieldsOf(family), ...VERSION_META];
  const projection = Object.fromEntries(Object.entries(doc).filter(([k]) => keys.includes(k)));
  const strip = [...VERSION_META, ...blank];
  const rawText = canonicalJson(withoutTopLevel(projection, strip)) as string;
  const rawHash = sha256Hex(rawText);
  const parsed = INCOMING_SCHEMA_OF[family as keyof typeof INCOMING_SCHEMA_OF]!.schema.safeParse(projection);
  if (!parsed.success) return { text: rawText, hash: rawHash, normalised: false, rawHash };
  const text = canonicalJson(withoutTopLevel(parsed.data as Record<string, unknown>, strip)) as string;
  return { text, hash: sha256Hex(text), normalised: true, rawHash };
}

/**
 * The body of `doc` as a family that forks reads it. `blank` names more top-level fields to leave out (the chrono redaction does, through `redacted`);
 * a caller with nothing to blank passes nothing.
 */
export function authoredContentHash(family: string, doc: Readonly<Record<string, unknown>>, blank: readonly string[] = []): AuthoredContent {
  const plain = hashed(family, doc as Record<string, unknown>, blank);
  const carriesRedaction = family === 'chrono' && doc['contentRedacted'] === true;
  if (family !== 'chrono' || blank.length > 0) return { ...plain, carriesRedaction };
  return { ...plain, carriesRedaction, redacted: { ...hashed(family, doc as Record<string, unknown>, REDACTION_BLANK), carriesRedaction } };
}

/**
 * Do two copies of one record at one version say different things? The hash pair of the fork rule: both copies are compared by their normalised hash
 * when both parse, by their raw hash when either does not (so a copy is never different from itself), and by the redaction-blanked hash of both when
 * either carries a chrono redaction (a redacted copy of the same entry is the same copy; one that also differs in `title` is not).
 */
export function bodiesDiffer(a: AuthoredContent, b: AuthoredContent): boolean {
  if ((a.carriesRedaction || b.carriesRedaction) && a.redacted && b.redacted) return bodiesDiffer(a.redacted, b.redacted);
  return a.normalised && b.normalised ? a.hash !== b.hash : a.rawHash !== b.rawHash;
}

/**
 * The two hashes the tie rule orders a divergent pair by (`arrivingWinsTie`, `sync/upsert-plan.ts`): the SAME projection `bodiesDiffer` chose for the
 * pair, so "do they differ" and "which one is the parent" are asked of one thing. A pair `bodiesDiffer` calls equal never reaches the tie, and a pair it
 * calls different has two different hashes here. Returned in the argument order, `[a's, b's]`.
 *
 * What it prevents: ordering by `hash` while `bodiesDiffer` compared `rawHash` (one copy failing its schema) or the redaction-blanked bodies would let
 * the two instances of a pair pick different parents, each reading a different projection of the same two copies.
 */
export function tieHashes(a: AuthoredContent, b: AuthoredContent): [string, string] {
  if ((a.carriesRedaction || b.carriesRedaction) && a.redacted && b.redacted) return tieHashes(a.redacted, b.redacted);
  return a.normalised && b.normalised ? [a.hash, b.hash] : [a.rawHash, b.rawHash];
}
