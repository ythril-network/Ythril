/**
 * What every EXISTING token becomes under the per-space rights matrix.
 *
 * ## Why this is a pure function in its own file
 *
 * This is the step where silent widening happens. Every token on every instance is re-expressed here, and a
 * mistake does not fail — it grants. A token that gains an area nobody chose keeps working, reports success,
 * and looks exactly like one that was configured that way on purpose. There is no error to notice.
 *
 * So it takes a record and returns a value, with no database, no config and no clock. Every shape a token can
 * have is a test case rather than a deployment.
 *
 * ## The rule, and it is the only one
 *
 * **Never a superset.** Where the old model is ambiguous, the mapping takes the NARROWER reading. A token
 * that loses an access it should have had produces a 403 that somebody reports on the first day; a token
 * that gains one produces nothing at all, for as long as nobody looks.
 */
import type { SpaceArea, Rung } from './space-rights.js';
import { SPACE_AREAS } from '../config/rights-shape.js';

/**
 * The areas, in the order the UI shows them — the ONE list, not a copy of it.
 *
 * This spelled the four names itself. So did `space-reach.ts`, and `space-rights.ts` had them a third time
 * as a union: four modules holding one vocabulary, with nothing comparing them, which is how the validator
 * that governs access could be written without agreeing with any of them (`Q-6`, 2026-09-07).
 *
 * Kept as a name because two modules import it, and re-pointed rather than deleted so the change is one
 * line rather than a rename across three files.
 */
export const AREAS: readonly SpaceArea[] = SPACE_AREAS;

export type AreaRungs = Record<SpaceArea, Rung>;

export interface MigratedRights {
  /** The instance-administrator switch — the danger zone, not an area. */
  instanceAdmin: boolean;
  /** May create spaces. Separate from instance admin by owner decision. */
  createSpaces: boolean;
  /**
   * The MINIMUM held in every space, including ones created later. `null` means no floor: this token
   * reaches only the spaces named in `perSpace`.
   */
  floor: AreaRungs | null;
  /** Explicit per-space rows, for a token that was scoped to a list. */
  perSpace: Record<string, AreaRungs>;
}

/** The subset of a token record this mapping reads. Deliberately narrow — anything else is not an input. */
export interface LegacyToken {
  admin?: boolean;
  readOnly?: boolean;
  /**
   * `null` is declared, not tolerated by accident.
   *
   * This shape comes from `config.json`, so anything JSON can hold, it can hold — and a stored `spaces: null`
   * is exactly as real as an absent key. Typing it `string[] | undefined` let the compiler agree that `null`
   * was impossible, and the migration below then tested `=== undefined` and fell through on it. Reported from
   * a live instance (the fleet integrator, 2026-08-12): an unscoped token stored as `null` lost every space it had.
   */
  spaces?: string[] | null;
  schemaLibrary?: boolean;
  peerInstanceId?: string;
}

/**
 * The four DATA areas take the legacy level. `networks` does not: every network route was instance-admin in the
 * legacy model, so below `admin` a legacy token held no network capability — mapping `write` onto it would hand
 * every old write token the right to create and leave networks at the moment the column appeared.
 */
const rungs = (r: Rung): AreaRungs =>
  ({ knowledge: r, files: r, schema: r, dataQuality: r, networks: r === 'admin' ? 'admin' : 'none' });

/**
 * Map one legacy token to its rights.
 *
 * The order of the branches is the order of precedence in the old model, and it matters:
 *
 *  1. `schemaLibrary` — has NO space access by construction (the create route rejects it alongside `admin`
 *     or any `spaces`), so it maps to nothing rather than to a floor. Checked first because such a token may
 *     also carry `readOnly: true`, which would otherwise read as "read everywhere".
 *  2. `admin` — reaches everything, so every area at `admin`, as a FLOOR. An admin token today also reaches
 *     spaces created tomorrow, and a floor is the only construct that preserves that.
 *  3. `readOnly` — every area at `read`, scoped as below.
 *  4. otherwise — `write`, scoped as below.
 *
 * `admin` at the area level is NOT the instance switch: it is the destructive rung within an area. The
 * instance switch is set separately from `admin` on the same record, which is why both appear here.
 */
export function migrateToken(t: LegacyToken): MigratedRights {
  // A schema-library token is not a space token at all. Mapping it to a read floor would hand it every
  // space on the instance — the widest possible widening, from the narrowest possible token.
  if (t.schemaLibrary) {
    return { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} };
  }

  const level: Rung = t.admin ? 'admin' : t.readOnly ? 'read' : 'write';

  // `spaces` absent means "all spaces" in the old model, including future ones. That is exactly a floor.
  // `spaces: []` is NOT the same as absent — an empty allowlist reaches nothing, and the create route can
  // produce one (a schemaLibrary token stores `[]`). Treating empty as absent would turn the narrowest
  // token into the widest, so the check is on ABSENCE, never on length.
  //
  // `== null` and not `=== undefined`: a stored `null` means the same thing as an absent key — no allowlist,
  // therefore every space — and it reached this function from real config. Under `=== undefined` a `null` fell
  // through to the loop below, which then iterated `null` and threw, so an unscoped token ended up reaching
  // NOTHING. It is a silent downgrade rather than a refusal: the token keeps answering reads and every write
  // is refused, which is why it went unnoticed for two days on the instance that reported it.
  //
  // `grantsMoreThan` in this same file already wrote `t.spaces ?? []`, so the two halves of one migration
  // disagreed about whether `null` could happen. That disagreement is the bug, not the operator's data.
  if (t.spaces == null) {
    return {
      instanceAdmin: t.admin === true,
      // Creating spaces was an admin-only act, so only an admin token carries it forward. A non-admin token
      // never had it and must not acquire it.
      createSpaces: t.admin === true,
      floor: rungs(level),
      perSpace: {},
    };
  }

  const perSpace: Record<string, AreaRungs> = {};
  for (const id of t.spaces) perSpace[id] = rungs(level);
  return {
    instanceAdmin: t.admin === true,
    createSpaces: t.admin === true,
    // A space-scoped token reaches only what it was given, and must NOT inherit spaces created later — it
    // could not reach them before. No floor is the whole point of the distinction.
    floor: null,
    perSpace,
  };
}

/**
 * Does the mapping grant anything the legacy token did not?
 *
 * Exported as its own predicate so the property can be asserted directly rather than inferred from a fixture
 * comparison: "never a superset" is the requirement, and a test that only checks known shapes cannot say
 * anything about one nobody thought of.
 */
export function grantsMoreThan(t: LegacyToken, r: MigratedRights): boolean {
  // `== null` for the same reason as the migration itself: absent and `null` both mean "no allowlist". Left as
  // `=== undefined`, this predicate would call the CORRECTED migration a widening and refuse it — the guard
  // would block the fix rather than the bug.
  const legacyReachesAllSpaces = !t.schemaLibrary && t.spaces == null;
  if (r.floor && !legacyReachesAllSpaces) return true;                   // a floor where there was no reach
  if (r.instanceAdmin && t.admin !== true) return true;                  // admin from a non-admin token
  if (r.createSpaces && t.admin !== true) return true;                   // ditto
  if (t.schemaLibrary && (r.floor || Object.keys(r.perSpace).length)) return true;

  const allowed = new Set(t.spaces ?? []);
  for (const id of Object.keys(r.perSpace)) {
    if (!legacyReachesAllSpaces && !allowed.has(id)) return true;        // a space it never had
  }

  const ceiling: Rung = t.admin ? 'admin' : t.readOnly ? 'read' : 'write';
  const order: Rung[] = ['none', 'read', 'write', 'admin'];
  const tooHigh = (a: AreaRungs) => AREAS.some(k => order.indexOf(a[k]) > order.indexOf(ceiling));
  if (r.floor && tooHigh(r.floor)) return true;
  return Object.values(r.perSpace).some(tooHigh);
}
