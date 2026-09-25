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
    return toResult(updateNetworkAct(callerOf(ctx), String(id), body), '');
  },
};

export const network_add_spaceTool: ToolHandler = {
  name: 'network_add_space',
  description: 'Add one of your spaces to a network this instance governs. Same parameters and refusals as '
    + '`POST /api/networks/:id/spaces`. The members\' tokens reach it at once, and the instances below learn it on '
    + 'their next sync — a subscriber creates the space if it has none, and merges into it if it has.\n\n'
    + 'WHO GOVERNS: the publisher of a pub/sub network, the root of a braintree. A club, closed or democratic network '
    + 'refuses it, because every member would have to agree and that vote does not exist yet.\n\n'
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
    return toResult(addNetworkSpaceAct(callerOf(ctx), String(id), body), '');
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
