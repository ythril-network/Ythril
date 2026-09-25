/**
 * The network acts — read, create, update, leave — once, for both doors (`F-36`).
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
import { networkCreateRefusal, networkLeaveRefusal, networkSettingsRefusal, visibleNetworks } from '../auth/network-rights.js';
import { recordOrigin } from '../auth/network-membership.js';
import { revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { getConfig, saveConfig, getSecrets } from '../config/loader.js';
import type { NetworkConfig } from '../config/types.js';
import { syncScheduleRefusal } from '../sync/schedule.js';
import { MIN_PEER_VERSION, peerFloorRefusal } from '../sync/peer-floor.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { log } from '../util/log.js';
import { networkRole } from './network-role.js';

type Caller = Parameters<typeof visibleNetworks>[0] & { id?: string };

/** What an act answers: the HTTP status IS the contract, so both doors carry it. */
export type NetworkActResult =
  | { status: 200 | 201; body: Record<string, unknown> }
  | { status: 204; body?: undefined }
  | { status: 400 | 403 | 404 | 409; error: string };

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
