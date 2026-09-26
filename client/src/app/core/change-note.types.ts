/**
 * A change note (F-42): markdown that travels with a downward sync. `in` arrived here from the instance above
 * (`from`); `out` was written here, and `pendingFor` names the members it has not reached yet.
 */
export interface ChangeNote {
  _id: string;
  networkId: string;
  direction: 'in' | 'out';
  note: string;
  /** Local space ids it concerns; empty = the whole network. */
  spaces: string[];
  author: string;
  generated: boolean;
  createdAt: string;
  pendingFor?: string[];
  /** Members that refused it as malformed; it is not offered to them again. */
  refusedBy?: string[];
  from?: string;
  receivedAt?: string;
}
