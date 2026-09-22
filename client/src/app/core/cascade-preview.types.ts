/**
 * What deleting an entity would take with it, and the token that authorises exactly that set.
 *
 * ## Its own module, because `api.types.ts` is frozen
 *
 * `no-new-god-files` refuses a frozen file growing, and its reason is the one that applies here: the
 * failure mode of a god-file is not its size on a given day, it is that every change lands in the same
 * place because that is where the code already is. This type belongs beside the behaviour that reads it.
 *
 * ## What the fields mean
 *
 * `removes` is what BLOCKS the plain delete — the records that reference this entity. **Nothing at the
 * other end of those edges is touched**: the edge goes, the record it pointed at stays. That promise is
 * the one the confirmation dialog makes, so it is written where the type is.
 *
 * `token` is DERIVED from the set rather than stored, so it stops matching the moment the set changes —
 * which is what stops a record added since the preview from being deleted by a decision taken before it
 * existed.
 */
export interface CascadePreview {
  entityId: string;
  removes: CascadeRemoval[];
  token: string;
}

/** One record standing in the way, and which end of it named the entity (edges only). */
export interface CascadeRemoval {
  type: 'edge' | 'fact' | 'chrono' | 'file' | 'face';
  _id: string;
  end?: 'from' | 'to' | 'both';
}
