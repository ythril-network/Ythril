/**
 * The two parts of `schema_update` that are about a save's CONVERSION choice and its refusals, kept out of `spaces.ts` (`Q-745`).
 *
 * ## What it prevents
 *
 * - **Two shapes of one parameter.** `CONVERT_RECORDS_PARAMETER` is the input schema of `convertRecords` WRITTEN BY zod's converter from the
 *   schema package's own body (`ConvertRecordsZ`, which is what `UpdateSpaceBody.convertRecords` is), so the tool and `PATCH /api/spaces/:id` cannot
 *   declare it two ways. `$schema` is left out, as it is for every property of the tool. Its description is the guarantee and its cost to the
 *   caller; the mechanism is in `meta-update.ts`.
 * - **A notice the tool says in words and leaves out of its text.** `metaUpdateNoticeText` is the words of every part of a space write's notice
 *   (`networkWriteNotice` and `convertNotice`), so the conversion run a save started, or why it did not, is in the text as well as the structure.
 * - **A refusal the tool says in words and the REST body says in a code.** `refusedMetaUpdate` words a planner refusal as the tools always have
 *   (`Error (status): sentence`) and carries the refusal's own body, `code` and `step` included, as structured content, so a caller that branches on
 *   `bad_conversion_step` reads it the way a REST caller does.
 *
 * It imports no module of the server (only the schema package and zod), so it joins no import cycle: a tool module that imported the planner's types
 * or the tools' shared types would be one more module of the server's large cyclic set, which a ceiling holds from growing.
 */
import { z } from 'zod';
import { ConvertRecordsZ, CONVERSION_STEPS_MAX } from '@ythril-network/schema/internal';

const SHAPE: Record<string, unknown> = (() => {
  const { $schema: _draft, ...shape } = z.toJSONSchema(ConvertRecordsZ.optional(), { io: 'input' }) as Record<string, unknown>;
  // A parameter nested in an object is described too (`tool-parameters-are-all-described`): the words only, never a second shape.
  const properties = shape['properties'] as Record<string, Record<string, unknown>>;
  properties['steps'] = {
    ...properties['steps'],
    description: 'The conversion steps, applied in a fixed order whatever the list order: the type steps (`renameType`, `splitType`) first, '
      + 'then the property steps (`renameProperty`, `mapEnum`) of the type each record has afterwards. Each step names one `kind` and one type.',
  };
  return shape;
})();

/** `schema_update`'s `convertRecords` property: the body's shape and the words a caller reads. */
export const CONVERT_RECORDS_PARAMETER: Record<string, unknown> = {
  ...SHAPE,
  description: 'What to do with the records already stored when this schema change lands: `{}` stamps the records that already '
    + `conform and rewrites nothing; \`steps\` (at most ${CONVERSION_STEPS_MAX}) rename a property, map an enum value, rename a type or split a type by a `
    + 'condition. It goes with a schema change: it needs the `meta` of that change (`convert_needs_meta`), and it pays the price of `space_schema_convert`, '
    + 'which starts the same rewrite: the `knowledge` admin rung AND the space\'s admin right (403 `space_admin_required`), and one call of the heavy-call '
    + 'allowance that tool and the server\'s other heavy calls share (429 `schema_convert_rate_limited`; a save refused for another reason costs none), because it can '
    + 'rewrite every record of a type. Each step is held to the schema before and the schema after the change and the save is refused whole '
    + '(400 `bad_conversion_step`, naming the step\'s index) if one cannot hold: nothing is written. The run rewrites every record of its '
    + 'types that this instance holds and the steps change, whoever last wrote it; on a space in a network it first asks each peer for one '
    + 'sync and waits for no peer that cannot be reached; a copy another member already converted arrives converted and is not rewritten '
    + 'here; when two members rewrite the same record before either copy has travelled, both write the same converted record and the '
    + 'later version wins. A rewrite moves the record\'s version and `updatedAt` and so reaches every peer. On a space in a network the '
    + 'steps travel with the vote, signed by this instance, and a member applies them only if the signature and the round agree, else it '
    + 'takes the schema without them. The answer\'s `convert` says what became of the run: `started` here, `after_vote` while the vote is '
    + 'open, `nothing` when the change reaches no type, or `not_started` with the reason, the schema saved all the same. '
    + 'Same as `convertRecords` on `PATCH /api/spaces/:id`.',
};

/** What a save's `convert` notice says in words, per state (`convertNotice` in `meta-update.ts` is the structured half). */
const CONVERT_STATE_WORDS: Readonly<Record<string, string>> = {
  started: 'The conversion run has started on this instance and continues in the background',
  after_vote: 'The conversion runs on each member when the vote passes there',
  nothing: 'The change reaches no type a conversion converts, so nothing was started',
  not_started: 'The schema was saved, but the conversion run could not be started',
};

/**
 * What a space write's notice says in words beside its structured half, as the text of a tool result: the merge note, what became of the write in
 * each network it reached, each warning, and what became of the conversion run the save chose. Empty when the notice says nothing.
 */
export function metaUpdateNoticeText(notice: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof notice['mergeNote'] === 'string') lines.push(notice['mergeNote']);
  if (Array.isArray(notice['layers'])) {
    lines.push('Per network: ' + (notice['layers'] as Array<{ networkLabel: string; outcome: string }>)
      .map(l => `${l.networkLabel} ${l.outcome === 'applied' ? 'applied it' : 'is voting on it'}`).join('; ') + '.');
  }
  for (const w of Array.isArray(notice['warnings']) ? notice['warnings'] as Array<{ message?: string }> : []) {
    if (typeof w.message === 'string') lines.push(`Warning: ${w.message}`);
  }
  const convert = notice['convert'] as { state?: string; types?: { kind: string; type: string }[]; error?: string } | undefined;
  if (convert?.state !== undefined) {
    const types = (convert.types ?? []).map(t => `${t.kind}:${t.type}`).join(', ');
    lines.push(`${CONVERT_STATE_WORDS[convert.state] ?? `Conversion: ${convert.state}`}${types ? ` (types: ${types})` : ''}`
      + `${convert.error ? `: ${convert.error}` : ''}.`);
  }
  return lines.length > 0 ? `\n\n${lines.join('\n\n')}` : '';
}

/** A planner's refusal as a tool result: the sentence, and (when the refusal has a `code`) the body REST answers with, `step` included. */
export function refusedMetaUpdate(refusal: { status: number; body: { error: string; code?: string } }): {
  content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError: true;
} {
  return {
    content: [{ type: 'text' as const, text: `Error (${refusal.status}): ${refusal.body.error}` }],
    ...(refusal.body.code !== undefined ? { structuredContent: { ...refusal.body } } : {}),
    isError: true,
  };
}
