/**
 * The network acts — read, create, update, add a space, leave — once, for both doors (`F-36`).
 *
 * ## Why this exists
 *
 * These were REST route handlers and nothing else, so governing a network was REST-only: `mcp/parity.ts` declared
 * every network act as a gap, and the project rule says such a row is a regression, not a plan. Writing MCP tools
 * that re-implemented the handlers would have made the other defect this repo produces most — one rule, two
 * implementations, the weaker one winning silently. So the decisions live here, each act returns a status and a
 * body, and each door only translates: REST to `res.status().json()`, MCP to a tool result.
 *
 * ## What each act guarantees, whichever door called it
 *
 * - A network the caller may not see is a `404`, never a `403` — a refusal would confirm it exists.
 * - The rights are the ones in `auth/network-rights.ts`, never re-derived here.
 * - The body a caller receives is built by `networkView`, so no door can hand out a token hash, a peer's TLS
 *   override or an invite-key hash. That strip used to be written three times in `crud.ts`.
 */
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  networkAddSpaceRefusal, networkCreateRefusal, networkInviteRefusal, networkJoinRefusal, networkLeaveRefusal, networkSettingsRefusal, visibleNetworks,
} from '../auth/network-rights.js';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS } from '../api/networks/_shared.js';
import { recordOrigin } from '../auth/network-membership.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { getConfig, saveConfig, getSecrets } from '../config/loader.js';
import type { NetworkConfig, VoteRound } from '../config/types.js';
import { syncScheduleRefusal } from '../sync/schedule.js';
import { MIN_PEER_VERSION, peerFloorRefusal } from '../sync/peer-floor.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { log } from '../util/log.js';
import { networkRole } from './network-role.js';
import { addSpacesToNetwork, widenPeerTokens } from './network-spaces.js';
import { concludeRoundIfReady } from '../sync/governance.js';
import { localToRemote, remoteToLocal } from '../sync/space-map.js';
import { makeSignedOwnCast } from '../util/signing.js';
import { openRoundHere } from './round-local-state.js';

type Caller = Parameters<typeof visibleNetworks>[0] & { id?: string };

/** What an act answers: the HTTP status IS the contract, so both doors carry it. */
export type NetworkActResult =
  | { status: 200 | 201 | 202; body: Record<string, unknown> }
  | { status: 204; body?: undefined }
  | { status: 400 | 403 | 404 | 409 | 410 | 500 | 502; error: string }
  /**
   * What ANOTHER instance answered, relayed as it came: a join's apply or finalize refused by the inviter. REST
   * sends `upstream` verbatim, as it always has; MCP reads `error` — the inviter's own sentence when it gave one.
   */
  | { status: number; error: string; upstream: unknown };

export const CreateNetworkBody = z.object({
  id: z.string().uuid().optional(),  // optional pre-specified ID for cross-instance registration
  label: z.string().min(1).max(200),
  type: z.enum(['closed', 'democratic', 'club', 'braintree', 'pubsub']),
  spaces: z.array(z.string().min(1)).min(1),
  votingDeadlineHours: z.number().int().min(1).max(72).default(24),
  syncSchedule: z.string().optional(),
  merkle: z.boolean().optional(),
  requireSignedVotes: z.boolean().optional(),  // strict mode: reject unsigned governance votes
  myParentInstanceId: z.string().optional(),  // braintree: this instance's parent in the tree (omit → root)
});

export const UpdateNetworkBody = z.object({
  syncSchedule: z.string().optional(),
  label: z.string().min(1).max(200).optional(),
  requireSignedVotes: z.boolean().optional(),
});

/** A network as any caller may see it: no credential of any kind, and each member's version verdict. */
export function networkView(net: NetworkConfig): Record<string, unknown> {
  const { inviteKeyHash: _ikh, ...rest } = net;
  // What this instance is in the network, and who that role acts on (F-38.1), by instance id into `members`.
  const role = networkRole(net);
  const myRole = {
    role: role.role,
    members: role.members.map(m => m.instanceId),
    ...(role.publisher ? { publisher: role.publisher.instanceId } : {}),
    ...(role.pathToRoot ? { pathToRoot: role.pathToRoot.map(m => m.instanceId) } : {}),
    ...(role.subtree ? { subtree: role.subtree.map(m => m.instanceId) } : {}),
  };
  return {
    ...rest,
    myRole,
    members: net.members.map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => ({
      ...m,
      belowFloor: peerFloorRefusal(m.version, m.versionCheckedAt),
      minPeerVersion: MIN_PEER_VERSION,
    })),
  };
}

const notFound = { status: 404 as const, error: 'Network not found' };

/** One network the caller may see. */
export function readNetworkAct(caller: Caller, id: string): NetworkActResult {
  const net = visibleNetworks(caller, getConfig().networks).find(n => n.id === id);
  return net ? { status: 200, body: networkView(net) } : notFound;
}

/** Create a network carrying `spaces`; the membership is recorded as the caller's. */
export function createNetworkAct(caller: Caller, input: unknown): NetworkActResult {
  const parsed = CreateNetworkBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const { id: presetId, label, type, spaces, votingDeadlineHours, syncSchedule, merkle, requireSignedVotes, myParentInstanceId } = parsed.data;
  const cfg = getConfig();

  // A schedule the scheduler cannot run is refused rather than stored, where it would sit on manual sync forever.
  const scheduleRefusal = syncScheduleRefusal(syncSchedule);
  if (scheduleRefusal) return { status: 400, error: scheduleRefusal };
  const unknownSpaces = spaces.filter(s => !cfg.spaces.some(cs => cs.id === s));
  if (unknownSpaces.length > 0) return { status: 400, error: `Unknown spaces: ${unknownSpaces.join(', ')}` };
  const refusal = networkCreateRefusal(caller, spaces);
  if (refusal) return { status: 403, error: refusal };
  if (presetId && cfg.networks.some(n => n.id === presetId)) return { status: 409, error: 'Network with this ID already exists' };

  const network: NetworkConfig = {
    id: presetId ?? uuidv4(),
    label,
    type,
    spaces,
    votingDeadlineHours,
    syncSchedule,
    merkle,
    ...(requireSignedVotes ? { requireSignedVotes: true } : {}),
    myParentInstanceId: type === 'braintree' ? myParentInstanceId : undefined,
    members: [],
    pendingRounds: [],
    createdAt: new Date().toISOString(),
    origin: 'created',
    // Who established each membership, so the leave rule can tell a token's own from another's. Recorded for an
    // instance admin too: the record is about the membership, not about whether its maker needed permission.
    ...(caller.id ? { spaceOrigins: spaces.reduce<Record<string, string>>((o, s) => recordOrigin(o, s, caller.id!), {}) } : {}),
    // And who established the network here (S-9): the authority for what a later announcement may add, exactly as
    // for a network this instance joined.
    ...(caller.id ? { joinedBy: caller.id } : {}),
  };
  cfg.networks.push(network);
  saveConfig(cfg);
  log.info(`Created network '${label}' (${type}) id=${network.id}`);
  return { status: 201, body: networkView(network) };
}

/**
 * Change a network's label, schedule or signed-vote mode. `before`/`after` are the three fields it can change, for
 * the audit trail; the record also holds credentials, so nothing wider is ever handed to it.
 */
export function updateNetworkAct(caller: Caller, id: string, input: unknown): NetworkActResult & {
  audit?: { before: Record<string, unknown>; after: Record<string, unknown> };
} {
  const parsed = UpdateNetworkBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  // Before the lookup: a schedule the scheduler cannot run is a bad request whichever network it names.
  const scheduleRefusal = syncScheduleRefusal(parsed.data.syncSchedule);
  if (scheduleRefusal) return { status: 400, error: scheduleRefusal };

  const cfg = getConfig();
  const net = visibleNetworks(caller, cfg.networks).find(n => n.id === id);
  if (!net) return notFound;
  const settingsRefusal = networkSettingsRefusal(caller, net);
  if (settingsRefusal) return { status: 403, error: settingsRefusal };

  const before = { label: net.label, syncSchedule: net.syncSchedule, requireSignedVotes: net.requireSignedVotes };
  if (parsed.data.syncSchedule !== undefined) {
    net.syncSchedule = parsed.data.syncSchedule || undefined;
    import('../sync/scheduler.js').then(({ scheduleSyncForNetwork }) => {
      scheduleSyncForNetwork(net.id, net.syncSchedule);
    }).catch(err => log.warn(`Failed to reschedule sync for ${net.id}: ${err}`));
  }
  if (parsed.data.label) net.label = parsed.data.label;
  if (parsed.data.requireSignedVotes !== undefined) net.requireSignedVotes = parsed.data.requireSignedVotes;
  saveConfig(cfg);
  log.info(`Updated network ${net.id}`);
  return {
    status: 200,
    body: networkView(net),
    audit: { before, after: { label: net.label, syncSchedule: net.syncSchedule, requireSignedVotes: net.requireSignedVotes } },
  };
}

export const AddNetworkSpaceBody = z.object({ spaceId: z.string().min(1) });

/**
 * Who adds a space to each network type (`F-38.3`, `F-38.4`). pub/sub and braintree have one governing position and
 * an upstream to announce through, so that position adds directly. The other three share every space both ways, so
 * the addition is a `space_addition` round the network's own rule decides: on a club the organiser's yes carries it,
 * on a closed network every member's, on a democratic one a majority with no veto.
 */
const ADD_SPACE_POSITION: Record<NetworkConfig['type'], { direct: boolean; position: string | null }> = {
  pubsub: { direct: true, position: 'publisher' },
  braintree: { direct: true, position: 'root' },
  club: { direct: false, position: 'organiser' },
  closed: { direct: false, position: null },
  democratic: { direct: false, position: null },
};

/**
 * Add one of this instance's spaces to a network (`F-38.3`, `F-38.4`). Answers `200` with the network when the space
 * is carried now, or `202` with the open round when the network still has to agree. The members' tokens are widened
 * here when it is carried; the other members add it from the announcement or from the passed round
 * (`networks/network-spaces.ts`). `audit` carries the space list before and after.
 */
export function addNetworkSpaceAct(caller: Caller, id: string, input: unknown): NetworkActResult & {
  audit?: { before: Record<string, unknown>; after: Record<string, unknown> };
} {
  const parsed = AddNetworkSpaceBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const { spaceId } = parsed.data;
  const cfg = getConfig();
  const net = visibleNetworks(caller, cfg.networks).find(n => n.id === id);
  if (!net) return notFound;
  const refusal = networkAddSpaceRefusal(caller, net, spaceId);
  if (refusal) return { status: 403, error: refusal };

  const rule = ADD_SPACE_POSITION[net.type];
  if (rule.position && networkRole(net).role !== rule.position) {
    return { status: 409, error: `Only the ${rule.position} of a ${net.type} network adds a space to it, and this instance is not the ${rule.position}.` };
  }
  if (!cfg.spaces.some(s => s.id === spaceId)) return { status: 400, error: `Unknown space: ${spaceId}` };
  if (net.spaces.includes(spaceId)) return { status: 409, error: `The network already carries '${spaceId}'.` };
  const networkSpaceId = localToRemote(net, spaceId);
  if (net.pendingRounds.some(r => r.type === 'space_addition' && !r.concluded && r.spaceId === networkSpaceId)) {
    return { status: 409, error: `A vote to add '${spaceId}' to this network is already open.` };
  }

  const before = { spaces: [...net.spaces] };
  if (!rule.direct) {
    const now = new Date().toISOString();
    const round: VoteRound = {
      roundId: uuidv4(), type: 'space_addition', spaceId: networkSpaceId,
      subjectInstanceId: cfg.instanceId, subjectLabel: cfg.instanceLabel, subjectUrl: '',
      deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(), openedAt: now, votes: [],
    };
    round.votes.push(makeSignedOwnCast(net.id, round, cfg.instanceId, 'yes'));
    openRoundHere(net, round);
    // Evaluated now: on a club, and on a network with no other member, the proposer's yes already carries it (Q-49).
    if (!concludeRoundIfReady(net, round)) {
      saveConfig(cfg);
      log.info(`Network ${net.id}: opened space_addition round ${round.roundId} for '${spaceId}'`);
      return { status: 202, body: { status: 'vote_pending', round } };
    }
  }
  net.spaces.push(spaceId);
  if (caller.id) net.spaceOrigins = recordOrigin(net.spaceOrigins ?? {}, spaceId, caller.id);
  widenPeerTokens(cfg, net, [spaceId]);
  saveConfig(cfg);
  log.info(`Network ${net.id}: added space '${spaceId}'`);
  return { status: 200, body: networkView(net), audit: { before, after: { spaces: [...net.spaces] } } };
}

export const ResolvePendingSpaceBody = z.object({
  spaceId: z.string().min(1),
  action: z.enum(['accept', 'dismiss']),
  mapTo: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
}).strict();

/** What a pending-space answer changes, ids only, for its audit row: carried, still waiting, and dismissed. */
const pendingSnapshot = (n: NetworkConfig) => ({
  spaces: [...n.spaces],
  pendingSpaces: (n.pendingSpaces ?? []).map(p => p.networkId),
  dismissedSpaces: [...(n.dismissedSpaces ?? [])],
});

/**
 * Accept or dismiss a space an upstream announced and this instance held as pending (S-9).
 *
 * An announcement is a proposal; this is the operator's answer. Accepting is judged by the rule a join runs,
 * over the ACCEPTING token (`networkJoinRefusal`): an existing local space needs `networks: write` on it or
 * administering it, a new one needs `createSpaces`. `mapTo` carries the network's space under a different local id —
 * the explicit mapping a same-id local space needs. Dismissing forgets the proposal and needs the network's settings
 * right, since it changes what the network carries here only by keeping a space out. `audit` carries before and after.
 */
export async function resolvePendingSpaceAct(caller: Caller, id: string, input: unknown): Promise<NetworkActResult & {
  audit?: { before: Record<string, unknown>; after: Record<string, unknown> };
}> {
  const parsed = ResolvePendingSpaceBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const { spaceId, action, mapTo } = parsed.data;
  const cfg = getConfig();
  const net = visibleNetworks(caller, cfg.networks).find(n => n.id === id);
  if (!net) return notFound;
  // A dismissed space can still be accepted by its id: dismissing stops the network re-proposing it, not the operator.
  const wasDismissed = net.dismissedSpaces?.includes(spaceId) ?? false;
  const entry = (net.pendingSpaces ?? []).find(p => p.networkId === spaceId)
    ?? (wasDismissed && action === 'accept' ? { networkId: spaceId, localId: remoteToLocal(net, spaceId), why: 'dismissed earlier', from: 'operator', at: new Date().toISOString() } : undefined);
  if (!entry) return { status: 404, error: `The network has no pending space '${spaceId}'.` };
  const before = pendingSnapshot(net);
  const dropPending = () => {
    net.pendingSpaces = (net.pendingSpaces ?? []).filter(p => p.networkId !== spaceId);
    if (wasDismissed) net.dismissedSpaces = net.dismissedSpaces!.filter(d => d !== spaceId);
  };

  if (action === 'dismiss') {
    const refusal = networkSettingsRefusal(caller, net);
    if (refusal) return { status: 403, error: refusal };
    dropPending();
    // Recorded, so the next announcement or passed round does not propose it again (a forgotten dismissal returned
    // on the next sync cycle, which made dismissing a snooze).
    net.dismissedSpaces = [...(net.dismissedSpaces ?? []), spaceId];
    saveConfig(cfg);
    log.info(`Network ${net.id}: dismissed pending space '${spaceId}'`);
    return { status: 200, body: networkView(net), audit: { before, after: pendingSnapshot(net) } };
  }

  const localId = mapTo ?? entry.localId;
  if (net.spaces.includes(localId)) return { status: 409, error: `The network already carries '${localId}' here.` };
  const exists = cfg.spaces.some(s => s.id === localId);
  const refusal = networkJoinRefusal(caller, exists ? { existing: [localId], toCreate: [] } : { existing: [], toCreate: [localId] });
  if (refusal) return { status: 403, error: refusal };
  dropPending();
  saveConfig(cfg);
  const added = await addSpacesToNetwork(net.id, [{ networkId: spaceId, localId }], `pending space accepted by ${caller.id ?? 'an instance admin'}`);
  const after = getConfig();
  const netAfter = after.networks.find(n => n.id === id);
  if (!netAfter || !added.includes(localId)) {
    // Put the proposal back: an accept that did not add must not silently lose it.
    if (netAfter && !(netAfter.pendingSpaces ?? []).some(p => p.networkId === spaceId)) { (netAfter.pendingSpaces ??= []).push(entry); saveConfig(after); }
    return { status: 500, error: `Could not add '${localId}' to the network; the pending entry is kept.` };
  }
  if (caller.id) netAfter.spaceOrigins = recordOrigin(netAfter.spaceOrigins ?? {}, localId, caller.id);
  saveConfig(after);
  return { status: 200, body: networkView(netAfter), audit: { before, after: pendingSnapshot(netAfter) } };
}

/**
 * Leave a network: tell its peers, remove it here, and revoke the credentials of any peer that now shares no
 * network with this instance. `warnings` names each peer that could not be told.
 */
export async function leaveNetworkAct(caller: Caller, id: string): Promise<NetworkActResult> {
  const cfg = getConfig();
  const net = visibleNetworks(caller, cfg.networks).find(n => n.id === id);
  if (!net) return notFound;
  const leaveRefusal = networkLeaveRefusal(caller, net);
  if (leaveRefusal) return { status: 403, error: leaveRefusal };

  const secrets = getSecrets();
  const warnings: string[] = [];
  await Promise.all(net.members.map(async (member) => {
    const peerToken = secrets.peerTokens[member.instanceId];
    if (!peerToken) return;
    try {
      const r = await peerSafeFetch(`${member.url}/api/notify`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ networkId: net.id, instanceId: cfg.instanceId, event: 'member_departed' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) warnings.push(`${member.label}: HTTP ${r.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`member_departed to ${member.label}: ${msg}`);
      warnings.push(`${member.label}: ${msg}`);
    }
  }));

  // Re-read after the awaits above, so a concurrent config write is not clobbered.
  const fresh = getConfig();
  const i = fresh.networks.findIndex(n => n.id === id);
  if (i >= 0) { fresh.networks.splice(i, 1); saveConfig(fresh); }
  log.info(`Deleted network id=${net.id}`);

  for (const member of net.members) {
    if (member.instanceId === cfg.instanceId) continue;
    await revokePeerCredentialsIfOrphaned(member.instanceId)
      .catch(err => log.error(`peer credential revocation for ${member.instanceId}: ${err}`));
  }
  return warnings.length ? { status: 200, body: { ok: true, warnings } } : { status: 204 };
}

// ── F-36 slice 3: an invite key, and a fork. ──────────────────────────────────────────────────────────────────

/**
 * Mint a fresh invite key for a network — reusable on pub/sub, single-use otherwise — and store only its hash.
 * Same rights as the handshake invite: instance admin, or administering every space the network carries (`F-37`).
 * A network the caller may not see is `404`.
 */
export async function inviteKeyAct(caller: Caller, id: string): Promise<NetworkActResult> {
  const cfg = getConfig();
  const net = visibleNetworks(caller, cfg.networks).find(n => n.id === id);
  if (!net) return notFound;
  const refusal = networkInviteRefusal(caller, net);
  if (refusal) return { status: 403, error: refusal };
  const key = `ythril_invite_${randomBytes(32).toString('base64url')}`;
  const inviteKeyHash = await bcrypt.hash(key, BCRYPT_ROUNDS);
  const fresh = getConfig();
  const freshNet = fresh.networks.find(n => n.id === id);
  if (!freshNet) return notFound;
  freshNet.inviteKeyHash = inviteKeyHash;
  saveConfig(fresh);
  log.info(`Generated new invite key for network ${freshNet.id}${net.type === 'pubsub' ? ' (reusable)' : ' (shown once)'}`);
  return {
    status: 200,
    body: {
      inviteKey: key,
      networkId: net.id,
      ...(net.type === 'pubsub'
        ? { reusable: true, note: 'This key is reusable — safe to publish in docs, QR codes, or share openly. Regenerating a new key revokes this one.' }
        : { reusable: false, note: 'Store this key securely — it is single-use and will not be shown again' }),
    },
  };
}

export const ForkNetworkBody = z.object({
  label: z.string().min(1).max(200),
  type: z.enum(['closed', 'club']).default('closed'),
  votingDeadlineHours: z.number().int().min(1).max(72).optional(),
  spaces: z.array(z.string().min(1)).optional(),
});

/**
 * Found a new network from an existing one — or from one this instance was ejected from, naming the spaces — with
 * no members yet. Instance-admin at both doors.
 */
export function forkNetworkAct(sourceId: string, input: unknown): NetworkActResult {
  const parsed = ForkNetworkBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const cfg = getConfig();
  const sourceNet = cfg.networks.find(n => n.id === sourceId);
  const isEjected = cfg.ejectedFromNetworks?.includes(sourceId) ?? false;
  if (!sourceNet && !isEjected) return notFound;
  const spaces = parsed.data.spaces ?? sourceNet?.spaces;
  if (!spaces || spaces.length === 0) return { status: 400, error: 'spaces is required when the source network is no longer locally available' };
  const unknownSpaces = spaces.filter(s => !cfg.spaces.some(cs => cs.id === s));
  if (unknownSpaces.length > 0) return { status: 400, error: `Unknown spaces: ${unknownSpaces.join(', ')}` };
  const forkedNet: NetworkConfig = {
    id: uuidv4(),
    label: parsed.data.label,
    type: parsed.data.type,
    spaces,
    votingDeadlineHours: parsed.data.votingDeadlineHours ?? sourceNet?.votingDeadlineHours ?? 24,
    members: [],
    pendingRounds: [],
    createdAt: new Date().toISOString(),
    origin: 'created',  // a fork is a new network this instance founded
  };
  cfg.networks.push(forkedNet);
  saveConfig(cfg);
  log.info(`Forked network ${sourceId} → new network ${forkedNet.id} ('${forkedNet.label}')`);
  return { status: 201, body: forkedNet as unknown as Record<string, unknown> };
}
