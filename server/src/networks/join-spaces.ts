/**
 * Which local space each space of a joined network lands on — decided ONCE, before anything is written (`Q-133`).
 *
 * ## The defect this closes
 *
 * A rename keeps the old id as the space's NETWORK id. The inviter's answer listed its LOCAL names, so a joiner created
 * `y-project-template` with no alias — and every exchange after the join named the space `y-twin`, which the joiner
 * then adopted as a second, empty space (owner, 2026-09-28: *"y-project-template arrives still as y-twin on
 * new-joiners"*). The answer now carries `networkSpaces` beside `spaces`, index-aligned, and this function turns the
 * pair into `{ networkId, localId }` per space: the network's id, and what this instance will call it.
 *
 * ## Why one function
 *
 * The rights check (`networkJoinRefusal`, F-34.1) and the loop that creates the spaces used to compute the local ids
 * separately. Two computations of one mapping are how a join checks one set of spaces and creates another. Both read
 * `entries` from here.
 *
 * ## The refusals, all before any space, token or finalize exists
 *
 * - `join_mapping_collision` — a requested key that is one space's shown name AND another's network id (renames
 *   x->y then z->x make both true of `x`), or two spaces landing on one local space. Resolved by guessing, one of them
 *   would sync into a space it was never meant for.
 * - `network_id_aliased` — on a network this instance already carries, a network id already reaching a different
 *   local space, or a local space already answering to another network id. Joining again must not re-point either.
 *
 * `networkSpaces` is trusted only when it is exactly as long as `spaces`, every entry is a space id and none repeats;
 * otherwise it is ignored, and the shown name is taken as the network id — which is what an older inviter meant.
 */
import type { NetworkConfig } from '../config/types.js';
import { isSpaceId, reverseSpaceMap } from '../sync/space-map.js';
import type { NetworkRefusalCode } from './refusal-codes.js';

export interface JoinSpaceEntry { networkId: string; localId: string }

export type JoinSpaces =
  | { ok: true; entries: JoinSpaceEntry[]; networkIdsTrusted: boolean }
  | { ok: false; code: Extract<NetworkRefusalCode, 'join_mapping_collision' | 'network_id_aliased' | 'invalid_answer'>; error: string };

/** The inviter's answer as it bears on spaces: what it calls each space here, and what the network calls it. */
export interface JoinAnswerSpaces { spaces?: unknown; networkSpaces?: unknown }

function trustedNetworkSpaces(spaces: string[], networkSpaces: unknown): string[] | null {
  if (!Array.isArray(networkSpaces) || networkSpaces.length !== spaces.length) return null;
  if (!networkSpaces.every(isSpaceId)) return null;
  return new Set(networkSpaces).size === networkSpaces.length ? networkSpaces as string[] : null;
}

export function resolveJoinSpaces(
  answer: JoinAnswerSpaces,
  requested: Record<string, string> | undefined,
  existing: Pick<NetworkConfig, 'spaces' | 'spaceMap'> | undefined,
  _localSpaceIds: readonly string[],
): JoinSpaces {
  const shown = Array.isArray(answer.spaces) ? answer.spaces : [];
  if (!shown.every(isSpaceId)) {
    return { ok: false, code: 'invalid_answer', error: 'The inviting instance named a space with an id no space can have; the join was refused.' };
  }
  const networkIds = trustedNetworkSpaces(shown, answer.networkSpaces);
  const entries: JoinSpaceEntry[] = shown.map((s, i) => ({ networkId: networkIds?.[i] ?? s, localId: s }));

  for (const [key, local] of Object.entries(requested ?? {})) {
    const byShown = shown.indexOf(key);
    const byNetwork = entries.findIndex(e => e.networkId === key);
    if (byShown !== -1 && byNetwork !== -1 && byShown !== byNetwork) {
      return {
        ok: false, code: 'join_mapping_collision',
        error: `'${key}' is the name of one space in this network and what the network calls another, so the mapping `
          + `'${key}' -> '${local}' could mean either. Map each space by the name the invite shows for it.`,
      };
    }
    const at = byShown !== -1 ? byShown : byNetwork;
    if (at !== -1) entries[at] = { networkId: entries[at]!.networkId, localId: local };
  }

  const seen = new Map<string, string>();
  for (const e of entries) {
    const other = seen.get(e.localId);
    if (other !== undefined) {
      return {
        ok: false, code: 'join_mapping_collision',
        error: `Two of the network's spaces ('${other}' and '${e.networkId}') would land on the one local space '${e.localId}'. Map them to different spaces.`,
      };
    }
    seen.set(e.localId, e.networkId);
  }

  if (existing) {
    const reverse = reverseSpaceMap(existing);
    for (const e of entries) {
      const reaches = existing.spaceMap?.[e.networkId];
      const answersTo = reverse.get(e.localId) ?? (existing.spaces.includes(e.localId) ? e.localId : undefined);
      if ((reaches !== undefined && reaches !== e.localId) || (answersTo !== undefined && answersTo !== e.networkId)) {
        return {
          ok: false, code: 'network_id_aliased',
          error: `This instance already carries the network's space '${e.networkId}' as '${reaches ?? e.networkId}', `
            + `or already syncs '${e.localId}' as another of its spaces; joining again would re-point it. Map it to the space it already uses.`,
        };
      }
    }
  }
  return { ok: true, entries, networkIdsTrusted: networkIds !== null };
}
