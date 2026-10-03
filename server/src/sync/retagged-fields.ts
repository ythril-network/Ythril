/**
 * The fields a RECEIVER rewrites on every arrival — replicated, but never stored as the sender sent them.
 *
 * `spaceId` is the one there is: every arrival is stored under THIS instance's own id for the space
 * (`retagToLocalSpace` in `sync/upsert-plan.ts`, their one writer), and under a `spaceMap` alias that id is not the
 * sender's. So two instances holding the same data hold it under two ids, by design.
 *
 * ## A third category, and why it is its own list (`Q-307`, bundle-30 ruling `R7`)
 *
 * Not `LOCAL_ONLY_FIELDS` (`sync/local-only-fields.ts`): those are DROPPED from whatever arrives and the receiver's
 * own values carried across the replace — a `spaceId` on that list would be deleted from every arrival. And not an
 * ordinary replicated field either, whose value two peers agree on. A retagged field crosses the wire and is then
 * replaced, so what it holds on each side is local even though the field is not.
 *
 * ## Who reads it
 *
 * The divergence hash (`brain/merkle.ts`) leaves these out of every leaf: hashed, a space held under an alias
 * differed in every leaf, for ever, on identical content — a `MERKLE_DIVERGENCE` every cycle, the permanent false
 * alarm that teaches an operator to ignore the one signal that means data really is missing.
 */
export const RETAGGED_FIELDS: ReadonlySet<string> = new Set(['spaceId']);
