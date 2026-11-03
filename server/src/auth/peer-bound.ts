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

/**
 * The refusal a token made for ONE purpose earns when it is asked to act as the operator: `undefined` when the token may, the words
 * to say when it may not. A peer-bound token (a peer's sync credential) and a schema-library token (a read of the public schema
 * library) each exist for a single door; an act that hands out new access — approving an AI connector at `/mcp-oauth/consent`,
 * minting a token at `POST /api/tokens` — would turn either into a general credential: the connector minted from a peer token's
 * consent carries the peer's rights matrix and NO peer binding, so every `peerBoundTo()` reader and every peer revocation takes it
 * for the operator's own tooling and it outlives the peer.
 *
 * One question, asked by both doors, so the two cannot disagree on what counts as special-purpose. The rest of the middleware keeps
 * `schemaLibrary` out of every other route (`performAuth`), but the consent route authenticates a token pasted in its body and never
 * passes through it. `view-acts.ts` asks a narrower question ("may this own a view": peer-bound only) and keeps its own.
 *
 * @param act  What was attempted; the refusal says it cannot, and says what to do instead.
 */
export function specialPurposeApproverRefusal(
  record: object | null | undefined,
  act: 'approve a connector' | 'mint a token' = 'approve a connector',
): string | undefined {
  const special = peerBoundTo(record) !== undefined
    || (record as { readonly schemaLibrary?: unknown } | null | undefined)?.schemaLibrary === true;
  if (!special) return undefined;
  const remedy = act === 'approve a connector' ? 'Paste your own access token.' : 'Use your own access token.';
  return `This token is made for one purpose (a peer's sync or the schema library) and cannot ${act}. ${remedy}`;
}
