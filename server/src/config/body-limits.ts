/**
 * How large a body the admin import door takes: `importBodyMaxBytes` (inflated bytes) and `importMaxDocuments` (documents in every family),
 * each a positive integer, validated when the config is loaded or reloaded and read live by the door (bundle-40 R1, Q-267).
 *
 * ## What it prevents
 *
 * The import sat behind the global 10 MB parser, so the only bound on a restore was one nobody chose for it, and it refused every backup of a
 * large space. The door now spools a body of any size, so it needs bounds of its own: the bytes it writes to disk (counted AFTER inflating, so
 * a small gzip body cannot expand past it) and the documents its index holds a few bytes each for. A value that is not a positive integer
 * refuses the load, naming the key: a ceiling read as `NaN` compares false against everything and bounds nothing.
 *
 * A leaf module: the loader imports it.
 */

/** The inflated bytes one import body may hold when `importBodyMaxBytes` is not set: 1 GiB. */
export const DEFAULT_IMPORT_BODY_MAX_BYTES = 1024 * 1024 * 1024;
/** The documents one import body may hold when `importMaxDocuments` is not set. */
export const DEFAULT_IMPORT_MAX_DOCUMENTS = 5_000_000;

/** The request-body limits of the config, declared here and extended by `Config`: the import's, and the file upload's beside them. */
export interface BodyLimitsConfig {
  /** The most bytes one admin import body may hold once inflated; above it the door answers 413. Default 1 GiB. */
  importBodyMaxBytes?: number;
  /** The most documents one admin import body may hold, every family together; above it the door answers 413. Default 5 000 000. */
  importMaxDocuments?: number;
  /** The single-body limit of a file upload (`files-upload.ts`); default 50 MiB. */
  maxUploadBodyBytes?: number;
  /** Max total size (bytes) a chunked upload may declare via Content-Range. Default 10 GiB. The storage quota (if configured) applies on top. */
  maxChunkedUploadBytes?: number;
}

const KEYS = ['importBodyMaxBytes', 'importMaxDocuments'] as const;

/** Refuse a config whose import limits are set and are not positive integers, naming the key. */
export function validateImportLimits(cfg: BodyLimitsConfig): void {
  for (const k of KEYS) {
    const v = cfg[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
      throw new Error(`config.json: ${k} must be a positive whole number (got ${JSON.stringify(v)})`);
    }
  }
}

/** The inflated bytes one import body may hold, read live. */
export function importBodyMaxBytes(cfg: BodyLimitsConfig): number {
  return cfg.importBodyMaxBytes ?? DEFAULT_IMPORT_BODY_MAX_BYTES;
}

/** The documents one import body may hold, read live. */
export function importMaxDocuments(cfg: BodyLimitsConfig): number {
  return cfg.importMaxDocuments ?? DEFAULT_IMPORT_MAX_DOCUMENTS;
}
