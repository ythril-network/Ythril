/**
 * Is this answer the refusal a peer-bound token earns on a door that is not a sync door (bundle-47, Q-244)?
 *
 * ## What it prevents
 *
 * Every test that drives a peer token at a non-sync door asks the same question, and wrote it inline: `403` and `code: 'peer_door'`.
 * A copy that checked the status alone would pass on any other 403 (a rung refusal, a hold that answered 403), which is exactly the
 * answer the rule replaced, so the code is part of the question and lives here once. It reads the code from the body (`{ status, body }`,
 * the shape most helpers return) or from the answer itself (`{ status, code }`), so a caller need not reshape what it got.
 *
 * The code is the server's own constant, read from the built module, so a renamed code fails here and not in each test's own spelling.
 */
import { PEER_DOOR_CODE } from '../../server/dist/auth/peer-doors.js';

/** @param {{ status: number, code?: unknown, body?: { code?: unknown } }} answer */
export function isPeerDoorRefusal(answer) {
  return answer?.status === 403 && (answer.body?.code ?? answer.code) === PEER_DOOR_CODE;
}
