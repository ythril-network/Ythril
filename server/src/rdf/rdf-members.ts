/**
 * The members of an RDF read, each with the state its records are read in: which of the spaces a caller reads can be read as RDF, under
 * which names, with which rights, and through which row filter (bundle-271, Q-756; design r2 R1.1, R1.2). The records export, the quad
 * source and the Linked Data addresses ask it, so the three read one scope alike.
 *
 * ## What it prevents
 *
 * - **A read that shows file statements to a token without `files: read`.** `files` is decided here, per member, once; a reader that walks
 *   the file kind asks it, so no door can forget the right.
 * - **A read of a space the caller cannot read.** {@link rdfMembers} skips every space its caller holds no `knowledge: read` on (the one
 *   question `mayReadArea` asks, the area a view's members are narrowed by), and does not name it: it trusts no door to have asked.
 * - **A member read under unsettled names.** A member with RDF off, a contested or shared base, a term clash or an address no document can
 *   carry is left out and named with the code and status the export answers for it, never read under names that are not its own.
 * - **A row that is not a record read as one.** {@link rdfRowFilter} is the filter every reader applies to a kind's collection: a file row
 *   that is a chunk, a deleted file or a feed marker is no file (the mapper refuses it too, so a reader that forgets it reads more, never
 *   more statements).
 */
import type { SpaceMeta } from '@ythril-network/schema';
import { getConfig } from '../config/loader.js';
import { mayReadArea } from '../auth/reachable-spaces.js';
import { LIVE_FILE_ROW, NOT_A_FEED_MARKER } from '../files/live-file-row.js';
import { schemaFingerprintOf } from '../spaces/schema-stamp.js';
import { RDF_RECORD_KINDS, type RdfRecordKind } from './record-triples.js';
import { rdfSpaceState, RDF_NOT_ENABLED, type RdfCaller, type FingerprintOf } from './rdf-space-state.js';
import type { EXPORT_CONFLICT } from '../export/export-statuses.js';
import type { BrainCollection } from '../config/types-knowledge.js';

/** One member read as RDF: its space, its resolved meta, its schema fingerprint, and whether the caller reads its files. */
export interface RdfMember {
  space: string;
  meta: SpaceMeta;
  fingerprint: string;
  /** The caller holds `files: read` here: without it the file kind is never read. */
  files: boolean;
}

/** A member the caller reads that is not read as RDF, with the refusal the export answers for it alone. */
export interface RdfMemberLeftOut {
  space: string;
  code: string;
  status: typeof EXPORT_CONFLICT;
  error: string;
  detail?: Record<string, unknown>;
}

/** The members of a read, in the order given, and the ones left out. */
export interface RdfMembers { members: RdfMember[]; leftOut: RdfMemberLeftOut[] }

/**
 * The members of `spaces` (the spaces the caller's guard accepted: one space, or a view's readable members) as RDF, for `caller`; a space
 * the caller cannot read in the knowledge area is dropped here, whatever the door asked.
 * `fingerprintOf` is the door's schema fingerprint (`rdf-space-state.ts` says why it is handed in); the stamp's own by default.
 */
export function rdfMembers(spaces: readonly string[], caller: RdfCaller | undefined, fingerprintOf: FingerprintOf = schemaFingerprintOf): RdfMembers {
  const cfg = getConfig();
  const rights = caller?.rights ?? undefined;
  const members: RdfMember[] = [];
  const leftOut: RdfMemberLeftOut[] = [];
  for (const space of spaces) {
    // A space the caller cannot read in the knowledge area is no member and is not named (naming it says it exists and how its RDF is settled).
    if (!mayReadArea(rights, space, 'knowledge')) continue;
    const state = rdfSpaceState(cfg, space, caller, fingerprintOf);
    if (state.ok) {
      members.push({ space, meta: state.meta, fingerprint: state.fingerprint, files: mayReadArea(rights, space, 'files') });
      continue;
    }
    leftOut.push({ space, code: state.code, status: state.status, error: state.error, ...(state.detail ? { detail: state.detail } : {}) });
  }
  return { members, leftOut };
}

/**
 * The members a read left out, by why: RDF off (`withoutRdf`), or names not settled (`inConflict`). The one split every door announces them
 * by (`Ythril-View-Members-Without-Rdf`, `Ythril-View-Members-In-Conflict`, `membersWithoutRdf`, `membersInConflict`), so no door says a left-out
 * member under the other reason.
 */
export function splitLeftOut(leftOut: readonly RdfMemberLeftOut[]): { withoutRdf: string[]; inConflict: string[] } {
  return {
    withoutRdf: leftOut.filter(l => l.code === RDF_NOT_ENABLED).map(l => l.space),
    inConflict: leftOut.filter(l => l.code !== RDF_NOT_ENABLED).map(l => l.space),
  };
}

/** The collection each kind lives in: keyed by kind, so a kind the mapper adds is a compile error here until it names its collection. */
const COLLECTION_OF: Readonly<Record<RdfRecordKind, BrainCollection>> = Object.freeze({
  entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges', link: 'links', file: 'files',
});

/** The kinds a member's records are read in, in walk order (the mapper's `RDF_RECORD_KINDS`), each with its collection. */
export const RDF_KIND_COLLECTIONS: ReadonlyArray<{ readonly kind: RdfRecordKind; readonly collection: BrainCollection }> = Object.freeze(
  RDF_RECORD_KINDS.map(kind => Object.freeze({ kind, collection: COLLECTION_OF[kind] })));

/** The collection the records of `kind` live in. */
export function rdfKindCollection(kind: RdfRecordKind): BrainCollection {
  return RDF_KIND_COLLECTIONS.find(w => w.kind === kind)!.collection;
}

/** The filter every reader applies to the collection of `kind`: a file row must be a live file, not a chunk, a deleted file or a feed marker. */
export function rdfRowFilter(kind: RdfRecordKind): Record<string, unknown> {
  return kind === 'file' ? { ...LIVE_FILE_ROW, ...NOT_A_FEED_MARKER } : {};
}
