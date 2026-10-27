/**
 * The forks of a space, as Review lists them (bundle-81, design rev 8 section 5; every kind since Q-624, design rev 4 sections 9a, 10, 11).
 *
 * Two peers wrote different versions of one record at one version, so both copies were kept: the second under a derived id with `forkOf`
 * naming the first, its parent. A fact, an entity, a chrono entry and an edge all fork. A row is a fork beside its parent (or alone,
 * when the parent was deleted), with what points at the fork (the resolve repoints those to the parent), how many forks the parent has
 * altogether, and which other instances already decided it.
 */

import { RECORD_TABS, type RecordTab } from '../pages/brain/brain-tabs';

/** The kinds of record that fork. The server's `FORKING_FAMILIES` in the singular. */
export type ForkKind = 'fact' | 'entity' | 'chrono' | 'edge';

/**
 * The Brain tab that names each kind: the app's one name for it (`brain.tab.<tab>`), and the place the kind sits in the Brain's tab strip.
 * Written as the record's table, so a kind added to `ForkKind` without a tab fails the build.
 */
export const FORK_KIND_TAB: Record<ForkKind, RecordTab> = { entity: 'entities', edge: 'edges', fact: 'facts', chrono: 'chrono' };

/**
 * The kinds in the order Review lists them, DERIVED from the Brain's tab strip (`RECORD_TABS`): Entities, Edges, Facts, Chrono, whatever the strip
 * says. No order is written here, so the kind switch and the strip cannot differ.
 */
export const FORK_KINDS: readonly ForkKind[] = RECORD_TABS.map(tab => (Object.keys(FORK_KIND_TAB) as ForkKind[]).find(kind => FORK_KIND_TAB[kind] === tab)!);

/**
 * One version of a record, as far as the Forks section reads it. The fields a kind compares are the ANSWER's (`kinds[kind].fields`), so the
 * client holds no field list of its own and a version is a record of whatever fields its kind has.
 */
export interface ForkVersion {
  _id: string;
  /** The version the record is at; a resolve names it back (`ifMatchSeq`, `ifMatchParentSeq`). */
  seq?: number;
  properties?: Record<string, unknown>;
  /** Who wrote it. A version with no author was written on this instance. */
  author?: { instanceId?: string; instanceLabel?: string };
  createdAt?: string;
  updatedAt?: string;
  [field: string]: unknown;
}

/** An instance that already decided this fork (design rev 4 section 9a). The mark is local to the instance that lists it. */
export interface ForkResolvedElsewhere {
  /** The instance that issued the decision. */
  by: string;
  /** The label this instance knows `by` under, when it knows one: shown in place of the short id. */
  byLabel?: string;
  at?: string;
  /** False when the delivering peer did not prove the issuer: the entry is a report, not a fact. */
  proven: boolean;
  /** The delivering peer, when it is not the issuer. */
  via?: string;
  /** The label this instance knows `via` under, when it knows one. */
  viaLabel?: string;
  /** Which side that instance kept, read by the server when the list is read; never stored. */
  kept: 'original' | 'this version' | 'not yet known';
}

export interface ForkRow {
  kind: ForkKind;
  /** The space the fork lives in; through a personal view, the member it was read from. */
  space: string;
  forkId: string;
  parentId: string;
  fork: ForkVersion;
  /** Null when the parent was deleted: the fork is an orphan and stands alone. */
  parent: ForkVersion | null;
  orphaned: boolean;
  /** Edges and links that point at the fork id: a resolve repoints them to the parent. Zero for an edge. */
  edgeCount: number;
  linkCount: number;
  /** How many forks the parent holds, this one included; at the cap the next differing copy is dropped. */
  siblings: number;
  /** The other instances that decided this fork already; empty when none did. */
  resolvedElsewhere: ForkResolvedElsewhere[];
  /** An edge fork's endpoint names, as the Edges list shows them; absent for another kind and for an end that is gone. */
  fromName?: string;
  toName?: string;
}

/** Which version a resolve keeps: the fork's body on the parent id, or the parent as it is. Either way the fork is deleted. */
export type ForkKeep = 'fork' | 'parent';

/** How many forks each kind has, as the list answers it. */
export type ForkCounts = Record<ForkKind, number>;
/** Per kind, how many of the counted forks another instance already decided. */
export type ForkMarkedCounts = Partial<Record<ForkKind, number>>;

/** What a kind compares: the fields of its body (the main one among them) and the one Review marks by word. */
export interface ForkKindFields { fields: string[]; mainField: string }
export type ForkKindsFields = Record<ForkKind, ForkKindFields>;

/** The body of a resolve: all five parameters are required on both doors (`forkId` rides in the path). */
export interface ForkResolveRequest {
  kind: ForkKind;
  keep: ForkKeep;
  ifMatchSeq: number;
  ifMatchParentSeq: number;
}

/** One page of the list. `total` is absent when the server does not say how many there are. */
export interface ForkPage {
  forks: ForkRow[];
  total?: number;
  skip: number;
  limit: number;
  /** Forks per kind over the whole space, not the page; absent when the answer does not say. */
  counts?: ForkCounts;
  /** Per kind, how many of the counted forks another instance already decided. */
  resolvedElsewhere?: ForkMarkedCounts;
  /** Per kind, the fields its versions compare and the main one; absent when the answer does not say. */
  kinds?: ForkKindsFields;
  /**
   * The most forks one record may hold, as the server says it (`MAX_FORKS_PER_RECORD`): the number the "at the limit" notice names. The client holds no
   * number of its own, so an answer that does not say it shows no such notice rather than one with a guess.
   */
  maxForksPerRecord?: number;
}
