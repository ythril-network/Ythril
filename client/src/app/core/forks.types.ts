/**
 * The forks of a space, as Review lists them (bundle-81, design rev 8 section 5).
 *
 * Two peers wrote different text for one fact at one version, so both copies were kept: the second under a derived id with `forkOf`
 * naming the first, its parent. A row is a fork beside its parent, with what points at the fork (the resolve repoints those to the
 * parent) and how many forks the parent has altogether.
 */

/** One version of the fact, as far as the Forks section reads it. */
export interface ForkVersion {
  _id: string;
  type?: string;
  fact: string;
  description?: string;
  tags?: string[];
  linkEntities?: string[];
  properties?: Record<string, unknown>;
  /** Who wrote it. A version with no author was written on this instance. */
  author?: { instanceId?: string; instanceLabel?: string };
  createdAt?: string;
  updatedAt?: string;
}

export interface ForkRow {
  forkId: string;
  parentId: string;
  fork: ForkVersion;
  parent: ForkVersion;
  /** Edges and links that point at the fork id: a resolve repoints them to the parent. */
  edgeCount: number;
  linkCount: number;
  /** How many forks the parent holds, this one included; at the cap the next differing copy is dropped. */
  siblings: number;
}

/** Which version a resolve keeps: the fork's text on the parent id, or the parent as it is. Either way the fork is deleted. */
export type ForkKeep = 'fork' | 'parent';

/** One page of the list. `total` is absent when the server does not say how many there are. */
export interface ForkPage {
  forks: ForkRow[];
  total?: number;
  skip: number;
  limit: number;
  /**
   * The most forks one record may hold, as the server says it (`MAX_FORKS_PER_RECORD`): the number the "at the limit" notice names. The client holds no
   * number of its own, so an answer that does not say it shows no such notice rather than one with a guess.
   */
  maxForksPerRecord?: number;
}
