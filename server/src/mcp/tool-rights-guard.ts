import { TOOL_RIGHTS } from '../auth/space-rights.js';
import { effectiveRung } from '../auth/mint-cap.js';
import { satisfies } from '../auth/required-rung.js';
import { isSpaceAdminFor } from '../auth/editor-scope.js';
import type { TokenRights } from '../config/rights-shape.js';

/**
 * Does this token hold the rung this tool needs, in this space?
 *
 * Returns the refusal TEXT, or `null` to allow — so the dispatcher's job is one line and this decision can
 * be exercised without standing up an MCP server. Pure on purpose, for the same reason
 * `resolveFindSimilarScope` is: a guard that can only be tested through a transport gets tested by reading
 * it, and a source-reading test cannot tell live code from dead. The first version of this check WAS a
 * source grep, and it passed against `if (false && !satisfies(...))`.
 *
 * ## What it is fixing
 *
 * Until 3.0 the MCP dispatcher gated on two booleans — `readOnly`, and the tool's `admin` flag — while REST
 * enforced a per-space, per-area rung. One policy, two implementations, and the weaker one was reachable.
 * Measured, not inferred: a token whose matrix said `perSpace.general.knowledge = 'write'` was refused
 * `DELETE /api/brain/spaces/general/facts/:id` with a 403, and the identical delete through
 * `delete_fact` answered "Fact deleted".
 *
 * ## The ONE way it deliberately does nothing, and the one it used to
 *
 * - **No row for the tool.** It is instance-level — `list_spaces`, `save_space`, `list_tokens`,
 *   `network_peers`, `network_sync`, `delete_space_data`, `help` — and governed by the tool's `admin` flag against
 *   `instanceAdmin`, because the capability is not scoped to a space at all. This one stays: the absence
 *   of a row means *not my question*, not *permitted*.
 * - **No rights matrix — REMOVED.** This said: *"Every token created since 2.9 carries one and a boot
 *   migration backfills the rest, so in practice this is the OIDC path, where the record is built per
 *   request from the identity and legitimately has none. Those are still governed by `readOnly` and the
 *   `admin` flag."* Every clause of that had stopped being true. Nothing reads `readOnly` or `admin` —
 *   `tool-visibility.ts` says so in as many words — and an OIDC session carries `rights` as a REQUIRED
 *   field, derived per request from its claim mapping. It was a fallback described as a safety net, with
 *   nothing behind either half.
 *
 * ## Why that mattered even though nothing could reach it
 *
 * Owner, 2026-09-05: *"no matrix = refuse - no fallback no backwards compatibility anymore."* That swept
 * `tokenReachesSpace` and `editorScopeFor`. **This was the third copy and it was missed**, which is the
 * defect class `CLAUDE.md` names as this repo's commonest — and it appeared at the shortest distance yet,
 * because `spaceAdminRefusal` twenty lines above already refuses an absent matrix. One file, both answers.
 *
 * It could not reach data: `mcp/router.ts` resolves a connection's accessible spaces as
 * `rights ? reachesSpace(rights, s.id) : false`, so a matrixless connection reaches no space and every
 * brain tool needs one. That is unreachable in exactly the way the two swept branches were — *"the worse
 * of the two ways to be unreachable: nothing exercises it, and anything that ever did would be handed the
 * whole instance."*
 *
 * `no-matrix-means-refuse-everywhere.test.js` asserts all four guards alike rather than each by name, so a
 * fifth written tomorrow is the case it exists for.
 *
 * The space is the one the CALLER named. For a proxy that is the proxy's own id, which is where an operator
 * grants access to a proxy; narrowing to members happens inside the tools. Checking a member here would let
 * a proxy grant be bypassed by naming the member instead.
 */
/**
 * Does this token administer THE space this call names?
 *
 * The precise half of the `spaceAdmin` flag, and the MCP mirror of `requireAdminOrSpaceAdminMfaScoped`.
 * `toolIsVisible` already admitted anyone who administers *a* space, because `tools/list` is answered before
 * any space is named; this asks the question that actually matters once one is.
 *
 * Separate from `toolRightsRefusal` above because it answers a different question against a different input —
 * that one reads `TOOL_RIGHTS` for an area and a rung, this one asks whether all four areas are at `admin`.
 * Folding them together would mean one of the two callers passing a flag to say which half it wanted.
 *
 * Returns the refusal TEXT or `null`, same contract as its neighbour, and pure for the same reason: a guard
 * testable only through a transport is one whose test cannot tell live code from dead.
 */
export function spaceAdminRefusal(
  tool: { name?: string; spaceAdmin?: boolean } | undefined,
  rights: TokenRights | undefined,
  space: string,
): string | null {
  if (!tool?.spaceAdmin) return null;
  if (rights?.instanceAdmin === true) return null;
  if (space && isSpaceAdminFor(rights, space)) return null;
  /*
   * The refusal names the GRANT, because since 5.0 the four rungs are not it.
   *
   * It used to say *"the admin rung on all four areas"*, and that is now a way to spend an afternoon: a
   * caller reads it, sets four rungs, is refused again, and has been told to do the wrong thing by the
   * error explaining what they may not do.
   */
  return `Error: tool '${tool.name ?? 'unknown'}' configures a space, so it needs either instance-admin rights `
    + `or SPACE ADMIN on '${space}' — the \`spaceAdmin\` grant, which is its own right and is not the same `
    + 'as holding the admin rung on all four areas. Administering a different space does not grant this one.';
}

export function toolRightsRefusal(
  toolName: string,
  rights: TokenRights | undefined,
  space: string,
): string | null {
  /*
   * THE ROW IS LOOKED UP FIRST, and the order is the whole fix rather than a tidy-up.
   *
   * This opened `if (!rights || !space) return null` — absent matrix, so allow — which is the third copy of
   * the shape the owner ruled out on 2026-09-05: *"no matrix = refuse - no fallback no backwards
   * compatibility anymore"*. The other two, `tokenReachesSpace` and `editorScopeFor`, were swept then; this
   * one is on the MCP door and was not.
   *
   * Refusing on `!rights` BEFORE finding the row would have broken every instance-level tool instead — they
   * legitimately have no `TOOL_RIGHTS` row, because the capability is not scoped to a space at all, and
   * `list_spaces` refusing a matrixless caller here would be the same mistake pointing the other way. So the
   * absence of a row still means *not my question*; the absence of a MATRIX, for a tool that has one, is now
   * a refusal.
   *
   * `!space` joins it. An area-scoped tool with no space named cannot be checked against an area rung, and
   * *cannot be checked* is not *passes*.
   */
  const need = TOOL_RIGHTS.find(r => r.tool === toolName);
  if (!need) return null;

  if (!rights) {
    return `Error: tool '${toolName}' needs ${need.area}: ${need.needs} on space '${space}', and this `
      + 'connection presented no rights matrix. A token with no matrix reaches nothing.';
  }
  if (!space) {
    return `Error: tool '${toolName}' needs ${need.area}: ${need.needs} on a space, and this call named none.`;
  }

  const held = effectiveRung(rights, space, need.area);
  if (satisfies(held, need.needs)) return null;

  return `Error: tool '${toolName}' needs ${need.area}: ${need.needs} on space '${space}'; `
    + `this token holds ${need.area}: ${held}`;
}
