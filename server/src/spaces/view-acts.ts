/**
 * What a personal view's owner (and the instance admin's three doors) can DO, once, for REST and MCP (Q-531).
 *
 * ## Why one module
 *
 * `POST /api/views` and `view_create` (and update, delete, copy, list, claim, orphans, purge) are one capability on two doors. Every rule
 * below - the name, the two caps, "a member you cannot read is answered as a missing one", "a peer-bound token cannot own a view", "a
 * copy keeps only what the RECEIVER reads" - is stated here and refused here, as a {@link ViewRefusal} both doors answer. A door that
 * stated a rule itself would be the weaker implementation the repo keeps producing.
 *
 * ## What each act refuses that a hand-written copy forgets
 *
 * - **A member the caller cannot read is answered exactly as a member that does not exist** (same status, same words), so the refusal is no
 *   oracle for which spaces exist.
 * - **Every check runs inside the config write** (`mutateConfig` re-reads first), so two creates cannot both pass the per-owner cap.
 * - **Another token's view is `view_not_found`**, whichever act asks: an owner is the only one who can name its views.
 * - **A copy is idempotent by (receiver, source view)**: a retry refreshes the earlier copy instead of making `-2`.
 */
import type { Config, TokenRecord, ViewRecord } from '../config/types.js';
import type { TokenRights } from '../config/rights-shape.js';
import { getConfig, mutateConfig } from '../config/loader.js';
import {
  MAX_VIEWS_PER_OWNER, MAX_VIEW_MEMBERS, VIEW_NAME_MAX, VIEW_NAME_PATTERN, WILDCARD_MEMBER, ViewRefusal,
  copySourceKey, deleteView, freeViewName, isValidViewName, isViewId, memberAdmissible, renameView, viewIdOf, resolveOwnView, viewOwnerKind, viewOwnerOf, viewReadMembers, viewsOfOwner,
  type ViewOwnerSource,
} from '../config/views.js';
import { peerBoundTo } from '../auth/peer-bound.js';
import { mayManageToken, mayManageTokens } from '../auth/editor-scope.js';
import { logAuditEntry } from '../audit/audit.js';
import { VIEW_OPERATIONS } from '../audit/middleware.js';
import { unknownSpaceSentence } from './unknown-space.js';
import { dropSpaceData } from './lifecycle.js';
import { NAME_QUOTED, peerText } from '../util/log.js';
import { z } from 'zod';

/**
 * The bounds a view's `members` are held to, on every door: both doors' acts parse with these (a create must send members, an update
 * may leave them out), and the tools state the same numbers (`view_create`, `view_update`), which `a-tool-and-its-route-agree-on-bounds`
 * compares. The count is of the list as SENT, as the tool's `maxItems` counts it, so one list is refused or accepted alike whichever
 * door it came through. Which refusal a list outside them gets is `checkedMembers`'s.
 */
export const ViewCreateInput = z.object({ members: z.array(z.string()).min(1).max(MAX_VIEW_MEMBERS) });
export const ViewUpdateInput = ViewCreateInput.partial();

/** Who is acting: the record that identifies them, and the rights the call is judged by. */
export interface ViewActor {
  record: ViewOwnerSource & { peerInstanceId?: unknown; rights?: TokenRights | null; id: string };
  rights: TokenRights | undefined;
}

/** A view as a door answers it: never the owner key, and which members the caller reads NOW. */
export interface ViewAnswer {
  id: string;
  name: string;
  members: string[];
  readable: string[];
  createdAt: string;
  migratedFrom?: string;
}

/** Whether the holder of `rights` (bound to `peerId`, or none) may have `spaceId` listed in a view: the one admission rule, `memberAdmissible`. */
const admissibleFor = (rights: TokenRights | null | undefined, peerId: string | undefined, config: Config) =>
  (spaceId: string): boolean => memberAdmissible({ rights: rights ?? undefined, spaceId, peerId, config });

const ownerOrRefuse = (actor: ViewActor): string => {
  const owner = viewOwnerOf(actor.record);
  if (!owner) throw new ViewRefusal('noOwner', 'This token carries no subject identifier, so it cannot own a personal view');
  return owner;
};

/** How a view reads to its owner right now: the members it lists and, of those, the ones read in the knowledge area. */
export function viewAnswer(actor: ViewActor, view: ViewRecord, config: Config = getConfig()): ViewAnswer {
  const readable = viewReadMembers({ rights: actor.rights, view, area: 'knowledge', needs: 'read', peerId: peerBoundTo(actor.record), config });
  return {
    id: view.id, name: view.name, members: [...view.members], readable, createdAt: view.createdAt,
    ...(view.migratedFrom ? { migratedFrom: view.migratedFrom } : {}),
  };
}

const notFound = (id: string): ViewRefusal => new ViewRefusal('notFound', `View '${peerText(id, { max: NAME_QUOTED })}' not found`);

/**
 * The members of a new or changed view, checked against what the CALLER may read: a list of distinct space ids, or `['*']`.
 * @throws ViewRefusal for an empty list, a view, an over-long list, a space that does not exist or that the caller cannot read.
 */
function checkedMembers(raw: unknown, withinBounds: boolean, readable: (id: string) => boolean): string[] {
  if (!withinBounds || !Array.isArray(raw)) {
    // Over the cap is its own refusal (it says the cap); anything else that is not a non-empty list of strings is a missing list.
    if (Array.isArray(raw) && raw.length > MAX_VIEW_MEMBERS) {
      throw new ViewRefusal('tooManyMembers', `A personal view may list at most ${MAX_VIEW_MEMBERS.toLocaleString('en-US').replace(',', ' ')} members; this one lists ${raw.length}. Use ["*"] for every space you can read`, { limit: MAX_VIEW_MEMBERS });
    }
    throw new ViewRefusal('membersMissing', 'A personal view needs `members`: a list of space ids, or ["*"] for every space you can read');
  }
  const members = [...new Set((raw as string[]).map(m => m.trim()))];
  if (members.some(m => m.length === 0)) throw new ViewRefusal('membersMissing', 'A personal view needs `members`: a list of space ids, or ["*"] for every space you can read');
  if (members.includes(WILDCARD_MEMBER)) return [WILDCARD_MEMBER];
  for (const m of members) {
    if (isViewId(m)) {
      throw new ViewRefusal('memberIsView', `'${peerText(m, { max: NAME_QUOTED })}' is a view; a personal view lists spaces only`, { members: [m] });
    }
    // `readable` is the admission rule, which a space that does not exist fails as well: one refusal, so it is no oracle for which exist.
    if (!readable(m)) {
      throw new ViewRefusal('memberUnknown', unknownSpaceSentence(m), { members: [m] });
    }
  }
  return members;
}

const checkedName = (raw: unknown): string => {
  if (!isValidViewName(raw)) {
    throw new ViewRefusal('nameInvalid', `A view name is 1 to ${VIEW_NAME_MAX} characters from ${VIEW_NAME_PATTERN.source} (lower-case letters, digits and hyphens); the view's id is "@" and its name`);
  }
  return raw;
};

const tooManyViews = (): ViewRefusal =>
  new ViewRefusal('tooManyViews', `This token already has ${MAX_VIEWS_PER_OWNER} personal views, the most one owner may hold; delete one first`, { limit: MAX_VIEWS_PER_OWNER });

/** Create the caller's own view. @throws ViewRefusal */
export function createView(actor: ViewActor, input: { name: unknown; members: unknown }): { view: ViewAnswer; ownerKey: string; memberCount: number } {
  const owner = ownerOrRefuse(actor);
  if (peerBoundTo(actor.record)) throw new ViewRefusal('peerBound', 'A token bound to a peer instance cannot own a personal view');
  const name = checkedName(input.name);
  let made!: ViewRecord;
  mutateConfig(cfg => {
    const mine = viewsOfOwner(owner, cfg);
    const members = checkedMembers(input.members, ViewCreateInput.safeParse({ members: input.members }).success, admissibleFor(actor.rights, peerBoundTo(actor.record), cfg));
    if (mine.some(v => v.name === name)) throw new ViewRefusal('nameTaken', `You already have a view named '${name}'`);
    if (mine.length >= MAX_VIEWS_PER_OWNER) throw tooManyViews();
    made = { id: viewIdOf(name), name, ownerId: owner, members, createdAt: new Date().toISOString() };
    cfg.views = [...(cfg.views ?? []), made];
  });
  return { view: viewAnswer(actor, made), ownerKey: owner, memberCount: made.members.length };
}

/** Rename and/or re-member the caller's own view; only what was sent is validated. @throws ViewRefusal */
export function updateView(actor: ViewActor, id: string, input: { name?: unknown; members?: unknown }): { view: ViewAnswer; ownerKey: string; memberCount: number } {
  const owner = ownerOrRefuse(actor);
  if (input.name === undefined && input.members === undefined) throw new ViewRefusal('nothingToChange', 'Send `name`, `members`, or both');
  let updated!: ViewRecord;
  mutateConfig(cfg => {
    const view = resolveOwnView(owner, id, cfg);
    if (!view) throw notFound(id);
    if (input.name !== undefined && input.name !== view.name) {
      const name = checkedName(input.name);
      if (viewsOfOwner(owner, cfg).some(v => v.name === name)) throw new ViewRefusal('nameTaken', `You already have a view named '${name}'`);
      renameView(cfg, view, name);
    }
    if (input.members !== undefined) {
      view.members = checkedMembers(input.members, ViewUpdateInput.safeParse({ members: input.members }).success, admissibleFor(actor.rights, peerBoundTo(actor.record), cfg));
    }
    updated = view;
  });
  return { view: viewAnswer(actor, updated), ownerKey: owner, memberCount: updated.members.length };
}

/** Delete the caller's own view. @throws ViewRefusal when it has none by that id */
export function deleteOwnView(actor: ViewActor, id: string): { ownerKey: string; memberCount: number } {
  const owner = ownerOrRefuse(actor);
  let memberCount = 0;
  mutateConfig(cfg => {
    const view = resolveOwnView(owner, id, cfg);
    if (!view) throw notFound(id);
    memberCount = view.members.length;
    deleteView(cfg, owner, id, 'owner');
  });
  return { ownerKey: owner, memberCount };
}

/** The caller's own views, each with the members it reads now. */
export function listOwnViews(actor: ViewActor): ViewAnswer[] {
  const owner = viewOwnerOf(actor.record);
  return viewsOfOwner(owner).map(v => viewAnswer(actor, v));
}

/** One of the caller's own views. @throws ViewRefusal when it has none by that id */
export function getOwnView(actor: ViewActor, id: string): ViewAnswer {
  const view = resolveOwnView(viewOwnerOf(actor.record), id);
  if (!view) throw notFound(id);
  return viewAnswer(actor, view);
}

/**
 * The view a copy is made FROM: the caller's own, else one belonging to a token the caller may MANAGE (`mayManageToken`, the guard the token
 * routes use) - how a token manager gives a receiver a view whose owner it manages, and the only way a view outlives a connector that
 * re-registered as a new owner. Never another token's view the caller may not manage: that is `view_not_found`, as for an id that never
 * existed. Two managed owners with a view of one name are told apart by `fromTokenId`.
 */
function copySourceFor(actor: ViewActor, owner: string, id: string, fromTokenId: unknown, config: Config): ViewRecord {
  const own = resolveOwnView(owner, id, config);
  if (own && fromTokenId === undefined) return own;
  const managed = (config.views ?? []).filter(v => {
    if (v.id !== id || v.ownerId === owner) return false;
    const holders = config.tokens.filter(t => viewOwnerOf(t) === v.ownerId);
    if (holders.length === 0 || !holders.some(t => mayManageToken(actor.record, t))) return false;
    return typeof fromTokenId !== 'string' || holders.some(t => t.id === fromTokenId);
  });
  if (managed.length === 1) return managed[0] as ViewRecord;
  if (managed.length > 1) throw new ViewRefusal('notFound', `More than one token you manage has a view '${peerText(id, { max: NAME_QUOTED })}'; name the owner with \`fromTokenId\``);
  throw notFound(id);
}

const copyNotManager = (): ViewRefusal => new ViewRefusal('copyNotManager', 'You may give a view only to a token you may manage');

/**
 * The copy's first question, asked by each door before its own second factor and again by {@link copyViewTo}: a caller who may manage no
 * token at all is refused as `view_copy_forbidden`, the answer a copy to a token it may not manage gets. REST's step-up guard would
 * otherwise answer it first with its generic admin refusal while MCP answered the code, so one act had two answers by door.
 * @throws ViewRefusal
 */
export function refuseCopyByNonManager(record: ViewActor['record'] | undefined): void {
  if (!mayManageTokens(record)) throw copyNotManager();
}

/**
 * Give another token a COPY of a view, owned by the receiver (owner ruling 0050bb1e: a view belongs to exactly one owner, and there is no
 * sharing state). Only a caller who may MANAGE the receiver may (`mayManageToken`), and it is refused as one answer whether the receiver is
 * unknown or not manageable, so the refusal is no oracle for which tokens exist. The copy keeps only the members the RECEIVER reads, and
 * none left refuses it. Idempotent by (receiver, source view). The second factor is the door's (REST: the route's step-up; MCP: it answers the
 * web-UI sentence). The row it audits names the SOURCE view's owner.
 * @throws ViewRefusal
 */
export function copyViewTo(actor: ViewActor, id: string, toTokenId: unknown, fromTokenId?: unknown): { view: ViewAnswer; created: boolean; ownerKey: string; memberCount: number } {
  const owner = ownerOrRefuse(actor);
  refuseCopyByNonManager(actor.record);
  const receiver = typeof toTokenId === 'string' ? getConfig().tokens.find(t => t.id === toTokenId) : undefined;
  if (!receiver || !mayManageToken(actor.record, receiver)) throw copyNotManager();
  const source = copySourceFor(actor, owner, id, fromTokenId, getConfig());
  const receiverOwner = viewOwnerOf(receiver);
  if (!receiverOwner) throw new ViewRefusal('noOwner', 'That token cannot own a personal view');
  if (peerBoundTo(receiver)) throw new ViewRefusal('peerBound', 'A token bound to a peer instance cannot own a personal view');
  const key = copySourceKey(source);
  let result!: { view: ViewRecord; created: boolean };
  mutateConfig(cfg => {
    const from = (cfg.views ?? []).find(v => v.ownerId === source.ownerId && v.id === source.id);
    if (!from) throw notFound(id);
    const held = cfg.tokens.find(t => t.id === toTokenId) as TokenRecord | undefined;
    const admissible = admissibleFor(held?.rights, held ? peerBoundTo(held) : undefined, cfg);
    // A wildcard is judged by what it stands for (every space), so a receiver that reads none of them is refused as for a listed one.
    const wildcard = from.members.includes(WILDCARD_MEMBER);
    const kept = wildcard
      ? (cfg.spaces.some(s => admissible(s.id)) ? [WILDCARD_MEMBER] : [])
      : from.members.filter(admissible);
    if (kept.length === 0) {
      throw new ViewRefusal('copyNothingReadable', 'That token reads none of the spaces this view lists, so a copy would read nothing');
    }
    const mine = viewsOfOwner(receiverOwner, cfg);
    const earlier = mine.find(v => v.copiedFrom === key);
    if (earlier) {
      earlier.members = kept;
      result = { view: earlier, created: false };
      return;
    }
    if (mine.length >= MAX_VIEWS_PER_OWNER) throw tooManyViews();
    const name = freeViewName(from.name, new Set(mine.map(v => v.name)));
    const copy: ViewRecord = { id: viewIdOf(name), name, ownerId: receiverOwner, members: kept, createdAt: new Date().toISOString(), copiedFrom: key };
    cfg.views = [...(cfg.views ?? []), copy];
    result = { view: copy, created: true };
  });
  // Answered as the RECEIVER's view (its id may carry a collision suffix); `readable` is empty: it is the receiver's to read.
  return { view: { id: result.view.id, name: result.view.name, members: [...result.view.members], readable: [], createdAt: result.view.createdAt }, created: result.created, ownerKey: source.ownerId, memberCount: source.members.length };
}

// ── The instance admin's three doors ───────────────────────────────────────────────────────────────────────────────

/**
 * How many views each owner kind holds whose owner holds no token, and no more: never a view name, never an owner key. An owner holds a
 * token while any record in `config.tokens` carries its key (an expired one still does: the grace sweep is what ends it).
 */
export function orphanViewCounts(config: Config = getConfig()): { ownerKind: string; count: number }[] {
  const held = new Set(config.tokens.map(t => viewOwnerOf(t)));
  const counts: Record<string, number> = {};
  for (const v of config.views ?? []) {
    const kind = viewOwnerKind(v.ownerId);
    if (kind === 'oidc' || held.has(v.ownerId) || !kind) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return Object.entries(counts).map(([ownerKind, count]) => ({ ownerKind, count }));
}

/** The orphan answer both doors give: the counts per owner kind, and the unclaimed definitions (a name and its members each, never an owner). */
export function orphanAnswer(config: Config = getConfig()): { orphans: { ownerKind: string; count: number }[]; unclaimed: { name: string; members: string[] }[] } {
  return {
    orphans: orphanViewCounts(config),
    unclaimed: (config.unclaimedViews ?? []).map(u => ({ name: u.name, members: [...u.members] })),
  };
}

/**
 * Copy an unclaimed (migrated, ownerless) view definition to the calling instance admin, owned by the caller, with the definition's members.
 * The definition is consumed: another admin takes a copy of the claimed view through `copyViewTo`.
 * @throws ViewRefusal
 */
export function claimUnclaimedView(actor: ViewActor, name: unknown): { view: ViewAnswer; ownerKey: string; memberCount: number } {
  const owner = ownerOrRefuse(actor);
  let made!: ViewRecord;
  mutateConfig(cfg => {
    const def = (cfg.unclaimedViews ?? []).find(u => u.name === name);
    if (!def) throw new ViewRefusal('unclaimedUnknown', 'No unclaimed view by that name');
    const mine = viewsOfOwner(owner, cfg);
    const earlier = mine.find(v => v.migratedFrom === def.migratedFrom);
    if (earlier) made = earlier;
    else {
      if (mine.length >= MAX_VIEWS_PER_OWNER) throw tooManyViews();
      const viewName = freeViewName(def.name, new Set(mine.map(v => v.name)));
      made = { id: viewIdOf(viewName), name: viewName, ownerId: owner, members: [...def.members], createdAt: new Date().toISOString(), migratedFrom: def.migratedFrom };
      cfg.views = [...(cfg.views ?? []), made];
    }
    cfg.unclaimedViews = (cfg.unclaimedViews ?? []).filter(u => u !== def);
    if (cfg.unclaimedViews.length === 0) delete cfg.unclaimedViews;
  });
  return { view: viewAnswer(actor, made), ownerKey: owner, memberCount: made.members.length };
}

/**
 * Drop what a retired proxy id still holds (its collections, vector indexes, files directory and activity rows, through the one physical
 * drop a space delete uses) and release the id. While OIDC maps spaces from a claim it refuses unless `confirmOidcClaims`, because a user
 * whose claim still names the id would reach a space created under it later. The id stays reserved if the drop failed, so running it again
 * is the resume.
 * @throws ViewRefusal
 */
export async function purgeRetiredSpaceId(id: string, opts: { confirmOidcClaims?: boolean }): Promise<{ released: string }> {
  const cfg = getConfig();
  if (!(cfg.retiredSpaceIds ?? []).includes(id)) {
    throw new ViewRefusal('retiredUnknown', `'${peerText(id, { max: NAME_QUOTED })}' is not a retired proxy id`);
  }
  const oidcMapsSpaces = !!cfg.oidc?.enabled && !!cfg.oidc.claimMapping?.spaces;
  if (oidcMapsSpaces && opts.confirmOidcClaims !== true) {
    throw new ViewRefusal('purgeConfirmOidc',
      `OIDC maps spaces from a claim, so a user whose claim still names '${peerText(id, { max: NAME_QUOTED })}' will reach a space created under that id later. `
      + 'Send `confirmOidcClaims: true` to purge it anyway');
  }
  const errors = await dropSpaceData(id);
  if (errors.length > 0) throw new Error(`Could not drop everything '${peerText(id, { max: NAME_QUOTED })}' still holds (${errors.length} step(s) failed); it stays reserved - run the purge again`);
  mutateConfig(c => { c.retiredSpaceIds = (c.retiredSpaceIds ?? []).filter(r => r !== id); });
  return { released: id };
}

/** What the 6.0 upgrade did, for `GET /api/admin/views/migration`: the report, and what is still owed. */
export function viewsMigrationReport(config: Config = getConfig()): Record<string, unknown> {
  const report = config.viewsMigration;
  return {
    // The proxy ids the upgrade turned into views, and the networks that lost one (the peers see this member as having left that network space).
    migrated: [...(report?.proxies ?? [])],
    networksLostIds: (report?.networksLeft ?? []).map(n => ({
      networkId: n.networkId,
      label: config.networks.find(net => net.id === n.networkId)?.label ?? n.networkId,
      spaceIds: [...n.spaceIds],
    })),
    unclaimed: (config.unclaimedViews ?? []).map(u => ({ name: u.name, members: [...u.members] })),
    retiredSpaceIds: [...(config.retiredSpaceIds ?? [])],
  };
}

// ── Audit ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a view act came from, for its audit row. */
export interface ViewAuditDoor {
  ip: string;
  method: string;
  path: string;
  tokenId: string | null;
  tokenLabel: string | null;
  authMethod: 'pat' | 'oidc' | null;
  oidcSubject: string | null;
}

/**
 * Record one view act: its owner key and member COUNT, never the view's name or its members, and a path that is the route pattern (a
 * request path would carry the name). Written for both doors from here, so a row cannot leave one door with the name in it. Answers when the
 * row is stored: the doors await it before they reply.
 */
export function auditViewAct(door: ViewAuditDoor, operation: typeof VIEW_OPERATIONS[keyof typeof VIEW_OPERATIONS], act: { ownerKey: string; memberCount: number }, status = 200): Promise<void> {
  return logAuditEntry({ ...door, spaceId: null, operation, status, durationMs: 0, view: { ownerKey: act.ownerKey, memberCount: act.memberCount } });
}
