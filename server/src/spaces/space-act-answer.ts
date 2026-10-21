/**
 * What a door answers for an error a space act raised: a write the space's standing act refused (`409` with that act's
 * `writeRefusalCode`), or an act refused because shutdown closed the runner (`503`). `null` for anything else.
 *
 * ## What it prevents (Q-560)
 *
 * The two halves were spelled `spaceWriteClosedAnswer(err) ?? spaceActClosedAnswer(err)` in the REST catch
 * (`sendCaughtFailure`) and in `callTool`, and not at all in the app's final error handler. A route that let the gate's
 * refusal propagate (Express 5 forwards a rejected handler there) answered `500 Internal server error` for a documented
 * `409 space_being_restored`, on sixteen of seventeen REST record routes, while the MCP door answered the same write
 * correctly. Every door that answers a caught error asks this one function, so a third door cannot know one half.
 *
 * Callers that ask only one half on purpose (a data route that runs an act and never a gated write, the rename's own
 * refusal) ask that half directly: theirs is a different question.
 */
import { spaceWriteClosedAnswer, type SpaceWriteClosedCode } from './space-write-gate.js';
import { spaceActClosedAnswer } from './space-act-runner.js';

export type SpaceActAnswer =
  | { status: 409; body: { error: string; code: SpaceWriteClosedCode } }
  | { status: 503; body: { error: string } };

/** The answer for an error a space act raised, or `null` when `err` is not one. */
export function spaceActAnswer(err: unknown): SpaceActAnswer | null {
  return spaceWriteClosedAnswer(err) ?? spaceActClosedAnswer(err);
}
