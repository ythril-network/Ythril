/**
 * The image a vision provider or a face detector is asked about: a PATH and the size, never the bytes.
 *
 * Both wires send the image as base64 inside a JSON body, and building that from a `Buffer` cost the file four times
 * over — in memory, as base64, as JSON, and again at the fetch encode — before the provider saw a byte (`Q-425`). From
 * a path the body is a stream with an exact `Content-Length`, and the size is what makes the length exact.
 *
 * ## Why this is its own module
 *
 * It is the one thing the provider contract (`providers.ts`) and the body builder (`image-body.ts`) both need, and the
 * builder is what the providers call — so while it lived in `providers.ts` the two imported each other at runtime. An
 * ESM cycle is legal until one side reads a binding during evaluation, and then it is `undefined` with the error far
 * from its cause (`no-runtime-import-cycles`). A leaf that both import has no such failure to wait for.
 */
export type ImageSource =
  /** A stored file: the big case, and the reason this is not a `Buffer` (`files/plaintext-file.ts`). */
  | { path: string; size: number }
  /**
   * Bytes already in memory, for the two callers that legitimately hold a small image: the model-verify probe (a fixed
   * test picture) and a video keyframe, which ffmpeg has just written and the job reads one at a time. Making those
   * write a file to be read back would add a copy in order to remove one.
   */
  | { bytes: Buffer };

/** The byte count of an image source, without reading it. */
export function imageSourceSize(src: ImageSource): number {
  return 'bytes' in src ? src.bytes.length : src.size;
}
