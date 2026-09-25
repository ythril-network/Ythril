/**
 * Network governance on MCP, slice 4 (`F-36`): join a remote network, and add or remove a network's members.
 *
 * Each tool is a door onto the act its REST route calls — `networks/join-remote-act.ts` and
 * `networks/member-acts.ts` — so the rights, the per-type governance (a vote or a direct change), the refusals and
 * their wording cannot differ between the doors. `network_join_remote` carries no `admin`: the Networks rung is
 * checked inside the act between the handshake's apply and finalize, exactly as on REST. The member tools are
 * instance-admin, as their routes are.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { joinRemoteAct } from '../../networks/join-remote-act.js';
import { addMemberAct, removeMemberAct } from '../../networks/member-acts.js';
import { uuidSchema } from './shared.js';
import { callerOf, networkIdSchema, toResult } from './networks.js';

const SPACE_ID = { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9-]+$' } as const;

export const network_join_remoteTool: ToolHandler = {
  name: 'network_join_remote',
  description: 'Join a network another instance invited this one into: runs the invite handshake against the inviter '
    + 'and registers the network here. Same parameters and answer as `POST /api/networks/join-remote` — pass the '
    + 'bundle the inviter\'s `POST /api/invite/generate` returned, plus this instance\'s own reachable URL.\n\n'
    + 'WHO MAY: `networks: write` (or administering the space) on every existing local space the join maps to; a '
    + 'space the join would create needs `createSpaces` too. The check runs after the inviter names its spaces and '
    + 'before anything is written, so a refused join leaves nothing behind.\n\n'
    + 'THE MAPPING IS ADDITIVE: a remote space lands on the local space of the same id, or the one `spaceMap` names, '
    + 'and a missing one is created. Nothing local is removed. No token is ever returned: both travel RSA-wrapped.',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      handshakeId: uuidSchema('From the invite bundle.'),
      inviteUrl: { type: 'string', minLength: 1, description: 'From the invite bundle: the inviter\'s `/api/invite/apply` URL. Must be https unless this instance allows insecure peers.' },
      rsaPublicKeyPem: { type: 'string', minLength: 100, description: 'From the invite bundle.' },
      networkId: uuidSchema('From the invite bundle: the network being joined.'),
      myUrl: { type: 'string', minLength: 1, description: 'This instance\'s externally reachable base URL, which the inviter will sync with.' },
      expiresAt: { type: 'string', description: 'From the invite bundle; informational only.' },
      spaceMap: { type: 'object', additionalProperties: SPACE_ID, description: 'Optional: remote space id → the local space id to map it onto. A remote id not named keeps its own id.' },
    },
    required: ['handshakeId', 'inviteUrl', 'rsaPublicKeyPem', 'networkId', 'myUrl'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(await joinRemoteAct(callerOf(ctx), ctx.args), '');
  },
};

export const network_member_addTool: ToolHandler = {
  name: 'network_member_add',
  description: 'Add a peer instance as a member of a network by hand. Same parameters and answer as '
    + '`POST /api/networks/:id/members`: the member (with no credential in it) when added at once, or '
    + '`{ status: "vote_pending", roundId }` when the network\'s type puts it to a vote — closed and democratic always, '
    + 'braintree unless this instance is the root. Requires instance-admin rights.\n\n'
    + 'Most members arrive by invite and join, not by this: it is for wiring two instances whose tokens you already hold.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      instanceId: { type: 'string', minLength: 1, description: 'The peer\'s instance id.' },
      label: { type: 'string', minLength: 1, maxLength: 200, description: 'A display name for the peer, 1-200 characters.' },
      url: { type: 'string', minLength: 1, description: 'The peer\'s base URL. Must be https unless this instance allows insecure peers.' },
      token: { type: 'string', minLength: 1, description: 'The token this instance presents to the peer. Stored in secrets; never returned.' },
      direction: { type: 'string', enum: ['both', 'push', 'pull'], default: 'both', description: 'Which way records flow. On pub/sub, `both` becomes `push`.' },
      parentInstanceId: { type: 'string', description: 'Braintree: the member\'s parent in the tree.' },
      skipTlsVerify: { type: 'boolean', description: 'Accept the peer\'s TLS certificate without verifying it. Never returned.' },
    },
    required: ['id', 'instanceId', 'label', 'url', 'token'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, ...body } = ctx.args;
    return toResult(await addMemberAct(String(id), body), '');
  },
};

export const network_member_removeTool: ToolHandler = {
  name: 'network_member_remove',
  description: 'Remove a member from a network. Same as `DELETE /api/networks/:id/members/:instanceId`: removed at '
    + 'once on club and pub/sub (and on braintree when this instance alone must approve), otherwise '
    + '`{ status: "vote_pending", roundId }`. Requires instance-admin rights.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      instanceId: { type: 'string', minLength: 1, description: 'The member\'s instance id, as `network_get` lists it.' },
    },
    required: ['id', 'instanceId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(removeMemberAct(String(ctx.args['id']), String(ctx.args['instanceId'])), 'Member removed.');
  },
};
