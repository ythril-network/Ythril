/**
 * What a TRUSTED in-process caller hands a write planner that a request never can: an id the instance minted, and a schema the caller proposes
 * (bundle-270, slice S4; plan section 3 (b)).
 *
 * ## Why they exist
 *
 * An import into a strict space is all or nothing, so each record is planned once without writing (a dry plan) and committed afterwards, and
 * a commit that is resumed after a restart must land each new record under the id the first attempt chose. So the importer mints each new
 * record's id once, keeps it, and hands it to the planner here; and it plans against the type schemas it is about to store
 * (`planMetaFor`, `spaces/schema-stamp.ts`), so a record is judged and stamped by the schema it will be stored under.
 *
 * ## What they must never become
 *
 * A way for a request to choose an identity. ID IS ID (owner ruling, 2026-08-12): a supplied id addresses an existing record and never
 * becomes a new one's identity, and every door's `id` still only addresses. So:
 *
 *  - `PlanTrust` is constructed only by {@link trustedPlan} (its constructor refuses any other caller), and a planner's fourth argument is a
 *    `PlanTrust`, never a field of its input;
 *  - `a-planner-judges-a-whole-import-before-anything-is-stored.test.js` holds that no server source outside the write planners and the RDF
 *    import (`server/src/rdf/`) names `trustedPlan` or `PlanTrust`, so no door can build one from what a request carries;
 *  - the minted id must be a UUID v4, and a planner refuses it beside a request's `id` (one write, two identities);
 *  - the plan schema is opaque here: the planner hands it to `readMetaForWrite(spaceId, planned)`, which takes only a pair `planMetaFor` made
 *    for that same space and refuses anything else.
 *
 * ## Why it imports nothing of the server
 *
 * The planners sit in the server's largest import cycle, and a module they import that imports any member back joins it (the architecture
 * probe holds the cycle's size to a ceiling). So the read set is named here by the two questions asked of it, and the plan schema by nothing.
 */
import { v4 as uuidv4, validate as isUuid, version as uuidVersion } from 'uuid';

/** The UUID version a minted id has: random (v4), as every id the instance mints. */
const MINTED_UUID_VERSION = 4;

/** Held by this module alone: the constructor refuses a call that does not pass it. */
const MINTED_HERE: unique symbol = Symbol('trustedPlan');

export class PlanTrust {
  /** The record's identity when the plan inserts, and the record it converges on when one is stored under it. */
  readonly mintedId: string | undefined;
  /** The pair (`planMetaFor`) the planner judges and stamps with in place of the stored meta, through `readMetaForWrite`. */
  readonly planMeta: object | undefined;

  constructor(token: typeof MINTED_HERE, readonly spaceId: string, mintedId: string | undefined, planMeta: object | undefined) {
    if (token !== MINTED_HERE) throw new Error('PlanTrust is built by trustedPlan(spaceId, ...) alone: a planner\'s trusted arguments never come from a request.');
    this.mintedId = mintedId;
    this.planMeta = planMeta;
  }
}

/** The trusted arguments for planning a write to `spaceId`. Throws on a minted id that is not a UUID v4. */
export function trustedPlan(spaceId: string, args: { mintedId?: string; planMeta?: object }): PlanTrust {
  const { mintedId, planMeta } = args;
  if (mintedId !== undefined && !(isUuid(mintedId) && uuidVersion(mintedId) === MINTED_UUID_VERSION)) {
    throw new Error(`trustedPlan: a minted id is a UUID v4 the instance generated, not '${mintedId}'`);
  }
  return new PlanTrust(MINTED_HERE, spaceId, mintedId, planMeta);
}

/**
 * The trust a planner was handed, checked against the space it plans for and the request id it was given; `undefined` when none.
 * A request id beside a minted one is two identities for one write, which no caller means.
 */
export function trustFor(spaceId: string, trust: PlanTrust | undefined, requestId: string | undefined): PlanTrust | undefined {
  if (trust === undefined) return undefined;
  if (!(trust instanceof PlanTrust)) throw new Error('a planner\'s trusted arguments are a PlanTrust from trustedPlan');
  if (trust.spaceId !== spaceId) throw new Error(`the trusted arguments were made for space '${trust.spaceId}', not for space '${spaceId}'`);
  if (trust.mintedId !== undefined && requestId !== undefined) {
    throw new Error(`a write names the id '${requestId}' and carries a minted id: a minted id is the identity of a new record, an id only addresses one`);
  }
  return trust;
}

/** The kinds whose identity a planner mints (an edge's is its triplet). */
export type MintedKind = 'entity' | 'fact' | 'chrono';

/** The two questions {@link mintedRecord} asks of a read set (`ReadSet`). */
export interface MintedView {
  seeded(kind: MintedKind, id: string): boolean;
  stored(kind: MintedKind, id: string): Record<string, unknown> | null;
}

/** What a plan with a minted id must load (`ReadWant.records`): the record stored under that id, if any. Empty without one. */
export function mintedWant(kind: MintedKind, trust: PlanTrust | undefined): Partial<Record<MintedKind, string[]>> {
  return trust?.mintedId !== undefined ? { [kind]: [trust.mintedId] } : {};
}

/**
 * The record stored under a trusted minted id — what a second plan of the same import record, or a commit resumed after its first attempt
 * landed, converges on — or `null` (none, or no minted id). A record only SEEDED under it (`ReadSet.seed`: present for the edges and links
 * that name it) is not stored, so its own plan inserts it.
 */
export function mintedRecord(view: MintedView, kind: MintedKind, trust: PlanTrust | undefined): Record<string, unknown> | null {
  const minted = trust?.mintedId;
  if (minted === undefined || view.seeded(kind, minted)) return null;
  return view.stored(kind, minted);
}

/**
 * The identity an insert takes: the trusted minted id, else one minted here, now (ID IS ID: never a request's `id`, which only addresses).
 */
export function insertIdentity(trust: PlanTrust | undefined): string {
  return trust?.mintedId !== undefined ? trust.mintedId : uuidv4();
}
