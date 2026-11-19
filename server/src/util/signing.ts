/**
 * Instance signing keys and vote-cast signatures.
 *
 * Each brain owns a persistent Ed25519 keypair: the private key lives in
 * secrets.json (never leaves the box), the public key lives in config.json and
 * is published to peers via the member-gossip `self` record (trust-on-first-use
 * pinning — see NetworkMember.signingPublicKey).
 *
 * A vote cast is signed ONCE by the voting instance over a canonical message
 * that binds the network, round, subject, voter and vote value. The signature
 * travels with the cast, so ANY node can verify a cast regardless of which peer
 * relayed it. This is what makes multi-hop vote relay safe: a relayed cast is
 * accepted only if its signature verifies against the voter's pinned key, so a
 * peer can neither forge another member's vote nor tamper with a relayed one.
 *
 * Ed25519 is used (not RSA): tiny keys/signatures, deterministic, no digest
 * configuration, and `crypto.sign(null, …)` / `crypto.verify(null, …)` operate
 * directly on the message.
 */

import crypto from 'node:crypto';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { peerRunsAtLeast } from '../sync/peer-floor.js';
import { sha256Hex } from './sha256-hex.js';
import { canonicalConvertRecordsText } from '@ythril-network/schema/internal';
import type { NetworkConfig, NetworkMember, VoteRound, VoteCast } from '../config/types.js';

export interface InstanceKeypair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Generate a fresh Ed25519 instance keypair (SPKI/PKCS8 PEM). */
export function generateInstanceKeypair(): InstanceKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * Canonical message signed for a vote cast. Binding all five fields prevents a
 * signature from being replayed onto a different network, round, subject, voter
 * or vote value.
 */
export function voteCastMessage(params: {
  networkId: string;
  roundId: string;
  subjectInstanceId: string;
  instanceId: string;
  vote: string;
}): string {
  return [
    'ythril-vote:v1',
    params.networkId,
    params.roundId,
    params.subjectInstanceId,
    params.instanceId,
    params.vote,
  ].join('|');
}

/**
 * The version from which a voter signs `bsig` (`Q-138`). A cast WITHOUT one from a voter known to run this or later
 * is refused: a relayer that strips the bound signature must not be able to fall back to the v1 check that it
 * defeats. From an older or unknown voter the v1 check stands — the transition, until every member upgrades.
 */
export const BOUND_CASTS_SINCE = '5.6.0';

/**
 * What a round would DO, as a cast's bound signature covers it (`Q-138`): its type and its target. `pendingMeta` is
 * not here: a sender inlines library references into it on the way out (`roundForPeer`), so honest copies differ.
 * `wipeTypes` is sorted and deduplicated, because neither its order nor a repeat is content: adoption stores the list canonical
 * (bundle-106, X11), and a cast signed over the list as an older proposer sent it must verify against what is stored.
 */
function roundTargetFields(round: Pick<VoteRound, 'type' | 'spaceId' | 'networkSpaceId' | 'wipeTypes' | 'rebase'>): string[] {
  const fields = [round.type, round.spaceId ?? '', round.networkSpaceId ?? '', [...new Set(round.wipeTypes ?? [])].sort().join(',')];
  // Q-748: a `space_rebase` round's target is also the base it moves to, so a relayer cannot change it. Appended for that type ONLY: every
  // other type's message stays byte-identical, and a member of an earlier release verifies every cast it verified before.
  if (round.type !== 'space_rebase') return fields;
  return [...fields, round.rebase?.base ?? '', round.rebase?.vocab ?? '', String(round.rebase?.epoch ?? '')];
}

/**
 * The message a cast's `bsig` signs: the v1 fields, then the round's type and target (`Q-138`). A v1 signature binds
 * the round's id, so a relayer could rewrite what the round deletes or wipes and every honest cast still verified.
 */
export function voteCastBoundMessage(params: {
  networkId: string;
  roundId: string;
  subjectInstanceId: string;
  instanceId: string;
  vote: string;
  round: Pick<VoteRound, 'type' | 'spaceId' | 'networkSpaceId' | 'wipeTypes' | 'rebase'>;
}): string {
  return ['ythril-vote:v2', params.networkId, params.roundId, params.subjectInstanceId, params.instanceId, params.vote,
    ...roundTargetFields(params.round)].join('|');
}

/**
 * The message a cast's `csig` signs (`Q-745`): the v2 bound message, then the hash of the canonical text of the round's `convertRecords`.
 *
 * **Why a third signature and not a field of `bsig`'s message.** A member of a release before this one builds the `bsig` message without
 * `convertRecords` and verifies the cast as given, so a hash of the steps inside it would make that member refuse every cast of a round that
 * carries steps, and the schema vote itself would fail on it. `csig` is added BESIDE `sig` and `bsig`, which stay what they were: an older member
 * verifies what it always did and never reads `csig`.
 *
 * Throws for a `convertRecords` that is not one (`canonicalConvertRecordsText`): there is no text of it, so nothing can have been signed over it.
 */
export function convertRecordsCastMessage(params: {
  networkId: string;
  roundId: string;
  subjectInstanceId: string;
  instanceId: string;
  vote: string;
  round: Pick<VoteRound, 'type' | 'spaceId' | 'networkSpaceId' | 'wipeTypes' | 'rebase'>;
  convertRecords: unknown;
}): string {
  const { convertRecords, ...bound } = params;
  return ['ythril-vote:v3-convert', voteCastBoundMessage(bound), sha256Hex(canonicalConvertRecordsText(convertRecords))].join('|');
}

/**
 * A cast as it crosses the wire, and back — ONE shape for the push, the relay route and the merge, so a signature
 * field added later cannot be dropped by one of three hand-written copies (it was three, and `bsig` would have been
 * lost by each).
 */
export function castForWire(cast: VoteCast): VoteCast {
  return {
    instanceId: cast.instanceId, vote: cast.vote, castAt: cast.castAt,
    ...(cast.sig ? { sig: cast.sig } : {}), ...(cast.bsig ? { bsig: cast.bsig } : {}), ...(cast.csig ? { csig: cast.csig } : {}),
  };
}

/** A cast read from a request body or a peer's round, or `null` when it is not one. */
export function castFromBody(body: unknown): VoteCast | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  if (typeof b['instanceId'] !== 'string' || !b['instanceId'] || (b['vote'] !== 'yes' && b['vote'] !== 'veto')) return null;
  return {
    instanceId: b['instanceId'], vote: b['vote'],
    castAt: typeof b['castAt'] === 'string' ? b['castAt'] : new Date().toISOString(),
    ...(typeof b['sig'] === 'string' && b['sig'] ? { sig: b['sig'] } : {}),
    ...(typeof b['bsig'] === 'string' && b['bsig'] ? { bsig: b['bsig'] } : {}),
    ...(typeof b['csig'] === 'string' && b['csig'] ? { csig: b['csig'] } : {}),
  };
}

/** Sign a message with an Ed25519 private key PEM; returns base64. Empty on failure. */
export function signMessage(privateKeyPem: string, message: string): string {
  try {
    const key = crypto.createPrivateKey(privateKeyPem);
    return crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
  } catch (err) {
    log.warn(`signMessage failed: ${peerText(err)}`);
    return '';
  }
}

/** Verify a base64 Ed25519 signature over `message` against a public key PEM. */
export function verifyMessage(publicKeyPem: string, message: string, sigB64: string): boolean {
  if (!publicKeyPem || !sigB64) return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// ── Instance keypair lifecycle ───────────────────────────────────────────────

/**
 * Ensure this instance has a persistent signing keypair. Generates one on first
 * call (private key → secrets.json, public key → config.json) and is a no-op
 * afterwards. Safe to call at startup and after setup. Returns the keypair, or
 * null if config/secrets are not yet available (pre-setup).
 */
export function ensureInstanceKeypair(): InstanceKeypair | null {
  let cfg;
  try {
    cfg = getConfig();
  } catch {
    return null; // config not loaded yet (pre-setup)
  }
  const secrets = getSecrets();

  const havePriv = typeof secrets.signingPrivateKey === 'string' && secrets.signingPrivateKey.length > 0;
  const havePub = typeof cfg.signingPublicKey === 'string' && cfg.signingPublicKey.length > 0;
  if (havePriv && havePub) {
    return { publicKeyPem: cfg.signingPublicKey!, privateKeyPem: secrets.signingPrivateKey! };
  }

  const kp = generateInstanceKeypair();
  secrets.signingPrivateKey = kp.privateKeyPem;
  saveSecrets(secrets);
  cfg.signingPublicKey = kp.publicKeyPem;
  saveConfig(cfg);
  log.info('Generated persistent Ed25519 instance signing keypair.');
  return kp;
}

/** Return this instance's signing keypair, or null if not yet initialised. */
export function getInstanceKeypair(): InstanceKeypair | null {
  let cfg;
  try {
    cfg = getConfig();
  } catch {
    return null;
  }
  const secrets = getSecrets();
  if (!secrets.signingPrivateKey || !cfg.signingPublicKey) return null;
  return { publicKeyPem: cfg.signingPublicKey, privateKeyPem: secrets.signingPrivateKey };
}

/** This instance's own public signing key (PEM), or undefined if not initialised. */
export function getSigningPublicKey(): string | undefined {
  try {
    return getConfig().signingPublicKey;
  } catch {
    return undefined;
  }
}

/**
 * Sign a vote cast for THIS instance. Returns a base64 signature, or '' when no
 * keypair is available (the cast then travels unsigned and is accepted by peers
 * only via the own-cast compatibility path, not by relay).
 */
export function signOwnVoteCast(params: {
  networkId: string;
  roundId: string;
  subjectInstanceId: string;
  instanceId: string;
  vote: string;
}): string {
  const kp = getInstanceKeypair();
  if (!kp) return '';
  return signMessage(kp.privateKeyPem, voteCastMessage(params));
}

/**
 * Build this instance's own vote cast, signed when a signing key is available: the v1 `sig` every version checks, and
 * `bsig` over the round's type and target (`Q-138`), which a 5.6.0 receiver requires of a voter it knows is current.
 */
export function makeSignedOwnCast(networkId: string, round: VoteRound, instanceId: string, vote: 'yes' | 'veto'): VoteCast {
  const base = { networkId, roundId: round.roundId, subjectInstanceId: round.subjectInstanceId, instanceId, vote };
  const sig = signOwnVoteCast(base);
  const kp = getInstanceKeypair();
  const bsig = kp ? signMessage(kp.privateKeyPem, voteCastBoundMessage({ ...base, round })) : '';
  const csig = kp ? signConvertRecords(kp.privateKeyPem, base, round) : '';
  return { instanceId, vote, castAt: new Date().toISOString(), ...(sig ? { sig } : {}), ...(bsig ? { bsig } : {}), ...(csig ? { csig } : {}) };
}

/**
 * The `csig` of a cast: only the PROPOSER's cast of a round that carries `convertRecords` has one (`Q-745`) — a member that votes on a round it
 * did not propose signs nothing over steps it did not choose. A `convertRecords` that is not one gets none rather than a throw: a member's own
 * cast must still be made, and a round whose steps no one could sign is read by every member as unsigned, which applies the schema and no steps.
 */
function signConvertRecords(privateKeyPem: string, base: { networkId: string; roundId: string; subjectInstanceId: string; instanceId: string; vote: string }, round: VoteRound): string {
  if (round.convertRecords === undefined || base.instanceId !== round.subjectInstanceId) return '';
  try {
    return signMessage(privateKeyPem, convertRecordsCastMessage({ ...base, round, convertRecords: round.convertRecords }));
  } catch (err) {
    log.warn(`round ${peerText(round.roundId)} carries convertRecords that cannot be signed, so its steps will read as unsigned: ${peerText(err)}`);
    return '';
  }
}

// ── Key rotation ─────────────────────────────────────────────────────────────

/** A signed proof that a new signing key supersedes a previous one. */
export interface SigningKeyRotation {
  /** The public key that was in use before this rotation. */
  previousPublicKey: string;
  /** base64 signature by the PREVIOUS private key over the rotation message. */
  proof: string;
}

/**
 * Canonical message signed by the OLD private key to prove that `newPublicKey`
 * is a legitimate successor for `instanceId`. Binding the instanceId prevents a
 * proof from being reused for a different instance.
 */
export function keyRotationMessage(params: { instanceId: string; newPublicKey: string }): string {
  return ['ythril-keyrot:v1', params.instanceId, params.newPublicKey].join('|');
}

/**
 * The fingerprint of a public key: the SHA-256 of its PEM text, as hex. What an audit entry says of a key (`signing.rotate`): enough to tell
 * which key a peer pinned, and nothing a signature could be forged from.
 */
export function publicKeyFingerprint(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(publicKeyPem).digest('hex');
}

/**
 * Rotate this instance's signing keypair, producing a continuity proof signed by
 * the OLD key so peers who pinned the old key can safely adopt the new one. The
 * new private key replaces the old in secrets.json; the new public key and the
 * rotation proof are written to config.json (published to peers via gossip).
 * Returns the new public key, or null if config/secrets are unavailable.
 */
export function rotateInstanceKeypair(): { publicKeyPem: string } | null {
  let cfg;
  try { cfg = getConfig(); } catch { return null; }
  const secrets = getSecrets();
  const old = getInstanceKeypair();

  const next = generateInstanceKeypair();
  secrets.signingPrivateKey = next.privateKeyPem;
  cfg.signingPublicKey = next.publicKeyPem;

  if (old) {
    // Prove continuity: sign the new key with the old private key.
    const proof = signMessage(old.privateKeyPem, keyRotationMessage({ instanceId: cfg.instanceId, newPublicKey: next.publicKeyPem }));
    cfg.signingKeyRotation = { previousPublicKey: old.publicKeyPem, proof };
    log.info('Rotated Ed25519 instance signing keypair (continuity proof generated).');
  } else {
    // No prior key — nothing to chain from; peers pin the new key trust-on-first-use.
    delete cfg.signingKeyRotation;
    log.info('Generated Ed25519 instance signing keypair (no prior key to rotate from).');
  }

  saveSecrets(secrets);
  saveConfig(cfg);
  return { publicKeyPem: next.publicKeyPem };
}

/** The current rotation proof to advertise to peers, or undefined if none. */
export function getSigningKeyRotation(): SigningKeyRotation | undefined {
  try {
    return getConfig().signingKeyRotation;
  } catch {
    return undefined;
  }
}

/**
 * Verify that `rotation` proves `newKey` legitimately supersedes `currentPinned`
 * for `instanceId` — i.e. it was signed by the currently-pinned key.
 */
export function isValidKeyRotation(
  instanceId: string,
  currentPinned: string,
  newKey: string,
  rotation: SigningKeyRotation | undefined,
): boolean {
  if (!rotation || rotation.previousPublicKey !== currentPinned) return false;
  return verifyMessage(currentPinned, keyRotationMessage({ instanceId, newPublicKey: newKey }), rotation.proof);
}

// ── Key distribution (trust-on-first-use + signed rotation) ───────────────────

/**
 * Pin a member's signing public key. Trust-on-first-use when absent. A change to
 * a DIFFERENT key is accepted only when accompanied by a valid rotation proof
 * signed by the currently-pinned key (continuity of control); otherwise it is
 * refused — preventing a peer from swapping another member's key to impersonate
 * it. Returns true when the member record was modified.
 */
export function pinMemberSigningKey(
  member: NetworkMember,
  incomingKey: string | undefined,
  rotation?: SigningKeyRotation,
): boolean {
  if (!incomingKey || typeof incomingKey !== 'string') return false;
  if (!member.signingPublicKey) {
    member.signingPublicKey = incomingKey;
    return true;
  }
  if (member.signingPublicKey === incomingKey) return false;

  if (isValidKeyRotation(member.instanceId, member.signingPublicKey, incomingKey, rotation)) {
    log.info(`Accepted signed key rotation for member '${peerText(member.instanceId)}' — re-pinning to the new key.`);
    member.signingPublicKey = incomingKey;
    return true;
  }
  log.warn(
    `Refusing to change pinned signing key for member '${peerText(member.instanceId)}' — no valid rotation proof (possible impersonation).`,
  );
  return false;
}

/**
 * Force-set a member's pinned signing key WITHOUT a rotation proof — the
 * break-glass recovery path used when a member lost its old private key (so it
 * cannot produce a continuity proof). Admin-gated at the API layer.
 */
export function forceSetMemberSigningKey(member: NetworkMember, key: string): void {
  member.signingPublicKey = key;
  log.warn(`Admin force-set signing key for member '${peerText(member.instanceId)}' (manual re-pin).`);
}

// ── Vote-cast verification & relay acceptance ────────────────────────────────

/** Resolve the pinned signing public key for a voter within a network. */
function voterPublicKey(net: NetworkConfig, voterInstanceId: string): string | undefined {
  let selfId: string | undefined;
  try { selfId = getConfig().instanceId; } catch { selfId = undefined; }
  if (voterInstanceId === selfId) return getSigningPublicKey();
  return net.members.find(m => m.instanceId === voterInstanceId)?.signingPublicKey;
}

/**
 * Whether this instance knows `voterInstanceId` runs a version that signs `bsig` (`Q-138`): itself, or a member whose
 * reported version is `BOUND_CASTS_SINCE` or later. An absent or unparseable version is NOT known — it falls back.
 */
function voterSignsBound(net: NetworkConfig, voterInstanceId: string): boolean {
  let selfId: string | undefined;
  try { selfId = getConfig().instanceId; } catch { selfId = undefined; }
  if (voterInstanceId === selfId) return true;
  return peerRunsAtLeast(net.members.find(m => m.instanceId === voterInstanceId), BOUND_CASTS_SINCE);
}

/**
 * True if the cast carries a valid signature from its claimed voter, over the round it is being applied to.
 *
 * A cast with `bsig` must verify it against THIS round's type and target — a relayed round re-aimed at another space
 * fails here although its v1 `sig` still verifies (`Q-138`). A cast without `bsig` is refused from a voter known to sign
 * one, so stripping it is not a downgrade; from an older or unknown voter the v1 check stands. A cast a voter made
 * before it upgraded is therefore accepted only by a peer that does not yet know it upgraded — the transition.
 */
export function isVoteCastSignatureValid(net: NetworkConfig, round: VoteRound, cast: VoteCast): boolean {
  if (!cast.sig) return false;
  const pub = voterPublicKey(net, cast.instanceId);
  if (!pub) return false;
  const base = { networkId: net.id, roundId: round.roundId, subjectInstanceId: round.subjectInstanceId,
    instanceId: cast.instanceId, vote: cast.vote };
  if (cast.bsig) return verifyMessage(pub, voteCastBoundMessage({ ...base, round }), cast.bsig);
  if (voterSignsBound(net, cast.instanceId)) return false;
  return verifyMessage(pub, voteCastMessage(base), cast.sig);
}

/**
 * Whether the PROPOSER of `round` signed the `convertRecords` the round carries now (`Q-745`): the round's subject is its proposer
 * (`subjectInstanceId`, the member whose yes opens it), and its cast must carry a `csig` that verifies, against the key pinned for it, over the
 * steps as stored. `false` for a round with no `convertRecords` (nothing signed is carried), a cast with no `csig` (an older relayer drops what it
 * does not know), a proposer with no pinned key, a `convertRecords` that is not one, and steps added, changed, removed or reordered since.
 *
 * It answers the question about the STEPS and nothing about the vote: a cast whose `csig` fails is still a valid yes (`isVoteCastSignatureValid`
 * never reads it), so a relayer can at worst make a member apply the schema without the steps, never refuse the schema.
 */
export function convertRecordsSignedByProposer(net: Pick<NetworkConfig, 'id' | 'members'>, round: VoteRound): boolean {
  if (round.convertRecords === undefined) return false;
  const cast = round.votes.find(c => c.instanceId === round.subjectInstanceId);
  if (!cast?.csig) return false;
  const pub = voterPublicKey(net as NetworkConfig, cast.instanceId);
  if (!pub) return false;
  let message: string;
  try {
    message = convertRecordsCastMessage({ networkId: net.id, roundId: round.roundId, subjectInstanceId: round.subjectInstanceId,
      instanceId: cast.instanceId, vote: cast.vote, round, convertRecords: round.convertRecords });
  } catch {
    return false;
  }
  return verifyMessage(pub, message, cast.csig);
}

/**
 * Decide whether to accept a vote cast that arrived from `reportingInstanceId`
 * (the authenticated peer that reported it — the sync peer we pulled from, or
 * the caller of the vote-relay endpoint).
 *
 *  - A cast with a valid signature is accepted from ANY reporter — this is what
 *    makes multi-hop relay safe (deep braintree trees).
 *  - In strict mode (`net.requireSignedVotes`), an unsigned or invalid cast is
 *    rejected outright.
 *  - Otherwise (compatibility mode, the default), an unsigned cast is accepted
 *    only when reported directly by its own voter — never relayed on behalf of
 *    another instance. This is the pre-signing forgery guard, preserved so that
 *    signing rolls out without breaking not-yet-upgraded peers.
 */
export function acceptVoteCast(
  net: NetworkConfig,
  round: VoteRound,
  cast: VoteCast,
  reportingInstanceId: string | undefined,
): { accept: boolean; reason?: string } {
  if (isVoteCastSignatureValid(net, round, cast)) return { accept: true };
  if (net.requireSignedVotes) {
    return { accept: false, reason: 'unsigned or invalid signature (network requires signed votes)' };
  }
  if (reportingInstanceId && cast.instanceId === reportingInstanceId) return { accept: true };
  return { accept: false, reason: 'unsigned vote relayed on behalf of another instance' };
}
