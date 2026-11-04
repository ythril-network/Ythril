/**
 * Shared types for the file conversion pipeline.
 */

/** A single chunk produced by the section or paragraph chunker. */
/**
 * One report of forward motion, emitted as work lands.
 *
 * `steps` is the route THIS document is taking, not a fixed list: `decideRoute` returns a different
 * chain per extraction level and per what is actually wired in, so a progress bar built from it shows
 * the stages that will really run rather than a template with permanently-dark segments.
 *
 * `done`/`total` are units within the current step — pages, almost always. They are absent for steps
 * that are not divisible (validation either happened or did not), and a renderer should show those as
 * indeterminate rather than inventing a fraction.
 */
export interface StepProgress {
  /** The stage now running, e.g. `render`, `vlm`, `repair`. */
  step: string;
  /** Every stage this document's route will run, in order. */
  steps: string[];
  /** Units finished within `step`, when the step is divisible. */
  done?: number;
  /** Units expected within `step`, when known. */
  total?: number;
}

export interface Chunk {
  headingText: string | null;
  content: string;
  chunkIndex: number;
  /**
   * Set by the `embed` text level on its ONE chunk, the whole document: its vector is made from the beginning of the text (cut where
   * it is embedded), and the stored `content` stays whole. It is stored on the row so a rebuild can tell this chunk from a chunker's
   * (which the ceiling bounds, and which is never cut on rebuild): a stored passage over the ceiling WITHOUT it needs its file
   * re-converted. Local-only: chunks never sync.
   */
  wholeDocument?: true;
}

/** Implemented by every converter. */
export interface FileConverter {
  convert(fileBytes: Buffer, fileName: string): Promise<string>;
}

/**
 * Thrown when a converter is unable to produce content.
 *   reason = 'no_content'   → blank/corrupted document
 *   reason = 'sidecar_down' → unstructured sidecar unreachable
 *   reason = 'sidecar_error'→ sidecar returned non-200
 *   reason = 'too_large'    → input exceeds the conversion size cap (never retried)
 */
export class ConversionUnavailableError extends Error {
  readonly reason: 'no_content' | 'sidecar_down' | 'sidecar_error' | 'too_large' | 'unknown';

  constructor(reason: ConversionUnavailableError['reason'], message?: string) {
    super(message ?? reason);
    this.reason = reason;
    this.name = 'ConversionUnavailableError';
  }
}
