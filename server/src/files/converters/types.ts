/**
 * Shared types for the file conversion pipeline.
 */

/** A single chunk produced by the section or paragraph chunker. */
export interface Chunk {
  headingText: string | null;
  content: string;
  chunkIndex: number;
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
 */
export class ConversionUnavailableError extends Error {
  readonly reason: 'no_content' | 'sidecar_down' | 'sidecar_error' | 'unknown';

  constructor(reason: ConversionUnavailableError['reason'], message?: string) {
    super(message ?? reason);
    this.reason = reason;
    this.name = 'ConversionUnavailableError';
  }
}
