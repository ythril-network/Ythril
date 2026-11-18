/**
 * The records a schema conversion could not convert, over MCP (Q-919, bundle-284 design r5 sections 2.3 and 6): `list_unconverted` and
 * `dismiss_unconverted`, the tool half of `GET /api/spaces/:id/schema-convert/items` and `POST .../items/:itemId/dismiss`.
 *
 * ## Both surfaces, the same parameters
 *
 * Both doors run `spaces/unconverted-acts.ts`, which owns the parameters (`UnconvertedListParams` and the list module's paging), the rights
 * (`knowledge: read` for the list, `knowledge: write` for the dismiss, asked inside the act) and every refusal's sentence and code. `kind` and
 * `status` declare no `enum` here on purpose: the act refuses a wrong one by its own code (`unconverted_bad_kind`, `unconverted_bad_status`), the
 * words the route answers too, where a schema `enum` would be refused by the dispatcher in other words.
 *
 * Not registered yet: `mcp/tools/index.ts` lists them, with the rights and audit rows (the wiring slice).
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { listUnconvertedAct, dismissUnconvertedAct, UNCONVERTED_REFUSAL_CODES, type UnconvertedRow } from '../../spaces/unconverted-acts.js';
import { toolRefusalOfAct } from '../../util/errors.js';

/** What an unconverted record is, in the words both tools open with. */
const WHAT_IT_IS = 'An unconverted record is one that a schema change left behind: the schema changed, a conversion (a save with `convertRecords`, a '
  + 'vote that carried one, or `space_schema_convert`) rewrote the records it could, and this record could not be made to follow the new schema, so it '
  + 'was left as it is.';

/** The one-line form of a row, for the tool's text: kind, record, type, why, and the id the dismiss takes. */
const lineOf = (r: UnconvertedRow): string =>
  `- ${r.kind} ${r.recordId} (${r.type || 'no type'}): ${r.reason}${r.record ? ` "${r.record.summary}"` : ' (record gone)'} [itemId ${r.itemId}${r.status === 'dismissed' ? ', dismissed' : ''}]`;

export const list_unconvertedTool: ToolHandler = {
  name: 'list_unconverted',
  description: `List the unconverted records of a space. ${WHAT_IT_IS} Each row is \`{ itemId, kind, recordId, type, seq, fromFp, toFp, reason, violations, `
    + 'proposed, status, detectedAt, record? }`: `reason` says why it was not converted (`not_conforming`, `no_case_matched`, `both_set`, `could_not_evaluate`, '
    + '`relationship_exists`, `functional_taken`, `version_ceiling`, `fork`, `step_refused`), `violations` names the fields that do not conform and why '
    + '(never their values), `proposed` what the steps would have made of it (a new type, the property names set and removed), and `record.summary` is '
    + 'the record\'s own name or summary, absent when the record is gone. Newest first. The answer carries `total`, `skip`, `limit`, `count`, `truncated`, '
    + '`nextSkip` when the page is cut, and `counts` (`{ open, dismissed }`, of the whole space whatever the filters). This call writes nothing: a row for a '
    + 'record that was edited, converted or deleted since is removed by the server\'s own sweep a little later, and is listed until then. '
    + 'To settle one: edit the record (a later write checks it against the schema and stamps it), or convert again with other steps '
    + '(`space_schema_convert`), or `dismiss_unconverted` it to stop listing it. Needs `knowledge: read`. '
    + `Refusals carry a code: ${UNCONVERTED_REFUSAL_CODES.filter(c => c !== 'unconverted_bad_item_id' && c !== 'unconverted_item_not_found').join(', ')}.`,
  mutating: false,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      // No enum or bound on these: the act refuses each by its own code, the words the route answers too.
      kind: { type: 'string', description: 'Only the items of records of this kind: `entity`, `fact`, `edge` or `chrono`. Omit for every kind. Anything else is refused (`unconverted_bad_kind`).' },
      type: { type: 'string', description: 'Only the items of records of this type (a relationship\'s label for an edge), as a row\'s `type` says. Omit for every type. A name no schema could declare is refused (`unconverted_bad_type`).' },
      status: { type: 'string', description: '`open` (the default) lists the records still to settle, `dismissed` the ones that were dismissed. One status per call: `counts` carries both numbers. Anything else is refused (`unconverted_bad_status`).' },
      skip: { type: 'integer', minimum: 0, description: 'Rows to skip before the page, newest first: the `nextSkip` of the previous page. The server reads past them, so a deep skip costs a deep read.' },
      limit: { type: 'integer', minimum: 1, description: 'Rows in the page. A limit above the largest page is held to it and the answer\'s `limit` says what applied; the page also stops at the byte budget, and `truncated` and `nextSkip` say so.' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { kind, type, status, skip, limit } = ctx.args;
    const r = await listUnconvertedAct(ctx.callSpace, { kind, type, status, skip, limit }, { rights: ctx.rights, transport: ctx.transport });
    if ('error' in r) throw toolRefusalOfAct(r.status, r.error, { error: r.error, ...(r.code ? { code: r.code } : {}) });
    const body = r.body as { items: UnconvertedRow[]; counts: { open: number; dismissed: number }; count: number; total: number };
    const head = `Unconverted records of '${ctx.callSpace}': ${body.counts.open} open, ${body.counts.dismissed} dismissed; ${body.items.length} on this page of ${body.total} matching.`;
    const text = body.items.length === 0 ? `${head} None on this page.` : `${head}\n${body.items.map(lineOf).join('\n')}`;
    return { content: [{ type: 'text' as const, text }], structuredContent: { ...r.body } };
  },
};

export const dismiss_unconvertedTool: ToolHandler = {
  name: 'dismiss_unconverted',
  description: `Dismiss one unconverted record from the list of a space. ${WHAT_IT_IS} Dismissing stops listing it as open: its row stays, marked dismissed, `
    + 'and `list_unconverted` with `status: "dismissed"` still shows it. The record is unchanged: nothing is written to it, it keeps its version and its '
    + 'stamp, and a later write of the record still checks it against the schema. A conversion that meets the same record version toward the same '
    + 'schema does not list it again; a new version of the record, or a schema change, can. Dismissing a dismissed item answers the same row. '
    + 'To settle a record otherwise: edit it, or convert again with other steps (`space_schema_convert`). Needs `knowledge: write`. '
    + 'Refused: an `itemId` that is not a bounded text (400, `unconverted_bad_item_id`), an item this space holds none of (404, `unconverted_item_not_found`), '
    + 'a token without the rung (403, `unconverted_rung`).',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      itemId: { type: 'string', description: 'The `itemId` of the row to dismiss, as `list_unconverted` lists it. An id this space holds no item for is refused (404), and another space\'s items are not reachable by it.' },
    },
    required: ['space', 'itemId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const r = await dismissUnconvertedAct(ctx.callSpace, ctx.args['itemId'], { rights: ctx.rights, transport: ctx.transport });
    if ('error' in r) throw toolRefusalOfAct(r.status, r.error, { error: r.error, ...(r.code ? { code: r.code } : {}) });
    const item = (r.body as { item: UnconvertedRow }).item;
    const text = `Dismissed the unconverted ${item.kind} '${item.recordId}' in '${ctx.callSpace}' (item ${item.itemId}): the item is now dismissed and no longer listed as open; the record is unchanged.`;
    return { content: [{ type: 'text' as const, text }], structuredContent: { ...r.body } };
  },
};
