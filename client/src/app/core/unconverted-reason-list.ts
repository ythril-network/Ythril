/**
 * Why a record was not converted: the server's `UNCONVERTED_REASONS`, in its order, and the type of one.
 *
 * Its own module with no import so the wire types (`conversion.types`) and the reason classes (`unconverted-reasons`, which reads the wire
 * types and the Brain's tab order) need not import each other: that pair, joined to `api.types` through the vote row, was an import cycle of nine
 * modules. `unconverted-reasons` re-exports both, so a page still reads them there.
 */
export const UNCONVERTED_REASONS = [
  'not_conforming', 'no_case_matched', 'both_set', 'could_not_evaluate',
  'relationship_exists', 'functional_taken', 'version_ceiling', 'fork', 'step_refused', 'conversion_failed',
] as const;
export type UnconvertedReason = typeof UNCONVERTED_REASONS[number];
