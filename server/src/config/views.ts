/**
 * Personal views: the store, the owner, what a view reads, and what ends one (Q-531, 6.0).
 *
 * ## What a view is
 *
 * A proxy used to be a space whose `proxyFor` listed members, shared by everyone who could reach it. It is now a PERSONAL VIEW:
 * a record in `config.views`, never in `config.spaces`, that belongs to ONE owner (the caller's stable principal, {@link viewOwnerOf}),
 * is seen, renamed and deleted by that owner only, ends with its owner, reads at call time per member what the caller can read in the
 * area the door asks about (unreadable members drop out, the answer says which were read), and never writes. Its id is `@<name>`:
 * `@` is not a legal space-id character, so a view and a space cannot collide and no creation site needs a two-way check.
 *
 * ## What each export prevents
 *
 * - {@link viewReadMembers} is THE place the members a view reads are computed. Six functions used to narrow a member list by reach or
 *   rung, each a little different (one fell back to the whole list when nothing was reached; MCP checked the rung on the proxy id
 *   alone). It asks, per member, what a direct read of that member asks - reach, the area's rung, and the hold on a peer-bound token -
 *   so a view is never a way round any of them.
 * - {@link dropSpaceFromViews} and {@link renameSpaceInViews} are called wherever a space leaves config or changes its id, so a recreated
 *   id never silently rejoins a view that named its predecessor.
 * - {@link deleteViewsOf} is the one deletion of an owner's views, and counts what it deleted by reason.
 * - {@link sweepOwnerlessViews} deletes a view only after its owner has had no live token for {@link VIEW_OWNER_GRACE_MS}: a connector
 *   re-consents under the same client id after its token expires, and an immediate sweep would delete views the owner gets back
 *   minutes later.
 * - {@link ViewRefusal} carries a refusal's status and code to either door; every code the doors answer is spelled in
 *   {@link VIEW_REFUSALS}, so the client's sentence tables and a gate can derive the list.
 */
import { getConfig, mutateConfig } from './loader.js';
import type { Config, ViewRecord } from './types.js';
import type { Rung, SpaceArea, TokenRights } from './rights-shape.js';
import { holdsRung } from '../auth/reachable-spaces.js';
import { reachesSpace } from '../auth/space-reach.js';
import { withoutHeldFor } from '../sync/space-exchange-set.js';
import { viewsDeletedTotal } from '../metrics/registry.js';
import { log } from '../util/log.js';
import { VIEW_OWNER_KINDS, WILDCARD_MEMBER, liveOwnerKeys, viewOwnerKind, viewOwnerOf } from './view-shape.js';

export {
  VIEW_NAME_PATTERN, VIEW_NAME_MAX, MAX_VIEWS_PER_OWNER, MAX_VIEW_MEMBERS, WILDCARD_MEMBER, isViewId, isValidViewName, freeViewName,
  viewOwnerKind, validateViews, viewOwnerOf, liveOwnerKeys,
} from './view-shape.js';
export type { ViewOwnerSource } from './view-shape.js';

/** How long an owner may hold no live token before the sweep deletes its views (30 days). */
export const VIEW_OWNER_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Why views were deleted, the label of `ythril_views_deleted_total`. */
export type ViewDeletionReason = 'revoke' | 'sweep' | 'owner' | 'admin';

/** The caller's own views, in the order stored. */
export function viewsOfOwner(ownerKey: string | null, config: Config = getConfig()): ViewRecord[] {
  if (!ownerKey) return [];
  return (config.views ?? []).filter(v => v.ownerId === ownerKey);
}

/**
 * The owner's view with this id, or `null`. Another owner's view is `null` as well: a caller can never learn that a view exists
 * under someone else's name.
 */
export function resolveOwnView(ownerKey: string | null, id: string, config: Config = getConfig()): ViewRecord | null {
  if (!ownerKey) return null;
  return (config.views ?? []).find(v => v.ownerId === ownerKey && v.id === id) ?? null;
}

/** Every concrete space id the config holds: what a `'*'` member list stands for. */
const allSpaceIds = (config: Config): string[] => config.spaces.map(s => s.id);

/**
 * The spaces a view READS for this caller, in this area at this rung: the members the caller reads now, and nothing the caller could not
 * read by naming the member itself.
 *
 * **It asks per member what a direct read of that member asks** - the caller reaches it, holds `needs` on `area` there, and it is not held
 * for the peer a peer-bound token is bound to - and DROPS what fails; it never refuses the view for one member. A caller with no rights
 * matrix reads nothing. A member that is no longer a space is not read. The order is the view's, so two identical calls merge alike.
 * An empty answer is meaningful (the view reads nothing for this caller now) and is never read as "all".
 */
export function viewReadMembers(input: {
  rights: TokenRights | undefined;
  view: Pick<ViewRecord, 'members'>;
  area: SpaceArea;
  needs: Rung;
  /** The peer a peer-bound token is bound to, or none. */
  peerId?: string | undefined;
  config?: Config;
}): string[] {
  const { rights, view, area, needs } = input;
  if (!rights) return [];
  const config = input.config ?? getConfig();
  const live = new Set(allSpaceIds(config));
  const listed = view.members.includes(WILDCARD_MEMBER) ? allSpaceIds(config) : view.members.filter(id => live.has(id));
  const read = [...new Set(listed)].filter(id => reachesSpace(rights, id) && holdsRung(rights, id, area, needs));
  return withoutHeldFor(read, input.peerId);
}

// ── What ends or edits a view ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Delete every view an owner holds, inside the caller's config write (the caller saves once). Counts what it deleted under `reason`.
 * @returns how many views were deleted.
 */
export function deleteViewsOf(config: Config, ownerKey: string, reason: ViewDeletionReason): number {
  const before = config.views?.length ?? 0;
  if (!before) return 0;
  config.views = (config.views ?? []).filter(v => v.ownerId !== ownerKey);
  const deleted = before - config.views.length;
  if (deleted > 0) {
    viewsDeletedTotal.inc({ reason }, deleted);
    log.info(`Deleted ${deleted} personal view(s) of one owner (${reason})`);
  }
  return deleted;
}

/**
 * Delete ONE view of an owner inside the caller's config write.
 * @returns whether it existed.
 */
export function deleteView(config: Config, ownerKey: string, id: string, reason: ViewDeletionReason): boolean {
  const before = config.views?.length ?? 0;
  config.views = (config.views ?? []).filter(v => !(v.ownerId === ownerKey && v.id === id));
  const deleted = before - config.views.length;
  if (deleted > 0) viewsDeletedTotal.inc({ reason }, deleted);
  return deleted > 0;
}

/** Remember when the last token of an owner went without its views being deleted (a cap eviction), so the sweep's grace counts from there. */
export function noteViewOwnerLeft(config: Config, ownerKey: string, atIso: string): void {
  for (const v of config.views ?? []) if (v.ownerId === ownerKey && !v.ownerLeftAt) v.ownerLeftAt = atIso;
}

/**
 * Take a space out of every view's member list, inside the caller's config write. Called at EVERY site a space leaves config, so a
 * recreated id never silently rejoins a view that named the earlier space.
 */
export function dropSpaceFromViews(config: Config, spaceId: string): void {
  for (const v of config.views ?? []) {
    if (v.members.includes(spaceId)) v.members = v.members.filter(m => m !== spaceId);
  }
}

/** Rewrite a renamed space in every view's member list, inside the caller's config write. */
export function renameSpaceInViews(config: Config, fromId: string, toId: string): void {
  for (const v of config.views ?? []) {
    if (v.members.includes(fromId)) v.members = [...new Set(v.members.map(m => (m === fromId ? toId : m)))];
  }
}

/** The views as they are now, copied: what a reload compares the reloaded file against (`restoreViewsMissingAfterReload`). */
export function snapshotViews(config: Config = getConfig()): ViewRecord[] {
  return structuredClone(config.views ?? []);
}

/**
 * Put back the views a reloaded file no longer lists, inside the caller's config write: a view is personal data of its owner, and a file
 * edit, a restored older config or a second replica must not delete it without a word (the S-10 guard, which keeps spaces the same way).
 * @returns how many it put back, for the line the caller says.
 */
export function restoreViewsMissingAfterReload(before: readonly ViewRecord[], config: Config): number {
  const present = new Set((config.views ?? []).map(v => `${v.ownerId}\u0000${v.id}`));
  const missing = before.filter(v => !present.has(`${v.ownerId}\u0000${v.id}`));
  if (missing.length > 0) config.views = [...(config.views ?? []), ...missing];
  return missing.length;
}

/** What the sweep would do to a config, as data: the views to delete and the stale marks to clear. Pure. */
function sweepPlan(config: Config, now: number): { remove: ViewRecord[]; clear: ViewRecord[] } {
  const tokens = config.tokens ?? [];
  const liveOwners = liveOwnerKeys(tokens, now);
  const lastLive = new Map<string, number>();
  for (const t of tokens) {
    const owner = viewOwnerOf(t);
    if (!owner || liveOwners.has(owner) || !t.expiresAt) continue;
    lastLive.set(owner, Math.max(lastLive.get(owner) ?? -Infinity, Date.parse(t.expiresAt)));
  }
  const remove: ViewRecord[] = [];
  const clear: ViewRecord[] = [];
  for (const v of config.views ?? []) {
    // An OIDC owner has no stored token to judge by: its views live until it deletes them (stated in the docs).
    if (viewOwnerKind(v.ownerId) === 'oidc') continue;
    if (liveOwners.has(v.ownerId)) { if (v.ownerLeftAt) clear.push(v); continue; }
    const marks = [lastLive.get(v.ownerId) ?? -Infinity, v.ownerLeftAt ? Date.parse(v.ownerLeftAt) : -Infinity].filter(Number.isFinite);
    const since = marks.length ? Math.max(...marks) : Date.parse(v.createdAt);
    if (now - since > VIEW_OWNER_GRACE_MS) remove.push(v);
  }
  return { remove, clear };
}

/**
 * Delete the views whose owner has had no live token for {@link VIEW_OWNER_GRACE_MS}, and forget the mark of an owner that came back.
 * One pass, one config write, and none when there is nothing to do. @returns how many views it deleted.
 */
export async function sweepOwnerlessViews(opts: { now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const first = sweepPlan(getConfig(), now);
  if (first.remove.length === 0 && first.clear.length === 0) return 0;
  let deleted = 0;
  mutateConfig(cfg => {
    const plan = sweepPlan(cfg, now);
    for (const v of plan.clear) delete v.ownerLeftAt;
    const gone = new Set(plan.remove);
    if (gone.size > 0) {
      cfg.views = (cfg.views ?? []).filter(v => !gone.has(v));
      deleted = gone.size;
      viewsDeletedTotal.inc({ reason: 'sweep' }, deleted);
      log.info(`Deleted ${deleted} personal view(s) whose owner had no live token for ${Math.round(VIEW_OWNER_GRACE_MS / 86_400_000)} days`);
    }
  });
  return deleted;
}

// ── Refusals ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every refusal the views doors answer, with its status and its code. The client has one sentence per code in each language
 * (`views.refusal.<code>`), so a code spelled anywhere else is a refusal that reaches a user as a raw code.
 */
export const VIEW_REFUSALS = Object.freeze({
  nameInvalid: { status: 400, code: 'view_name_invalid' },
  nameTaken: { status: 409, code: 'view_name_taken' },
  membersMissing: { status: 400, code: 'view_members_empty' },
  memberUnknown: { status: 404, code: 'view_member_unknown' },
  memberIsView: { status: 400, code: 'view_member_is_view' },
  tooManyViews: { status: 409, code: 'view_limit_reached' },
  tooManyMembers: { status: 400, code: 'view_members_limit' },
  peerBound: { status: 403, code: 'view_peer_bound' },
  noOwner: { status: 403, code: 'view_owner_unknown' },
  notFound: { status: 404, code: 'view_not_found' },
  nothingToChange: { status: 400, code: 'view_nothing_to_change' },
  copyNotManager: { status: 403, code: 'view_copy_forbidden' },
  copyReceiverUnknown: { status: 403, code: 'view_copy_forbidden' },
  copyNothingReadable: { status: 400, code: 'view_copy_nothing_readable' },
  copyNeedsMfa: { status: 403, code: 'view_copy_needs_mfa' },
  unclaimedUnknown: { status: 404, code: 'view_claim_unknown' },
  retiredUnknown: { status: 404, code: 'retired_id_unknown' },
  purgeConfirmOidc: { status: 409, code: 'retired_purge_unconfirmed' },
} as const);

export type ViewRefusalKind = keyof typeof VIEW_REFUSALS;

/** A refusal of a views act: thrown by the shared acts, answered with its status by REST and as an error result by MCP. */
export class ViewRefusal extends Error {
  override readonly name = 'ViewRefusal';
  readonly status: number;
  readonly code: string;
  constructor(kind: ViewRefusalKind, message: string, readonly params: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.status = VIEW_REFUSALS[kind].status;
    this.code = VIEW_REFUSALS[kind].code;
  }
  /** The body both doors carry: the sentence, the code, and the list a sentence may name (`members`). */
  get body(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.params };
  }
}

/** The owner-key kinds, for the orphan listing and its gates. */
export const OWNER_KINDS = VIEW_OWNER_KINDS;
