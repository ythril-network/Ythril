/**
 * The type reads of a `SchemaApi` stub, for a spec that mounts the Schema tab (or a record tab under a definition filter) and is not
 * about a type's history.
 *
 * Each answers as a server that does not support the type forms ("not supported", the answer an older one earns), so the tab draws no
 * History and no marker and the spec's own subject is unchanged. The tab and the landing call the type reads without a guard, so a stub
 * that leaves them out fails loudly instead of being read as "no history" by a catch written for it.
 */
import { of } from 'rxjs';

const unsupported = () => of({ supported: false as const });

/** Spread into the `useValue` of a `{ provide: SchemaApi, ... }` stub. */
export const NO_TYPE_READS = {
  typeList: unsupported,
  typeHistory: unsupported,
  typeStandings: unsupported,
  typeComparison: unsupported,
};
