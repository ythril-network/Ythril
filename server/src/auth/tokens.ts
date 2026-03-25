import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, saveConfig } from '../config/loader.js';
import type { TokenRecord } from '../config/types.js';

const BCRYPT_ROUNDS = 12;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(bytes: Buffer): string {
  let num = BigInt('0x' + bytes.toString('hex'));
  if (num === 0n) return '0';
  let out = '';
  const base = BigInt(64); // use 64 slots but only 62 chars — safe due to distribution
  while (num > 0n) {
    out = (BASE62[Number(num % BigInt(62))] ?? '0') + out;
    num = num / BigInt(62);
  }
  return out;
}

/** Generate a new PAT plaintext: `ythril_<base62(32 random bytes)>` */
export function generateToken(): string {
  return `ythril_${toBase62(randomBytes(32))}`;
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
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Invalidate the in-memory cache entry for a given token plaintext.
 *  Call when revoking or rotating a token. */
export function invalidateTokenCache(plaintext: string): void {
  _tokenCache.delete(plaintext);
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
  // `prefix` is the first 8 chars of the plaintext token, stored in the record
  // at creation time — this allows O(small n) pre-filtering so we virtually
  // never run more than 1 bcrypt compare (collisions are ~1/62^8 ≈ 1 in 218 trillion).
  const prefix = plaintext.slice(0, 8);
  const candidates = config.tokens.filter(t => t.prefix === prefix);

  for (const record of candidates) {
    const ok = await verifyToken(plaintext, record.hash);
    if (!ok) continue;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) continue;
    _tokenCache.set(plaintext, { tokenId: record.id, expiresAt: Date.now() + CACHE_TTL_MS });
    return record;
  }
  return null;
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
  readOnly?: boolean;
}): Promise<{ record: TokenRecord; plaintext: string }> {
  const plaintext = generateToken();
  const hash = await hashToken(plaintext);
  const record: TokenRecord = {
    id: uuidv4(),
    name: opts.name,
    hash,
    prefix: plaintext.slice(0, 8),
    createdAt: new Date().toISOString(),
    lastUsed: null,
    expiresAt: opts.expiresAt ?? null,
    spaces: opts.spaces,
    admin: opts.admin ?? false,
    readOnly: opts.readOnly ?? false,
  };
  const config = getConfig();
  config.tokens.push(record);
  saveConfig(config);
  return { record, plaintext };
}

/** List all token records (hashes excluded) */
export function listTokens(): Omit<TokenRecord, 'hash'>[] {
  return getConfig().tokens.map(({ hash: _h, ...rest }) => rest);
}

/** Update space allowlist for a token (undefined = all spaces) */
export function updateTokenSpaces(id: string, spaces: string[] | undefined): boolean {
  const config = getConfig();
  const idx = config.tokens.findIndex(t => t.id === id);
  if (idx < 0) return false;
  config.tokens[idx]!.spaces = spaces;
  saveConfig(config);
  return true;
}

/** Revoke a token by ID */
export async function revokeToken(id: string): Promise<boolean> {
  const config = getConfig();
  const before = config.tokens.length;
  config.tokens = config.tokens.filter(t => t.id !== id);
  if (config.tokens.length === before) return false;
  saveConfig(config);
  return true;
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
  config.tokens[idx]!.prefix = plaintext.slice(0, 8);
  saveConfig(config);
  // Evict any cached entry for the old plaintext by scanning the cache
  for (const [key, val] of _tokenCache) {
    if (val.tokenId === id) _tokenCache.delete(key);
  }
  return plaintext;
}
