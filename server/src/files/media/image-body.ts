/**
 * The request body for an image a vision provider is asked about: a prefix, the file's base64, and a suffix — with the
 * exact `Content-Length`, computed rather than measured (`Q-425`).
 *
 * ## What it replaces
 *
 * The caption call built one string: the file in memory, its base64 (1.33x), the JSON around that (1.33x again) and
 * whatever `fetch` encoded for the wire (1.33x once more). For a 64 MiB image that is most of the seven times its size
 * this ticket is about, and it happened before the provider saw a byte.
 *
 * ## Why the LENGTH is the rule, and not "it streams"
 *
 * A stream of unknown length goes out `Transfer-Encoding: chunked`, and an OpenAI-compatible provider, a proxy in front
 * of one, or llama.cpp's own server may refuse a chunked upload outright. A stub server accepts anything, so "the stub
 * took it" proves nothing. So the length is computed from the file's size — base64 is exactly `4 * ceil(n / 3)` bytes,
 * and the prefix and suffix are fixed strings — and the body is a stream. If the two ever disagreed the request would
 * hang or be truncated, which is why the file's size comes from a stat of the stored file and not from counting.
 *
 * ## One shape, two wires
 *
 * The Ollama wire puts the base64 in `messages[0].images[0]`; the OpenAI-compatible one puts a `data:` URL in
 * `content[1].image_url.url`. Both are a prefix and a suffix around the same base64, so they share this builder and
 * differ only in the two strings — written out per wire by the provider, because inventing a shape neither accepts is
 * the one mistake a shared builder could make for both of them at once.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { imageSourceSize, type ImageSource } from './image-source.js';

/** The encoded length of `n` bytes of base64, which is exact and not an estimate. */
export function base64Length(n: number): number {
  return 4 * Math.ceil(n / 3);
}

export interface StreamedBody {
  /** A fresh body for one hop — a redirect asks again (`ssrfSafeFetch` takes this as its body factory). */
  stream(): Readable;
  /** What the body will be, to the byte. */
  contentLength: number;
}

/**
 * A body of `prefix` + the base64 of `filePath` + `suffix`, `size` being the file's own byte count.
 *
 * The caller passes the two strings for its wire and nothing else: every byte of the image goes from the file to the
 * socket through one transform, and the only thing held is the base64 of a chunk at a time.
 */
export function streamedImageBody(o: { src: ImageSource; prefix: string; suffix: string }): StreamedBody {
  const prefixBytes = Buffer.byteLength(o.prefix, 'utf8');
  const suffixBytes = Buffer.byteLength(o.suffix, 'utf8');
  return {
    contentLength: prefixBytes + base64Length(imageSourceSize(o.src)) + suffixBytes,
    stream: () => Readable.from(parts(o.src, o.prefix, o.suffix)),
  };
}

/**
 * A marker that survives `JSON.stringify` unchanged — no character JSON escapes — so a body built as an ORDINARY
 * object can be split around it afterwards.
 */
const IMAGE_MARKER = '@@YTHRIL-IMAGE-BASE64@@';

/**
 * The streamed body of a request whose JSON carries the image's base64 in one place.
 *
 * `envelope` builds the request body as a normal object, putting the marker wherever the base64 goes. It is then
 * serialised by `JSON.stringify` exactly as it always was and split around the marker — so **no provider writes JSON
 * by hand**, which is the one way a streamed body could produce something a server reads differently from the object
 * the author wrote. A marker that does not appear exactly once is a programming error and throws.
 */
export function bodyAroundImage(envelope: (marker: string) => unknown, src: ImageSource): StreamedBody {
  const json = JSON.stringify(envelope(IMAGE_MARKER));
  const parts = json.split(IMAGE_MARKER);
  if (parts.length !== 2) {
    throw new Error(`bodyAroundImage: the marker appears ${parts.length - 1} time(s) in the request body, not once`);
  }
  return streamedImageBody({ src, prefix: parts[0]!, suffix: parts[1]! });
}

/**
 * The body as an async iterable: the prefix, the file's base64 in 3-byte-aligned pieces, the suffix.
 *
 * The alignment is what makes the length exact: base64 of a stream encoded in arbitrary pieces pads EACH piece, so
 * three 1-byte chunks would be twelve characters where the whole is four. Reading in a multiple of 3 means only the
 * last piece can pad, exactly as `4 * ceil(n / 3)` says.
 */
async function* parts(src: ImageSource, prefix: string, suffix: string): AsyncGenerator<Buffer> {
  yield Buffer.from(prefix, 'utf8');
  if ('bytes' in src) {
    // Already in memory: one base64 of the whole, which is what the length says. Nothing is saved by chunking it.
    yield Buffer.from(src.bytes.toString('base64'), 'utf8');
    yield Buffer.from(suffix, 'utf8');
    return;
  }
  // A multiple of 3 (and of 64 KiB, for the read itself): `highWaterMark` bounds the piece, and a remainder is carried
  // to the next one rather than padded here.
  let carry = Buffer.alloc(0);
  /*
   * SMALL pieces on purpose, and the number is the one thing in this file that is about the runtime rather than the
   * wire.
   *
   * V8 allocates anything from about 256 KiB upward in large-object space, which the nursery never touches: only a
   * major collection frees it. Encoding a 64 MiB image in 192 KiB reads made a 256 KiB string and a 256 KiB buffer per
   * read — every one of them just over that line — so the garbage of one image sat in the old generation and the peak
   * grew by 2.6 times the file for a body that streams. At 48 KiB (a multiple of 3, so only the last piece pads) both
   * the string and the buffer are 64 KiB, they die in the nursery, and the peak is the stream's own.
   */
  for await (const chunk of createReadStream(src.path, { highWaterMark: 48 * 1024 })) {
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    const whole = buf.length - (buf.length % 3);
    if (whole > 0) yield Buffer.from(buf.subarray(0, whole).toString('base64'), 'utf8');
    carry = Buffer.from(buf.subarray(whole));
  }
  if (carry.length > 0) yield Buffer.from(carry.toString('base64'), 'utf8');
  yield Buffer.from(suffix, 'utf8');
}
