/**
 * Network governance on MCP, slice 1 (`F-36`): read, create, update and leave a network — and add a space to one
 * (`F-38.3`).
 *
 * Each tool is a door onto `networks/network-acts.ts` and nothing more — the same act the REST route calls, so the
 * rights, the refusals, their wording and the body a caller receives cannot differ between the two. None carries
 * `admin`: who may act is decided by the rights matrix inside the act (the Networks column, or F-37's space
 * administration), exactly as on REST.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { uuidSchema } from './shared.js';
import {
  readNetworkAct, createNetworkAct, updateNetworkAct, leaveNetworkAct, addNetworkSpaceAct, type NetworkActResult,
} from '../../networks/network-acts.js';
import { castVoteAct, listOpenVotesAct, syncHistoryAct } from '../../networks/vote-acts.js';
import { forkNetworkAct, inviteKeyAct } from '../../networks/network-acts.js';

/** The caller an act sees: this connection's matrix, and the token id memberships are recorded against. */
const callerOf = (ctx: ToolContext) => ({ ...(ctx.rights ? { rights: ctx.rights } : {}), ...(ctx.actor?.tokenId ? { id: ctx.actor.tokenId } : {}) });

/** An act's answer as a tool result: the status travels in the text, as on every other tool that mirrors a route. */
function toResult(r: NetworkActResult, done: string): ToolResult {
  if ('error' in r) return { content: [{ type: 'text' as const, text: `Error (${r.status}): ${r.error}` }], isError: true };
  if (r.status === 204) return { content: [{ type: 'text' as const, text: done }], structuredContent: { ok: true } };
  return { content: [{ type: 'text' as const, text: JSON.stringify(r.body) }], structuredContent: r.body };
}

const networkIdSchema = uuidSchema('The network\'s id — `networkId` on a `network_peers` row, `id` everywhere else, as in `/api/networks/:id`.');

export const network_getTool: ToolHandler = {
  name: 'network_get',
  description: 'Read one network: its type, the spaces it carries, its members with their sync state and version '
    + 'verdict, and its settings. Same answer as `GET /api/networks/:id`.\n\n'
    + 'A NETWORK YOU MAY NOT SEE IS "not found", never "forbidden" — a refusal would confirm it exists. You see a '
    + 'network with `networks: read` on EVERY space it carries, or by administering every one of them.\n\n'
    + 'NO CREDENTIALS ARE EVER RETURNED: member token hashes, TLS overrides and the invite-key hash are stripped.',
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object', properties: { id: networkIdSchema }, required: ['id'], additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(readNetworkAct(callerOf(ctx), String(ctx.args['id'])), '');
  },
};

export const network_createTool: ToolHandler = {
  name: 'network_create',
  description: 'Create a network carrying one or more of your spaces. Same parameters, defaults and refusals as '
    + '`POST /api/networks`; the membership is recorded as yours, which is what later lets you leave it.\n\n'
    + 'WHO MAY: `networks: write` on EVERY space it carries, or administering every one of them; a space you are short '
    + 'on is named in the refusal. An instance admin always may.\n\n'
    + 'THE NETWORK STARTS EMPTY. Nobody joins until you generate an invite and another instance applies it.',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 200, description: 'A display name, 1-200 characters. Peers see it too: it travels with the invite.' },
      type: { type: 'string', enum: ['closed', 'democratic', 'club', 'braintree', 'pubsub'],
        description: 'How joins and changes are governed: closed (unanimous), democratic (majority, any veto blocks), '
          + 'club (the inviter decides), braintree (every ancestor up to the root), pubsub (publisher pushes, anyone subscribes).' },
      spaces: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Local space ids it carries — each must exist, and you need the right on EVERY one, or the whole create is refused naming the short ones.' },
      votingDeadlineHours: { type: 'integer', minimum: 1, maximum: 72, default: 24, description: 'Hours a vote round stays open (1-72, default 24); a round nobody concludes by then fails.' },
      syncSchedule: { type: 'string', description: 'A cron expression, e.g. "*/15 * * * *". Omit for manual sync only. One the scheduler cannot run is refused.' },
      merkle: { type: 'boolean', description: 'Compare a Merkle root with each peer every cycle and warn on divergence.' },
      requireSignedVotes: { type: 'boolean', description: 'Refuse any unsigned governance vote. Turn it on only once every member has synced once, or their votes are refused.' },
      myParentInstanceId: { type: 'string', description: 'braintree only: this instance\'s parent in the tree; omit to be the root.' },
      id: uuidSchema('A pre-chosen UUID for the network, for registering the same network on several instances; one already in use is refused (409).'),
    },
    required: ['label', 'type', 'spaces'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(createNetworkAct(callerOf(ctx), ctx.args), '');
  },
};

export const network_updateTool: ToolHandler = {
  name: 'network_update',
  description: 'Change a network\'s label, sync schedule or signed-vote mode. Same parameters and refusals as '
    + '`PATCH /api/networks/:id`. Only the fields you send change.\n\n'
    + 'WHO MAY: `networks: admin` on EVERY space the network carries — its settings are shared by all of them.',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      label: { type: 'string', minLength: 1, maxLength: 200, description: 'A new display name, 1-200 characters; omit it to keep the current one.' },
      syncSchedule: { type: 'string', description: 'A cron expression; an empty string turns scheduled sync off. One the scheduler cannot run is refused.' },
      requireSignedVotes: { type: 'boolean', description: 'Refuse any unsigned governance vote. Turn it on only once every member has synced once, or their votes are refused.' },
    },
    required: ['id'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, ...body } = ctx.args;
    const r = updateNetworkAct(callerOf(ctx), String(id), body);
    if (r.audit) ctx.recordChanges?.(r.audit.before, r.audit.after);  // Q-50: the entry PATCH writes
    return toResult(r, '');
  },
};

export const network_add_spaceTool: ToolHandler = {
  name: 'network_add_space',
  description: 'Add one of your spaces to a network. Same parameters and refusals as '
    + '`POST /api/networks/:id/spaces`. The members\' tokens reach it at once, and the instances below learn it on '
    + 'their next sync — a subscriber creates the space if it has none, and merges into it if it has.\n\n'
    + 'WHO DECIDES: the publisher of a pub/sub network and the root of a braintree add it at once; so does a club\'s '
    + 'organiser, whose own yes carries the vote. On a closed or democratic network it opens a vote and answers '
    + '`status: "vote_pending"` with the round; the space is added when the vote passes. A member that already has a '
    + 'space of that name keeps it out of the network unless it voted yes.\n\n'
    + 'WHO MAY: sharing the space (`networks: write` on it, or administering it) AND `networks: admin` on, or '
    + 'administering, every space the network already carries.',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      spaceId: { type: 'string', minLength: 1, description: 'The local id of the space to add. It must exist on this instance and not be carried already (409).' },
    },
    required: ['id', 'spaceId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, ...body } = ctx.args;
    const r = addNetworkSpaceAct(callerOf(ctx), String(id), body);
    if (r.audit) ctx.recordChanges?.(r.audit.before, r.audit.after);  // Q-50: the entry the route writes
    return toResult(r, '');
  },
};

export const network_leaveTool: ToolHandler = {
  name: 'network_leave',
  description: 'Leave a network: its peers are told, it is removed from this instance, and a peer that now shares no '
    + 'network with this instance loses its credentials. Same as `DELETE /api/networks/:id`. The local data is not '
    + 'touched.\n\n'
    + 'WHO MAY: a membership you established at `networks: write`; anyone\'s, or one with no recorded establisher, at '
    + '`networks: admin` — on every space the network carries.\n\n'
    + 'A reply listing `warnings` means the network was left and those peers could not be told.',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object', properties: { id: networkIdSchema }, required: ['id'], additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(await leaveNetworkAct(callerOf(ctx), String(ctx.args['id'])), 'Left the network.');
  },
};

// ── F-36 slice 2: votes and sync history. Instance-admin, like their routes: they act on the network as a whole. ──

export const network_votesTool: ToolHandler = {
  name: 'network_votes',
  description: 'List the vote rounds still open on a network: joins, removals, space deletions and wipes, space '
    + 'additions and meta changes, each with its deadline and the casts so far. Same answer as '
    + '`GET /api/networks/:id/votes`. Requires instance-admin rights.\n\n'
    + 'A ROUND IS HOW A NETWORK APPROVES A CHANGE. Cast on one with `network_vote`; a round nobody concludes by its '
    + 'deadline fails.',
  admin: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object', properties: { id: networkIdSchema }, required: ['id'], additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(listOpenVotesAct(String(ctx.args['id'])), '');
  },
};

export const network_voteTool: ToolHandler = {
  name: 'network_vote',
  description: 'Cast this instance\'s vote on an open round — `yes` or `veto` — signed with the instance key. Same '
    + 'parameters and answer as `POST /api/networks/:id/votes/:roundId`: `{ concluded, round }`. Requires '
    + 'instance-admin rights.\n\n'
    + 'A CAST CAN CONCLUDE THE ROUND, and a concluded round takes effect here at once: a passed join admits the '
    + 'member, a passed removal ejects one, a passed space deletion or wipe empties the space on this instance, a '
    + 'passed space addition adds it. A single veto stops a deletion or wipe. Voting again replaces your earlier cast.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      roundId: uuidSchema('The round to vote on — `roundId` from `network_votes`. A round already concluded is refused (404).'),
      vote: { type: 'string', enum: ['yes', 'veto'], description: 'Your vote: `yes` carries the change as the network type decides, `veto` stops it.' },
    },
    required: ['id', 'roundId', 'vote'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, roundId, ...body } = ctx.args;
    return toResult(castVoteAct(String(id), String(roundId), body), '');
  },
};

export const network_sync_historyTool: ToolHandler = {
  name: 'network_sync_history',
  description: 'Read a network\'s recent sync cycles, newest first: when each ran, whether it succeeded, how many '
    + 'records moved each way, and what stopped. Same answer as `GET /api/networks/:id/sync-history`. Requires '
    + 'instance-admin rights.\n\n'
    + 'A CYCLE THAT FAILED says which space and direction did not complete; a network that fails every cycle is not '
    + 'syncing at all.',
  admin: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'How many cycles to return, newest first: 1-100, default 20.' },
    },
    required: ['id'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(await syncHistoryAct(String(ctx.args['id']), ctx.args['limit']), '');
  },
};

// ── F-36 slice 3: an invite key and a fork. ──────────────────────────────────────────────────────────────────

export const network_inviteTool: ToolHandler = {
  name: 'network_invite',
  description: 'Mint a fresh invite key for a network. Same answer as `POST /api/networks/:id/invite`: '
    + '`{ inviteKey, networkId, reusable, note }`. On a pub/sub network the key is reusable and safe to publish; on '
    + 'every other type it is single-use and shown only this once. Minting a new key revokes the previous one.\n\n'
    + 'WHO MAY: instance admin, or a token that administers EVERY space the network carries. A network you may not see '
    + 'is "not found".',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object', properties: { id: networkIdSchema }, required: ['id'], additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(await inviteKeyAct(callerOf(ctx), String(ctx.args['id'])), '');
  },
};

export const network_forkTool: ToolHandler = {
  name: 'network_fork',
  description: 'Found a new network from an existing one — or from one this instance was ejected from, naming the '
    + 'spaces — with no members yet. Same parameters and answer as `POST /api/networks/:id/fork`. Requires '
    + 'instance-admin rights.\n\n'
    + 'THE FORK STARTS EMPTY: invite members into it as into any new network.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      label: { type: 'string', minLength: 1, maxLength: 200, description: 'A display name for the new network, 1-200 characters.' },
      type: { type: 'string', enum: ['closed', 'club'], default: 'closed', description: 'The new network\'s governance: closed (unanimous) or club (the organiser decides). Default closed.' },
      votingDeadlineHours: { type: 'integer', minimum: 1, maximum: 72, description: 'Hours a vote stays open, 1-72; omitted, the source network\'s value, or 24.' },
      spaces: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Local space ids it carries; omitted, the source network\'s. Required when the source is no longer here.' },
    },
    required: ['id', 'label'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, ...body } = ctx.args;
    return toResult(forkNetworkAct(String(id), body), '');
  },
};
