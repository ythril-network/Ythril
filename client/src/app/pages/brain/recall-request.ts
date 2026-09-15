import type { RecallKnowledgeType } from '../../core/api.types';
import type { RecallRequestBody } from '../../core/brain-api.service';
import type { RecallFormState, RecallTypeOpt } from './recall-form.component';

/**
 * The recall body, typed as the API method takes it rather than as a loose record.
 *
 * The route is `.strict()`, so a key it does not accept is a 400 — and this object is also what the JSON
 * preview shows an operator to paste into an MCP call. A loose record would compile with a key that
 * refuses, and the person who pasted it would get the error.
 */
export type RecallBody = RecallRequestBody;

/**
 * Either the body to send, or the translation key of the one thing wrong with the form.
 *
 * A discriminated result rather than a throw: the two callers want opposite things from a bad form. The
 * search reports it and stops; the preview shows the message where the JSON would be, without a console
 * error and without pretending it has a request.
 */
export type RecallRequest =
  | { body: RecallBody; errorKey?: undefined }
  | { body?: undefined; errorKey: string };

/**
 * Build the recall request from the form, and be the ONLY thing that does.
 *
 * ## Why this is a module and not a method
 *
 * `U-1`'s last piece is a live JSON view of the request beside the form, so an operator can copy it into an
 * MCP call. That view is worth nothing unless it is the SAME request — and "the same" cannot mean "built the
 * same way by a second reader of the same rules". That is this codebase's most expensive defect shape, and it
 * has shipped as: a proxy lens computed and discarded on three routes, an empty allowlist read as
 * unrestricted on three more, one shape rule with five copies. A preview assembled separately would be the
 * same mistake with a worse failure mode, because it would be believed: a caller pastes the JSON, gets a
 * different answer from the one on screen, and nothing anywhere is wrong.
 *
 * So the preview does not RE-BUILD the request. It calls this, and shows what it returns.
 *
 * ## Every rule here decides whether a value is SENT
 *
 * They are not uniform, and that is the point of pinning them in one place:
 *
 * - **three flags are sent only when ON**, and `includeContent` only when OFF, because the server includes
 *   content by default — spelling out `true` would put a parameter in every request meaning what its absence
 *   means;
 * - **the zeros are all "say nothing", for four different reasons**: `depth: 0` IS no expansion,
 *   `maxTimeMS: 0` is not a legal deadline, the three size ceilings mean "use the instance default", and
 *   `skip: 0` is the first page. `maxPerType: 0` means NO CAP, and sent literally would cap every type at
 *   nothing;
 * - **`types` and `minPerType` come off the same rows by different tests** — a ticked row with no minimum
 *   contributes to one and not the other.
 *
 * 19 characterization cases pin them, and were written before any of this moved.
 */
export function recallRequestFrom(form: RecallFormState, typeOpts: readonly RecallTypeOpt[]): RecallRequest {
  const query = form.query.trim();
  if (!query) return { errorKey: '' };

  const filterResult = objectField(form.filter, 'filter');
  if (filterResult.errorKey) return { errorKey: filterResult.errorKey };
  const projectionResult = objectField(form.projection, 'projection');
  if (projectionResult.errorKey) return { errorKey: projectionResult.errorKey };

  let filter = filterResult.value;
  // The "filter by type" dropdown is a friendly shortcut for filter:{type:{eq}}; it merges into (and
  // OVERRIDES the `type` key of) any hand-written filter above. The two controls sit in different groups
  // now, which is exactly when a reader stops noticing that one silently beats the other.
  if (form.type) filter = { ...(filter ?? {}), type: { eq: form.type } };

  const selected = typeOpts.filter(o => o.on);
  const types = selected.length ? selected.map(o => o.type) : undefined;

  const minPerType: Partial<Record<RecallKnowledgeType, number>> = {};
  for (const o of selected) {
    if (o.min != null && o.min > 0) minPerType[o.type] = o.min;
  }

  const tags = commaList(form.tags);
  const edgeLabels = commaList(form.edgeLabels);

  /*
   * The traversal, as an OBJECT rather than a bare number.
   *
   * A number reached the depth and nothing else, so `direction`, `edgeLabels` and the three `include*` flags
   * were unreachable from this panel however the rest of the request was written. The route accepts either
   * shape and a depth alone still sends `{ depth: n }`, which it reads identically — so this widened what
   * the form can say without changing what the same form said before.
   */
  const traverse = form.depth > 0
    ? {
        depth: form.depth,
        ...(form.direction ? { direction: form.direction } : {}),
        ...(edgeLabels.length ? { edgeLabels } : {}),
        ...(form.includeChrono ? { includeChrono: true } : {}),
        ...(form.includeMemories ? { includeMemories: true } : {}),
        ...(form.includeFiles ? { includeFiles: true } : {}),
      }
    : undefined;

  return {
    body: {
      query,
      topK: form.topK,
      minScore: form.minScore || undefined,
      ...(types ? { types } : {}),
      ...(Object.keys(minPerType).length ? { minPerType } : {}),
      ...(tags.length ? { tags } : {}),
      ...(filter ? { filter } : {}),
      ...(form.maxPerType > 0 ? { maxPerType: form.maxPerType } : {}),
      ...(form.includeFreshWrites ? { includeFreshWrites: true } : {}),
      ...(form.includeContent ? {} : { includeContent: false }),
      ...(form.includeDiagnostics ? { includeDiagnostics: true } : {}),
      ...(form.includeRecordMeta ? { includeRecordMeta: true } : {}),
      ...(traverse ? { traverse } : {}),
      ...(projectionResult.value ? { projection: projectionResult.value } : {}),
      ...(form.maxTimeMS > 0 ? { maxTimeMS: form.maxTimeMS } : {}),
      // The size ceiling in all four units. Sending more than one is legal and the server applies whichever
      // is SMALLEST, which is what makes offering all four honest rather than confusing.
      ...(form.maxBytes > 0 ? { maxBytes: form.maxBytes } : {}),
      ...(form.maxChars > 0 ? { maxChars: form.maxChars } : {}),
      ...(form.maxTokens > 0 ? { maxTokens: form.maxTokens } : {}),
      // Only with a token ceiling: on its own it converts nothing, and the control is hidden for the same
      // reason. Guarded so a 0 cannot reach a divisor.
      ...(form.maxTokens > 0 && form.charsPerToken > 0 ? { charsPerToken: form.charsPerToken } : {}),
      ...(form.skip > 0 ? { skip: form.skip } : {}),
      ...(form.remainderDump ? { remainderDump: true } : {}),
    },
  };
}

/**
 * The request as an operator would paste it into an MCP call, or the message saying why there is none.
 *
 * `minScore: form.minScore || undefined` leaves an explicit `undefined` on the object, which is invisible
 * over the wire and would print as nothing useful — `JSON.stringify` drops it, which is why the preview is
 * built by stringifying rather than by walking the object.
 */
export function recallRequestJson(form: RecallFormState, typeOpts: readonly RecallTypeOpt[]): RecallRequest & { json: string } {
  const result = recallRequestFrom(form, typeOpts);
  return { ...result, json: result.body ? JSON.stringify(result.body, null, 2) : '' };
}

/** A comma-separated field as a list: trimmed, empties dropped. Absent rather than `[]` when it says nothing. */
function commaList(raw: string): string[] {
  return raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
}

/**
 * A JSON-object field, or the key of the message explaining what is wrong with it.
 *
 * Parsed here rather than sent as text so a typo is a form error and not a 400, and REFUSED when it parses
 * to an array or a scalar: `[1,2]` is valid JSON and is not a filter, and the route would reject it with a
 * message about a field the operator was not editing.
 */
function objectField(raw: string, which: 'filter' | 'projection'):
  { value?: Record<string, unknown>; errorKey?: string } {
  const text = raw.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errorKey: `brain.query.${which}InvalidJson` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { errorKey: `brain.query.${which}MustBeObject` };
  }
  return { value: parsed as Record<string, unknown> };
}
