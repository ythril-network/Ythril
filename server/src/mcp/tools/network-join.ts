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
import { joinByInviteKeyAct, joinRemoteAct, INVITE_CODE_MAX_LENGTH } from '../../networks/join-remote-act.js';
import { addMemberAct, removeMemberAct, acceptIntroductionAct } from '../../networks/member-acts.js';
import { uuidSchema } from './shared.js';
import { DEFAULT_JOIN_SYNC_SCHEDULE } from '../../sync/schedule.js';
import { callerOf, networkIdSchema, toResult } from './networks.js';
import { MAX_SPACE_IDS } from '../../util/request-bounds.js';

const SPACE_ID = { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9-]+$' } as const;

/** The joiner's schedule (Q-137), declared once for both join tools so the two cannot describe it differently. */
const JOIN_SYNC_SCHEDULE = {
  type: 'string', maxLength: 200,
  description: 'Optional: the cron schedule this instance syncs the joined network on, e.g. "*/15 * * * *"; "" for '
    + `manual sync only. Omitted, the join adopts the inviter's schedule, or "${DEFAULT_JOIN_SYNC_SCHEDULE}" when the `
    + 'inviter offers none. Refused (400) before the handshake when it is not a runnable cron expression. A network this instance '
    + 'already carries keeps its own schedule.',
} as const;

export const network_join_remoteTool: ToolHandler = {
  name: 'network_join_remote',
  description: 'Join a network another instance invited this one into: runs the invite handshake against the inviter '
    + 'and registers the network here. Same parameters and answer as `POST /api/networks/join-remote` — pass the '
    + 'bundle the inviter\'s `POST /api/invite/generate` returned, plus this instance\'s own reachable URL.\n\n'
    + 'WHO MAY: `networks: write` (or administering the space) on every existing local space the join maps to; a '
    + 'space the join would create needs `createSpaces` too. The check runs after the inviter names its spaces and '
    + 'before anything is written, so a refused join leaves nothing behind.\n\n'
    + 'THE MAPPING IS ADDITIVE: each of the network\'s spaces lands on the local space of the name the invite shows '
    + 'for it (`spaces` in the bundle), or on the one `spaceMap` names, and a missing one is created. Nothing local is '
    + 'removed. A space the inviter RENAMED keeps its old name as the network\'s id (`networkSpaces`, beside `spaces`): '
    + 'the join lands it under the current name and records the alias, so everything the network sends later reaches '
    + 'that one space. Refused (400) before anything is written, with a `code`: `join_mapping_collision` when two '
    + 'spaces would land on one local space or a `spaceMap` key could mean two spaces; `network_id_aliased` when this '
    + 'instance already carries one of them under another name. No token is ever returned: both travel RSA-wrapped.',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      handshakeId: uuidSchema('From the invite bundle. Single-use, and it expires: a handshake cannot be replayed.'),
      inviteUrl: { type: 'string', minLength: 1, description: 'From the invite bundle: the inviter\'s `/api/invite/apply` URL. Must be https unless this instance allows insecure peers.' },
      rsaPublicKeyPem: { type: 'string', minLength: 100, description: 'From the invite bundle, as given; the inviter\'s own key is read back from its apply answer.' },
      networkId: uuidSchema('From the invite bundle: the network being joined.'),
      myUrl: { type: 'string', minLength: 1, description: 'This instance\'s externally reachable base URL, which the inviter will sync with.' },
      expiresAt: { type: 'string', description: 'From the invite bundle; informational only.' },
      // The rest of the bundle, so it can be passed whole as the description says (Q-133). Informational: the join
      // reads the inviter's own answer, never these.
      spaces: { type: 'array', items: SPACE_ID, maxItems: MAX_SPACE_IDS, description: 'From the invite bundle; informational only — the inviter\'s answer is what the join uses.' },
      networkSpaces: { type: 'array', items: SPACE_ID, maxItems: MAX_SPACE_IDS, description: 'From the invite bundle; informational only.' },
      inviteCode: { type: 'string', maxLength: INVITE_CODE_MAX_LENGTH, description: 'From the invite bundle; informational only.' },
      spaceMap: { type: 'object', additionalProperties: SPACE_ID, description: 'Optional: a space of the network → the local space id to put it in. Key it by the name the invite shows for the space (`spaces`); the network\'s id for it (`networkSpaces`) is accepted too. A space not named keeps the name the invite shows.' },
      syncSchedule: JOIN_SYNC_SCHEDULE,
    },
    required: ['handshakeId', 'inviteUrl', 'rsaPublicKeyPem', 'networkId', 'myUrl'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(await joinRemoteAct(callerOf(ctx), ctx.args), '');
  },
};

export const network_join_by_keyTool: ToolHandler = {
  name: 'network_join_by_key',
  description: 'Join a pub/sub network with nothing but its publisher\'s URL and its published invite key. Same '
    + 'parameters and answer as `POST /api/networks/join-by-key`. A pub/sub admits without a vote, so the key is the '
    + 'publisher\'s standing permission: this redeems it at the publisher and runs the same handshake as '
    + '`network_join_remote`. Only a network the instance at that URL publishes answers to its key.\n\n'
    + 'WHO MAY: as for `network_join_remote` — `networks: write` (or administering the space) on every existing local '
    + 'space the join maps to, and `createSpaces` for a space the join would create. Your token is then the one that '
    + 'decides what the network may add here later.',
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      publisherUrl: { type: 'string', minLength: 1, description: 'The publisher\'s base URL, as the invite gives it. Must be https unless this instance allows insecure peers.' },
      inviteKey: { type: 'string', minLength: 20, maxLength: 200, description: 'The network\'s published invite key (`ythril_invite_…`).' },
      myUrl: { type: 'string', minLength: 1, description: 'This instance\'s externally reachable base URL, which the publisher will sync with.' },
      spaceMap: { type: 'object', additionalProperties: SPACE_ID, description: 'Optional: a space of the network → the local space id to put it in, keyed by the name the publisher gives it or by the network\'s id for it. A space not named keeps the publisher\'s name; a renamed one lands under its current name with the alias recorded.' },
      syncSchedule: JOIN_SYNC_SCHEDULE,
    },
    required: ['publisherUrl', 'inviteKey', 'myUrl'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(await joinByInviteKeyAct(callerOf(ctx), ctx.args), '');
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
      instanceId: { type: 'string', minLength: 1, description: 'The peer\'s instance id, as its `/api/about` reports it. A member already present is a 409.' },
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

export const network_introduction_acceptTool: ToolHandler = {
  name: 'network_introduction_accept',
  description: 'Accept a member another member\'s roster only PROPOSED, on a closed or democratic network. Same as '
    + '`POST /api/networks/:id/introductions/:instanceId/accept`. On a voted network a roster is not the authority, '
    + 'because an admitted instance votes: a member introduced by a passed join round, or by the member that admitted '
    + 'this instance, pairs on its own; any other introduction waits in `network_get`\'s `introductions` with '
    + '`needsApproval: true` until accepted here. Pairing follows on the next sync. A 404 when nothing of that id is '
    + 'waiting. Requires instance-admin rights.',
  admin: true,
  mutating: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      id: networkIdSchema,
      instanceId: { type: 'string', minLength: 1, description: 'The waiting introduction\'s instance id, as `network_get` lists it under `introductions`.' },
    },
    required: ['id', 'instanceId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(acceptIntroductionAct(String(ctx.args['id']), String(ctx.args['instanceId'])), 'Introduction accepted.');
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
