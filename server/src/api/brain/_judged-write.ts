/**
 * What a REST brain write route does with the unknown-field judge's answer — the two lines every route used to leave to itself (Q-320,
 * bundle-128).
 *
 * ## The question this answers
 *
 * "The judge (`contract/write-accepts.ts`) has said whether this body carried a field the write does not take. How does the route carry
 * that onto its answer?" There are two things, and they are one function because a route that did one and forgot the other is the
 * defect this exists for:
 *
 * - **the rows ride on EVERY answer the request gives from here on**, not on the success body alone. A route has about fifteen
 *   `res.status(400).json(...)` sites; a judge that put its rows on the 201 told a caller nothing on the answer it reads most carefully,
 *   the refusal. The decoration is `decorateJsonAnswer`'s (`api/decorate-json-answer.ts`), so none of the sites has to remember, and the
 *   rows are worded for what the answer says happened to the write (`unknownFieldRowsAs`): `ignored`, with the received value, where the
 *   record was stored, `not accepted` and no value where it was not.
 * - **a refusal the judge made is sent, and ends the request.** A retired name in either mode, or an unknown field in a space set to
 *   refuse, is a 400 before any other check and before anything is stored.
 *
 * What it does not do: it does not judge (the route calls `answerUnknownWriteFields` itself, after it has resolved its target and before
 * it reads the body — `a-route-judges-before-it-checks-the-body` holds that order), and it does not put rows on an answer where nothing was
 * stored because the store failed (`answerCarriesUnknownFieldRows`, the one predicate the MCP door asks too).
 */
import type express from 'express';
import { decorateJsonAnswer, answerCarriesUnknownFieldRows, answerLeftARecord } from '../decorate-json-answer.js';
import { unknownFieldRowsAs, withUnknownFieldWarnings } from '../../contract/unknown-field-rows.js';
import type { UnknownFieldAnswer } from '../../contract/write-accepts.js';

/**
 * Carry the judge's answer onto this request's answers; when it refused the write, send that refusal.
 *
 * @returns `true` when the judge refused and the refusal has been sent — the route must `return`; `false` when the write goes on.
 */
export function applyJudgment(res: express.Response, judged: UnknownFieldAnswer): boolean {
  if (judged.rows.length > 0) {
    decorateJsonAnswer(res, 'unknown-field-rows', (status, body) => {
      if (!answerCarriesUnknownFieldRows(status, body)) return body;
      // A 5xx that left its record behind (`ConnectionsNotWritten`) is a write that happened: the field WAS ignored.
      const outcome = status < 400 || answerLeftARecord(body) ? 'stored' : 'refused';
      return { ...body, warnings: withUnknownFieldWarnings(body['warnings'], unknownFieldRowsAs(judged.rows, outcome)) };
    });
  }
  if (!judged.refused) return false;
  res.status(400).json(judged.refusal);
  return true;
}
