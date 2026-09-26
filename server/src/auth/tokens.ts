import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, saveConfig, mutateConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { log } from '../util/log.js';
import type { TokenRecord, Config } from '../config/types.js';
import { migrateToken } from './rights-migration.js';
import { withInstanceAdminGrants } from './instance-admin-grants.js';
import { resolveLimitFor } from '../rate-limit/per-token.js';

const BCRYPT_ROUNDS = 12;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TOKEN_PREFIX = 'ythril_';
const PREFIX_LOOKUP_LENGTH = 8;

function toBase62(bytes: Buffer): string {
  let num = BigInt('0x' + bytes.toString('hex'));
  if (num === 0n) return '0';
  let out = '';
  while (num > 0n) {
    out = (BASE62[Number(num % BigInt(62))] ?? '0') + out;
    num = num / BigInt(62);
  }
  return out;
}

/** Generate a new PAT plaintext: `ythril_<base62(32 random bytes)>` */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${toBase62(randomBytes(32))}`;
}

/**
 * Lookup prefix for a plaintext token: 8 chars taken from the RANDOM part,
 * i.e. AFTER the literal `ythril_`.
 *
 * The prefix is a pre-filter for the bcrypt scan, so it wants entropy. Slicing
 * from offset 0 captured `ythril_` + a single random char — about 1 char of
 * entropy, so ~1/62 of all tokens shared a bucket and a large deployment ran
 * many bcrypt compares per auth (and the value leaked nothing useful either
 * way). Slicing from offset 7 gives the intended 62^8.
 */
function tokenPrefix(plaintext: string): string {
  return plaintext.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + PREFIX_LOOKUP_LENGTH);
}

/** The pre-fix format used before the entropy fix — still matched on lookup. */
function legacyTokenPrefix(plaintext: string): string {
  return plaintext.slice(0, PREFIX_LOOKUP_LENGTH);
}

/** Hash a plaintext token for storage */
export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, BCRYPT_ROUNDS);
}

/** Compare a plaintext token against a stored bcrypt hash */
export async function verifyToken(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}

// ── Token verification cache ────────────────────────────────────────────────
// bcrypt.compare() is intentionally slow; cache successful verifications to
// avoid O(n×bcrypt) cost on every authenticated request.
const _tokenCache = new Map<string, { tokenId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Clear the entire token verification cache.
 *  Called on config reload so revoked tokens aren't honoured from cache. */
export function clearTokenCache(): void {
  _tokenCache.clear();
}

/** Find the matching TokenRecord for a plaintext token (null if none) */
export async function findMatchingToken(
  plaintext: string,
): Promise<TokenRecord | null> {
  const config = getConfig();

  // Fast path: check in-memory cache
  const cached = _tokenCache.get(plaintext);
  if (cached && Date.now() < cached.expiresAt) {
    const record = config.tokens.find(t => t.id === cached.tokenId);
    if (record) {
      if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
        _tokenCache.delete(plaintext);
        return null;
      }
      return record;
    }
    // Token was deleted — evict cache entry
    _tokenCache.delete(plaintext);
  }

  // Prefix-filtered path: only bcrypt-compare records whose prefix matches.
  // Records may carry either prefix format (see tokenPrefix) — match both, then
  // self-heal the record to the current format on a successful verify.
  const prefix = tokenPrefix(plaintext);
  const legacyPrefix = legacyTokenPrefix(plaintext);
  const candidates = config.tokens.filter(t => t.prefix === prefix || t.prefix === legacyPrefix);

  for (const record of candidates) {
    const ok = await verifyToken(plaintext, record.hash);
    if (!ok) continue;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) continue;
    healPrefix(record, prefix);
    _tokenCache.set(plaintext, { tokenId: record.id, expiresAt: Date.now() + CACHE_TTL_MS });
    return record;
  }

  // Fallback for LEGACY tokens created before the `prefix` field existed. They
  // cannot be prefix-prefiltered, but they can still be bcrypt-verified. Rather
  // than silently deleting such tokens on startup (which used to break every
  // client using them at once), we verify them here and BACKFILL the prefix on
  // first use so future lookups take the fast path. This list is empty in a
  // fully-migrated deployment, so there is no cost in the common case.
  const legacy = config.tokens.filter(t => !t.prefix);
  for (const record of legacy) {
    const ok = await verifyToken(plaintext, record.hash);
    if (!ok) continue;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) continue;
    healPrefix(record, prefix);
    _tokenCache.set(plaintext, { tokenId: record.id, expiresAt: Date.now() + CACHE_TTL_MS });
    return record;
  }
  return null;
}

/**
 * Rewrite a record's prefix to the current format (best-effort persist).
 *
 * Re-resolves the record by id inside the write instead of saving the object it was handed. The
 * caller looked the record up out of `config.tokens`, then awaited a bcrypt verify — and a config
 * reload during that await replaces the tokens array wholesale, leaving the caller holding a detached
 * record. Mutating that object and saving would persist a config with no backfill in it: the token
 * keeps authenticating via the slow fallback scan forever, silently, and the migration never lands.
 * The in-memory object is still updated so the current request sees the healed value.
 */
function healPrefix(record: TokenRecord, prefix: string): void {
  if (record.prefix === prefix) return;
  record.prefix = prefix;
  try {
    mutateConfig(cfg => {
      const live = cfg.tokens.find(t => t.id === record.id);
      if (live) live.prefix = prefix;
    });
    log.info(`Migrated lookup prefix for token '${record.name}' (${record.id}) on first use.`);
  } catch { /* best-effort — will persist on the next config save */ }
}

/** Update lastUsed timestamp for a token (best-effort, non-blocking).
 *  We update _config in memory only; the value persists to disk with the next
 *  saveConfig() call triggered by any config-mutating operation (network sync,
 *  space changes, etc.).  Not writing here avoids racing with concurrent reads
 *  of the config file (e.g. POST /api/admin/reload-config). */
export function touchToken(tokenId: string): void {
  const config = getConfig();
  const idx = config.tokens.findIndex(t => t.id === tokenId);
  if (idx < 0) return;
  config.tokens[idx]!.lastUsed = new Date().toISOString();
  // Intentionally NOT calling saveConfig() here — see comment above.
}

/** Create a new PAT and return the record + plaintext */
export async function createToken(opts: {
  name: string;
  expiresAt?: string | null;
  spaces?: string[];
  admin?: boolean;
  /**
   * NOT stored on the record any more (D-8d) — kept as an INPUT that shapes the initial rights matrix.
   *
   * A caller minting without an explicit `rights` still says "read-only" and gets `read` in every area,
   * because `migrateToken` is what turns that into a matrix. Dropping the parameter as well would have made
   * that phrasing unsayable and forced every caller to hand-build a matrix to express the commonest grant.
   */
  readOnly?: boolean;
  peerInstanceId?: string;
  schemaLibrary?: boolean;
  /** `inherit` (default), `exempt`, or `required` — see `TokenRecord.mfa`. */
  mfa?: 'inherit' | 'exempt' | 'required';
  /**
   * An explicit rights matrix, already capped against the minter by the route.
   *
   * Threaded through rather than derived here: the caller has the minter's record and this function does
   * not, so deriving at this depth would mean re-reading auth state from a place that has no business
   * knowing about it. Absent means the load-time backfill will derive one from the legacy fields.
   */
  rights?: TokenRecord['rights'];
  /**
   * This token's own request quota per minute. Absent = inherit the instance value.
   *
   * Validated by the CALLER against `rateLimitRefusal`, which owns the bounds and the instance ceiling.
   * Not re-checked here for the same reason `rights` is not re-capped here: the check needs the env and the
   * caller's context, and a second copy of a rule infra owns is how the two answers drift.
   */
  rateLimitPerMinute?: number;
}): Promise<{ record: TokenRecord; plaintext: string }> {
  const plaintext = generateToken();
  const hash = await hashToken(plaintext);
  const record: TokenRecord = {
    id: uuidv4(),
    name: opts.name,
    hash,
    prefix: tokenPrefix(plaintext),
    createdAt: new Date().toISOString(),
    lastUsed: null,
    expiresAt: opts.expiresAt ?? null,
    peerInstanceId: opts.peerInstanceId,
    ...(opts.schemaLibrary ? { schemaLibrary: true } : {}),
    // Stored only when it says something. `inherit` IS the absent state, so writing it would put a field on
    // every future token that means exactly what its absence already means.
    ...(opts.mfa && opts.mfa !== 'inherit' ? { mfa: opts.mfa } : {}),
    // Stored only when set, for the same reason: absence MEANS inherit-the-instance-value, so writing the
    // resolved number would freeze today's instance default onto the token and stop it following a change.
    ...(opts.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: opts.rateLimitPerMinute } : {}),
    // ALWAYS stored. Owner ruling 2026-08-13: *"translate old tokens into matrix rights and overwrite on
    // update. only matrix from now on."*
    //
    // It used to be omitted so the load-time backfill would derive it — but that backfill runs once, at load,
    // over the tokens already in the config. A token minted afterwards had no matrix until the next restart,
    // and `enforceAreaRung` PASSES when `rights` is absent. Measured: a plain non-admin token deleted a fact
    // over REST with a 204 where a rights-bearing `write` token got a 403 for the same call. The hole was the
    // missing matrix, not the rung.
    rights: opts.rights ?? (migrateToken({
      admin: opts.admin ?? false,
      readOnly: opts.readOnly ?? false,
      spaces: opts.spaces,
      ...(opts.schemaLibrary ? { schemaLibrary: true } : {}),
    }) as unknown as TokenRecord['rights']),
  };
  // An instance admin is stored with space admin on the floor (S-11): one statement, every minting path.
  record.rights = withInstanceAdminGrants(record.rights);
  const config = getConfig();
  config.tokens.push(record);
  saveConfig(config);
  return { record, plaintext };
}

/**
 * Mint a PAT for an MCP OAuth connector (S5). Unlike {@link createToken} this
 * bounds token growth in a single config write:
 *  - carries an `expiresAt` so abandoned connector tokens self-expire;
 *  - rotates — any prior token for the same `clientId` is revoked, so a
 *    connector that re-consents on every reconnect never accumulates tokens;
 *  - caps the total number of connector tokens, evicting the oldest beyond
 *    `maxTokens` as a belt-and-braces bound across all clients.
 */
export async function createOAuthToken(opts: {
  clientId: string;
  name: string;
  spaces?: string[];
  admin?: boolean;
  readOnly?: boolean;
  /**
   * The authorising token's own matrix, carried across verbatim.
   *
   * Prefer this to the three fields above, and not only for tidiness: routing a grant through the legacy
   * triple LOSES per-area detail. A PAT holding `alpha: { knowledge: write, files: read }` collapses to
   * `readOnly: false, spaces: ['alpha']`, which `migrateToken` re-expands to `write` in EVERY area of alpha.
   * The connector would end up able to write files the authorising token could only read.
   */
  rights?: TokenRecord['rights'];
  ttlMs: number | null; // null = never expires
  maxTokens: number;
}): Promise<{ record: TokenRecord; plaintext: string }> {
  const plaintext = generateToken();
  const hash = await hashToken(plaintext);
  const record: TokenRecord = {
    id: uuidv4(),
    name: opts.name,
    hash,
    prefix: tokenPrefix(plaintext),
    createdAt: new Date().toISOString(),
    lastUsed: null,
    expiresAt: opts.ttlMs === null ? null : new Date(Date.now() + opts.ttlMs).toISOString(),
    oauthClientId: opts.clientId,
    // ALWAYS stored, for the reason spelled out on `createToken` above — and this is the path that fix
    // MISSED. `createToken` was given an unconditional matrix because a token minted after boot had none
    // until the next restart; this second minting path kept storing nothing, so every OAuth connector token
    // was matrix-less. Harmless while a missing matrix meant "fall back to the flags", and NOT harmless once
    // `toolIsVisible` began failing closed: a fresh connector could not call a single mutating tool.
    rights: opts.rights ?? (migrateToken({
      admin: opts.admin ?? false,
      readOnly: opts.readOnly ?? false,
      spaces: opts.spaces,
    }) as unknown as TokenRecord['rights']),
  };
  record.rights = withInstanceAdminGrants(record.rights);
  const config = getConfig();
  const removedIds: string[] = [];
  // Rotate: drop any prior token for this client.
  config.tokens = config.tokens.filter(t => {
    if (t.oauthClientId === opts.clientId) { removedIds.push(t.id); return false; }
    return true;
  });
  config.tokens.push(record);
  // Cap: keep only the newest `maxTokens` connector tokens overall.
  const oauthTokens = config.tokens.filter(t => t.oauthClientId);
  if (oauthTokens.length > opts.maxTokens) {
    const byAge = [...oauthTokens].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const evict = new Set(byAge.slice(0, oauthTokens.length - opts.maxTokens).map(t => t.id));
    config.tokens = config.tokens.filter(t => {
      if (evict.has(t.id)) { removedIds.push(t.id); return false; }
      return true;
    });
  }
  saveConfig(config);
  // Evict any cached entries for revoked tokens so bcrypt compare is never skipped.
  if (removedIds.length) {
    const gone = new Set(removedIds);
    for (const [key, val] of _tokenCache) {
      if (gone.has(val.tokenId)) _tokenCache.delete(key);
    }
  }
  return { record, plaintext };
}

/** List all token records (hashes excluded) */
export function listTokens(): (Omit<TokenRecord, 'hash'> & { rateLimitEffective: number })[] {
  return getConfig().tokens.map(({ hash: _h, ...rest }) => ({
    ...rest,
    /*
     * The limit that ACTUALLY applies, derived here rather than at either door.
     *
     * `rateLimitPerMinute` absent means "inherit the instance value", and from a list that is indistinguishable
     * from "inherits 300" versus "inherits 50 because infra set a ceiling" — the absent-versus-not-checked
     * ambiguity this codebase keeps having to fix. So the resolved number rides along beside the stored one.
     *
     * In `listTokens` and not in the REST response shaper, because the MCP `list_tokens` tool calls this
     * function directly. Deriving it at one door would give the two doors different answers to the same
     * question, which is the parity defect `CLAUDE.md` calls the most expensive lesson in this codebase.
     */
    rateLimitEffective: resolveLimitFor(rest),
  }));
}

/** Rename a token — updates only its human-readable label (`name`); the secret and scope are untouched. */
/**
 * Replace a token's rights matrix. Separate from `renameToken` because the two are different decisions with
 * different guards, and one function taking an optional second thing would let a caller change rights while
 * believing it renamed.
 */
export function setTokenRights(id: string, rights: TokenRecord['rights']): boolean {
  const config = getConfig();
  const idx = config.tokens.findIndex(t => t.id === id);
  if (idx < 0) return false;
  config.tokens[idx]!.rights = withInstanceAdminGrants(rights);
  saveConfig(config);
  return true;
}

export function renameToken(id: string, name: string): boolean {
  const config = getConfig();
  const idx = config.tokens.findIndex(t => t.id === id);
  if (idx < 0) return false;
  config.tokens[idx]!.name = name;
  saveConfig(config);
  return true;
}

/**
 * Set a token's relationship to the second factor: `inherit`, `exempt` or `required`.
 *
 * Separate from the two above for the same reason they are separate from each other, and here the stakes are
 * higher: this is the only one of the three that can weaken an instance-wide control. The route guards it —
 * granting `exempt` costs a live TOTP code on the request even from a token that is itself exempt — and that
 * guard must not be reachable around. A combined setter taking an optional `mfa` would let a caller change it
 * while believing it had renamed.
 *
 * `inherit` is stored as ABSENT rather than as the string. It is the default, every existing token has no
 * `mfa` field at all, and writing `'inherit'` explicitly would make a token that follows the instance switch
 * look different on disk depending on whether anyone had ever opened its editor.
 */
export function setTokenMfa(id: string, mfa: 'inherit' | 'exempt' | 'required'): boolean {
  const config = getConfig();
  const idx = config.tokens.findIndex(t => t.id === id);
  if (idx < 0) return false;
  if (mfa === 'inherit') delete config.tokens[idx]!.mfa;
  else config.tokens[idx]!.mfa = mfa;
  saveConfig(config);
  return true;
}

/**
 * Set (or clear) one token's request quota.
 *
 * `null` CLEARS it, and that is the only way back to inheriting the instance value — the same shape
 * `setTokenMfa` uses for `inherit`. Writing the resolved number instead would freeze today's instance default
 * onto the token and stop it following a later change, which is a quota nobody set and nobody can see they set.
 *
 * The value is validated by the CALLER against `rateLimitRefusal`, which owns the bounds and the instance
 * ceiling. Re-checking here would be a second copy of a rule infra owns.
 */
export function setTokenRateLimit(id: string, perMinute: number | null): boolean {
  const config = getConfig();
  const idx = config.tokens.findIndex(t => t.id === id);
  if (idx < 0) return false;
  if (perMinute === null) delete config.tokens[idx]!.rateLimitPerMinute;
  else config.tokens[idx]!.rateLimitPerMinute = perMinute;
  saveConfig(config);
  return true;
}

/** Revoke a token by ID */
/**
 * Set or clear a token's expiry. `null` means it no longer expires.
 *
 * For the invite handshake: the peer token apply creates carries the handshake's expiry, and finalize clears it
 * once the membership is real — see `api/invite.ts`. The cache is evicted so an expiry takes effect at once.
 */
export function setTokenExpiry(id: string, expiresAt: string | null): boolean {
  const config = getConfig();
  const t = config.tokens.find(x => x.id === id);
  if (!t) return false;
  t.expiresAt = expiresAt;
  saveConfig(config);
  for (const [key, val] of _tokenCache) if (val.tokenId === id) _tokenCache.delete(key);
  return true;
}

/**
 * The peer instances holding an inbound token while sharing no network with us — nothing a live membership needs.
 *
 * A token an unfinished handshake created was never cleaned up: its session lived in memory and expired, and the
 * token outlived it with no expiry and no member record. Pure, so the choice is testable without a config; the boot
 * sweep hands each id to `revokePeerCredentialsIfOrphaned`, which re-checks membership before revoking anything.
 */
export function orphanedPeerInstanceIds(config: Pick<Config, 'tokens' | 'networks'>): string[] {
  const live = new Set(config.networks.flatMap(n => [
    ...n.members.map(m => m.instanceId),
    ...(n.pendingRounds ?? []).filter(r => !r.concluded && r.pendingMember).map(r => r.pendingMember!.instanceId),
  ]));
  return [...new Set(config.tokens.flatMap(t => (t.peerInstanceId && !live.has(t.peerInstanceId) ? [t.peerInstanceId] : [])))];
}

export async function revokeToken(id: string): Promise<boolean> {
  const config = getConfig();
  const before = config.tokens.length;
  config.tokens = config.tokens.filter(t => t.id !== id);
  if (config.tokens.length === before) return false;
  saveConfig(config);
  // Evict any cached entry for this token so bcrypt compare is never skipped
  for (const [key, val] of _tokenCache) {
    if (val.tokenId === id) _tokenCache.delete(key);
  }
  return true;
}

/**
 * Revoke all credentials tied to a peer instance once it no longer shares any
 * network with us: the inbound PATs it presents (records with a matching
 * `peerInstanceId`) and our outbound token for calling it (`secrets.peerTokens`).
 *
 * A peer can legitimately be a member of several networks, so this is a no-op
 * while the instance still appears in any network's member list or in an
 * unconcluded join round's pending member. Call it after a member has been
 * removed (vote conclusion, direct removal, departure, or network deletion).
 *
 * Returns true if any credential was actually revoked.
 */
export async function revokePeerCredentialsIfOrphaned(instanceId: string): Promise<boolean> {
  if (!instanceId) return false;
  const config = getConfig();
  const stillMember = config.networks.some(n =>
    n.members.some(m => m.instanceId === instanceId) ||
    n.pendingRounds?.some(r => !r.concluded && r.pendingMember?.instanceId === instanceId),
  );
  if (stillMember) return false;

  let revoked = false;
  const inbound = config.tokens.filter(t => t.peerInstanceId === instanceId);
  for (const t of inbound) {
    if (await revokeToken(t.id)) {
      revoked = true;
      log.info(`Revoked peer PAT '${t.name}' (${t.id}) — instance ${instanceId} is no longer a member of any network`);
    }
  }
  const secrets = getSecrets();
  if (secrets.peerTokens[instanceId]) {
    delete secrets.peerTokens[instanceId];
    saveSecrets(secrets);
    revoked = true;
    log.info(`Dropped outbound peer token for departed instance ${instanceId}`);
  }
  return revoked;
}

/** Rotate a token: generate a new plaintext/hash for an existing record.
 *  The old plaintext is immediately invalidated (cache miss on next request).
 *  Returns the new plaintext, or null if the token was not found.
 */
export async function regenerateToken(id: string): Promise<string | null> {
  const config = getConfig();
  const idx = config.tokens.findIndex(t => t.id === id);
  if (idx < 0) return null;
  const plaintext = generateToken();
  const hash = await hashToken(plaintext);
  config.tokens[idx]!.hash = hash;
  config.tokens[idx]!.prefix = tokenPrefix(plaintext);
  saveConfig(config);
  // Evict any cached entry for the old plaintext by scanning the cache
  for (const [key, val] of _tokenCache) {
    if (val.tokenId === id) _tokenCache.delete(key);
  }
  return plaintext;
}
