/**
 * What a door answers for a space id it cannot serve: the one existence rule, and the two ids that are not spaces (Q-531).
 *
 * ## The rule
 *
 * A space id names one of four things: a space (served), a RETIRED proxy id, the caller's own personal view, or nothing - and another
 * token's view is nothing. The answers:
 *
 * - **a retired id** (a pre-6.0 proxy the upgrade reserved) answers `410 Gone`, code `space_retired`, one sentence, to EVERY caller. The
 *   id was public before (anyone who could list spaces saw it) and it is not a view, so no privacy rule applies.
 * - **the caller's own view, on a door that does not take one** (every write, every config read) answers the plain "not found" and, to
 *   the OWNER only, a hint that it is a view and which way to write. Another token's view and an id that never existed answer the same
 *   words, so the answer is no oracle for who owns what.
 * - **an unknown id** answers `404 Space '<id>' not found`.
 *
 * ## Why one function
 *
 * Twenty-nine REST sites wrote `cfg.spaces.some(...)` and answered 404 in their own words, the MCP dispatcher, the tool write gate and the
 * body-scoped guard wrote it again, and five record-DELETE routes had no check at all - so a door that forgot it answered for a view id as
 * for a space and a member loop walked the view's members. `spaceCollection` additionally refuses an `@` id, so a door that still forgets
 * REFUSES instead of answering 500 with a made-up collection name.
 */
import type { Config } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { isViewId, resolveOwnView, viewOwnerOf, type ViewOwnerSource } from '../config/views.js';
import { NAME_QUOTED, peerText } from '../util/log.js';

/** A space id a pre-6.0 proxy reserved, named for a creation: the id is not free until an instance admin purges what it still holds. */
export class ReservedSpaceIdError extends Error {
  override readonly name = 'ReservedSpaceIdError';
}

/**
 * Refuse a creation under a retired proxy id: the ONE check every site that brings a space id into config makes (create, rename, join, an
 * adopted network space, a hand-edited added space). A reservation exists because rows synced or imported under the old id may still sit in
 * their collections, and a new space under it would meet them. A live space wins over a reservation (`isRetiredSpaceId`), so this never
 * refuses an id a space already holds.
 * @throws ReservedSpaceIdError
 */
export function assertNotRetiredSpaceId(id: string, config: Reservations = getConfig()): void {
  const refusal = retiredSpaceIdRefusal(id, config);
  if (refusal) throw new ReservedSpaceIdError(refusal);
}

/**
 * Why a creation under `id` is refused, or `null`: {@link assertNotRetiredSpaceId} for a site that RECORDS the reason instead of throwing
 * it (an announced network space waits in `pending` with it).
 */
export function retiredSpaceIdRefusal(id: string, config: Reservations = getConfig()): string | null {
  return isRetiredSpaceId(id, config)
    ? `'${peerText(id, { max: NAME_QUOTED })}' is reserved: it was a shared proxy and is now personal views, and an instance admin must purge what it still holds before the id is used again`
    : null;
}

/** A refusal as a door sends it: its status and its body. */
export interface SpaceAnswer {
  status: 404 | 410;
  body: { error: string; code?: string };
}

/** The half of a config the retired-id rule reads: the reservations and the live spaces (a pure caller may hand just these). */
export interface Reservations {
  spaces: readonly { id: string }[];
  retiredSpaceIds?: readonly string[] | undefined;
}

/** Whether `id` is a retired proxy id: reserved, and not a live space (a live space wins over a reservation). */
export function isRetiredSpaceId(id: string, config: Reservations = getConfig()): boolean {
  return (config.retiredSpaceIds ?? []).includes(id) && !config.spaces.some(s => s.id === id);
}

/** The first retired proxy id a call's `space` argument names (one name or a list), or `null`: asked before anything else about the call. */
export function retiredIdNamedIn(space: unknown, config: Config = getConfig()): string | null {
  const names = typeof space === 'string' ? [space] : Array.isArray(space) ? space : [];
  for (const raw of names) {
    if (typeof raw === 'string' && isRetiredSpaceId(raw.trim(), config)) return raw.trim();
  }
  return null;
}

/** The one sentence a retired id is answered with. */
export const retiredSpaceSentence = (id: string): string =>
  `'${peerText(id, { max: NAME_QUOTED })}' was a shared proxy and is now personal views; ask the instance admin`;

/** `Space '<id>' not found`, the words every door uses, the id rendered as caller text. */
export const unknownSpaceSentence = (id: string): string => `Space '${peerText(id, { max: NAME_QUOTED })}' not found`;

/** What the owner of a view is told when it addresses a door that takes a space and not a view. */
export const viewIsNotASpaceHint = (id: string): string => `'${peerText(id, { max: NAME_QUOTED })}' is a view; write to one of its member spaces`;

/**
 * The answer for `id`, or `null` when the id is served: a configured space, or a view the door has already accepted for this caller.
 * `ownerKey` is the caller's {@link viewOwnerOf}; `acceptedView` says the door resolved `id` as the caller's own view for a read.
 */
export function unknownSpaceAnswer(ownerKey: string | null, id: string, acceptedView = false, config: Config = getConfig()): SpaceAnswer | null {
  if (config.spaces.some(s => s.id === id)) return null;
  if (acceptedView) return null;
  if (isRetiredSpaceId(id, config)) return { status: 410, body: { error: retiredSpaceSentence(id), code: 'space_retired' } };
  const hint = isViewId(id) && resolveOwnView(ownerKey, id, config) ? `. ${viewIsNotASpaceHint(id)}` : '';
  return { status: 404, body: { error: `${unknownSpaceSentence(id)}${hint}` } };
}

/** The request half {@link answerUnknownSpace} reads: who is asking, and the view a door accepted for this request. */
export interface SpaceAsker {
  authToken?: unknown;
  viewRead?: { id: string } | undefined;
}

/**
 * The answer a REST route sends for `id`, or `null` when the id is served: the one existence check every route that names a space makes
 * before it does anything else (before the body is judged, before a member loop). A route sends it as
 * `res.status(a.status).json(a.body)`.
 */
export function answerUnknownSpace(req: SpaceAsker, id: string): SpaceAnswer | null {
  return unknownSpaceAnswer(askerOwnerKey(req.authToken), id, req.viewRead?.id === id);
}

/**
 * The answer for a space a door has already found missing: {@link unknownSpaceAnswer}, and the plain `404` sentence when the id is back by the
 * time it is asked (a config reload between the door's read and this one). For the site that looked the space up itself, or lost it between
 * a plan and its write: it never answers `null`, so a door cannot fall through on a space it did not find, and it never spells the words
 * itself, so a retired id still answers 410 and the owner of a view still gets the hint.
 */
export function lostSpaceAnswer(ownerKey: string | null, id: string, config: Config = getConfig()): SpaceAnswer {
  return unknownSpaceAnswer(ownerKey, id, false, config) ?? { status: 404, body: { error: unknownSpaceSentence(id) } };
}

/** {@link lostSpaceAnswer} for a REST route: the answer for a space the route has already found missing. */
export function answerLostSpace(req: SpaceAsker, id: string): SpaceAnswer {
  return lostSpaceAnswer(askerOwnerKey(req.authToken), id);
}

/** The view-owner key of a caller an act was handed (a token record, an OIDC record, or none), for {@link unknownSpaceAnswer}. */
export function askerOwnerKey(caller: unknown): string | null {
  return caller ? viewOwnerOf(caller as ViewOwnerSource) : null;
}
