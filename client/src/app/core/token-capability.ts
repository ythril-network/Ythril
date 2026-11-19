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

// ── What a token may do in ONE space: the questions the conversion controls ask (bundle-285, Q-747) ─────────────────

type Rung = (typeof RUNGS)[number];
type Area = (typeof AREAS)[number];

/**
 * The rung this token holds for `area` in `spaceId`: the client's mirror of the server's `effectiveRung` (`auth/mint-cap.ts`), and the one
 * place the client resolves a rung in a space, so the Schema tab, the conversion dialog and Review ask one rule. Administering the space
 * (`spaceAdmin`, named or the floor) is the top of every area in it; otherwise the HIGHER of the space's own row and the floor, which is
 * how the server resolves it (a row lower than the floor lowers nothing). An area the matrix does not name is `none`.
 */
function rungIn(rights: TokenRights, spaceId: string, area: Area): Rung {
  if (isSpaceAdmin(rights, spaceId)) return 'admin';
  const rank = (r: string | undefined): number => Math.max(0, RUNGS.indexOf((r ?? 'none') as Rung));
  const own = rights.perSpace?.[spaceId]?.[area];
  const floor = rights.floor?.[area];
  return RUNGS[Math.max(rank(own), rank(floor))] ?? 'none';
}

/**
 * Does the token hold at least `rung` on the knowledge area of `spaceId`? Strict, as the server is: no matrix holds nothing. An instance
 * administrator holds every rung. For a control that must stay silent while the rights are unknown, ask {@link knowledgeAllowed}.
 */
export function holdsKnowledge(rights: TokenRights | null | undefined, spaceId: string, rung: Rung): boolean {
  // A rung name off the ladder is held by nobody: `satisfies` ranks it -1 and would answer yes.
  if (!rights || !RUNGS.includes(rung)) return false;
  return rights.instanceAdmin || satisfies(rungIn(rights, spaceId, 'knowledge'), rung);
}

/**
 * {@link holdsKnowledge} as a DISPLAY hint: unknown rights (still loading, or a token that may not read its own matrix) count as allowed, the
 * Schema tab's own rule, because a lock drawn on a guess would refuse what the server allows. The server decides every act either way.
 */
export function knowledgeAllowed(rights: TokenRights | null | undefined, spaceId: string, rung: Rung): boolean {
  return !rights || holdsKnowledge(rights, spaceId, rung);
}

/** Does the token administer the space (the `spaceAdmin` grant, named or the floor)? The grant alone: the server's `isSpaceAdminFor`. */
export function isSpaceAdmin(rights: TokenRights | null | undefined, spaceId: string): boolean {
  const grant = rights?.spaceAdmin;
  return !!grant && (grant.floor === true || (grant.spaces ?? []).includes(spaceId));
}

/**
 * Does the token hold admin on the schema area of `spaceId`? The check the Schema tab computes for its rules and its instance setting,
 * pulled out so the tab and the conversion read one rule. An instance administrator holds it; so does a space administrator and a token
 * whose row or floor says `schema: admin`. Strict like {@link holdsKnowledge}; the tab keeps its own "unknown counts as yes".
 */
export function holdsSchemaAdmin(rights: TokenRights | null | undefined, spaceId: string): boolean {
  if (!rights) return false;
  return rights.instanceAdmin || rungIn(rights, spaceId, 'schema') === 'admin';
}

/**
 * May this token start a conversion of the records of `spaceId`? A conversion rewrites records on every peer, so the server prices it
 * (`schemaConvertPrice`, `spaces/schema-convert-acts.ts`): an instance administrator always may; anyone else needs the knowledge admin rung
 * in the space AND to administer the space. Unknown rights count as allowed. A DISPLAY hint (the lock on the Convert records button, the
 * dialog's "Convert the records now" and Review's Convert again), never the decision: the server answers 403 `knowledge_rung` or
 * `space_admin_required` to what the token may not do.
 */
export function mayConvertRecords(rights: TokenRights | null | undefined, spaceId: string): boolean {
  if (!rights) return true;
  return rights.instanceAdmin || (holdsKnowledge(rights, spaceId, 'admin') && isSpaceAdmin(rights, spaceId));
}
