/**
 * At-rest encryption for Ythril's state files (PR-S2) — config.json / secrets.json /
 * schema-library.json / schema-catalogs.json — and, in the chunked binary envelope at the end of this file,
 * for the files Ythril stores (F-43). One module for both, because two implementations of an at-rest format drift.
 *
 * A pure leaf (only `node:crypto` and `node:stream`). The loader wraps its serialize/parse choke points with
 * {@link encryptEnvelope} / {@link decryptEnvelope}; detection is via {@link isEnvelope}. The master
 * secret lives ONLY in the environment (never written to disk) so a stolen file — or a co-tenant on
 * shared hardware reading the volume — is useless without it:
 *   - `YTHRIL_MASTER_KEY`        — 32 raw bytes as base64 or hex (used directly, kdf `raw`).
 *   - `YTHRIL_MASTER_PASSPHRASE` — any passphrase; a per-file scrypt salt is stored in the envelope.
 *
 * AES-256-GCM (authenticated): a wrong key or a tampered file fails the auth tag and throws — the loader
 * turns that into a hard boot failure rather than ever treating ciphertext as plaintext.
 *
 * WARNING: losing the master secret makes these files unrecoverable, by design. Back it up.
 */
import crypto from 'node:crypto';
import { Transform } from 'node:stream';

export type MasterSecret =
  | { kind: 'key'; key: Buffer }
  | { kind: 'passphrase'; passphrase: string };

interface Envelope {
  ythrilEnc: 1;
  alg: 'AES-256-GCM';
  kdf: 'raw' | 'scrypt';
  salt?: string; // base64, present iff kdf === 'scrypt'
  iv: string;    // base64 (12 bytes)
  tag: string;   // base64 (16 bytes)
  ct: string;    // base64 ciphertext
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/** Parse a 32-byte key from base64 or hex; throws on any other length/encoding. */
function parseRawKey(raw: string): Buffer {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  let buf: Buffer;
  try { buf = Buffer.from(s, 'base64'); } catch { throw new Error('YTHRIL_MASTER_KEY must be base64 or hex'); }
  if (buf.length !== 32) {
    throw new Error(`YTHRIL_MASTER_KEY must decode to exactly 32 bytes (got ${buf.length}); use 64 hex chars or base64 of 32 bytes`);
  }
  return buf;
}

/** Resolve the master secret from the environment, or null when none is configured. */
export function resolveMasterSecret(): MasterSecret | null {
  const rawKey = process.env['YTHRIL_MASTER_KEY'];
  if (rawKey && rawKey.trim()) return { kind: 'key', key: parseRawKey(rawKey) };
  const pass = process.env['YTHRIL_MASTER_PASSPHRASE'];
  if (pass && pass.length > 0) return { kind: 'passphrase', passphrase: pass };
  return null;
}

function scryptKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

/** True if `raw` is one of our encryption envelopes (unambiguous `ythrilEnc` marker). */
export function isEnvelope(raw: string): boolean {
  const t = raw.trimStart();
  if (!t.startsWith('{')) return false;
  try {
    const o = JSON.parse(t) as { ythrilEnc?: unknown };
    return o !== null && typeof o === 'object' && o.ythrilEnc === 1;
  } catch {
    return false;
  }
}

/**
 * The AES-GCM step both decrypt paths share. `.final()` throws when the auth tag does not verify — a wrong
 * key or a tampered file — which is what makes it impossible to treat ciphertext as plaintext by accident.
 */
function decipherEnvelope(env: Envelope, key: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * A master secret with its key derivation ALREADY DONE.
 *
 * This exists because {@link encryptEnvelope} derives inside every call, and with a passphrase that means one
 * scrypt (N=16384, tens of milliseconds, deliberately) per invocation. Correct and cheap for the four state
 * files it was written for — four calls at boot. Catastrophic for a caller that encrypts *per record*: a
 * hundred thousand records would be hours, and the operation would look like a hang.
 *
 * So a batch caller derives once with {@link deriveKey} and passes this to {@link encryptWithKey} for every
 * item. The envelope format has exactly ONE implementation either way — `encryptEnvelope` delegates here —
 * because two implementations of an at-rest format drift, and this one is a security boundary.
 */
export interface DerivedKey {
  key: Buffer;
  kdf: 'raw' | 'scrypt';
  /** Present iff `kdf === 'scrypt'`; the same salt is then recorded in every envelope made with this key. */
  salt?: Buffer;
}

/**
 * Derive the encryption key once. **This is the expensive call** for a passphrase secret — hoist it out of
 * any loop.
 */
export function deriveKey(secret: MasterSecret): DerivedKey {
  if (secret.kind === 'key') return { key: secret.key, kdf: 'raw' };
  const salt = crypto.randomBytes(16);
  return { key: scryptKey(secret.passphrase, salt), kdf: 'scrypt', salt };
}

/**
 * Derive for a salt that already exists — the DECRYPT side of {@link deriveKey}.
 *
 * {@link deriveKey} invents a random salt, which is right for writing and useless for reading. A batch reader
 * has the salt in front of it (every envelope records the one its file was written with) and needs the key that
 * matches it, derived **once**, not once per line.
 *
 * Without this the reader has no choice but {@link decryptEnvelope}, which derives from each envelope's own
 * salt on every call — correct, and one scrypt per record. That is the same trap {@link DerivedKey} exists to
 * avoid, and it is easy to reintroduce on the read side after fixing it on the write side.
 */
export function deriveKeyForSalt(secret: MasterSecret, salt: Buffer | null): DerivedKey {
  if (secret.kind === 'key') {
    if (salt) throw new Error('envelope has a scrypt salt but YTHRIL_MASTER_KEY is set, not a passphrase');
    return { key: secret.key, kdf: 'raw' };
  }
  if (!salt) throw new Error('envelope has no salt but YTHRIL_MASTER_PASSPHRASE is set, not a raw key');
  return { key: scryptKey(secret.passphrase, salt), kdf: 'scrypt', salt };
}

/**
 * Encrypt with an already-derived key. Cheap and safe to call in a loop: only the 12-byte IV is fresh per
 * call, which is what AES-GCM requires (a reused key with a reused IV is catastrophic; a reused key with a
 * fresh IV is the normal, correct construction).
 */
export function encryptWithKey(plaintext: string, dk: DerivedKey): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dk.key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const env: Envelope = {
    ythrilEnc: 1,
    alg: 'AES-256-GCM',
    kdf: dk.kdf,
    ...(dk.salt ? { salt: dk.salt.toString('base64') } : {}),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(env);
}

/**
 * Decrypt with an already-derived key, for the same batch case.
 *
 * Refuses an envelope whose salt does not match the derived key's rather than silently failing the auth tag:
 * "this envelope was made with a different salt" is an actionable message, and `.final()` throwing
 * `Unsupported state or unable to authenticate data` is not.
 */
export function decryptWithKey(raw: string, dk: DerivedKey): string {
  const env = JSON.parse(raw) as Envelope;
  if (env.ythrilEnc !== 1 || env.alg !== 'AES-256-GCM') throw new Error('unrecognised encryption envelope');
  if (env.kdf !== dk.kdf) {
    throw new Error(`envelope kdf is ${String(env.kdf)} but the derived key is ${dk.kdf}`);
  }
  if (dk.kdf === 'scrypt' && env.salt !== dk.salt?.toString('base64')) {
    throw new Error('envelope salt does not match the derived key — derive per salt, or decrypt with decryptEnvelope');
  }
  return decipherEnvelope(env, dk.key);
}

export function encryptEnvelope(plaintext: string, secret: MasterSecret): string {
  // Delegates, so there is one implementation of the envelope format. Derives per call, which is correct for
  // the four state-file callers and wrong in a loop — see DerivedKey.
  return encryptWithKey(plaintext, deriveKey(secret));
}

/** Decrypt an envelope string back to UTF-8. Throws on a wrong secret, missing secret kind, or tamper. */
export function decryptEnvelope(raw: string, secret: MasterSecret): string {
  const env = JSON.parse(raw) as Envelope;
  if (env.ythrilEnc !== 1 || env.alg !== 'AES-256-GCM') throw new Error('unrecognised encryption envelope');
  let key: Buffer;
  if (env.kdf === 'scrypt') {
    if (secret.kind !== 'passphrase') throw new Error('file is passphrase-encrypted but YTHRIL_MASTER_PASSPHRASE is not set');
    if (!env.salt) throw new Error('envelope missing salt');
    key = scryptKey(secret.passphrase, Buffer.from(env.salt, 'base64'));
  } else if (env.kdf === 'raw') {
    if (secret.kind !== 'key') throw new Error('file is key-encrypted but YTHRIL_MASTER_KEY is not set');
    key = secret.key;
  } else {
    throw new Error(`unsupported kdf: ${String((env as Envelope).kdf)}`);
  }
  return decipherEnvelope(env, key);
}

/** Generate a fresh 32-byte master key as base64 (for setup/CLI helpers). */
export function generateMasterKeyBase64(): string {
  return crypto.randomBytes(32).toString('base64');
}

// ── The chunked binary envelope, for STORED FILES (F-43) ─────────────────────────────────────────────────────
//
// The JSON envelope above holds a whole plaintext as one base64 string: right for four small state files, and
// useless for an uploaded file of ten gigabytes, which has to stream through without ever being held whole. So a
// stored file gets a binary format of its own — in THIS module, beside the other, because two implementations of
// an at-rest format drift, and the key derivation below is the same one (`deriveKey` / `deriveKeyForSalt`).
//
// Layout: MAGIC 'YTHF' | version 1 | kdf (0 raw, 1 scrypt) | [scrypt salt, 16, scrypt only] | file salt, 32 |
// key check, 8 — then the body: chunks of CHUNK_PLAINTEXT_BYTES plaintext, each followed by its 16-byte GCM tag;
// every chunk is full except the last, which holds 0..CHUNK bytes.
//
// - A PER-FILE key: HKDF-SHA256 over the master-derived key with the file's random salt. Each file has its own
//   key, so the nonce can be the chunk counter and there is no collision bound across the millions of files an
//   instance writes over its life.
// - The AAD of every chunk is the whole header plus the chunk's index and a last-chunk flag. Edit the header,
//   reorder chunks, drop one or cut the tail off, and a tag fails. A truncated file cannot decode short.
// - The key check (8 bytes of the same HKDF output) lets a reader say "not my key" instead of "tampered", which
//   is the difference between a misconfigured instance and an attacked one.
// - No path in the AAD, deliberately: a stored file stays valid when it is renamed, moved, or copied to another
//   space. The cost, documented: someone who can write the volume can swap two ciphertexts undetected.

/** Plaintext bytes per chunk. Exported so a reader can compute sizes and offsets without decrypting. */
export const CHUNK_PLAINTEXT_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const CIPHER_CHUNK_BYTES = CHUNK_PLAINTEXT_BYTES + TAG_BYTES;
const CHUNKED_MAGIC = Buffer.from('YTHF', 'ascii');
const CHUNKED_VERSION = 1;
const FILE_SALT_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;
const KEY_CHECK_BYTES = 8;
const HKDF_INFO = 'ythril files v1';
/** The longest header there is (scrypt), so a reader knows how much to peek. */
export const CHUNKED_MAX_HEADER_BYTES = 4 + 1 + 1 + SCRYPT_SALT_BYTES + FILE_SALT_BYTES + KEY_CHECK_BYTES;

/** Why a stored file could not be decoded. `code` is what a door turns into its answer. */
export class ChunkedEnvelopeError extends Error {
  constructor(readonly code: 'wrong-key' | 'tampered' | 'no-secret' | 'kind-mismatch', message: string) {
    super(message);
    this.name = 'ChunkedEnvelopeError';
  }
}

/** The header length of `buf`'s envelope, or 0 when `buf` does not start with one (or is too short to say). */
export function chunkedHeaderLength(buf: Buffer): number {
  if (buf.length < 6 || !buf.subarray(0, 4).equals(CHUNKED_MAGIC) || buf[4] !== CHUNKED_VERSION) return 0;
  const kdf = buf[5];
  if (kdf !== 0 && kdf !== 1) return 0;
  return 6 + (kdf === 1 ? SCRYPT_SALT_BYTES : 0) + FILE_SALT_BYTES + KEY_CHECK_BYTES;
}

/**
 * True when `buf` starts with a well-formed header and is long enough to hold at least the last chunk's tag.
 * Strict on purpose: this decides whether a reader decrypts, so a file that merely shares the magic is not enough.
 */
export function isChunkedEnvelope(buf: Buffer, totalLength: number = buf.length): boolean {
  const h = chunkedHeaderLength(buf);
  return h > 0 && buf.length >= h && totalLength >= h + TAG_BYTES;
}

/** Plaintext size of an envelope of `totalLength` bytes with a header of `headerLength`, without decrypting. */
export function chunkedPlaintextSizeFor(totalLength: number, headerLength: number): number {
  const body = totalLength - headerLength;
  const chunks = Math.max(1, Math.ceil(body / CIPHER_CHUNK_BYTES));
  return body - chunks * TAG_BYTES;
}

/** Plaintext size of a whole envelope held in memory. */
export function chunkedPlaintextSize(buf: Buffer): number {
  return chunkedPlaintextSizeFor(buf.length, chunkedHeaderLength(buf));
}

/** The per-file key and key check, from the master-derived key and the file's salt. */
function fileKeys(base: Buffer, fileSalt: Buffer): { key: Buffer; check: Buffer } {
  const okm = Buffer.from(crypto.hkdfSync('sha256', base, fileSalt, HKDF_INFO, 32 + KEY_CHECK_BYTES));
  return { key: okm.subarray(0, 32), check: okm.subarray(32) };
}

const chunkNonce = (index: number): Buffer => { const iv = Buffer.alloc(12); iv.writeUInt32BE(index, 8); return iv; };
const chunkAad = (header: Buffer, index: number, last: boolean): Buffer => {
  const tail = Buffer.alloc(5); tail.writeUInt32BE(index, 0); tail[4] = last ? 1 : 0;
  return Buffer.concat([header, tail]);
};

/**
 * Master-derived keys already computed for a salt. A passphrase key costs one scrypt; a reader that derived per
 * FILE would pay it on every read, which is the trap `DerivedKey` describes. Keyed on the secret's fingerprint as
 * well as the salt, so a changed secret can never be answered from the cache.
 */
const baseKeyCache = new Map<string, Buffer>();
const secretFingerprint = (s: MasterSecret): string =>
  crypto.createHash('sha256').update(s.kind === 'key' ? s.key : Buffer.from(s.passphrase, 'utf8')).update(s.kind).digest('hex');

/** Drop every cached derivation. For tests, and for a process whose secret changes under it. */
export function resetChunkedKeyCache(): void { baseKeyCache.clear(); }

/**
 * Bounded: a passphrase instance adds one salt per boot, so real use holds a handful — and a volume someone can
 * write could plant a new salt per file, which an unbounded map would keep for ever. Oldest entry out first.
 */
const BASE_KEY_CACHE_MAX = 64;

function baseKeyFor(secret: MasterSecret, scryptSalt: Buffer | null): Buffer {
  const id = `${secretFingerprint(secret)}:${scryptSalt ? scryptSalt.toString('hex') : 'raw'}`;
  let key = baseKeyCache.get(id);
  if (!key) {
    try { key = deriveKeyForSalt(secret, scryptSalt).key; } catch (err) {
      throw new ChunkedEnvelopeError('kind-mismatch', err instanceof Error ? err.message : String(err));
    }
    if (baseKeyCache.size >= BASE_KEY_CACHE_MAX) baseKeyCache.delete(baseKeyCache.keys().next().value as string);
    baseKeyCache.set(id, key);
  }
  return key;
}

/** The one encoder. Both the Buffer helper and the Transform drive it, so there is one implementation. */
class ChunkEncoder {
  readonly header: Buffer;
  private readonly key: Buffer;
  private index = 0;
  constructor(dk: DerivedKey) {
    const fileSalt = crypto.randomBytes(FILE_SALT_BYTES);
    const { key, check } = fileKeys(dk.key, fileSalt);
    this.key = key;
    this.header = Buffer.concat([CHUNKED_MAGIC, Buffer.from([CHUNKED_VERSION, dk.kdf === 'scrypt' ? 1 : 0]),
      ...(dk.kdf === 'scrypt' ? [dk.salt!] : []), fileSalt, check]);
  }
  chunk(plain: Buffer, last: boolean): Buffer {
    const c = crypto.createCipheriv('aes-256-gcm', this.key, chunkNonce(this.index));
    c.setAAD(chunkAad(this.header, this.index, last));
    this.index++;
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
}

/** The one decoder, for the same reason. Built from a parsed header; refuses a foreign key before any chunk. */
class ChunkDecoder {
  private readonly key: Buffer;
  private index = 0;
  constructor(readonly header: Buffer, secret: MasterSecret | null) {
    if (!secret) throw new ChunkedEnvelopeError('no-secret', 'this file is encrypted at rest, and no master secret is configured');
    const kdf = header[5];
    const scryptSalt = kdf === 1 ? header.subarray(6, 6 + SCRYPT_SALT_BYTES) : null;
    const saltAt = 6 + (kdf === 1 ? SCRYPT_SALT_BYTES : 0);
    const fileSalt = header.subarray(saltAt, saltAt + FILE_SALT_BYTES);
    const stored = header.subarray(saltAt + FILE_SALT_BYTES, saltAt + FILE_SALT_BYTES + KEY_CHECK_BYTES);
    const { key, check } = fileKeys(baseKeyFor(secret, scryptSalt), fileSalt);
    if (!crypto.timingSafeEqual(check, stored)) {
      throw new ChunkedEnvelopeError('wrong-key', 'this file was encrypted with a different master secret');
    }
    this.key = key;
  }
  chunk(sealed: Buffer, last: boolean): Buffer {
    if (sealed.length < TAG_BYTES) throw new ChunkedEnvelopeError('tampered', 'this file is truncated');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, chunkNonce(this.index));
    d.setAAD(chunkAad(this.header, this.index, last));
    d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    this.index++;
    try {
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_BYTES)), d.final()]);
    } catch {
      throw new ChunkedEnvelopeError('tampered', 'this file failed its integrity check: it was altered, truncated or reordered');
    }
  }
}

/** Encrypt a whole Buffer. For small writes; anything that can be large streams through the Transform. */
export function encryptChunked(plain: Buffer, dk: DerivedKey): Buffer {
  const enc = new ChunkEncoder(dk);
  const out = [enc.header];
  const chunks = Math.max(1, Math.ceil(plain.length / CHUNK_PLAINTEXT_BYTES));
  for (let i = 0; i < chunks; i++) {
    out.push(enc.chunk(plain.subarray(i * CHUNK_PLAINTEXT_BYTES, (i + 1) * CHUNK_PLAINTEXT_BYTES), i === chunks - 1));
  }
  return Buffer.concat(out);
}

/** Decrypt a whole Buffer that {@link isChunkedEnvelope} accepted. Throws {@link ChunkedEnvelopeError}. */
/**
 * Refuse a file this secret cannot open — no secret, or a different one — from its HEADER alone, before any
 * content is read. A streamed reader has usually committed to a response by the time the first chunk fails; this
 * lets it answer with a refusal instead of an aborted transfer. Tampering is only visible chunk by chunk and is
 * not caught here.
 */
export function checkChunkedKey(head: Buffer, secret: MasterSecret | null): void {
  const h = chunkedHeaderLength(head);
  if (!h) throw new ChunkedEnvelopeError('tampered', 'this file is not a complete encrypted file');
  new ChunkDecoder(head.subarray(0, h), secret);
}

export function decryptChunked(buf: Buffer, secret: MasterSecret | null): Buffer<ArrayBuffer> {
  const h = chunkedHeaderLength(buf);
  if (!h || buf.length < h + TAG_BYTES) throw new ChunkedEnvelopeError('tampered', 'this file is not a complete encrypted file');
  const dec = new ChunkDecoder(buf.subarray(0, h), secret);
  const body = buf.subarray(h);
  const chunks = Math.max(1, Math.ceil(body.length / CIPHER_CHUNK_BYTES));
  const out: Buffer[] = [];
  for (let i = 0; i < chunks; i++) {
    out.push(dec.chunk(body.subarray(i * CIPHER_CHUNK_BYTES, (i + 1) * CIPHER_CHUNK_BYTES), i === chunks - 1));
  }
  return Buffer.concat(out);
}

/**
 * Plaintext in, envelope out, a chunk at a time. The last chunk is only known at the end, so a full chunk is held
 * back until more data proves it is not the last; the flush writes the final one (possibly empty) with the flag.
 */
export function createChunkedEncryptor(dk: DerivedKey): Transform {
  const enc = new ChunkEncoder(dk);
  let pending: Buffer = Buffer.alloc(0);
  let headerOut = false;
  return new Transform({
    transform(data: Buffer, _enc, done) {
      if (!headerOut) { this.push(enc.header); headerOut = true; }
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      while (pending.length > CHUNK_PLAINTEXT_BYTES) {
        this.push(enc.chunk(pending.subarray(0, CHUNK_PLAINTEXT_BYTES), false));
        pending = pending.subarray(CHUNK_PLAINTEXT_BYTES);
      }
      done();
    },
    flush(done) {
      if (!headerOut) this.push(enc.header);
      this.push(enc.chunk(pending, true));
      done();
    },
  });
}

/** Envelope in, plaintext out. Errors with {@link ChunkedEnvelopeError}; a stream that ends early is `tampered`. */
export function createChunkedDecryptor(secret: MasterSecret | null): Transform {
  let pending: Buffer = Buffer.alloc(0);
  let dec: ChunkDecoder | null = null;
  return new Transform({
    transform(data: Buffer, _enc, done) {
      try {
        pending = pending.length ? Buffer.concat([pending, data]) : data;
        if (!dec) {
          const h = chunkedHeaderLength(pending);
          if (!h || pending.length < h) {
            if (pending.length >= CHUNKED_MAX_HEADER_BYTES) throw new ChunkedEnvelopeError('tampered', 'this file does not start with an encryption header');
            return done();
          }
          dec = new ChunkDecoder(Buffer.from(pending.subarray(0, h)), secret);
          pending = pending.subarray(h);
        }
        while (pending.length > CIPHER_CHUNK_BYTES) {
          this.push(dec.chunk(pending.subarray(0, CIPHER_CHUNK_BYTES), false));
          pending = pending.subarray(CIPHER_CHUNK_BYTES);
        }
        done();
      } catch (err) { done(err as Error); }
    },
    flush(done) {
      try {
        if (!dec) throw new ChunkedEnvelopeError('tampered', 'this file ends before its encryption header');
        this.push(dec.chunk(pending, true));
        done();
      } catch (err) { done(err as Error); }
    },
  });
}
