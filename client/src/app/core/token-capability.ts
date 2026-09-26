import type { TokenRights } from '../pages/settings/rights-glyph.component';

const AREAS = ['knowledge', 'files', 'schema', 'dataQuality'] as const;
const RUNGS = ['none', 'read', 'write', 'admin'] as const;

/** Is `held` at least `needs` on the four-rung ladder? Mirrors the server's `satisfies`. */
function satisfies(held: string | undefined, needs: (typeof RUNGS)[number]): boolean {
  const h = RUNGS.indexOf((held ?? 'none') as (typeof RUNGS)[number]);
  return h >= 0 && h >= RUNGS.indexOf(needs);
}

/**
 * Can this token write at all — any area, any space?
 *
 * ## Why the UI needs this rather than a `readOnly` flag
 *
 * The badge on the Tokens page and the graph editor's `canEdit` both asked `!token.readOnly`. That flag is
 * being removed: it cannot express a per-space, per-area grant, and every guard on the server now reads the
 * matrix instead. A UI still branching on the flag would show "read-only" for a token that can write in one
 * space, and "standard" for one whose matrix reaches nothing.
 *
 * ## It mirrors the server deliberately, and only this far
 *
 * The server's `auth/write-anywhere.ts` answers the same question for the coarse mutation guard, and this is
 * the same predicate — instance admin, or a write rung in some area of the floor or of any space. Keeping the
 * ladder here is a duplication, and the alternative is worse: the UI would have to ask the server whether to
 * draw a badge.
 *
 * What it must NOT be used for is deciding whether a specific action is allowed. That is the server's answer,
 * per space and per area, and the UI's job is to render the outcome — not to pre-empt it. This exists to pick
 * a LABEL and to grey out an editor, both of which are cosmetic and both of which the server re-checks.
 */
export function canWriteAnywhere(rights: TokenRights | undefined | null): boolean {
  if (!rights) return false;
  if (rights.instanceAdmin) return true;
  const floor = rights.floor;
  if (floor && AREAS.some(a => satisfies(floor[a], 'write'))) return true;
  return Object.values(rights.perSpace ?? {}).some(areas => AREAS.some(a => satisfies(areas[a], 'write')));
}

/**
 * How much power this token holds, as a number, for ORDERING a list of tokens.
 *
 * ## What it is for, and what it must not be used for
 *
 * Sorting the Tokens table's Permission column. It is cosmetic in exactly the sense the docblock above
 * describes: it picks a row order, and every action the rows offer is still authorised by the server per space
 * and per area. Do not branch on it to decide whether something is allowed.
 *
 * ## Why it lives here
 *
 * Because the ladder does. `AREAS` and `RUNGS` are already in this file with the comparison written against
 * them, and a rank built anywhere else would be the third copy of `['none','read','write','admin']` in the
 * repo — the defect class this codebase produces most, and the one where the weaker copy wins silently.
 *
 * ## The two things it decides that the ladder does not
 *
 * **Instance admin sits above any per-space admin.** They are different kinds of power and the four-rung
 * ladder does not compare them: an `admin` rung reaches one area of one space, while instance admin reaches
 * spaces that do not exist yet. So it is ranked above the top of the ladder rather than at it.
 *
 * **No matrix at all ranks below a matrix that grants nothing.** They look different in the table — "no
 * rights" text versus an omitted glyph — and they ARE different: one has never been given a matrix, the other
 * has one that reaches nothing. Sorting them together would bury the first among the second, and the first is
 * the one an operator has to act on. That distinction is the same one `api.types.ts` states for the field: a
 * missing matrix means "not known here", not "reaches nothing".
 */
export function rightsRank(rights: TokenRights | undefined | null): number {
  if (!rights) return -1;
  if (rights.instanceAdmin) return RUNGS.length;
  const held = (areas: Record<string, string> | null | undefined): number =>
    areas ? Math.max(0, ...AREAS.map(a => RUNGS.indexOf((areas[a] ?? 'none') as (typeof RUNGS)[number]))) : 0;
  return Math.max(held(rights.floor as never), ...Object.values(rights.perSpace ?? {}).map(a => held(a as never)));
}


/**
 * Tick or untick an instance-level flag on a rights draft. Granting instance admin also sets space admin on the
 * FLOOR — what the server stores for every instance admin (`auth/instance-admin-grants.ts`, S-11) — so the matrix
 * shows the grant the token will hold instead of a floor the server fills in on save. Unticking it leaves the
 * floor alone: that is its own grant, edited in the matrix. Shared by the create and the rights dialogs so the
 * two cannot disagree about what ticking the box means.
 */
export function withInstanceFlag(rights: TokenRights, key: 'instanceAdmin' | 'createSpaces', on: boolean): TokenRights {
  const next = { ...rights, [key]: on } as TokenRights;
  if (key === 'instanceAdmin' && on) {
    next.spaceAdmin = { floor: true, spaces: [...(rights.spaceAdmin?.spaces ?? [])] };
  }
  return next;
}
