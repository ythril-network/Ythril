/**
 * The content hash of a STREAM, taken as the bytes pass: the stream twin of `util/sha256-hex.ts`, which answers the same
 * question for a Buffer.
 *
 * ## What it prevents
 *
 * A file too large to hold is hashed by a tap on the stream that carries it (the manifest reading a stored file, a chunked
 * upload assembling, a migration encrypting, a peer's body being staged), and that tap was written four times, each as a
 * `createHash` beside a `data` listener or a `for await`. The halves a copy drops are the two that make a tap a GUARD and not
 * only a meter:
 *
 *  - **the decision is made in `flush`**, before the stream ends. A tap that is read after the pipeline resolved says the hash is
 *    wrong when the bytes are already renamed into place; one that fails in `flush` fails the pipeline, so whatever the pipeline
 *    was writing is never completed (`stageStored` removes it);
 *  - **the cap is on the DECLARED size, enforced as bytes arrive.** A peer chooses its body, so a body far past the size it
 *    declared must stop being read at that size, not at its end — otherwise the declaration is a suggestion and the cost of the
 *    transfer is the peer's to set.
 *
 * A tap with no expectation only measures. With one, a body that is too long, too short or not the expected hash fails with a
 * {@link StreamVerificationError} naming which, and a caller that wants to say so (a pull warns, a door answers 422) tests for it.
 *
 * Not for a keyed or namespaced digest (`brain/merkle.ts`, derived ids, the upload id): those ask a different question.
 */
import { createHash, type Hash } from 'node:crypto';
import { Transform, Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Why a verified stream was refused. */
export type StreamVerificationCode = 'hash-mismatch' | 'size-exceeded' | 'size-short';

/** A stream that did not carry what it was expected to: more bytes than declared, fewer, or bytes that hash to something else. */
export class StreamVerificationError extends Error {
  constructor(readonly code: StreamVerificationCode, message: string) {
    super(message);
    this.name = 'StreamVerificationError';
  }
}

/** What a stream is expected to be. Both parts optional; with neither, the tap only measures. */
export interface TapExpectation {
  /** The lowercase hex sha256 the whole stream must hash to (checked in `flush`). */
  sha256?: string | undefined;
  /** The exact size in bytes: a longer stream is stopped at it, a shorter one is refused in `flush`. */
  size?: number | undefined;
}

/** A pass-through that counts and hashes what flows through it. `hex()` is the digest once the stream has ended. */
export interface Sha256Tap extends Transform {
  /** Bytes seen so far; the size of the stream once it has ended. */
  readonly size: number;
  /** The lowercase hex sha256 of everything that passed. Throws until the stream has ended (a hash of a prefix is a wrong answer). */
  hex(): string;
}

class Tap extends Transform implements Sha256Tap {
  private readonly hash: Hash = createHash('sha256');
  private seen = 0;
  private digest: string | undefined;

  constructor(private readonly expect: TapExpectation) { super(); }

  get size(): number { return this.seen; }

  hex(): string {
    if (this.digest === undefined) throw new Error('the stream has not ended: a hash of what has passed so far is not the hash of the stream');
    return this.digest;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (err?: Error | null, data?: Buffer) => void): void {
    this.seen += chunk.length;
    if (this.expect.size !== undefined && this.seen > this.expect.size) {
      done(new StreamVerificationError('size-exceeded', `the stream is longer than the ${this.expect.size} bytes it declared`));
      return;
    }
    this.hash.update(chunk);
    done(null, chunk);
  }

  override _flush(done: (err?: Error | null) => void): void {
    this.digest = this.hash.digest('hex');
    if (this.expect.size !== undefined && this.seen !== this.expect.size) {
      done(new StreamVerificationError('size-short', `the stream ended at ${this.seen} bytes, short of the ${this.expect.size} it declared`));
      return;
    }
    if (this.expect.sha256 !== undefined && this.digest !== this.expect.sha256.toLowerCase()) {
      done(new StreamVerificationError('hash-mismatch', 'the stream does not hash to the sha256 it was expected to'));
      return;
    }
    done();
  }
}

/** A tap for one stream: put it between the source and whatever the stream is written to. */
export function sha256Tap(expect: TapExpectation = {}): Sha256Tap {
  return new Tap(expect);
}

/** The lowercase hex sha256 and the byte count of a stream read to its end (the stream twin of `sha256Hex`). */
export async function sha256OfStream(source: Readable | AsyncIterable<Buffer | Uint8Array>): Promise<{ sha256: string; size: number }> {
  const tap = sha256Tap();
  const drain = new Writable({ write(_chunk, _encoding, done) { done(); } });
  await pipeline(source instanceof Readable ? source : Readable.from(source), tap, drain);
  return { sha256: tap.hex(), size: tap.size };
}
