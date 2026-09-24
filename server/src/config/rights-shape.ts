/**
 * The shape of a token's per-space rights, in a leaf module with no imports.
 *
 * It lives here rather than inline in `types.ts` for a concrete reason: written out there it added six lines
 * to a file that had already taken three god-file ratchet raises in one day, and the honest response to a
 * fifth is to stop putting things in it — not to raise it again.
 *
 * It cannot live in `auth/rights-migration.ts` either, because `types.ts` would then import from `auth/`,
 * which imports `types.ts`. A leaf both can import breaks that cycle without either owning the other.
 */

/** Rungs, lowest first. Each CONTAINS the one below, so "write but not read" is unrepresentable. */
export type Rung = 'none' | 'read' | 'write' | 'admin';

/**
 * The four space-scoped areas, as VALUES — so a validator can reject an unknown one.
 *
 * The type alone was not enough. `POST`/`PATCH /api/tokens` validated the rung values against
 * `none|read|write|admin` and left the area NAME unvalidated, so `{"brain": "write"}` stored happily at 200
 * and granted nothing, because the real area is `knowledge`. An operator wrote that onto a live token while
 * probing and took an agent offline for four minutes; the only thing that named the true area was a later
 * 403's own wording.
 *
 * That is the same conflation fixed for token mints in 2.6.0 — unknown keys accepted and silently dropped —
 * one level deeper. Exported as a tuple so `z.enum` can consume it and there is one list rather than the four
 * hand-written copies that existed before.
 */
export const SPACE_AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'] as const;

/** The four space-scoped areas. Instance capabilities are not here — they have no space to scope to. */
export type SpaceArea = typeof SPACE_AREAS[number];

/** The rungs as values, for the same reason. */
export const RUNGS = ['none', 'read', 'write', 'admin'] as const;

export type AreaRungs = Record<SpaceArea, Rung>;

/**
 * One area's rung entailing a rung in ANOTHER area, in the same space.
 *
 * Owner ruling 2026-08-15: *"whenever someone has write in knowledge he should automatically have read on
 * schemas."* Writing a record against a schema requires reading that schema, so `knowledge: write` with
 * `schema: none` is not a narrower grant — it is a grant that cannot be exercised. Leaving the pair to an
 * operator means the commonest useful token is one checkbox away from being broken, and broken in a way that
 * surfaces as a 403 on a route nobody deliberately called.
 *
 * ## Why the TABLE lives here and the resolution does not
 *
 * This module is the leaf both `types.ts` and `auth/` can import, so a table here has exactly one copy. The
 * APPLICATION lives in `auth/mint-cap.ts` next to `effectiveRung`, which is the single place the whole server
 * asks "what does this token hold here" — REST middleware, the MCP tool guard, `reachable-spaces.ts` and the
 * mint cap all route through it. An implication applied anywhere else would be a second security rule.
 *
 * The client gets it from `GET /api/tokens/rights-catalog` rather than typing its own copy, for the same
 * reason the route table is published there: a copy of a security rule drifts, and the copy people read is
 * the one that is wrong.
 *
 * ## Implications do NOT chain, deliberately
 *
 * Each rule is evaluated against what the token was GRANTED, never against what an earlier rule inferred. A
 * chain would make the order of this array load-bearing and let two innocuous rules compose into a grant
 * nobody wrote down. If a transitive implication is ever wanted, it goes in as its own row, visibly.
 */
/**
 * The named rungs beyond the four areas, published so a caller can find and GRANT them.
 *
 * ## `spaceAdmin` stopped being derived at 5.0, and this docblock is where that shows
 *
 * It was `SPACE_AREAS.every(area => effectiveRung(...) === 'admin')` and nothing else — a real capability
 * with no way to grant it in one action. The canary operator asked twice (2026-08-17T1910Z and 1916Z) and
 * this list was the answer: a NAME, findable through `rights-catalog`, still assembled from four cells.
 * Owner, 2026-09-16: *"Make space admin real and not derived"*.
 *
 * `TokenRights.spaceAdmin` is now a grant of its own, read by `grantedRung`. **`requires` below is still
 * correct and is still computed** — it says what the grant RESOLVES TO, which is what a caller reading the
 * catalogue needs in order to understand what it hands over, and it is what a token granted the old way
 * still satisfies. The name of this array is the part that is now half-true, and it is kept: `derivedRungs`
 * is a published response key that integrators branch on, and renaming it to correct a word would break
 * them for no capability.
 *
 * ## Why this exists at all
 *
 * `isSpaceAdminFor` (auth/editor-scope.ts) is `SPACE_AREAS.every(area => effectiveRung(...) === 'admin')`.
 * That capability has been enforced since #937 and is real: it unlocks a space's own tokens and settings, and
 * `space-admin-edit-boundary.test.js` red-teams both of its containment rules.
 *
 * **But it had no NAME on any surface.** `isSpaceAdminFor` appears in three server files and zero client
 * files, so the matrix showed four independent rungs and nothing said that all four at `admin` IS being that
 * space's administrator. The canary operator asked for it twice — 2026-08-17T1910Z and a 1916Z narrowing — and
 * their words were about the surface, not the capability: *"there is still no SPACE ADMIN rung in the rights
 * matrix"*. An operator could not find it, grant it in one action, or verify they held it.
 *
 * ## Why `requires` is COMPUTED and not written out
 *
 * The same reason `rights-catalog` publishes `ROUTE_RIGHTS` instead of letting the client type a list: *"a
 * list typed into the client would be a second copy of a security control, and the copy that drifts is the
 * one people read."* A literal `{knowledge: 'admin', files: 'admin', ...}` here would be a second statement
 * of the predicate, free to disagree with it — and if a fifth area is ever added, the predicate would change
 * and the published definition would not. Built from `SPACE_AREAS`, both move together or neither does.
 *
 * `space-admin-rung-is-named.test.js` asserts this definition against `isSpaceAdminFor` itself, by running
 * the predicate over a rights object built from `requires` — so agreement is proven rather than intended.
 */
export const DERIVED_RUNGS = [
  {
    id: 'spaceAdmin',
    /** Every area at its top rung, FOR ONE SPACE — never the instance. */
    requires: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) as AreaRungs,
    /**
     * What it unlocks BEYOND what the four rungs already grant, in words rather than as a route list.
     *
     * Deliberately prose: the routes it governs are the ones NOT in `ROUTE_RIGHTS` (that table is the four
     * DATA areas), so enumerating them here would create the second copy this file's own reasoning forbids.
     * `NOT_AREA_SCOPED` in auth/space-rights.ts carries them with a `why` each.
     */
    grants: 'That space’s own tokens (listing, minting and editing) and that space’s own settings, schema '
      + 'and index rebuilds.',
    /**
     * The two containment rules, stated because the canary operator asked for them to be part of the
     * DEFINITION rather than inferred. Both are enforced today and red-teamed.
     */
    excludes: 'Nothing instance-shaped: it cannot grant `instanceAdmin` or `createSpaces`, cannot set a floor, '
      + 'and cannot reach, mint for, or edit tokens for any space it does not administer — it does not even '
      + 'list them.',
  },
] as const;
export const RUNG_IMPLICATIONS = [
  { when: 'knowledge', atLeast: 'write', grants: 'schema', rung: 'read' },
] as const satisfies readonly { when: SpaceArea; atLeast: Rung; grants: SpaceArea; rung: Rung }[];

export type RungImplication = typeof RUNG_IMPLICATIONS[number];

export interface TokenRights {
  instanceAdmin: boolean;
  createSpaces: boolean;
  /** The MINIMUM held in every space, including ones created later. `null` means no floor. */
  floor: AreaRungs | null;
  perSpace: Record<string, AreaRungs>;
  /**
   * Spaces this token ADMINISTERS outright — the rung an operator can grant in one action.
   *
   * ## Why this exists when the four rungs already expressed it
   *
   * They expressed it and nothing could GRANT it. `isSpaceAdminFor` is `every area === 'admin'`, so being
   * a space's administrator was something you assembled out of four checkboxes and hoped you had got
   * right. The canary operator asked twice — 2026-08-17T1910Z and 1916Z — and their words were about the
   * surface: *"there is still no SPACE ADMIN rung in the rights matrix"*. Naming it in `DERIVED_RUNGS`
   * made it findable and left it unassemblable in one click. Owner, 2026-09-16: *"Make space admin real
   * and not derived"*.
   *
   * ## Why this is not the second source of truth that was rejected
   *
   * `editor-scope.ts` turned a flag down because *"it would then be a second thing that can disagree with
   * them"* — true of a flag CHECKED BESIDE the rungs, false of one that GRANTS them. This is read by
   * `grantedRung`, the single funnel every per-space rung already passes through, so a space named here
   * holds `admin` in every area BY RESOLUTION. `isSpaceAdminFor` is unchanged and still asks
   * `effectiveRung` four times; there is no comparison to get wrong because there are not two answers.
   *
   * ## Scope, exactly
   *
   * Per space, never the instance, and never the FLOOR — the floor reaches spaces that do not exist yet,
   * and a per-space grant leaking into it would hand one space's administrator the whole instance.
   *
   * ## Two scopes, because everything else in this matrix has two
   *
   * `floor` reaches every space including ones created later; `spaces` names them. Administration needed
   * both for a configuration that already exists: the canary operator's token holds `admin` on all four
   * areas of every space through the FLOOR, with no `instanceAdmin`, and it runs their daily token
   * inventory. A per-space list alone would have enumerated today's spaces and frozen a list that was
   * never a list — and silently stopped that token administering anything, which is the incident `Q-12`
   * already cost them once.
   *
   * Optional, so every matrix stored before it existed reads back unchanged and grants nothing new.
   */
  spaceAdmin?: { floor: boolean; spaces: string[] };
}

const isRung = (v: unknown): v is Rung => (RUNGS as readonly unknown[]).includes(v);
const isArea = (k: string): k is SpaceArea => (SPACE_AREAS as readonly string[]).includes(k);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Bring a STORED rights object back to the shape the API validates against, without ever granting more.
 *
 * ## Why this exists
 *
 * Owner-reported 2026-08-15: saving a rights matrix was refused with ~40 zod errors, the same two repeated for
 * the floor and for every space — `unrecognized_keys ["admin"]` and an invalid `dataQuality`. Each stored rungs
 * object was `{ knowledge, files, schema, admin }`: three areas plus a key that is not an area, and the fourth
 * area missing. The editor round-trips what it read, so the malformed shape was on DISK and every save of that
 * token was rejected — the matrix could be looked at and never corrected.
 *
 * Nothing in this codebase ever wrote that shape (checked back through `v2.6.0`, which had no rights model at
 * all, and `v2.7.0`, whose migration already wrote `dataQuality`). So the repair cannot be aimed at one known
 * producer: it has to be aimed at the shape itself, which is what makes it a normalizer rather than a patch.
 *
 * ## The rule is the migration's rule — never a superset
 *
 * A missing area becomes `none`, an unreadable rung becomes `none`, and a key that is not an area is DROPPED.
 * All three are what the enforcement code already does with them — `floor?.[area] ?? 'none'` — so this changes
 * no decision anywhere; it only makes the record say what the server was already doing with it. Re-deriving
 * from the legacy fields instead would have been the widening: a legacy `admin` token whose matrix an operator
 * had deliberately narrowed would get `admin` on everything back, silently, at boot.
 *
 * `changed` is reported rather than inferred by comparison, so a caller can persist exactly when there was
 * something to persist and a boot that repairs nothing writes nothing.
 *
 * Returns `null` when the value is not an object at all — there is nothing to preserve, and the caller should
 * derive a fresh matrix from the legacy fields.
 */
export function repairRights(value: unknown): { rights: TokenRights; changed: boolean } | null {
  if (!isPlainObject(value)) return null;
  let changed = false;

  const rungsOf = (v: unknown): AreaRungs | null => {
    if (!isPlainObject(v)) return null;
    const out = {} as AreaRungs;
    for (const a of SPACE_AREAS) {
      out[a] = isRung(v[a]) ? v[a] : 'none';
      if (v[a] !== out[a]) changed = true;              // absent, misspelled, or not a rung
    }
    for (const k of Object.keys(v)) if (!isArea(k)) changed = true;   // dropped: `admin` is not an area
    return out;
  };

  const floor = value['floor'] == null ? null : rungsOf(value['floor']);
  if (value['floor'] !== null && floor === null) changed = true;      // absent, or not an object

  const perSpace: Record<string, AreaRungs> = {};
  if (isPlainObject(value['perSpace'])) {
    for (const [id, row] of Object.entries(value['perSpace'])) {
      const fixed = rungsOf(row);
      if (fixed) perSpace[id] = fixed;
      else changed = true;                                            // a row that is not an object grants nothing
    }
  } else {
    changed = true;                                                   // absent, or not an object: no rows at all
  }

  const instanceAdmin = value['instanceAdmin'] === true;
  const createSpaces = value['createSpaces'] === true;
  if (typeof value['instanceAdmin'] !== 'boolean' || typeof value['createSpaces'] !== 'boolean') changed = true;

  /*
   * The spaces this token administers. A non-string entry is DROPPED rather than kept or refused: this
   * function exists because a malformed matrix reached disk once and made every save of that token fail
   * validation, so the matrix could be looked at and never corrected. Refusing here would recreate that.
   *
   * Absent is the common case and is not a repair — a matrix stored before this field existed is correct
   * as it stands and must not be reported as changed, or every old token would look edited on first read.
   */
  let spaceAdmin: { floor: boolean; spaces: string[] } | undefined;
  if (value['spaceAdmin'] !== undefined) {
    const raw = value['spaceAdmin'];
    if (isPlainObject(raw)) {
      const spaces: string[] = [];
      if (Array.isArray(raw['spaces'])) {
        for (const id of raw['spaces']) {
          if (typeof id === 'string' && id.length > 0) spaces.push(id);
          else changed = true;
        }
      } else if (raw['spaces'] !== undefined) {
        changed = true;                                               // not an array: names nothing
      }
      const floor = raw['floor'] === true;
      if (typeof raw['floor'] !== 'boolean') changed = true;
      for (const k of Object.keys(raw)) if (k !== 'floor' && k !== 'spaces') changed = true;
      spaceAdmin = { floor, spaces };
    } else {
      changed = true;                                                 // not an object: administers nothing
    }
  }

  for (const k of Object.keys(value)) {
    if (k !== 'instanceAdmin' && k !== 'createSpaces' && k !== 'floor' && k !== 'perSpace'
      && k !== 'spaceAdmin') changed = true;
  }

  return {
    // Emitted only when it grants something, so a matrix that predates the field round-trips unchanged.
    rights: {
      instanceAdmin, createSpaces, floor, perSpace,
      ...(spaceAdmin && (spaceAdmin.floor || spaceAdmin.spaces.length) ? { spaceAdmin } : {}),
    },
    changed,
  };
}
