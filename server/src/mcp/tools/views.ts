/**
 * The MCP doors of personal views (Q-531): the caller's own views, a copy to a token the caller manages, and the instance admin's doors.
 * Twins of `api/views.ts`; every rule is in `spaces/view-acts.ts`, refused there, and answered here as the same sentence the REST door sends.
 *
 * `view_create`, `view_update` and `view_delete` tell the client its tool list changed (`notifications/tools/list_changed`, sent by the
 * dispatcher's adapter in `mcp/router.ts`): a read tool's `space` enum offers the caller's views, so creating or deleting one changes the
 * schemas the client holds.
 */
import type { ToolHandler, ToolContext, ToolResult } from './types.js';
import {
  ViewRefusal, viewOwnerOf,
} from '../../config/views.js';
import {
  auditViewAct, claimUnclaimedView, copyViewTo, createView, deleteOwnView, getOwnView, listOwnViews, orphanAnswer,
  purgeRetiredSpaceId, updateView, viewsMigrationReport, type ViewActor, type ViewAuditDoor,
} from '../../spaces/view-acts.js';
import { VIEW_OPERATIONS } from '../../audit/middleware.js';
import { mfaRequiredFor } from '../../auth/mfa-policy.js';
import { isMfaEnabled } from '../../auth/totp.js';
import { ToolRefusal } from '../../util/errors.js';

const json = (data: Record<string, unknown>, text?: string): ToolResult => ({
  content: [{ type: 'text' as const, text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

/** The actor of a call, from the record the door snapshotted. */
function actorOf(ctx: ToolContext): ViewActor {
  if (!ctx.callerRecord) throw new ViewRefusal('noOwner', 'This connection carries no token record, so it cannot own a personal view');
  return { record: ctx.callerRecord, rights: ctx.rights };
}

/** The audit door of a view act on this transport: `http:<tool>` / `/api/<tool>`, never a path that carries the view's name. */
function doorOf(ctx: ToolContext): ViewAuditDoor {
  return {
    ip: '', method: ctx.transport === 'mcp' ? 'MCP' : 'POST',
    path: ctx.transport === 'mcp' ? `http:${ctx.name}` : `/api/${ctx.name}`,
    tokenId: ctx.actor?.tokenId ?? null, tokenLabel: ctx.actor?.tokenLabel ?? null,
    authMethod: ctx.callerRecord?.oidcIssuer !== undefined ? 'oidc' : 'pat',
    oidcSubject: ctx.callerRecord?.oidcSubject ?? null,
  };
}

/** A refusal of the shared acts as a tool refusal carrying its status and body, so REST answers the status and both doors the same sentence. */
async function answering(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ViewRefusal) throw new ToolRefusal(err.status as 400 | 403 | 404 | 409, err.message, err.body);
    throw err;
  }
}

const viewProp = { type: 'string' as const, description: 'The view\'s id, "@" and its name (for example "@team"). Only your own views are named.' };
const membersProp = {
  type: 'array' as const, items: { type: 'string' as const }, minItems: 1, maxItems: 1000,
  description: 'The spaces the view lists: space ids, or ["*"] for every space you can read. A view reads, at call time and per member, what you can read; '
    + 'a member you cannot read is not read. At most 1 000 members.',
};

export const view_listTool: ToolHandler = {
  name: 'view_list',
  ownerScoped: true,
  description: 'List YOUR personal views: each with the spaces it lists (`members`) and the ones you can read now (`readable`). A personal view is a '
    + 'named read lens over spaces you read, owned by your token alone; pass its id ("@name") as `space` to a read tool to read through it. It never writes.',
  inputSchema: () => ({ type: 'object', properties: {}, additionalProperties: false }),
  handle: async (ctx) => answering(async () => {
    const views = listOwnViews(actorOf(ctx));
    return json({ views }, `${views.length} personal view(s).\n${JSON.stringify(views, null, 2)}`);
  }),
};

export const view_createTool: ToolHandler = {
  name: 'view_create',
  ownerScoped: true,
  description: 'Create a personal view of your own: a named read lens over spaces you read, id "@<name>". Read tools (recall, filter, similar, graph_traverse, '
    + 'space_stats and the other reads) accept it as `space` and read each member you can read at that moment, naming the members read in `viewMembers`. '
    + 'It never writes: write to one of its member spaces. At most 50 views per token; names are 1-40 characters of a-z, 0-9 and hyphen, unique per token.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The view\'s name, 1-40 characters of a-z, 0-9 and hyphen.' },
      members: membersProp,
    },
    required: ['name', 'members'],
    additionalProperties: false,
  }),
  handle: async (ctx) => answering(async () => {
    const made = createView(actorOf(ctx), { name: ctx.args['name'], members: ctx.args['members'] });
    await auditViewAct(doorOf(ctx), VIEW_OPERATIONS.created, made);
    return json({ view: made.view }, `Created personal view ${made.view.id}.\n${JSON.stringify(made.view, null, 2)}`);
  }),
};

export const view_updateTool: ToolHandler = {
  name: 'view_update',
  ownerScoped: true,
  description: 'Rename and/or change the members of one of YOUR personal views. Send only what changes.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      view: viewProp,
      name: { type: 'string', description: 'The new name, 1-40 characters of a-z, 0-9 and hyphen.' },
      members: membersProp,
    },
    required: ['view'],
    additionalProperties: false,
  }),
  handle: async (ctx) => answering(async () => {
    const changed = updateView(actorOf(ctx), String(ctx.args['view'] ?? ''), { name: ctx.args['name'], members: ctx.args['members'] });
    await auditViewAct(doorOf(ctx), VIEW_OPERATIONS.updated, changed);
    return json({ view: changed.view }, `Updated personal view ${changed.view.id}.\n${JSON.stringify(changed.view, null, 2)}`);
  }),
};

export const view_deleteTool: ToolHandler = {
  name: 'view_delete',
  ownerScoped: true,
  description: 'Delete one of YOUR personal views. Only the view goes: the spaces it listed and their data are untouched.',
  inputSchema: () => ({ type: 'object', properties: { view: viewProp }, required: ['view'], additionalProperties: false }),
  handle: async (ctx) => answering(async () => {
    const id = String(ctx.args['view'] ?? '');
    const gone = deleteOwnView(actorOf(ctx), id);
    await auditViewAct(doorOf(ctx), VIEW_OPERATIONS.deleted, gone);
    return json({ deleted: id }, `Deleted personal view ${id}. No space or record was touched.`);
  }),
};

export const view_copyTool: ToolHandler = {
  name: 'view_copy',
  ownerScoped: true,
  description: 'Give another token a COPY of one of YOUR personal views, owned by that token; you may do this only for a token you may manage. The copy keeps '
    + 'only the members that token can read, and a repeated copy refreshes the earlier one. Needs the second factor when the instance asks it for token management: '
    + 'then it answers that it needs MFA step-up and to use the web UI.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      view: viewProp,
      toTokenId: { type: 'string', description: 'The id of the token that receives the copy.' },
      fromTokenId: { type: 'string', description: 'Only when a view of one name belongs to more than one token you manage: the token whose view to copy.' },
    },
    required: ['view', 'toTokenId'],
    additionalProperties: false,
  }),
  handle: async (ctx) => answering(async () => {
    const record = ctx.callerRecord;
    // The second factor token management asks, answered honestly: this door has no place for a code, so a caller who would need one on REST
    // is told to use the web UI. The same rule as REST's (`mfaRequiredFor`), not a third divergence.
    if (record && record.oidcIssuer === undefined && mfaRequiredFor({ mfa: record.mfa }, isMfaEnabled())) {
      throw new ViewRefusal('copyNeedsMfa', 'Giving a view to a token needs MFA step-up, which this door cannot present; use the web UI (Settings > Tokens)');
    }
    const given = copyViewTo(actorOf(ctx), String(ctx.args['view'] ?? ''), ctx.args['toTokenId'], ctx.args['fromTokenId']);
    await auditViewAct(doorOf(ctx), VIEW_OPERATIONS.copied, given);
    return json({ view: given.view, created: given.created }, `${given.created ? 'Copied' : 'Refreshed the earlier copy of'} the view to the token as ${given.view.id}.`);
  }),
};

// ── The instance admin's doors ─────────────────────────────────────────────────────────────────────────────────────

export const view_orphansTool: ToolHandler = {
  name: 'view_orphans',
  admin: true,
  description: 'Instance admin: count the personal views whose owner holds no token, per owner kind (`token`, `oauth`). Names no view and no owner.',
  inputSchema: () => ({ type: 'object', properties: {}, additionalProperties: false }),
  handle: async () => answering(() => {
    return json({ ...orphanAnswer() });
  }),
};

export const view_claimTool: ToolHandler = {
  name: 'view_claim',
  admin: true,
  description: 'Instance admin: copy an unclaimed view (a migrated definition no admin token could own at the upgrade) to YOUR token, with the members the definition had.',
  inputSchema: () => ({ type: 'object', properties: { name: { type: 'string', description: 'The unclaimed view\'s name.' } }, required: ['name'], additionalProperties: false }),
  handle: async (ctx) => answering(async () => {
    const claimed = claimUnclaimedView(actorOf(ctx), ctx.args['name']);
    await auditViewAct(doorOf(ctx), VIEW_OPERATIONS.claimed, claimed);
    return json({ view: claimed.view }, `Claimed ${claimed.view.id}.`);
  }),
};

export const view_purge_retiredTool: ToolHandler = {
  name: 'view_purge_retired',
  admin: true,
  heavy: true,
  description: 'Instance admin: drop everything a retired space id still holds (its collections, files and activity) and release the id for new spaces. '
    + 'While OIDC maps spaces from a claim it refuses unless `confirmOidcClaims` is true: a user whose claim still names the id would reach a space created under it.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The retired space id (listed by view_migration).' },
      confirmOidcClaims: { type: 'boolean', description: 'Confirm the purge although OIDC maps spaces from a claim.' },
    },
    required: ['id'],
    additionalProperties: false,
  }),
  handle: async (ctx) => answering(async () => {
    const { released } = await purgeRetiredSpaceId(String(ctx.args['id'] ?? ''), { confirmOidcClaims: ctx.args['confirmOidcClaims'] === true });
    await auditViewAct(doorOf(ctx), VIEW_OPERATIONS.purgedRetiredId, { ownerKey: viewOwnerOf(actorOf(ctx).record) ?? 'unknown', memberCount: 0 });
    return json({ released }, `Released the retired id '${released}'.`);
  }),
};

export const view_migrationTool: ToolHandler = {
  name: 'view_migration',
  admin: true,
  description: 'Instance admin: what the 6.0 upgrade did to the old shared groupings of spaces: the report, the unclaimed view definitions and the retired space ids still reserved.',
  inputSchema: () => ({ type: 'object', properties: {}, additionalProperties: false }),
  handle: async () => answering(() => json(viewsMigrationReport())),
};

export const view_getTool: ToolHandler = {
  name: 'view_get',
  ownerScoped: true,
  description: 'Read one of YOUR personal views: its members and which of them you can read now. A view of another token is "not found".',
  inputSchema: () => ({ type: 'object', properties: { view: viewProp }, required: ['view'], additionalProperties: false }),
  handle: async (ctx) => answering(async () => {
    const view = getOwnView(actorOf(ctx), String(ctx.args['view'] ?? ''));
    return json({ view }, JSON.stringify(view, null, 2));
  }),
};
