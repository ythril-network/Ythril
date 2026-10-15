/**
 * MCP `schema_validate` (F-46) — the tool half of `POST /api/spaces/:id/validate-schema`. Both run `beginSchemaValidate`, the module
 * that also holds the rail, the single flight, the fixed projection and the rule that a stored value reaches only a caller who may
 * read the space's knowledge, so the two doors accept the same body, refuse for the same reasons in the same words and answer the
 * same rows.
 *
 * The one difference is the answer's envelope, and it is the tool's: it never echoes the meta it was sent — a tool answer lands in an
 * agent's context, and a meta is up to a megabyte of what the agent already holds. The REST route keeps its published echo in stored
 * mode.
 *
 * Dispatcher validation is skipped on purpose: the ONE parser both doors share does the refusing, so a malformed call is answered with
 * the same sentence, naming the same parameter, here as over REST. Not `heavy`, for the reason `ingest` and `file_stamp_report` are
 * not: the rail is inside the module (and only for the stored-data walk), and declared here as well the dispatcher would count every
 * call twice.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { beginSchemaValidate, mayReadStoredValues, SCHEMA_VALIDATE_MAX_LIMIT, SCHEMA_VALIDATE_CURSOR_MAX, SCHEMA_VALIDATE_SCAN_BOUND } from '../../spaces/schema-validate-door.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { HEAVY_CALLS_PER_WINDOW } from '../../rate-limit/heavy-tool.js';
import { ToolRefusal } from '../../util/errors.js';

export const schema_validateTool: ToolHandler = {
  name: 'schema_validate',
  description: 'Check a schema against records without writing anything — the space\'s stored schema, or one you propose in `meta` '
    + '(parsed exactly as `schema_update` would parse it, so a rule the save would refuse is refused here in the same words). '
    + 'Needs the `read` rung on the `schema` area of the space.\n\n'
    + 'TWO MODES. With `sample: { kind, record }` the schema is run over ONE record you supply — `kind` is entity, edge, fact or '
    + 'chrono, `record` in the stored shape (`name` for an entity, `fact` for a fact, `title` for a chrono entry, `label` for an edge, '
    + 'with `type`, `description`, `tags`, `properties`) — and nothing stored is read: the quick way to try a rule. Without `sample` '
    + 'the schema is run over the space\'s stored records.\n\n'
    + 'THE ANSWER: `violations` lists each record that breaks the schema with its rows (`field`, `reason`); a rule\'s row is '
    + '`rules.<name>` (a type\'s rule) or `meta.rules.<name>` (a space rule) and its reason is the rule\'s message. `totalViolations` '
    + 'counts the violating records the call read, `checked` says per collection how many records were read of how many there are, '
    + 'and `complete` is true only when nothing is left. The meta you sent is not echoed.\n\n'
    + 'STORED VALUES are shown only to a caller who may read the space\'s knowledge; otherwise each row comes without its `value`. '
    + 'A rule\'s row never carries one.\n\n'
    + `PAGING (stored records): \`limit\` violating records per call (1 to ${SCHEMA_VALIDATE_MAX_LIMIT}, default ${SCHEMA_VALIDATE_MAX_LIMIT}); `
    + `a call reads at most ${SCHEMA_VALIDATE_SCAN_BOUND} records. While records are left the answer carries \`nextAfter\`: pass it as `
    + '`after` for the next page. Same parameters as `POST /api/spaces/:id/validate-schema`.\n\n'
    + `A stored-records check is limited to ${HEAVY_CALLS_PER_WINDOW} runs a minute per token, counted with the REST route, and one run `
    + 'per space at a time (a second is a 409); a sample check is not limited.',
  mutating: false,
  spaceRequired: true,
  skipSchemaValidation: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      meta: {
        type: 'object',
        description: 'The schema to check, as `schema_update` takes its fields (`typeSchemas`, `rules`, `validationMode`, ...). '
          + 'Omit it to check the space\'s stored schema.',
      },
      sample: {
        type: 'object',
        description: 'One record to check instead of the stored ones: `{ kind, record }`, `kind` one of entity, edge, fact, chrono.',
        properties: {
          kind: { type: 'string', enum: ['entity', 'edge', 'fact', 'chrono'] },
          record: { type: 'object', description: 'The record in its stored shape.' },
        },
        required: ['kind', 'record'],
        additionalProperties: false,
      },
      limit: {
        type: 'integer', minimum: 1, maximum: SCHEMA_VALIDATE_MAX_LIMIT, default: SCHEMA_VALIDATE_MAX_LIMIT,
        description: `Violating records per page: 1 to ${SCHEMA_VALIDATE_MAX_LIMIT}, default ${SCHEMA_VALIDATE_MAX_LIMIT}.`,
      },
      after: {
        type: 'string', maxLength: SCHEMA_VALIDATE_CURSOR_MAX,
        description: 'The `nextAfter` of the previous page, to continue after it. Omit it to start from the beginning.',
      },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { space: _space, ...body } = ctx.args;
    const r = await beginSchemaValidate({
      spaceId: ctx.callSpace,
      memberIds: memberSpacesWithin(ctx.callSpace, ctx.accessibleSpaceIds),
      body,
      canReadValues: mayReadStoredValues(ctx.rights, ctx.callSpace),
      callerKey: ctx.rateKey,
    });
    if (r.status !== 200) throw new ToolRefusal(r.status, r.error);
    // The answer in `content` as well as `structuredContent`: a client may read either one alone.
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.answer) }], structuredContent: { ...r.answer } };
  },
};
