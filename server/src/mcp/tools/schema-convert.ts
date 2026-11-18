/**
 * MCP `space_schema_convert` and `space_schema_conversion` (Q-746, bundle-284 design r5 section 2.3): start a conversion of the records of named types
 * toward a space's current schema, and read how it went - the tool halves of `POST` and `GET /api/spaces/:id/schema-convert`.
 *
 * Both run `spaces/schema-convert-acts.ts`, so the doors take the same parameters and answer the same bodies and refusals. The start hands the
 * arguments to the act whole (less `space`) and the dispatcher's own argument check is skipped for it (`skipSchemaValidation`), so a key the capability
 * has no parameter for is refused by the act, by the code the route answers with. The rights are decided inside the act (the knowledge rung, and for a
 * start the space's admin right); `TOOL_RIGHTS` rows (`knowledge: admin` for the start, `knowledge: read` for the read) are the wiring's.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { schemaConvertStartAct, schemaConvertStatusAct, SCHEMA_CONVERT_REFUSAL_CODES, type SchemaConvertActResult } from '../../spaces/schema-convert-acts.js';
import { SCHEMA_CONVERT_TYPES_MAX } from '../../spaces/schema-convert-run.js';
import { KNOWLEDGE_TYPES } from '../../config/types-knowledge.js';
import { toolRefusalOfAct, type ToolRefusal } from '../../util/errors.js';
import { CONVERT_RECORDS_PARAMETER } from './schema-update-parts.js';
import { convertStartChanges } from '../../audit/audit-changes.js';

/** The lowest status an act answers a refusal with. */
const FIRST_REFUSAL_STATUS = 400;

/** An act's answer as a tool result: the body in `content` and in `structuredContent`, or the refusal the REST door answers, code and `step` included. */
function resultOf(r: SchemaConvertActResult): ToolResult {
  if (r.status >= FIRST_REFUSAL_STATUS) throw toolRefusalOfAct(r.status as ToolRefusal['status'], String(r.body['error']), r.body);
  return { content: [{ type: 'text' as const, text: JSON.stringify(r.body) }], structuredContent: { ...r.body } };
}

/** The `steps` of `schema_update`'s `convertRecords`, the one shape of a step, under the words of this tool. */
const STEPS_PARAMETER: Record<string, unknown> = {
  ...((CONVERT_RECORDS_PARAMETER['properties'] as Record<string, Record<string, unknown>>)['steps']),
  description: 'How to change a record the conversion reads: `renameProperty`, `mapEnum`, `renameType` and `splitType` steps, applied in a fixed order '
    + 'whatever the list order (the type steps first, then the property steps of the type each record has afterwards). Each step names one `kind` and '
    + 'one type. They are held to the schema the space has NOW: a new name must be declared, a renamed property\'s old name must no longer be, and the '
    + 'type a `splitType` splits must still be declared (its conditions are read against that type\'s properties); a '
    + 'step it cannot hold refuses the whole call (400 `bad_conversion_step`, naming the step\'s index in `step`) and nothing is started. Omit them to '
    + 'stamp the records that already conform and list the ones that do not, rewriting nothing.',
};

export const space_schema_convertTool: ToolHandler = {
  name: 'space_schema_convert',
  description: 'Convert the records of the types you name to the schema the space has now, so records written under an older schema conform to it and '
    + 'are marked as conforming. It is the explicit way to run a conversion when a schema change offered none, or to run one again with other steps. '
    + 'Same as `POST /api/spaces/:id/schema-convert`.\n\n'
    + 'WHAT IT DOES TO RECORDS: it converts every copy of those types this instance holds, whoever last wrote it - a record a peer delivered, or one '
    + 'whose author has left the network, as well as one written here. A fork row (an unresolved version of a record) is left alone. A record the `steps` '
    + 'change is REWRITTEN: it gets a new version, moves to the top of every list sorted by change date, and replicates to every peer. A record that '
    + 'already conforms and that no step changes is only marked, with no new version and no replication. A record that cannot be converted (it would '
    + 'not conform afterwards, no case of a split matches, a rename would collide) is left as it is and listed as an unconverted item. It changes no '
    + 'schema, is never voted, and does not sync first: a copy another instance already converted is skipped; when another instance converts the same '
    + 'record at the same time, both write the same converted record and the later version wins, and when the two use different steps the later write '
    + 'decides.\n\n'
    + 'IT NEEDS AN ADMIN: `knowledge: admin` on the space AND the space\'s admin right, because the rewrite reaches every peer. A read-only token is refused.\n\n'
    + 'THE ANSWER comes at once, `{ state: \'started\', toFp, types, steps }` (`toFp` is the schema fingerprint the run converts toward, `steps` how many '
    + 'steps it holds); the conversion runs in the background, one page at a time, and survives a restart. Read how it went with `space_schema_conversion`.\n\n'
    + `REFUSALS (\`code\`): ${SCHEMA_CONVERT_REFUSAL_CODES.map(c => `\`${c}\``).join(', ')}. \`schema_convert_running\` (409) while a run of the space is unfinished: `
    + 'wait for it, or read it.',
  mutating: true,
  spaceRequired: true,
  // The act judges the whole call with the coded refusals the route answers with; the dispatcher's own check would answer the same mistake in its words.
  skipSchemaValidation: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      types: {
        type: 'array', minItems: 1, maxItems: SCHEMA_CONVERT_TYPES_MAX,
        items: {
          type: 'object', additionalProperties: false, required: ['kind', 'type'],
          properties: {
            kind: { type: 'string', enum: [...KNOWLEDGE_TYPES], description: 'The kind of the records to convert: `entity`, `fact`, `edge` or `chrono`. A kind that is none of them refuses the whole call and starts nothing.' },
            type: { type: 'string', minLength: 1, description: 'The type name (for an edge, its label). Naming a type no record has costs nothing.' },
          },
        },
        description: `The types to convert, at least one and at most ${SCHEMA_CONVERT_TYPES_MAX}: \`[{ kind, type }]\`. Every record of each type this instance holds is `
          + 'read, so the run takes as long as those records take; the records of other types are not read.',
      },
      steps: STEPS_PARAMETER,
    },
    required: ['space', 'types'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { space: _space, ...body } = ctx.args;
    const answer = await schemaConvertStartAct(ctx.callSpace, body, { rights: ctx.rights });
    const result = resultOf(answer);   // throws a refusal: nothing below runs for one
    // What the act accepted, for the audit entry (`schema.convert.start`), as the route hands it: the types and the number of steps.
    ctx.recordAuditChanges?.(convertStartChanges(answer.body));
    return result;
  },
};

export const space_schema_conversionTool: ToolHandler = {
  name: 'space_schema_conversion',
  description: 'Read how the conversion of a space\'s records went, whether a schema save, a passed vote or a conversion an administrator started by hand started it. Same as '
    + '`GET /api/spaces/:id/schema-convert`; it needs `knowledge: read` and writes nothing.\n\n'
    + 'THE ANSWER is `{ state, toFp, types, steps, stepsRefused, sources, owed, syncedFirst?, startedAt, finishedAt?, counts, left, failures, error? }`. '
    + '`state` is `running`, `complete` or `failed`; `types` lists each type with `done`; `steps` are the steps the run holds and `stepsRefused` the ones '
    + 'it refused, each with its reason; `counts` is `{ stamped, rewritten, unconverted, moved, edgesRestamped }` - records marked as conforming with no '
    + 'new version, records rewritten, records that could not be converted (listed as items), records that changed while the run read them and are '
    + 'left for a later run, and edges marked again after their entity was re-typed. `left` counts the records of the unfinished types still to read (`null` '
    + 'when counting them took longer than a request may); `syncedFirst` says how many peers the run asked for one sync before it began and how many '
    + 'answered. A space that never had a run answers `{ state: \'none\' }`.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object', properties: { space: s.requiredSpace }, required: ['space'], additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return resultOf(await schemaConvertStatusAct(ctx.callSpace, { rights: ctx.rights }));
  },
};
