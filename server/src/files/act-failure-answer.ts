/**
 * Answer a caught failure that is a file act's refusal or failure — counted, and reported to the operator when it is the server's own.
 *
 * ## What it prevents
 *
 * Three doors met a caught failure the same first way and each wrote the two lines by hand: the REST routes' `catch`
 * (`sendCaughtFailure`, `api/send-failure.ts`), the MCP dispatcher (`mcp/call-tool.ts`) and a bulk resolution's per-id failure
 * (`api/conflicts.ts`) all asked {@link fileActAnswer}, and then, for an answer of `500` or above, reported the CAUSE with
 * `reportServerFailure`, because the answer's body is deliberately generic and the operator's only evidence is the log line. A copy that
 * dropped the report answered a `file_system_fault` or an `act_not_recorded` with nothing in the log, which is the silent 5xx
 * `a-5xx-never-discards-its-cause` exists for; a copy that called `fileActAnswerOf` instead did not count the answer
 * (`ythril_file_act_answers_total`). Here the count and the report are the one call.
 *
 * `undefined` is "this failure is not a file act's": the caller goes on to the store's answer (`storeFailureAnswer`) or its own, and
 * nothing was reported or counted. `where` names the operation for the operator's search, as `reportServerFailure` asks.
 * What each door does with the answer (a status line and `Retry-After`, `structuredContent`, one item of a bulk answer) stays the door's.
 */
import { fileActAnswer, type FileActAnswer } from './act-answers.js';
import { reportServerFailure } from '../util/report-failure.js';

export function answerFileActFailure(err: unknown, where: string): FileActAnswer | undefined {
  const answer = fileActAnswer(err);
  if (answer !== undefined && answer.status >= 500) reportServerFailure(where, err);
  return answer;
}
