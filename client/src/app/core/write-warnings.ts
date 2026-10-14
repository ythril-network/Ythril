import type { WireRow } from './refusal-text';

/**
 * A successful write's answer, split into the RECORD and the `warnings` it carried.
 *
 * Under `warn` mode (and for a violation a strict space does not block) the server stores the record and answers it with
 * `warnings: Row[]`. The record is what the lists and the drawer hold, and the warnings are not part of it: keeping them on the
 * record would put a transient answer into every list row and into the next save's body. Every editor takes the answer apart here,
 * so no surface reads the field its own way - and a surface that never reads it is the defect this module exists for.
 *
 * Only a list of rows counts: anything else the field could be is no warning at all.
 */
export function splitWriteWarnings<T extends object>(answer: T): { record: T; warnings: WireRow[] } {
  // An answer without the field is the record itself, not a copy of it: a host that compares what it saved by identity keeps working.
  if (!('warnings' in answer)) return { record: answer, warnings: [] };
  const { warnings, ...record } = answer as T & { warnings?: unknown };
  const rows = Array.isArray(warnings)
    ? warnings.filter((w): w is WireRow => w !== null && typeof w === 'object' && typeof (w as WireRow).field === 'string')
    : [];
  return { record: record as T, warnings: rows };
}
