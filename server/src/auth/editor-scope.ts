/**
 * What a SPACE-RESTRICTED administrator may do to another token.
 *
 * ## The hole this closes, measured rather than assumed
 *
 * Probed on 2026-08-13 with an admin token scoped to one space, editing a token scoped to a different one:
 *
 * ```
 * rename that token                            -> 200
 * grant it rights.instanceAdmin: true          -> 200, and STORED
 * grant it rights.createSpaces: true           -> 200, and STORED
 * ```
 *
 * There was no boundary at all. `PATCH /api/tokens/:id` is gated by `requireAdminMfa`, and a space-restricted admin
 * carries `admin: true`, so it was admitted like any other administrator.
 *
 * **Both escalated rights were inert at the time**, because the admin-only routes read the legacy `admin` flag rather
 * than `rights.instanceAdmin` — so this was a stored escalation, not a live one. That is precisely why it needed
 * fixing before anything else: the 2.6 rights matrix exists so guards can move onto `rights`, and the day one does,
 * every token a space admin has touched carries whatever it was handed.
 *
 * `capRights` did not stop it either. The editor's record had `rights: null` and `admin: true`, so its derived rights
 * read as a full instance admin — and a `spaces` allowlist is not part of that comparison. Rung-capping and
 * scope-capping are different questions, which is why this is a separate guard rather than a change to that one.
 *
 * ## The rule, in the owner's words
 *
 * *"as space admin i want to be able to edit token rights"* — for THEIR space. So: a space admin for X may edit
 * `rights.perSpace[X]` and nothing else.
 *
 * `floor` is refused outright rather than capped, and that is the non-obvious one: a floor applies to every space
 * **including spaces that do not exist yet**, so however narrow it looks, it is instance-wide in effect. A space admin
 * granting a floor of `read` would be granting read on every space the instance ever gains.
 *
 * ## Why it mirrors the MINT guard instead of inventing a second rule
 *
 * `POST /api/tokens` already refuses a space-restricted creator minting outside its own scope. An edit route without
 * the same rule is the same escalation by a shorter path — mint is guarded, edit was not — and two surfaces with one
 * rule expressed twice is how they come to disagree. This function is the single expression; both routes call it.
 */
import type { TokenRecord } from '../config/types.js';
import { SPACE_AREAS } from '../config/rights-shape.js';
import type { TokenRights } from '../config/rights-shape.js';
import { effectiveRung, administers } from './mint-cap.js';

/**
 * The spaces an administrator is CONFINED to, read from the rights matrix rather than the legacy allowlist.
 *
 * ## Why this exists
 *
 * Both callers of `refusalsOutsideEditorScope` passed `req.authToken?.spaces` — the pre-3.0 allowlist. The
 * matrix has been the permission model since 2.6 and `spaces` is a deprecated field (`_DEPRECATIONS.md` 1.7,
 * measured at 14 files and 87 reads), so the guard was making its decision from the older of the two
 * descriptions of the same thing. A token minted with a matrix and no `spaces` array read as `undefined` here
 * — which this guard treats as an UNRESTRICTED instance administrator, the widest possible reading of a token
 * that may hold one space.
 *
 * That is the same absent-vs-empty conflation `reachable-spaces.ts` documents, arriving one layer up: there,
 * an empty allowlist was read as unrestricted; here, an absent one is, on a token whose real scope was in a
 * field nobody looked at.
 *
 * ## `undefined` means unrestricted, and only two things produce it
 *
 *  - **A floor with any rung above `none`.** A floor applies to every space *including ones created later*,
 *    so it cannot be enumerated. This is the same reasoning that makes the guard below refuse a floor rather
 *    than cap it: however modest the rungs look, the reach is instance-wide.
 * **A record with NO MATRIX is not one of them, and this bullet used to say it was.** It read *"an OIDC
 * session, or a record that predates the backfill — the legacy allowlist answers instead"*, which is the
 * exact branch the body twenty lines below removed: no matrix now answers `[]`, meaning NO spaces, and
 * `[]` and `undefined` mean opposite things here. Neither of the two shapes it named produces one anyway —
 * an OIDC session derives a matrix per request, and a pre-backfill record gets one on every boot.
 *
 * Otherwise the scope is the spaces with something in them: any area above `none`. A row of four `none`s is
 * not scope, it is a row somebody emptied, and counting it would let a token administer a space it holds
 * nothing in.
 *
 * ## `instanceAdmin` is NOT one of them, and that was a real bug in this function
 *
 * The first version short-circuited on `rights.instanceAdmin`. CI refused it, and the reason is the whole
 * point of this file: `migrateToken` maps a legacy **space-restricted** admin — `admin: true` with
 * `spaces: ['qa']` — to `{ instanceAdmin: true, floor: null, perSpace: { qa: … } }`. The old model narrowed
 * that token with its allowlist; `instanceAdmin` in the matrix carries no such narrowing. So the
 * short-circuit made exactly the token this guard exists to constrain read as unrestricted — a WIDENING
 * shipped inside a change whose stated purpose was to narrow.
 *
 * The distinction the first version missed: `instanceAdmin` is a **capability** switch (create spaces, manage
 * tokens), not a **reach**. Reach over every space, present and future, is what a floor expresses and the
 * only thing that does. A token holding `instanceAdmin` with no floor and no rows scopes to `[]` — it reaches
 * no space's data — and that is the honest answer, not an oversight.
 */
/**
 * Is this token the administrator OF a space?
 *
 * ## The GRANT, and only the grant — the four rungs are not equal to it
 *
 * Owner, 2026-09-16: *"Space admin is more than the four area admin rungs. It must be its own"*, and
 * *"It includes the four but the four do not equal space admin"*. So the implication runs one way:
 *
 *     spaceAdmin  ⟹  admin in all four areas of that space     (resolved in `grantedRung`)
 *     admin in all four  ⟹̸  spaceAdmin                         (this predicate refuses it)
 *
 * A token with the four rungs has everything you can do to the DATA in that space and is not its
 * administrator: it does not manage the space's own tokens, and it does not change the space's settings.
 * Those are not a fifth area — they are a different kind of authority over the same space, which is
 * exactly why reading them off the data rungs was wrong.
 *
 * **This used to be `SPACE_AREAS.every(area => effectiveRung(...) === 'admin')`**, and the docblock here
 * argued for it: a per-space flag *"would then be a second thing that can disagree with them"*. Two things
 * were wrong with that. The capability could not be GRANTED, only assembled — which the canary operator
 * reported twice. And the equivalence it rested on is false: maximal data rights are not administration,
 * so the derivation handed the space's token surface to every token that happened to hold four rungs.
 *
 * Nothing can disagree now either, for a better reason than before: there is one statement of the right,
 * and the rungs are RESOLVED from it rather than compared against it.
 *
 * **Existing tokens are migrated, not stranded.** `db/space-admin-becomes-a-grant.ts` writes the flag for
 * every token that held all four — under the old rule those tokens WERE administrators, and dropping them
 * silently on upgrade would take away access nobody asked to remove.
 *
 * ## What it unlocks, which is an owner ruling and not a derivation
 *
 * Owner, 2026-08-15, correcting a narrower proposal of mine: *"those are INSTANCE admin things. B and
 * includes the rest of the matrixes rungs for this space."*
 *
 * The routes I had wanted to protect — create a space, join a network, change instance settings, the database
 * page — are instance-shaped. There is no space to scope them to, so a space administrator was never going to
 * reach them and no separate rule is needed to keep them out. What a space admin gets is **its own space**:
 * that space's tokens, that space's settings, and whatever the four rungs already grant inside it.
 *
 * ## Deliberately reads the matrix ONLY
 *
 * No fallback to the legacy `admin` boolean. A legacy admin already passes `enforceAdmin` on its own, so
 * folding it in here would make this predicate answer two questions at once — and the whole point of
 * deprecation 1.7 is to get the legacy pair out of the decision path, not to add it to one more place.
 */
export function isSpaceAdminFor(rights: TokenRights | null | undefined, spaceId: string): boolean {
  if (!rights) return false;
  return administers(rights, spaceId);
}

/**
 * Every space this token administers. Empty means it administers none.
 *
 * Derived from the rows it actually holds rather than from every space on the instance: a floor of `admin`
 * makes `editorScopeFor` unrestricted anyway, and enumerating the config here would make this function's
 * answer depend on how many spaces exist rather than on what the token says.
 */
export function spaceAdminSpacesFor(record: { rights?: TokenRights | null } | undefined): string[] {
  const rights = record?.rights;
  if (!rights) return [];
  /*
   * The grant's own list. It used to filter `perSpace` keys through the predicate, which was right while
   * administration WAS four rungs on a row — and reads as zero for a token granted the right directly,
   * because such a token needs no row at all.
   *
   * The FLOOR form is deliberately not expanded here. This answers *"which spaces does it administer by
   * name"*, and a floor administers every space including ones that do not exist yet; enumerating the
   * config would make the answer depend on how many spaces exist. `administersAnySpace` is the predicate
   * for *"does it administer anything"*, and `Q-12` is what happens when the two get confused.
   */
  return [...(rights.spaceAdmin?.spaces ?? [])];
}

/**
 * Does this token administer ANY space — including by a floor, which names no space at all?
 *
 * ## Why this is not `spaceAdminSpacesFor(...).length > 0`
 *
 * That is what two callers used, and it is a different question. `spaceAdminSpacesFor` answers *which rows
 * does this token hold*, deliberately derived from the rows rather than from the instance's space list — see
 * its own note. A token whose admin comes from the FLOOR holds no rows, so the list is empty, and
 * `.length > 0` reads that as *administers nothing*.
 *
 * Reported by the canary operator 2026-09-06 §7: their token holds `admin` on all four areas of every space,
 * no `instanceAdmin`, no `createSpaces`, and `GET /api/tokens` answered `Admin token required` — a flat
 * refusal where `07-tokens-api` promises a scoped listing. **The cost was real**: that credential runs their
 * daily token inventory, so their seven-day expiry warning had been blind since 2026-08-20 and their MCP
 * connector lapsed on 2026-09-01 with no notice at all.
 *
 * The same rights make `editorScopeFor` return `undefined` — unrestricted — so one function read the floor
 * and the other did not. One rule, two implementations, and the weaker one refusing silently.
 *
 * ## What passing this still is not
 *
 * Permission to be CONSIDERED, exactly as before. Every route behind the gate still runs
 * `refusalsOutsideEditorScope`, and for a floor-admin token that scope is unrestricted because the floor
 * genuinely reaches every space — which is what the operator was promised.
 */
export function administersAnySpace(record: { rights?: TokenRights | null } | undefined): boolean {
  const rights = record?.rights;
  if (!rights) return false;
  /*
   * THE FLOOR FORM FIRST, and it is the whole reason this function is not `spaceAdminSpacesFor(...).length`.
   *
   * A token administering every space names NONE of them, so any check that counts named spaces reads zero
   * and refuses it. That is `Q-12` exactly, and the shape survived the 5.0 change: it used to be four admin
   * AREA floors and is now the grant's own floor, but it is still the configuration that holds no rows.
   */
  if (rights.spaceAdmin?.floor) return true;
  return spaceAdminSpacesFor(record).length > 0;
}

export function editorScopeFor(
  record: { rights?: TokenRights | null } | undefined,
): readonly string[] | undefined {
  if (!record) return undefined;
  const rights = record.rights;
  /*
   * NO MATRIX MEANS NO SCOPE, and here that has to be `[]` rather than `undefined`.
   *
   * This returned `record.spaces`, the pre-3.0 allowlist — which is `undefined` on every token since
   * 3.1, and `undefined` from THIS function means unrestricted. So a token with no matrix was read as an
   * instance-wide administrator by every caller: the same absent-means-permission mistake as
   * `tokenReachesSpace`, one layer up, where the two values that mean opposite things look identical.
   *
   * Owner, 2026-09-05: *"no matrix = refuse - no fallback no backwards compatibility anymore"*.
   */
  if (!rights) return [];
  // Either floor reaches every space, so neither can be expressed as a list.
  if (rights.spaceAdmin?.floor) return undefined;
  if (rights.floor && SPACE_AREAS.some(a => rights.floor?.[a] && rights.floor[a] !== 'none')) return undefined;
  /*
   * The UNION of rows and granted spaces. A token granted `spaceAdmin` for a space needs no `perSpace`
   * row there — the grant resolves its rungs — so deriving the scope from rows alone would give the
   * space's own administrator an empty scope and refuse it everything, including its own space.
   */
  const named = new Set(rights.spaceAdmin?.spaces ?? []);
  for (const id of Object.keys(rights.perSpace ?? {})) {
    if (SPACE_AREAS.some(a => effectiveRung(rights, id, a) !== 'none')) named.add(id);
  }
  return [...named];
}

/** The rights object as the API accepts it. */
export type EditableRights = {
  instanceAdmin: boolean;
  createSpaces: boolean;
  floor: Record<string, string> | null;
  perSpace: Record<string, Record<string, string>>;
};

/**
 * Reasons a space-restricted editor may not make this edit. Empty means allowed.
 *
 * `editorSpaces === undefined` is an UNRESTRICTED administrator — every check here is skipped, because an instance
 * admin editing anything is the tier that already worked and is not what this guard is about.
 */
export function refusalsOutsideEditorScope(input: {
  editorSpaces: readonly string[] | undefined;
  target: { spaces?: string[]; schemaLibrary?: boolean; rights?: TokenRights | null } | undefined;
  rights: EditableRights | undefined;
}): string[] {
  const { editorSpaces, target, rights } = input;
  if (!editorSpaces) return [];                       // unrestricted admin — tier 1, unchanged

  const out: string[] = [];

  // 1. The TARGET must live inside the editor's scope.
  //
  // Without this, a space admin could rename or re-right a token that reaches spaces it cannot see — which is how the
  // rename above succeeded. A `schemaLibrary` token has no space access at all, so it is inside any scope; a token
  // with NO allowlist reaches every space and is therefore outside every restricted scope.
  if (target && !target.schemaLibrary) {
    // The target's own scope, MATRIX first — `editorScopeFor` is the same resolution applied to the EDITOR,
    // so both sides of this comparison now answer one question one way. Reading the raw allowlist here
    // would call every token minted since 2.9 unrestricted, and refuse a space administrator every edit.
    const targetSpaces = editorScopeFor(target);
    if (!targetSpaces) {
      out.push('that token is unrestricted (it reaches every space), so a space-restricted administrator cannot edit it');
    } else {
      const outside = targetSpaces.filter(s => !editorSpaces.includes(s));
      if (outside.length > 0) {
        out.push(`that token reaches space(s) outside your scope: ${outside.join(', ')}`);
      }
    }
  }

  if (!rights) return out;

  // 2. Instance-wide flags are never a space administrator's to grant.
  if (rights.instanceAdmin) out.push('`instanceAdmin` is instance-wide and cannot be granted by a space-restricted administrator');
  if (rights.createSpaces) out.push('`createSpaces` is instance-wide and cannot be granted by a space-restricted administrator');

  // 3. A floor is instance-wide in EFFECT, even when its rungs look modest: it applies to every space, including ones
  //    created later. Refused rather than capped, because there is no per-space version of it to cap to.
  if (rights.floor && Object.keys(rights.floor).length > 0) {
    out.push('`floor` applies to every space including ones not yet created, so it cannot be set by a space-restricted administrator');
  }

  // 4. Per-space rows only for spaces the editor holds.
  const rows = Object.keys(rights.perSpace ?? {});
  const foreign = rows.filter(s => !editorSpaces.includes(s));
  if (foreign.length > 0) out.push(`per-space rights for space(s) outside your scope: ${foreign.join(', ')}`);

  return out;
}
