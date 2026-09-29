/**
 * A club is a mesh: every member peers with every other, not only with whoever admitted it (`Q-135`).
 *
 * Owner, 2026-09-28: two members of one club did not see each other, which is wrong in a club. An admission landed on the
 * admitting instance alone, so two members admitted by one organiser never learned of each other: every record
 * between them travelled through the organiser, and the club stopped when it did. A removal landed the same way.
 *
 * ## The rule, in three parts, and this module is the only place any of them is written
 *
 * 1. **A roster says when each member was admitted**, and a removal says when it happened. Every club admission
 *    stamps `admittedAt` (`stampAdmission`) and every club removal records a `MemberRemoval` (`recordRemoval`), so a
 *    peer comparing the two compares the SAME acts: the later one wins, wherever it arrives from.
 * 2. **A peer's roster introduces the members it lists and removes the ones it removed** (`mergePeerRoster`), read
 *    during the gossip exchange every sync cycle already makes — so an existing club heals on its next cycle.
 * 3. **Two introduced members pair directly** (`pairIntroduced`, `answerPairing`, `confirmPairing`). Credentials are
 *    pairwise and each side mints its own, so an introduction is not a membership until both have.
 *
 * ## Why a peer's roster may introduce at all
 *
 * A club member already holds every space the club carries, with a token that writes to them. So an introduction
 * hands nobody data or reach a member could not already relay — which is also why this is club-only. On a voted
 * network (`Q-154`) an admission is the network's decision, and one member's roster must not stand in for a vote;
 * a pub/sub subscriber peers with its publisher alone, and a tree node with its parent and children, by design.
 *
 * ## Why the pairing is safe with an anonymous first call
 *
 * The lower instance id opens: it mints a token for the newcomer and hands it over on `POST .../pair`, which carries
 * no credential because the caller has none yet. The newcomer believes none of it: it answers only an instance its
 * OWN peers introduced, and it proves the caller by calling back the address that introduction vouched for —
 * never one the request names — presenting the token it was handed. The opener's confirm route accepts exactly the
 * token it recorded minting for that pairing, so a forged `/pair` costs a mint and a revoke and gains nothing.
 */
import bcrypt from 'bcrypt';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { createToken, revokeToken, adoptPeerToken, revokePeerCredentialsIfOrphaned } from '../auth/tokens.js';
import { peerTokenSpaces } from '../auth/peer-token-scope.js';
import { peerSafeFetch, isPeerUrlAllowed } from '../sync/peer-fetch.js';
import { widenPeerTokensOf } from './network-spaces.js';
import { BCRYPT_ROUNDS } from '../api/networks/_shared.js';
import { log } from '../util/log.js';
import { boundedErrorText } from '../util/bounded-read.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import type { MemberIntroduction, MemberRemoval } from '../config/types-networks.js';

/** How long an opener waits before trying a pairing that failed again. The sync cycle is the clock. */
export const PAIR_RETRY_MS = 5 * 60_000;
/** How long a token minted for a pairing lives before the pairing completes and lifts the expiry. */
const PAIRING_TOKEN_TTL_MS = 10 * 60_000;
/** Removals kept per network. Oldest dropped first: a removal older than every admission it could beat is inert. */
export const MAX_REMOVALS = 1000;

/** Whether members of this network pair with each other. Club only — see the module docblock for why. */
export function isMeshNetwork(net: Pick<NetworkConfig, 'type'>): boolean {
  return net.type === 'club';
}

const time = (iso?: string): number => (iso ? Date.parse(iso) || 0 : 0);
const nowIso = (): string => new Date().toISOString();

/** Stamp an admission made HERE, and forget any removal and introduction of the same instance it supersedes. */
export function stampAdmission(net: NetworkConfig, member: NetworkMember, at: string = nowIso()): void {
  if (!isMeshNetwork(net)) return;
  member.admittedAt ??= at;
  net.removedMembers = (net.removedMembers ?? []).filter(r => r.instanceId !== member.instanceId);
  net.introductions = (net.introductions ?? []).filter(i => i.instanceId !== member.instanceId);
}

/** Record a removal, so it is answered to peers beside the roster and a stale roster cannot bring the member back. */
export function recordRemoval(net: NetworkConfig, instanceId: string, at: string = nowIso()): void {
  if (!isMeshNetwork(net)) return;
  const kept = (net.removedMembers ?? []).filter(r => r.instanceId !== instanceId);
  kept.push({ instanceId, removedAt: at });
  net.removedMembers = kept.slice(-MAX_REMOVALS);
  net.introductions = (net.introductions ?? []).filter(i => i.instanceId !== instanceId);
}

function readRemovals(raw: unknown): MemberRemoval[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is MemberRemoval =>
    !!r && typeof r.instanceId === 'string' && typeof r.removedAt === 'string' && time(r.removedAt) > 0);
}

/**
 * Apply one peer's roster answer to this network: its removals first, then its members as introductions.
 *
 * Mutates `net`; the caller saves. Returns whether anything changed and which members were removed, so the caller
 * can revoke their credentials AFTER the save (a revoke reads the saved config to decide whether it is orphaned).
 */
export function mergePeerRoster(
  net: NetworkConfig,
  selfId: string,
  fromId: string,
  peerMembers: readonly Partial<NetworkMember>[],
  peerRemoved: unknown,
): { changed: boolean; removed: string[] } {
  const out = { changed: false, removed: [] as string[] };
  if (!isMeshNetwork(net)) return out;

  for (const r of readRemovals(peerRemoved)) {
    // Never ourselves (an ejection has its own notice), and never the peer that is answering.
    if (r.instanceId === selfId || r.instanceId === fromId) continue;
    const idx = net.members.findIndex(m => m.instanceId === r.instanceId);
    if (idx >= 0) {
      if (time(r.removedAt) <= time(net.members[idx]!.admittedAt)) continue;
      net.members.splice(idx, 1);
      out.removed.push(r.instanceId);
      log.info(`Club ${net.id}: ${r.instanceId} removed here too — ${fromId} removed it at ${r.removedAt}`);
    }
    const known = net.removedMembers?.find(x => x.instanceId === r.instanceId);
    if (!known || time(known.removedAt) < time(r.removedAt)) {
      // Kept either way, so it travels on to members that have not heard of it yet.
      recordRemoval(net, r.instanceId, r.removedAt);
      out.changed = true;
    }
  }
  if (out.removed.length) out.changed = true;

  for (const rec of peerMembers) {
    const id = rec.instanceId;
    if (!id || id === selfId || id === fromId || !rec.url || !rec.label) continue;
    if (net.members.some(m => m.instanceId === id)) continue;
    if ((net.introductions ?? []).some(i => i.instanceId === id)) continue;
    const removal = net.removedMembers?.find(x => x.instanceId === id);
    if (removal && time(removal.removedAt) >= time(rec.admittedAt)) continue;
    if (!isPeerUrlAllowed(rec.url)) {
      log.warn(`Club ${net.id}: ${fromId} introduced ${id} at an address this instance refuses to call: ${rec.url}`);
      continue;
    }
    const intro: MemberIntroduction = {
      instanceId: id, label: rec.label, url: rec.url, introducedBy: fromId, introducedAt: nowIso(),
      ...(rec.admittedAt ? { admittedAt: rec.admittedAt } : {}),
    };
    (net.introductions ??= []).push(intro);
    out.changed = true;
    log.info(`Club ${net.id}: ${fromId} introduced ${rec.label} (${id}); pairing follows`);
  }
  return out;
}

/** Revoke what removed members held here, once the removal is saved. Never throws. */
export function revokeRemoved(ids: readonly string[]): void {
  for (const id of ids) {
    revokePeerCredentialsIfOrphaned(id).catch(err => log.error(`peer credential revocation for ${id}: ${err}`));
  }
}

/** The member an introduction becomes once both sides hold a token for each other. */
function memberFrom(intro: MemberIntroduction, tokenHash: string): NetworkMember {
  return {
    instanceId: intro.instanceId, label: intro.label, url: intro.url, tokenHash, direction: 'both',
    lastSeqReceived: {}, introducedBy: intro.introducedBy,
    ...(intro.admittedAt ? { admittedAt: intro.admittedAt } : {}),
  };
}

/**
 * Turn an introduction into a member, on the config as it is NOW. Hashed before the read, because a reference
 * held across an await is orphaned by a config reload (the same window `api/invite.ts` finalize documents).
 */
async function admitIntroduced(networkId: string, instanceId: string, outboundToken: string, tokenId: string): Promise<boolean> {
  const tokenHash = await bcrypt.hash(outboundToken, BCRYPT_ROUNDS);
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  const intro = net?.introductions?.find(i => i.instanceId === instanceId);
  if (!net || !intro || net.members.some(m => m.instanceId === instanceId)) return false;
  net.members.push(memberFrom(intro, tokenHash));
  net.introductions = net.introductions!.filter(i => i.instanceId !== instanceId);
  const secrets = getSecrets();
  secrets.peerTokens[instanceId] = outboundToken;
  saveSecrets(secrets);
  widenPeerTokensOf(cfg, [instanceId], net.spaces);
  saveConfig(cfg);
  await adoptPeerToken(tokenId);   // live now, and it replaces what an earlier handshake gave that peer (Q-163)
  log.info(`Club ${networkId}: paired with ${intro.label} (${instanceId})`);
  return true;
}

function noteAttempt(networkId: string, instanceId: string, patch: Partial<MemberIntroduction>): void {
  const cfg = getConfig();
  const intro = cfg.networks.find(n => n.id === networkId)?.introductions?.find(i => i.instanceId === instanceId);
  if (!intro) return;
  Object.assign(intro, patch);
  if (patch.lastError === undefined) delete intro.lastError;
  saveConfig(cfg);
}

async function mintPairingToken(net: NetworkConfig, intro: MemberIntroduction) {
  return createToken({
    name: `peer:${intro.label} (club pairing)`,
    // Expires unless the pairing completes, which lifts it: a token minted for a pairing that never finished belongs
    // to nothing, the way a handshake's token belongs to nothing until finalize.
    expiresAt: new Date(Date.now() + PAIRING_TOKEN_TTL_MS).toISOString(),
    spaces: peerTokenSpaces(intro.instanceId, net.spaces),
    peerInstanceId: intro.instanceId,
  });
}

const inFlight = new Set<string>();

type Answer = { status: number; body: Record<string, unknown> };

async function errorText(r: Response): Promise<string> {
  const text = await boundedErrorText(r);
  try { return (JSON.parse(text) as { error?: string }).error ?? `HTTP ${r.status}`; } catch { return `HTTP ${r.status}`; }
}

/**
 * The opener's half, once per sync cycle: pair with every introduced member this instance is due to open for.
 * Best-effort and never throws — a failure is recorded on the introduction, where the network view shows it.
 */
export async function pairIntroduced(networkId: string): Promise<void> {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net || !isMeshNetwork(net)) return;
  for (const intro of [...(net.introductions ?? [])]) {
    // The lower id opens, so two members never open towards each other at once.
    if (!(cfg.instanceId < intro.instanceId)) continue;
    if (Date.now() - time(intro.lastAttemptAt) < PAIR_RETRY_MS) continue;
    await openPairing(networkId, intro.instanceId).catch(err => log.warn(`Club ${networkId}: pairing with ${intro.instanceId}: ${err}`));
  }
}

async function openPairing(networkId: string, instanceId: string): Promise<void> {
  const key = `${networkId}:${instanceId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  let tokenId: string | undefined;
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === networkId);
    const intro = net?.introductions?.find(i => i.instanceId === instanceId);
    if (!net || !intro) return;
    const { record, plaintext } = await mintPairingToken(net, intro);
    tokenId = record.id;
    // Recorded BEFORE the call: the newcomer confirms by calling back while this request is still open.
    noteAttempt(networkId, instanceId, { pairingTokenId: record.id, lastAttemptAt: nowIso(), lastError: undefined });
    const r = await peerSafeFetch(`${intro.url}/api/sync/networks/${encodeURIComponent(networkId)}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: cfg.instanceId, label: cfg.instanceLabel, token: plaintext }),
    });
    const paired = getConfig().networks.find(n => n.id === networkId)?.members.some(m => m.instanceId === instanceId);
    if (paired) { tokenId = undefined; return; }
    const why = r.ok ? 'the newcomer answered without confirming the pairing' : await errorText(r);
    noteAttempt(networkId, instanceId, { lastError: why });
    log.warn(`Club ${networkId}: pairing with ${intro.label} (${instanceId}) failed: ${why}`);
  } catch (err) {
    noteAttempt(networkId, instanceId, { lastError: String(err) });
    throw err;
  } finally {
    inFlight.delete(key);
    const stillPending = getConfig().networks.find(n => n.id === networkId)?.members.every(m => m.instanceId !== instanceId);
    if (tokenId && stillPending) await revokeToken(tokenId).catch(() => {});
  }
}

/**
 * The newcomer's half: `POST /api/sync/networks/:id/pair`, called by an instance with no credential here yet.
 * Answered only for an instance this instance was introduced to, and proven by calling back its introduced address.
 */
export async function answerPairing(networkId: string, b: { instanceId: string; token: string }): Promise<Answer> {
  const instanceId = b.instanceId;
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  // One answer for a network that is missing and one that is not a club: neither tells a stranger what exists.
  if (!net || !isMeshNetwork(net)) return { status: 404, body: { error: 'No club with this id pairs here' } };
  if (net.members.some(m => m.instanceId === instanceId)) return { status: 409, body: { error: 'Already a member here' } };
  const intro = net.introductions?.find(i => i.instanceId === instanceId);
  if (!intro) return { status: 403, body: { error: 'No member of this club has introduced that instance here yet' } };
  const key = `${networkId}:${instanceId}`;
  if (inFlight.has(key)) return { status: 409, body: { error: 'A pairing with that instance is already in progress' } };
  inFlight.add(key);
  let tokenId: string | undefined;
  try {
    const { record, plaintext } = await mintPairingToken(net, intro);
    tokenId = record.id;
    const r = await peerSafeFetch(`${intro.url}/api/sync/networks/${encodeURIComponent(networkId)}/pair/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
      body: JSON.stringify({ instanceId: cfg.instanceId, token: plaintext }),
    });
    if (!r.ok) {
      const why = await errorText(r);
      noteAttempt(networkId, instanceId, { lastAttemptAt: nowIso(), lastError: `confirm refused: ${why}` });
      return { status: 502, body: { error: `The introduced address did not confirm the pairing: ${why}` } };
    }
    await admitIntroduced(networkId, instanceId, b.token, record.id);
    tokenId = undefined;
    return { status: 200, body: { status: 'paired', instanceId: cfg.instanceId } };
  } catch (err) {
    noteAttempt(networkId, instanceId, { lastAttemptAt: nowIso(), lastError: String(err) });
    return { status: 502, body: { error: `Could not reach the introduced address: ${err}` } };
  } finally {
    inFlight.delete(key);
    if (tokenId) await revokeToken(tokenId).catch(() => {});
  }
}

/**
 * The opener's confirmation: `POST /api/sync/networks/:id/pair/confirm`, called back by the newcomer with the token
 * this instance handed it. Only that exact token, minted for that pairing, is accepted.
 */
export async function confirmPairing(
  networkId: string,
  caller: { id?: string; peerInstanceId?: string } | undefined,
  b: { instanceId: string; token: string },
): Promise<Answer> {
  const net = getConfig().networks.find(n => n.id === networkId);
  const intro = net && isMeshNetwork(net) ? net.introductions?.find(i => i.instanceId === b.instanceId) : undefined;
  if (!intro?.pairingTokenId || caller?.id !== intro.pairingTokenId || caller.peerInstanceId !== b.instanceId) {
    return { status: 403, body: { error: 'This token opened no pairing with that instance' } };
  }
  const admitted = await admitIntroduced(networkId, b.instanceId, b.token, intro.pairingTokenId);
  return admitted
    ? { status: 200, body: { status: 'paired' } }
    : { status: 409, body: { error: 'The pairing is no longer pending here' } };
}

/** An introduction as a caller may see it: the token id this instance minted is its own bookkeeping. */
export function introductionView(intro: MemberIntroduction): Omit<MemberIntroduction, 'pairingTokenId'> {
  const { pairingTokenId: _p, ...rest } = intro;
  return rest;
}
