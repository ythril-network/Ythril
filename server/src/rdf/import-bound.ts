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
 * A file, or the import's index and record sets, over a named bound: the door's 413. `limit` is the bound's figure (for the memory bound the room
 * one import is given, in bytes) and `need`, for the memory bound only, what the import needs: at least that, as the refusal comes at the first charge
 * past the room, before the whole need is known.
 */
export class RdfImportBoundExceeded extends Error {
  readonly code = 'rdf_bound_exceeded' as const;
  constructor(readonly bound: ImportBoundName, readonly limit: number, readonly need?: number) {
    super(need === undefined
      ? `The file is over the import's bound ${bound} (${limit}); nothing was imported.`
      : `The file needs at least ${mib(need)} MiB for the import's index and record sets; this instance gives one import ${mib(limit)} MiB `
        + '(a quarter of the smaller of its heap limit and half its container\'s limit); nothing was imported.');
    this.name = 'RdfImportBoundExceeded';
  }

  /** What a 413 for the bound carries beside its sentence, on the door's path and the act's alike: the bound, its figure and, for memory, the need. */
  get detail(): { bound: ImportBoundName; limit: number; need?: number } {
    return { bound: this.bound, limit: this.limit, ...(this.need !== undefined ? { need: this.need } : {}) };
  }
}
