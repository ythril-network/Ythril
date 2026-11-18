/**
 * The records a schema conversion could not convert, over MCP (Q-919, bundle-284 design r5 sections 2.3 and 6): `list_unconverted` and
 * `dismiss_unconverted`, the tool half of `GET /api/spaces/:id/schema-convert/items` and `POST .../items/:itemId/dismiss`.
 *
 * ## Both surfaces, the same parameters
 *
 * Both doors run `spaces/unconverted-acts.ts`, which owns the parameters (`UnconvertedListParams` and the list module's paging), the rights
 * (`knowledge: read` for the list, `knowledge: write` for the dismiss, asked inside the act) and every refusal's sentence and code. The filters
 * declare the kinds, reasons, statuses and name length the act's schema holds (`UnconvertedFilterParams`, from the same constants), so a caller
 * reads the real bounds and the bounds gate compares them; the dispatcher's own check is skipped (`skipSchemaValidation`), so a wrong one is still
 * refused by the act's own code (`unconverted_bad_kind`, `unconverted_bad_status`...), the words the route answers too.
 *
 * Registered in `mcp/tools/index.ts`, priced in `TOOL_RIGHTS` and named in `MCP_TOOL_OPERATIONS`. A dismissal hands the audit entry what it did
 * (`ctx.recordAuditChanges`: the item id, or the filter, `expect` and count), which the operation's allowlist cuts to scalars.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { listUnconvertedAct, dismissUnconvertedAct, dismissShownUnconvertedAct } from '../../spaces/unconverted-acts.js';
import {
  refusalBody, UNCONVERTED_REFUSAL_CODES, UNCONVERTED_DISMISS_MAX, UNCONVERTED_REASONS, UNCONVERTED_STATUSES, type UnconvertedRow,
} from '../../spaces/unconverted-terms.js';
import { KNOWLEDGE_TYPES } from '../../config/types-knowledge.js';
import { TYPE_NAME_MAX } from '@ythril-network/schema/internal';
import { toolRefusalOfAct } from '../../util/errors.js';
import { dismissChanges, dismissShownChanges } from '../../audit/audit-changes.js';

/** The filters' bounds as the act's schema holds them (`UnconvertedFilterParams`), from the same constants; each tool adds its own words. */
const KIND_FILTER = { type: 'string', enum: [...KNOWLEDGE_TYPES] } as const;
const TYPE_FILTER = { type: 'string', maxLength: TYPE_NAME_MAX } as const;
const REASON_FILTER = { type: 'string', enum: [...UNCONVERTED_REASONS] } as const;

/** The refusal codes a list can answer: the filters, the paging and the rung. */
const LIST_CODES: ReadonlySet<string> = new Set([
  'unconverted_bad_kind', 'unconverted_bad_status', 'unconverted_bad_type', 'unconverted_bad_reason', 'unconverted_bad_paging', 'unconverted_rung',
]);

/** What an unconverted record is, in the words both tools open with. */
const WHAT_IT_IS = 'An unconverted record is one that a schema change left behind: the schema changed, a conversion (a save with `convertRecords`, a '
  + 'vote that carried one, or a conversion someone started by hand) rewrote the records it could, and this record could not be made to follow the new schema, so it '
  + 'was left as it is.';

/** The one-line form of a row, for the tool's text: kind, record, type, why, and the id the dismiss takes. */
const lineOf = (r: UnconvertedRow): string =>
  `- ${r.kind} ${r.recordId} (${r.type || 'no type'}): ${r.reason}${r.record ? ` "${r.record.summary}"` : ' (record gone)'} [itemId ${r.itemId}${r.status === 'dismissed' ? ', dismissed' : ''}]`;

export const list_unconvertedTool: ToolHandler = {
  name: 'list_unconverted',
  description: `List the unconverted records of a space. ${WHAT_IT_IS} Each row is \`{ itemId, kind, recordId, type, seq, fromFp, toFp, reason, violations, `
    + 'proposed, status, detectedAt, record? }`: `reason` says why it was not converted (`not_conforming`, `no_case_matched`, `both_set`, `could_not_evaluate`, '
    + '`relationship_exists`, `functional_taken`, `version_ceiling`, `fork`, `step_refused`, `conversion_failed`: a rewrite that kept failing for a reason '
    + 'no other class names, its one violation naming the kind of error and never its words), `violations` names the fields that do not conform and why '
    + '(never their values), `proposed` what the steps would have made of it (a new type, the property names set and removed), and `record.summary` is '
    + 'the record\'s own name or summary, absent when the record is gone. Newest first. The answer carries `total`, `skip`, `limit`, `count`, `truncated`, '
    + '`nextSkip` when the page is cut, and `counts` (`{ open, dismissed }`, of the whole space whatever the filters). This call writes nothing: a row for a '
    + 'record that was edited, converted or deleted since is removed by the server\'s own sweep a little later, and is listed until then. '
    + 'To settle one: edit the record (a later write checks it against the schema and stamps it), or convert again with other steps '
    + '(an administrator\'s call), or dismiss the item to stop listing it (a write call). Needs `knowledge: read`. '
    + `Refusals carry a code: ${UNCONVERTED_REFUSAL_CODES.filter(c => LIST_CODES.has(c)).join(', ')}.`,
  mutating: false,
  // The act judges every parameter with the coded refusal the route answers with (`unconverted_bad_paging`, `unconverted_bad_kind`...): the
  // dispatcher's own check would refuse `skip: -1` or `limit: "abc"` in its words and without the code, on this door only. Found by asking through
  // `tools/call`, which the handler-level cases did not.
  skipSchemaValidation: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      // The bounds of the act's schema (`UnconvertedListParams`); the act still refuses a wrong one by its own code, the words the route answers too.
      kind: { ...KIND_FILTER, description: 'Only the items of records of this kind: `entity`, `fact`, `edge` or `chrono`. Omit for every kind. Anything else is refused (`unconverted_bad_kind`).' },
      type: { ...TYPE_FILTER, description: 'Only the items of records of this type (a relationship\'s label for an edge), as a row\'s `type` says. Omit for every type. A name no schema could declare is refused (`unconverted_bad_type`).' },
      reason: { ...REASON_FILTER, description: 'Only the items with this reason class (a row\'s `reason`, for example `not_conforming` or `no_case_matched`). Omit for every reason. The same filter the bulk dismissal takes, so the number you are shown is the number it dismisses. Anything else is refused (`unconverted_bad_reason`).' },
      status: { type: 'string', enum: [...UNCONVERTED_STATUSES], description: '`open` (the default) lists the records still to settle, `dismissed` the ones that were dismissed. One status per call: `counts` carries both numbers. Anything else is refused (`unconverted_bad_status`).' },
      skip: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Rows to skip before the page, newest first: the `nextSkip` of the previous page. The server reads past them, so a deep skip costs a deep read.' },
      limit: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Rows in the page. A limit above the largest page is held to it and the answer\'s `limit` says what applied; the page also stops at the byte budget, and `truncated` and `nextSkip` say so.' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { kind, type, reason, status, skip, limit } = ctx.args;
    const r = await listUnconvertedAct(ctx.callSpace, { kind, type, reason, status, skip, limit }, { rights: ctx.rights, transport: ctx.transport });
    if ('error' in r) throw toolRefusalOfAct(r.status, r.error, refusalBody(r));
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
  // The act judges `itemId` with its own code (`unconverted_bad_item_id`), as the route does; see `list_unconvertedTool`.
  skipSchemaValidation: true,
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
    if ('error' in r) throw toolRefusalOfAct(r.status, r.error, refusalBody(r));
    const item = (r.body as { item: UnconvertedRow }).item;
    ctx.recordAuditChanges?.(dismissChanges(item.itemId));
    const text = `Dismissed the unconverted ${item.kind} '${item.recordId}' in '${ctx.callSpace}' (item ${item.itemId}): the item is now dismissed and no longer listed as open; the record is unchanged.`;
    return { content: [{ type: 'text' as const, text }], structuredContent: { ...r.body } };
  },
};

export const dismiss_unconverted_shownTool: ToolHandler = {
  name: 'dismiss_unconverted_shown',
  description: `Dismiss, in one call, every OPEN unconverted record that a filter lists in a space: the bulk form of \`dismiss_unconverted\`, for a schema change that left many records behind. ${WHAT_IT_IS} `
    + 'Dismissing stops listing the items as open: they stay listed, marked dismissed, and `list_unconverted` with `status: "dismissed"` still shows them. '
    + 'The records themselves are not changed: nothing is written to them. Pass the same `kind`, `type` and `reason` you listed with, and `expect`, the '
    + 'number of open items that list showed: the call dismisses exactly that set, or nothing. If the number moved since (items arrived or were settled) '
    + 'it is refused (409, `unconverted_changed`, with `current`), and if the filter matches more than one call may dismiss '
    + `(${UNCONVERTED_DISMISS_MAX} open items) it is refused (400, \`unconverted_too_many\`, with \`max\`): narrow the filter by kind, type or reason. `
    + 'Answers `{ dismissed }`. Needs `knowledge: write`. Other refusals: `unconverted_bad_kind`, `unconverted_bad_type`, `unconverted_bad_reason`, '
    + '`unconverted_bad_expect` (missing, or not a whole number), `unconverted_rung`.',
  // The act judges `expect` and the filter with their own codes, as the route does; see `list_unconvertedTool`.
  skipSchemaValidation: true,
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      kind: { ...KIND_FILTER, description: 'Only the items of records of this kind: `entity`, `fact`, `edge` or `chrono`. Omit for every kind. Anything else is refused (`unconverted_bad_kind`). The same filter `list_unconverted` takes.' },
      type: { ...TYPE_FILTER, description: 'Only the items of records of this type (a relationship\'s label for an edge). Omit for every type. A name no schema could declare is refused (`unconverted_bad_type`).' },
      reason: { ...REASON_FILTER, description: 'Only the items with this reason class (a `list_unconverted` row\'s `reason`). Omit for every reason. Anything else is refused (`unconverted_bad_reason`).' },
      expect: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'REQUIRED: the number of open items `list_unconverted` told you this filter lists (`total` with `status: "open"`). If the number now differs, nothing is dismissed and the call is refused (409, `unconverted_changed`, with the `current` number), so a confirmation of one number never dismisses another. Cost: list again and confirm when it moved.' },
    },
    required: ['space', 'expect'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { kind, type, reason, expect } = ctx.args;
    const r = await dismissShownUnconvertedAct(ctx.callSpace, { kind, type, reason, expect }, { rights: ctx.rights, transport: ctx.transport });
    if ('error' in r) throw toolRefusalOfAct(r.status, r.error, refusalBody(r));
    ctx.recordAuditChanges?.(dismissShownChanges({ kind, type, reason, expect }, (r.body as { dismissed: number }).dismissed));
    const text = `Dismissed ${(r.body as { dismissed: number }).dismissed} open unconverted item(s) in '${ctx.callSpace}': they stay listed under status "dismissed", and the records themselves are unchanged.`;
    return { content: [{ type: 'text' as const, text }], structuredContent: { ...r.body } };
  },
};
