/**
 * The peer a token is bound to: the one reader of a token record's `peerInstanceId`.
 *
 * ## What it prevents
 *
 * A peer token is a PEER's credential and every other token the operator's, and a door that reads the field itself decides which of the
 * two it is looking at. The field was read by hand at every door — the sync routes, the governance relay, the rights middleware, the
 * search fan-out, the tool dispatch — each correct while every site agreed on what counts as bound: a non-empty string. The first door
 * to read it slightly differently (an empty string taken for a peer, which is held with nobody) is a silent change of who is the operator.
 *
 * It takes the record structurally, whatever shape reached the door: an authenticated token off a request, the config's token row an
 * id resolves to, or an OIDC session built per request, which is bound to no peer. No record, or no usable value, is `undefined`:
 * an input carrying no information is the operator's own tooling, never a peer.
 *
 * It lives in `auth/` and imports nothing, so the sync router, the governance relay and the tool dispatch can all reach it without
 * closing an import loop (the relay kept a local copy of its one line for that reason, and a gate held the two alike).
 */
export function peerBoundTo(record: object | null | undefined): string | undefined {
  const peer = (record as { readonly peerInstanceId?: unknown } | null | undefined)?.peerInstanceId;
  return typeof peer === 'string' && peer ? peer : undefined;
}
