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
import { beginSchemaValidate, SCHEMA_VALIDATE_MAX_LIMIT, SCHEMA_VALIDATE_CURSOR_MAX, SCHEMA_VALIDATE_SCAN_BOUND } from '../../spaces/schema-validate-door.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { HEAVY_CALLS_PER_WINDOW } from '../../rate-limit/heavy-tool.js';
import { KNOWLEDGE_TYPES } from '../../config/types-knowledge.js';
import { ToolRefusal } from '../../util/errors.js';
import { budgetSizeSchema } from './_page-budget-schema.js';

export const schema_validateTool: ToolHandler = {
  name: 'schema_validate',
  description: 'Check a schema against records without writing anything — the space\'s stored schema, or one you propose in `meta` '
    + '(parsed exactly as a schema save would parse it, so a rule the save would refuse is refused here in the same words). '
    + 'Needs the `read` rung on the `schema` area of the space — and a `sample` that runs rules in a proposed `meta` needs the right to '
    + 'SAVE those rules (`admin` on `schema`): a sample runs only the stored rules, or rules you could save, and is otherwise refused '
    + '(403) naming each rule field and what it needs. A proposed `meta` whose rules equal the stored ones is not a change of them.\n\n'
    + 'TWO MODES. With `sample: { kind, record }` the schema is run over ONE record you supply — `kind` is entity, edge, fact or '
    + 'chrono, `record` in the stored shape (`name` for an entity, `fact` for a fact, `title` for a chrono entry, `label` for an edge, '
    + 'with `type`, `description`, `tags`, `properties`) — and nothing stored is read: the quick way to try a rule. Without `sample` '
    + 'the schema is run over the space\'s stored records.\n\n'
    + 'THE ANSWER: `violations` lists each record that breaks the schema with its rows (`field`, `reason`); a rule\'s row is '
    + '`rules.<name>` (a type\'s rule) or `meta.rules.<name>` (a space rule) and its reason is the rule\'s message. `checked` says per '
    + 'collection how many records THIS call read of how many there are, and `progress` (stored records) is `{ checked, total }`: '
    + '`checked` is the records THIS call read — add it up over your pages, each record is read once, and it reaches `total` when the '
    + 'walk ends — and `total` is the space\'s record count when the check started (collection metadata), so a space that grows while '
    + 'you page can read above 100%. `complete` is true only when the walk reached its end. `staleGuards` lists the edges, among the '
    + 'records this call read, whose write guard names another subject (at most `limit`, each once across pages). The meta you sent is '
    + 'not echoed.\n\n'
    + 'STORED VALUES are shown only to a caller who may read the space\'s knowledge; otherwise each row comes without its `value`. '
    + 'A rule\'s row never carries one.\n\n'
    + `PAGING (stored records): \`limit\` violating records per call (1 to ${SCHEMA_VALIDATE_MAX_LIMIT}, default ${SCHEMA_VALIDATE_MAX_LIMIT}); `
    + 'a call STOPS reading at the record that fills its page (`limit` violating records, or `limit` stale guards, or the size budget), '
    + `at ${SCHEMA_VALIDATE_SCAN_BOUND} records, or at the end — it does not read on to count what it does not show. While records are `
    + 'left the answer carries `nextAfter`: pass it as `after` for the next page, which continues right after the last record this one '
    + 'read. THE SIZE BUDGET (`maxChars`, `maxBytes`, `maxTokens`) cuts a page to whole records: `truncated` says it did, and '
    + '`budgetChars` / `budgetBytes` say what was applied. Same parameters as `POST /api/spaces/:id/validate-schema`.\n\n'
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
        description: 'The schema to check, in the shape `space_meta` returns it (`typeSchemas`, `rules`, `validationMode`, ...). '
          + 'Omit it to check the space\'s stored schema.',
      },
      sample: {
        type: 'object',
        description: 'One record to check instead of the stored ones: `{ kind, record }`, `kind` one of entity, edge, fact, chrono.',
        properties: {
          kind: {
            // The REST body's own list (`SchemaValidateBody`): the knowledge types, by their one declaration.
            type: 'string', enum: [...KNOWLEDGE_TYPES],
            description: 'Which kind of record `record` is: its rules and its type schemas are the ones for this kind (a file is refused).',
          },
          record: {
            type: 'object',
            description: 'The record in its STORED shape, not the write tool\'s: `name` for an entity, `fact` for a fact, `title` for a '
              + 'chrono entry, `label` for an edge, with `type`, `description`, `tags` and `properties`. A field left out is empty.',
          },
        },
        required: ['kind', 'record'],
        additionalProperties: false,
      },
      limit: {
        type: 'integer', minimum: 1, maximum: SCHEMA_VALIDATE_MAX_LIMIT, default: SCHEMA_VALIDATE_MAX_LIMIT,
        description: `Violating records per page: 1 to ${SCHEMA_VALIDATE_MAX_LIMIT}, default ${SCHEMA_VALIDATE_MAX_LIMIT}.`,
      },
      after: {
        type: 'string', minLength: 1, maxLength: SCHEMA_VALIDATE_CURSOR_MAX,
        description: 'The `nextAfter` of the previous page, to continue after it. Omit it to start from the beginning.',
      },
      // The size ceilings every budgeted tool takes, from their one declaration.
      ...budgetSizeSchema('violating record', 'nextAfter'),
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
      rights: ctx.rights,
      callerKey: ctx.rateKey,
      // The door that received the call, as every budgeted tool reads it: a tool is also served as `POST /api/schema_validate`.
      transport: ctx.transport,
    });
    if (r.status !== 200) throw new ToolRefusal(r.status, r.error, r.body);
    // The answer in `content` as well as `structuredContent`: a client may read either one alone.
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.answer) }], structuredContent: { ...r.answer } };
  },
};
