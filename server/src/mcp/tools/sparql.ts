/**
 * MCP `sparql_query` (bundle-271, Q-757; design §2, r2 R1.2, R3.6, R3.7, R4.6): a SPARQL 1.1 query over a space or the caller's own view,
 * the tool half of `GET/POST /api/brain/spaces/:spaceId/sparql`.
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** Both run `rdf/sparql-answer.ts`, which owns the parameters, the members, the bounds, every refusal's sentence
 *   and code and the bytes of the answer; the dispatcher leaves those arguments to it (`argumentsJudgedByTheAct`). The answer body is the one
 *   REST answers (SPARQL results JSON for SELECT and ASK, Turtle for CONSTRUCT and DESCRIBE).
 * - **A budget that cuts a row in half** (decision 04). The size ceilings (`maxChars`, `maxBytes`, `maxTokens`, MCP only: an agent pays for
 *   the bytes in its own context) admit whole rows or statements only; what they cut is kept as a read spill (`read_spill`), each row
 *   `{spaceId, members, row}`, so the spill's read check and a space's deletion reach every member it came from.
 * - **A body with keys of its own.** What the answer left out is in the summary's `warnings` (members left out, file statements withheld),
 *   never in the results body.
 * - **A slot held past the call.** The act releases it when the answer is collected; nothing of the query runs after the call returns.
 *
 * Registered in `mcp/tools/index.ts`, priced in `TOOL_RIGHTS` (`knowledge: read`), recorded as the act `brain.sparql_query`
 * (`MCP_ACT_OPERATIONS`).
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { readSpacesOfCall, viewReadOfCall } from '../../spaces/read-scope.js';
import { toolRefusalOfAct, type ToolRefusalStatus } from '../../util/errors.js';
import { budgetSizeSchema } from './_page-budget-schema.js';
import { applyBudget, budgetBoundBy, carriagesFor, defaultBudgetChars, resolveBudget, ROW_PAGER, type ResolvedBudget, type BudgetOutcome } from '../../brain/result-budget.js';
import { spillResultSet } from '../../brain/graph-spill.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';
import { SPARQL_LIMIT_BOUNDS } from '../../config/sparql-limits.js';
import { MAX_SPACE_IDS } from '../../util/request-bounds.js';
import { createRdfWriter, RdfWriteError } from '../../rdf/serialize.js';
import type { Quad } from '../../rdf/literals.js';
import {
  answerSparql, prepareSparql, renderGraph, resultsJson, unwritable, holdsTriple, SPARQL_ENDPOINT_CODES, SPARQL_MEMBERS_LEFT_OUT, SPARQL_FILE_TRIPLES_WITHHELD, type PreparedSparql, type SparqlAnswerRefusal, type SparqlQueryInput,
} from '../../rdf/sparql-answer.js';

const STRINGS = { type: 'array', items: { type: 'string' } } as const;

/** The summary every answer carries in its second text block and in `structuredContent`. */
export const SPARQL_QUERY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    space: { type: 'string' }, members: STRINGS, form: { type: 'string', enum: ['select', 'ask', 'construct', 'describe'] }, mediaType: { type: 'string' },
    rows: { type: 'integer' }, returned: { type: 'integer' }, truncated: { type: 'boolean' },
    budgetChars: { type: 'integer' }, budgetBytes: { type: ['integer', 'null'] }, charsReturned: { type: 'integer' }, bytesReturned: { type: 'integer' },
    budgetBoundBy: STRINGS, remainder: { type: 'object' }, spillRefused: { type: 'string' },
    warnings: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, members: STRINGS }, required: ['code', 'members'] } },
  },
  required: ['space', 'members', 'form', 'mediaType', 'rows', 'returned', 'truncated'],
} as const;

/** The act's refusal as the tool's. */
function refused(r: SparqlAnswerRefusal): Error {
  return toolRefusalOfAct(r.status as ToolRefusalStatus, r.error, {
    error: r.error, code: r.code, ...(r.line !== undefined ? { line: r.line } : {}), ...(r.column !== undefined ? { column: r.column } : {}),
    ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}), ...(r.detail ?? {}),
  });
}

const isRefusal = (v: unknown): v is SparqlAnswerRefusal => typeof (v as SparqlAnswerRefusal | null)?.code === 'string' && typeof (v as SparqlAnswerRefusal).status === 'number';

/** What the answer left out, as the summary names it. */
function warningsOf(p: PreparedSparql): Array<{ code: string; members: string[] }> {
  return [
    ...(p.leftOut.length > 0 ? [{ code: SPARQL_MEMBERS_LEFT_OUT, members: p.leftOut }] : []),
    ...(p.filesWithheld.length > 0 ? [{ code: SPARQL_FILE_TRIPLES_WITHHELD, members: p.filesWithheld }] : []),
  ];
}

/** The budget's fields of a summary (no continuation: a query is asked again, with LIMIT and OFFSET, never paged by the server). */
function budgetSummary<T>(outcome: BudgetOutcome<T>, budget: ResolvedBudget): Record<string, unknown> {
  return {
    returned: outcome.returned.length, truncated: outcome.truncated,
    budgetChars: budget.stated?.chars ?? budget.chars, budgetBytes: budget.stated ? budget.stated.bytes : budget.bytes,
    charsReturned: outcome.charsReturned, bytesReturned: outcome.bytesReturned,
    ...(outcome.refusedBy ? { budgetBoundBy: budgetBoundBy(outcome.refusedBy, budget) } : {}),
  };
}

/** Keep `cut` (rows or statement lines) as a read spill, each `{spaceId, members, row}`; its place or why it was not kept. */
async function spillCut(ctx: ToolContext, members: readonly string[], cut: readonly unknown[], request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (cut.length === 0) return {};
  // Each row says which spaces it came from, as a record says its own (`spaceId`, the first member; `members`, all): the spill is addressed
  // to no space, and the store derives its read check and its deletion from these.
  const spaceId = members[0] ?? ctx.callSpace;
  const attributed = cut.map(row => ({ spaceId, members: [...members], row }));
  const kept = await spillResultSet({ issuedTo: ctx.actor?.tokenId, results: attributed, request });
  return 'spillRefused' in kept ? { spillRefused: kept.spillRefused } : { remainder: kept };
}

/** One statement as an N-Quads line, the unit a graph answer's budget admits and a spill keeps. */
function statementLine(q: Quad): string {
  const writer = createRdfWriter('nquads', { edgeDetails: holdsTriple(q) ? 'rdf12' : 'reification' });
  return writer.write({ quads: [q] }).trim();
}

export const sparql_queryTool: ToolHandler = {
  name: 'sparql_query',
  description: 'Ask a SPARQL 1.1 query (SELECT, ASK, CONSTRUCT, DESCRIBE) of the records of a space, read at query time. Name a personal view '
    + 'as `space` to query several spaces at once: the default graph is the union of the member spaces you read, and each member is its own '
    + 'named graph (`GRAPH ?g`). Same as GET/POST /api/brain/spaces/:spaceId/sparql.\n\n'
    + 'ANSWER: the first text block is the answer body REST gives: SPARQL results JSON for SELECT and ASK, Turtle for CONSTRUCT and '
    + 'DESCRIBE. The second block and `structuredContent` hold the summary: the form, the rows answered, the budget used, and `warnings` '
    + '(`members_left_out`: view members with RDF off or unsettled names; `file_triples_withheld`: members whose file statements need '
    + '`files: read`).\n\n'
    + 'WHOLE OR REFUSED: an answer over `sparql.maxResults` rows (or the lower `limit` you send) is refused (413, `sparql_too_many_results`), '
    + 'never cut short: use LIMIT and OFFSET in the query to page. A query that reads more than `sparql.maxRecordsRead` records or runs past '
    + '`sparql.timeoutMs` is refused too. The size ceilings (`maxChars`, `maxBytes`, `maxTokens`) admit whole rows only; the rows they cut '
    + 'are kept for a day as a spill, read with `read_spill` (the answer\'s `remainder`).\n\n'
    + 'NOT HERE: SERVICE (federation), SPARQL Update and LOAD are refused; FROM and `default-graph-uri` naming a graph outside your members '
    + 'answer empty. Cost: one query runs at a time per token (503 `sparql_busy` otherwise). Needs `knowledge: read`. '
    + `Refusals carry a code: ${SPARQL_ENDPOINT_CODES.join(', ')}.`,
  mutating: false,
  argumentsJudgedByTheAct: ['query', 'limit', 'default-graph-uri', 'named-graph-uri'],
  spaceRequired: true,
  outputSchema: SPARQL_QUERY_OUTPUT_SCHEMA,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      query: { type: 'string', minLength: 1, description: 'The SPARQL 1.1 query text (at most 64 KiB). SELECT, ASK, CONSTRUCT or DESCRIBE; prefixes as the query declares them.' },
      limit: { type: 'integer', minimum: 1, maximum: SPARQL_LIMIT_BOUNDS.maxResults.max, description: 'The most rows (or statements) the answer may hold, at most `sparql.maxResults` (default 10 000); an answer over it is refused, not cut. To cut, put LIMIT in the query.' },
      'default-graph-uri': { ...STRINGS, maxItems: MAX_SPACE_IDS, description: 'The SPARQL protocol\'s dataset: the member graphs that make up the default graph (replaces the query\'s FROM). A graph that is not one of your members holds nothing.' },
      'named-graph-uri': { ...STRINGS, maxItems: MAX_SPACE_IDS, description: 'The SPARQL protocol\'s dataset: the member graphs `GRAPH` may name (replaces FROM NAMED).' },
      ...budgetSizeSchema('row', ROW_PAGER),
    },
    // `query` is judged by the act (`sparql_no_query`, as on REST), so it is not required here: a missing one is answered by the code.
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const a = ctx.args;
    const budget = resolveBudget(a, defaultBudgetChars(ctx.transport), carriagesFor(ctx.transport));
    if (!budget.ok) throw new Error(budget.error);
    const spaces = readSpacesOfCall(ctx, ctx.callSpace);
    const input: SparqlQueryInput = {
      spaceId: ctx.callSpace, spaces, view: viewReadOfCall(ctx, ctx.callSpace) !== undefined,
      query: a['query'], limit: a['limit'], defaultGraphUri: a['default-graph-uri'], namedGraphUri: a['named-graph-uri'], accept: undefined,
      caller: ctx.callerRecord ?? { rights: ctx.rights ?? null }, callerKey: ctx.rateKey, fingerprintOf: schemaFingerprintOf,
    };
    const prepared = await prepareSparql(input);
    if (isRefusal(prepared)) throw refused(prepared);
    const answered = await answerSparql(input, prepared);
    // A refusal of the run is audited too, by the counts of the query it ended and its code as the outcome.
    if (isRefusal(answered)) {
      if (answered.auditChanges) ctx.recordAuditChanges?.(answered.auditChanges);
      throw refused(answered);
    }
    ctx.recordAuditChanges?.(answered.auditChanges);
    const c = answered.collected;
    const warnings = warningsOf(prepared);
    const head = { space: ctx.callSpace, members: prepared.members, form: prepared.form, rows: answered.rows, ...(warnings.length > 0 ? { warnings } : {}) };
    const request = { space: ctx.callSpace, form: prepared.form, rows: answered.rows };
    if (c.form === 'ask') {
      const body = resultsJson(c);
      const summary = { ...head, mediaType: 'application/sparql-results+json', returned: 1, truncated: false };
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }, { type: 'text' as const, text: JSON.stringify(summary) }], structuredContent: { ...body, ...summary } };
    }
    if (c.form === 'select') {
      const outcome = applyBudget(c.rows, budget);
      const body = resultsJson({ form: 'select', vars: c.vars, rows: outcome.returned });
      const summary = { ...head, mediaType: 'application/sparql-results+json', ...budgetSummary(outcome, budget), ...(await spillCut(ctx, spaces, outcome.remainder, request)) };
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }, { type: 'text' as const, text: JSON.stringify(summary) }], structuredContent: { ...body, ...summary } };
    }
    let lines: string[];
    try {
      lines = c.quads.map(statementLine);
    } catch (err) {
      if (err instanceof RdfWriteError) throw refused(unwritable());
      throw err;
    }
    const outcome = applyBudget(lines, budget);
    const document = renderGraph('turtle', c.quads.slice(0, outcome.returned.length));
    if (isRefusal(document)) throw refused(document);
    const summary = { ...head, mediaType: document.contentType, ...budgetSummary(outcome, budget), ...(await spillCut(ctx, spaces, outcome.remainder, request)) };
    return { content: [{ type: 'text' as const, text: document.body }, { type: 'text' as const, text: JSON.stringify(summary) }], structuredContent: { ...summary } };
  },
};
