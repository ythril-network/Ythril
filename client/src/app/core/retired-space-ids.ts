/**
 * Which of the ids a caller is about to use were once a proxy space and are still held back (Q-531).
 *
 * Since 6.0 a proxy is a personal view, and its old id is RESERVED until an instance admin purges it: createSpace, rename and a network join
 * all refuse it, and the server's refusal comes after the work (a join after the handshake). `GET /api/spaces` serves the list to an admin
 * (`retiredSpaceIds`), so a dialog asks THIS function before it submits and says the id aloud, instead of letting the server refuse it later.
 *
 * One question, asked by the create dialog and the join dialog: it answers the ids that are retired, in the order given. An absent list is
 * no reservation, which is how a non-admin's answer reads (the server still refuses; the dialog just cannot say so first).
 */
export function retiredAmong(ids: readonly string[], retired: readonly string[] | null | undefined): string[] {
  if (!retired || retired.length === 0) return [];
  const held = new Set(retired);
  return ids.filter(id => held.has(id));
}
