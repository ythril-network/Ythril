/**
 * "Did this instance issue this tombstone?" — a LOCAL mark, asked in one place (bundle-81, design rev 8 §6e, decision 1; decision 59 for files).
 *
 * ## The question it answers
 *
 * A tombstone is issued here when the local tombstone writer stamped `issuedHere: true` on it. Its one reader is push selection
 * (`sync/push-selection.ts`): a closed, democratic or club network sends only the deletions this instance issued, and a relayed one reaches the
 * peers below by pull.
 *
 * ## What it prevents
 *
 * A tombstone's `instanceId` is the SENDER's text. Asked of it, "issued here" lets a peer store a tombstone naming this instance as issuer, which the
 * mesh push then forwards as this instance's own deletion — and at the next hop the deliverer equals the issuer, so it reads as proven
 * (`sync/deletion-authority.ts`, security S1). The mark is stamped by the local writer alone, is never on the wire (`TOMBSTONE_LOCAL_FIELDS`), and an
 * arrival stores `false` — so no text a peer writes decides it, and this module never reads the issuer field at all.
 *
 * Tombstones stored before 6.0 carry no mark: nothing then proved who issued one, so none is pushed on the mesh as this instance's own (they reach
 * mesh peers by pull, which serves every stored tombstone). The deletion authority asks a different question (whose deletion governs a record) and
 * stays in `sync/deletion-authority.ts`.
 */

/** The filter matching tombstones this instance issued. */
export function issuedHereFilter(): { issuedHere: true } {
  return { issuedHere: true };
}

/** Did this instance issue this stored tombstone (brain or file)? */
export function isIssuedHere(row: { readonly issuedHere?: unknown } | null | undefined): boolean {
  return row?.issuedHere === true;
}

/**
 * What a LOCAL writer of a tombstone stamps. Only a writer that is this instance's own act (a local delete) spells it, so the mark exists in one
 * writer per tombstone kind: the brain tombstone (`brain/tombstones.ts`, which names the field itself) and the file tombstone (`files/tombstones.ts`, through this).
 */
export function issuedHereStamp(): { issuedHere: true } {
  return { issuedHere: true };
}
