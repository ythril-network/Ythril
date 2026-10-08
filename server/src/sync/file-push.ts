/**
 * Pushing one stored file to a peer's upload door: as one streamed body when the peer takes a body that size, and as a
 * sequence of ranges through the CHUNKED door when it does not (bundle-48, Q-296).
 *
 * ## What it prevents
 *
 * The push read the whole stored file (`readStored`) and sent it as ONE `POST` body. A receiver accepts one body up to its
 * `maxUploadBodyBytes` (50 MiB by default) and answers `413` to anything above it, so a file over the limit was refused by every
 * receiver on every cycle, for ever, and the sender — which cannot tell the refusal from a failure and remembered nothing —
 * read the file whole and sent it whole again each time. The chunked door exists for exactly this (`Content-Range`, up to
 * `maxChunkedUploadBytes`), and no peer ever reached it.
 *
 * ## The rule
 *
 * A file that the peer's single-body limit admits goes as one body, STREAMED from the stored-bytes door (never held whole). A
 * file above it goes as ranges, each under the limit, each carrying the whole file's sha256 in `x-expected-sha256` — the header the
 * chunked door binds to the assembly and refuses a different assembly by (`api/files-upload.ts`) — and each held in memory one at
 * a time, never the file. The peer's limit is LEARNED, not guessed: the first range is small enough for any receiver
 * ({@link PROBE_BYTES}), and the door answers every range with the limit it enforces (`maxBodyBytes`), which is remembered per peer
 * ({@link peerBodyLimits}). A receiver that does not say (an older one) is sent ranges of {@link UNANNOUNCED_RANGE_BYTES} and a `413`
 * on a range halves it and sends that range again — ranges are idempotent at the receiver, so a smaller second try is safe.
 *
 * ## What it does not do
 *
 * It does not talk to the network: the caller hands it `send`, the one place that holds the endpoint, the credentials and the
 * transfer budget (`file-sync.ts`). That keeps the budget of a whole-file call in one spelling and lets this be run without a peer.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { openStoredRead } from '../files/stored-bytes.js';
import { LruMap } from '../util/lru-map.js';

/** One request to the peer's upload door: what `send` is given. */
export interface UploadRequest {
  /** Headers of this request beyond the credentials and the content type (`Content-Range`, `x-expected-sha256`, `Content-Length`). */
  headers: Record<string, string>;
  body: Buffer | WebReadableStream<Uint8Array>;
}

/** The peer's answer: its status and the JSON it sent (`{}` when it sent none). */
export interface UploadAnswer { status: number; json: Record<string, unknown> }

/** Sends one request to the peer's upload door for the file being pushed. Throws on a transport failure. */
export type SendUpload = (req: UploadRequest) => Promise<UploadAnswer>;

/** What became of one file's push. */
export type PushOutcome =
  /** The peer has the bytes (or ignored them as its own to derive, `{ ignored: 'instance-local' }`): record the base and stop. */
  | { kind: 'delivered' }
  /** The peer holds a tombstone that erased exactly these bytes and stored nothing (`200 { tombstoned: true }`). */
  | { kind: 'tombstoned' }
  /** The peer refused THESE BYTES (a hash that is not the one promised, a malformed range): the same bytes will be refused again. */
  | { kind: 'refused'; status: number; error: string | undefined }
  /** Not delivered, and not because of the bytes: a status about the moment (quota, rate, auth, a server error). Tried again next cycle. */
  | { kind: 'failed'; status: number; error: string | undefined };

/**
 * The first range of a chunked push, and the largest body sent to a peer whose limit is not known yet: small enough that no sane
 * `maxUploadBodyBytes` refuses it, large enough that most of a small file is one request.
 */
export const PROBE_BYTES = 64 * 1024;

/** The range size used against a peer that does not announce its limit (an older release): under the 50 MiB default, in memory one at a time. */
export const UNANNOUNCED_RANGE_BYTES = 8 * 1024 * 1024;

/** The ceiling of one range held in memory, whatever limit the peer announces. */
export const MAX_RANGE_BYTES = 16 * 1024 * 1024;

/** A range is never halved below this: a peer that refuses a body this small refuses every body. */
const MIN_RANGE_BYTES = 4 * 1024;

const MAX_PEERS = 1_000;

/**
 * The single-body limit each peer has announced (`maxBodyBytes` in the chunked door's answers), by the peer's instance id. In
 * memory and bounded: a restart forgets it and costs the first large file per peer one probe range.
 */
const peerBodyLimits = new LruMap<string, number>(MAX_PEERS);

/** Forget every learned limit. For tests. */
export function forgetPeerBodyLimits(): void { peerBodyLimits.clear(); }

const isLimit = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= MIN_RANGE_BYTES;

/**
 * Takes an exact number of bytes at a time from a stream, keeping what it read past it for the next take: the window a range is
 * built from. Holds one range and a stream chunk, never the file.
 */
class RangeReader {
  private spare: Buffer = Buffer.alloc(0);
  private readonly it: AsyncIterator<Buffer | string>;
  constructor(source: Readable) { this.it = source[Symbol.asyncIterator](); }

  /** Up to `n` bytes: fewer only at the end of the stream. */
  async take(n: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let have = 0;
    if (this.spare.length > 0) { parts.push(this.spare); have = this.spare.length; this.spare = Buffer.alloc(0); }
    while (have < n) {
      const next = await this.it.next();
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      parts.push(chunk);
      have += chunk.length;
    }
    const all = parts.length === 1 ? parts[0]! : Buffer.concat(parts, have);
    if (all.length <= n) return all;
    this.spare = all.subarray(n);
    return all.subarray(0, n);
  }

  /** Put back bytes that were taken and not sent (a range the peer found too large goes again, smaller). */
  giveBack(bytes: Buffer): void { this.spare = this.spare.length === 0 ? bytes : Buffer.concat([bytes, this.spare]); }
}

const errorOf = (answer: UploadAnswer): string | undefined => typeof answer.json['error'] === 'string' ? answer.json['error'] : undefined;

/** Whether a status says the BYTES are what was refused, so asking again with the same bytes asks for the same refusal. */
const aboutTheBytes = (status: number): boolean => status === 400 || status === 422;

/** The outcome of an answer to the request that completed an upload (or the only request of one). */
function settled(answer: UploadAnswer): PushOutcome {
  if (answer.status >= 200 && answer.status < 300) return answer.json['tombstoned'] === true ? { kind: 'tombstoned' } : { kind: 'delivered' };
  return aboutTheBytes(answer.status)
    ? { kind: 'refused', status: answer.status, error: errorOf(answer) }
    : { kind: 'failed', status: answer.status, error: errorOf(answer) };
}

/**
 * Push the stored file at `abs` (`size` plaintext bytes, hash `sha256`) to `peerId`'s upload door through `send`.
 * Throws only what `send` throws (a transport failure) or `openStoredRead` does (a file that cannot be read): the outcome of a
 * peer's answer is a value.
 */
export async function pushStoredFile(args: { peerId: string; abs: string; size: number; sha256: string; send: SendUpload }): Promise<PushOutcome> {
  const { peerId, abs, size, sha256, send } = args;
  const known = peerBodyLimits.get(peerId);
  if (size <= (known ?? PROBE_BYTES)) {
    const whole = await sendWhole(abs, size, send);
    if (whole.status !== 413) return settled(whole);
    // The peer's limit is lower than what it last announced (or than the probe): forget it and go through the chunked door,
    // which answers with the limit in force now.
    peerBodyLimits.delete(peerId);
  }
  return sendRanges(peerId, abs, size, sha256, send);
}

/** One streamed body, never held whole: the stored file's plaintext as the request body, its length as the `Content-Length`. */
async function sendWhole(abs: string, size: number, send: SendUpload): Promise<UploadAnswer> {
  const source = await openStoredRead(abs);
  try {
    return await send({ headers: { 'Content-Length': String(size) }, body: Readable.toWeb(source) as WebReadableStream<Uint8Array> });
  } finally {
    source.destroy();
  }
}

/** The ranges of a file, in order, each under what the peer takes, each carrying the whole file's hash. */
async function sendRanges(peerId: string, abs: string, size: number, sha256: string, send: SendUpload): Promise<PushOutcome> {
  const source = await openStoredRead(abs);
  try {
    const reader = new RangeReader(source);
    let start = 0;
    let window = Math.min(peerBodyLimits.get(peerId) ?? PROBE_BYTES, MAX_RANGE_BYTES);
    let first = true;
    while (start < size) {
      // The first range is always the probe's size, so the ranges of one file tile the same way whatever the peer's limit was
      // when this attempt began (the receiver keeps what an earlier attempt staged, by offset).
      const want = Math.min(first ? PROBE_BYTES : window, window, size - start);
      const bytes = await reader.take(want);
      if (bytes.length === 0) throw new Error(`the file ended at ${start} of ${size} bytes: it changed while it was being pushed`);
      const answer = await send({
        headers: {
          'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${size}`,
          'Content-Length': String(bytes.length),
          'x-expected-sha256': sha256,
        },
        body: bytes,
      });
      if (answer.status === 413 && bytes.length > MIN_RANGE_BYTES) {
        // Too large for this peer's single-body limit: this same range goes again at half the size.
        reader.giveBack(bytes);
        window = Math.max(MIN_RANGE_BYTES, Math.floor(bytes.length / 2));
        first = false;
        continue;
      }
      first = false;
      if (answer.status < 200 || answer.status >= 300 || answer.json['tombstoned'] === true) return settled(answer);
      start += bytes.length;
      if (start >= size) {
        // The completing request answers with the stored file's hash; a bare `received` after the last range is a peer that did not complete it.
        return typeof answer.json['sha256'] === 'string' || answer.json['received'] === undefined
          ? settled(answer)
          : { kind: 'failed', status: answer.status, error: 'the peer did not complete the upload after the last range' };
      }
      const announced = answer.json['maxBodyBytes'];
      window = isLimit(announced) ? Math.min(announced, MAX_RANGE_BYTES) : Math.min(window === PROBE_BYTES ? UNANNOUNCED_RANGE_BYTES : window, MAX_RANGE_BYTES);
      if (isLimit(announced)) peerBodyLimits.set(peerId, announced);
    }
    throw new Error('an empty file was sent through the chunked door');
  } finally {
    source.destroy();
  }
}
