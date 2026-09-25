/**
 * A braintree's topology — reparent this instance, adopt a member, revert a member's parent — once, for both doors
 * (`F-36`, slice 5). These were the bodies of the three topology routes, moved unchanged so the route and the MCP
 * tool call one implementation. All three stay instance-admin: topology is an act on the network as a whole.
 */
import { z } from 'zod';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { log } from '../util/log.js';
import { SSRF_SAFE_URL } from '../api/networks/_shared.js';
import type { NetworkActResult } from './network-acts.js';

export const ReparentSelfBody = z.object({
  /** instanceId of the new parent (e.g. grandparent) */
  newParentInstanceId: z.string().uuid(),
  newParentLabel: z.string().min(1).max(200),
  newParentUrl: SSRF_SAFE_URL,
  /** Plaintext token (decrypted from the invite apply response) to call the new parent */
  tokenForNewParent: z.string().min(1),
  /** instanceId of the original parent that is offline */
  originalParentInstanceId: z.string().uuid(),
});

/**
 * Called by a node on ITSELF after completing the invite apply step. Records the new parent in the local config so
 * this node knows it is temporarily connected to a grandparent rather than its original parent.
 */
export function reparentSelfAct(networkId: string, input: unknown): NetworkActResult {
  const parsed = ReparentSelfBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };
  if (net.type !== 'braintree') return { status: 400, error: 'reparent-self is only valid for braintree networks' };

  const { newParentInstanceId, newParentLabel, newParentUrl, tokenForNewParent, originalParentInstanceId } = parsed.data;

  // Upsert the new parent in the local member list so the engine can report status
  const existing = net.members.find(m => m.instanceId === newParentInstanceId);
  if (!existing) {
    net.members.push({
      instanceId: newParentInstanceId,
      label: newParentLabel,
      url: newParentUrl,
      tokenHash: '',   // no inbound auth needed on this side — new parent pushes TO us
      direction: 'push',
    });
  }

  // Store the outbound token so this engine can call the new parent if needed
  const secrets = getSecrets();
  secrets.peerTokens[newParentInstanceId] = tokenForNewParent;
  saveSecrets(secrets);

  // Mark the temporary reparent state
  net.temporaryReparent = {
    newParentInstanceId,
    originalParentInstanceId,
    reparentedAt: new Date().toISOString(),
  };

  saveConfig(cfg);
  log.info(`reparent-self: network ${net.id} — new parent ${newParentInstanceId} (was ${originalParentInstanceId})`);
  return { status: 200, body: { status: 'reparented', newParentInstanceId, originalParentInstanceId } };
}

/**
 * Called on the GRANDPARENT side. Makes a temporary reparent permanent by clearing originalParentInstanceId from the
 * grandchild's member record.
 */
export function adoptMemberAct(networkId: string, instanceId: string): NetworkActResult {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };

  const member = net.members.find(m => m.instanceId === instanceId);
  if (!member) return { status: 404, error: 'Member not found' };
  if (!member.originalParentInstanceId) {
    return { status: 409, error: 'Member is not in a temporary reparent state' };
  }

  const oldOriginal = member.originalParentInstanceId;
  delete member.originalParentInstanceId;
  saveConfig(cfg);

  log.info(`Permanent adoption: '${member.label}' (${member.instanceId}) adopted from ${oldOriginal} in network ${net.id}`);
  return { status: 200, body: { status: 'adopted', instanceId: member.instanceId, parentInstanceId: member.parentInstanceId } };
}

/**
 * Called on the GRANDPARENT side when the original parent is back online. Restores the topology: the grandchild
 * re-parents to its original parent.
 */
export function revertParentAct(networkId: string, instanceId: string): NetworkActResult {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };

  const member = net.members.find(m => m.instanceId === instanceId);
  if (!member) return { status: 404, error: 'Member not found' };
  if (!member.originalParentInstanceId) {
    return { status: 409, error: 'Member is not in a temporary reparent state' };
  }

  // Restore original parent
  const restoredParentId = member.originalParentInstanceId;
  member.parentInstanceId = restoredParentId;
  delete member.originalParentInstanceId;

  // Move member from this instance's children back to original parent's children
  const selfInNet = net.members.find(m => m.instanceId === cfg.instanceId);
  if (selfInNet?.children) {
    selfInNet.children = selfInNet.children.filter(c => c !== member.instanceId);
  }
  const originalParent = net.members.find(m => m.instanceId === restoredParentId);
  if (originalParent?.children && !originalParent.children.includes(member.instanceId)) {
    originalParent.children.push(member.instanceId);
  }

  // Remove direct outbound token — grandparent no longer pushes directly
  const secrets = getSecrets();
  delete secrets.peerTokens[member.instanceId];
  saveSecrets(secrets);

  saveConfig(cfg);
  log.info(`Parent reverted: '${member.label}' (${member.instanceId}) re-parented back to ${restoredParentId} in network ${net.id}`);
  return { status: 200, body: { status: 'reverted', instanceId: member.instanceId, parentInstanceId: restoredParentId } };
}
