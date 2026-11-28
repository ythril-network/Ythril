/**
 * The RDF import's refusal for a file, or an index, over a named bound: the door's 413 (`rdf_bound_exceeded`).
 *
 * One module for the class so the two modules that raise it, the sorted spool (`import-spool.ts`) and the memory meter (`import-memory.ts`, which the
 * spool asks for its subject bound), can both import it without importing each other.
 */

const MiB = 1024 * 1024;
/** The digits a size is shown with once it is under 1 MiB, so a small test budget does not read "0.0 MiB". */
const SMALL_DIGITS = 4;
const LARGE_DIGITS = 1;

const mib = (bytes: number): string => (bytes / MiB).toFixed(bytes >= MiB ? LARGE_DIGITS : SMALL_DIGITS);

/** The name of a bound an import refuses at: the constant's own name. */
export type ImportBoundName =
  | 'RDF_IMPORT_MAX_QUADS' | 'RDF_IMPORT_MAX_MEMORY' | 'RDF_IMPORT_MAX_SUBJECT_QUADS' | 'RDF_IMPORT_MAX_SUBJECT_CHARS'
  | 'RDF_IMPORT_MAX_SPOOL_BYTES';

/**
 * A file, or what an import holds for it, over a named bound: the door's 413. `limit` is the bound's figure (for the memory bound the room one import is
 * given, in bytes) and `need`, for the memory bound only, what the import needs. `whole` says the need is the whole of it (a figure the file's counts
 * give, such as a phase's cost from its subjects, or the last charge of a count); without it the refusal came at the first charge past the room, before
 * the rest was known, and the need is at least that. The words say which, so a caller is never told "at least" when the figure to aim for is known.
 */
export class RdfImportBoundExceeded extends Error {
  readonly code = 'rdf_bound_exceeded' as const;
  constructor(readonly bound: ImportBoundName, readonly limit: number, readonly need?: number, readonly whole = false) {
    super(need === undefined
      ? `The file is over the import's bound ${bound} (${limit}); nothing was imported.`
      : `The file needs ${whole ? '' : 'at least '}${mib(need)} MiB for what the import holds in memory (its index, record sets, minted ids and inferred schema); `
        + `this instance gives one import ${mib(limit)} MiB (a quarter of the smaller of its heap limit and half its container's limit); nothing was imported.`);
    this.name = 'RdfImportBoundExceeded';
  }

  /** What a 413 for the bound carries beside its sentence, on the door's path and the act's alike: the bound, its figure and, for memory, the need. */
  get detail(): { bound: ImportBoundName; limit: number; need?: number } {
    return { bound: this.bound, limit: this.limit, ...(this.need !== undefined ? { need: this.need } : {}) };
  }
}
