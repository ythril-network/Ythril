/**
 * Network governance on MCP, slice 5 (`F-36`): admit a joiner by invite key, pin a member's signing key, and the
 * three braintree topology acts.
 *
 * Each tool is a door onto the act its REST route calls — `networks/member-acts.ts` and `networks/topology-acts.ts` —
 * so the governance, the refusals and their wording cannot differ between the doors. All five are instance-admin,
 * as their routes are: each is an act on the network as a whole, not on one space's membership of it.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { uuidSchema } from './shared.js';
import { admitByInviteKeyAct, setSigningKeyAct } from '../../networks/member-acts.js';
import { adoptMemberAct, reparentSelfAct, revertParentAct } from '../../networks/topology-acts.js';
import { networkIdSchema, toResult } from './networks.js';

const memberIdSchema = { type: 'string', minLength: 1, description: 'The member\'s instance id, as `network_get` lists it. An unknown one is "Member not found".' } as const;

export const network_member_admitTool: ToolHandler = {
  name: 'network_member_admit',
  description: 'Admit an instance that presents this network\'s invite key — the inviter\'s half of a join. Same '
    + 'parameters and answer as `POST /api/networks/:id/join`: `{ status: "joined", members, networkId }`, or '
    + '`{ status: "vote_pending", roundId }` where the type votes (closed, democratic, braintree below the root). '
    + 'Requires instance-admin rights.\n\n'
    + 'THE KEY IS SINGLE-USE except on pub/sub, and presenting it again polls the joiner\'s own round. An instance '
    + 'joining by handshake does not need this — `network_join_remote` on its side runs the whole exchange.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      inviteKey: { type: 'string', minLength: 1, description: 'The key `network_invite` minted, as the joiner presents it. A wrong one is "Invalid invite key".' },
      instanceId: { type: 'string', minLength: 1, description: 'The joiner\'s instance id, as its `/api/about` reports it. A member already present is a 409.' },
      label: { type: 'string', minLength: 1, maxLength: 200, description: 'A display name for the joiner, 1-200 characters.' },
      url: { type: 'string', minLength: 1, description: 'The joiner\'s base URL. Must be https unless this instance allows insecure peers.' },
      token: { type: 'string', minLength: 1, description: 'The token this instance presents to the joiner. Stored in secrets; never returned.' },
      direction: { type: 'string', enum: ['both', 'push', 'pull'], default: 'both', description: 'Which way records flow. Pub/sub and braintree set it themselves.' },
      parentInstanceId: { type: 'string', description: 'Ignored on braintree, where the joiner always becomes this instance\'s child.' },
      skipTlsVerify: { type: 'boolean', description: 'Accept the joiner\'s TLS certificate without verifying it. Never returned.' },
    },
    required: ['id', 'inviteKey', 'instanceId', 'label', 'url', 'token'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, ...body } = ctx.args;
    return toResult(await admitByInviteKeyAct(String(id), body), '');
  },
};

export const network_member_signing_keyTool: ToolHandler = {
  name: 'network_member_signing_key',
  description: 'Break-glass: pin a member\'s governance signing key without a rotation proof. Same as '
    + '`PUT /api/networks/:id/members/:instanceId/signing-key`. Requires instance-admin rights.\n\n'
    + 'ONLY FOR A PEER THAT LOST ITS OLD KEY. A normal rotation arrives by itself as a signed proof over gossip; pinning '
    + 'a key by hand trusts whatever you paste, and votes signed with it count from then on.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      instanceId: memberIdSchema,
      signingPublicKey: { type: 'string', minLength: 100, maxLength: 4000, description: 'The member\'s new public signing key, PEM, as the member itself reports it. Get it from the peer\'s operator, never from the network.' },
    },
    required: ['id', 'instanceId', 'signingPublicKey'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, instanceId, ...body } = ctx.args;
    return toResult(setSigningKeyAct(String(id), String(instanceId), body), '');
  },
};

export const network_reparent_selfTool: ToolHandler = {
  name: 'network_reparent_self',
  description: 'Braintree only: record that this instance is temporarily attached to a new parent (usually its '
    + 'grandparent) while its own parent is offline. Same parameters and answer as `POST /api/networks/:id/reparent-self`. '
    + 'Requires instance-admin rights.\n\n'
    + 'RUN IT AFTER the invite apply with the new parent, whose token it stores. The new parent then `network_member_adopt`s '
    + 'this instance to make it permanent, or `network_member_revert_parent`s it when the original parent is back.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      newParentInstanceId: uuidSchema('The new parent\'s instance id — usually the grandparent in the tree.'),
      newParentLabel: { type: 'string', minLength: 1, maxLength: 200, description: 'A display name for the new parent, 1-200 characters.' },
      newParentUrl: { type: 'string', minLength: 1, description: 'The new parent\'s base URL. Must be https unless this instance allows insecure peers.' },
      tokenForNewParent: { type: 'string', minLength: 1, description: 'The token this instance presents to the new parent, from the invite apply. Stored in secrets; never returned.' },
      originalParentInstanceId: uuidSchema('The parent that is offline, so the tree can be restored when it returns.'),
    },
    required: ['id', 'newParentInstanceId', 'newParentLabel', 'newParentUrl', 'tokenForNewParent', 'originalParentInstanceId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { id, ...body } = ctx.args;
    return toResult(reparentSelfAct(String(id), body), '');
  },
};

/** Both grandparent-side acts take the network and the member, nothing else. */
const memberOfNetwork = (_s: ToolSchemas) => ({
  type: 'object',
  properties: { id: networkIdSchema, instanceId: memberIdSchema },
  required: ['id', 'instanceId'],
  additionalProperties: false,
});

export const network_member_adoptTool: ToolHandler = {
  name: 'network_member_adopt',
  description: 'Braintree only, on the new parent: make a member\'s temporary reparent permanent. Same as '
    + '`POST /api/networks/:id/members/:instanceId/adopt`. Requires instance-admin rights. A member not in a temporary '
    + 'reparent state is a 409.',
  admin: true,
  mutating: true,
  inputSchema: memberOfNetwork,
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(adoptMemberAct(String(ctx.args['id']), String(ctx.args['instanceId'])), '');
  },
};

export const network_member_revert_parentTool: ToolHandler = {
  name: 'network_member_revert_parent',
  description: 'Braintree only, on the new parent: hand a temporarily reparented member back to its original parent '
    + 'once that parent is online again. Same as `POST /api/networks/:id/members/:instanceId/revert-parent`. Requires '
    + 'instance-admin rights. A member not in a temporary reparent state is a 409.',
  admin: true,
  mutating: true,
  inputSchema: memberOfNetwork,
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(revertParentAct(String(ctx.args['id']), String(ctx.args['instanceId'])), '');
  },
};
