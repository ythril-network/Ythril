/**
 * MCP `space_schema_versions` (bundle-267, Q-742): a space's schema versions listed, one read, two compared - the tool half of
 * `GET /api/spaces/:id/schema-versions`, `.../:fp` and `.../:fp/diff`. All four run `spaces/schema-versions-acts.ts`, so the doors take the same
 * parameters and answer the same bodies and refusals. Rights come from `TOOL_RIGHTS`: `schema: read`.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { schemaVersionsToolAct } from '../../spaces/schema-versions-acts.js';
import { networkIdsSharedWithCaller } from '../../networks/network-spaces.js';
import { ToolRefusal } from '../../util/errors.js';
import { budgetSizeSchema } from './_page-budget-schema.js';
import { ROW_PAGER } from '../../brain/result-budget.js';

export const space_schema_versionsTool: ToolHandler = {
  name: 'space_schema_versions',
  description: 'List, read and compare the schema versions of a space. Every record written while it conformed carries the fingerprint of '
    + 'the schema it conformed to (`schemaFingerprint`); a version is that fingerprint and the schema it names.\n\n'
    + 'WITHOUT `fp`: the list, `{ versions: [{ fp, current, held, origin?, since?, counts }], nextSkip? }` - the current version first, then '
    + 'the versions this instance keeps, newest first, then the fingerprints records carry that it keeps no schema for (`held: false`). '
    + '`counts` are the records of each collection that carry the version, read from the schema version index of four collections, no '
    + 'record. The order is the listing order only, not a version history. Same as `GET /api/spaces/:id/schema-versions`.\n\n'
    + 'WITH `fp`: that version, `{ fp, current, held, schema: { typeSchemas, rules } }` (`GET .../schema-versions/:fp`).\n\n'
    + 'WITH `fp` AND `against` (`current` or a fingerprint): what changed from `fp` to `against`, per type, in four classes - `structural` '
    + '(whether a record conforms can change), `wording`, `write` and `lifecycle` (`GET .../schema-versions/:fp/diff`). A place this release '
    + 'cannot read is listed in `unread`, never answered as unchanged.\n\n'
    + 'REFUSALS: `bad_fingerprint` (not 64 lowercase hex), `unknown_fingerprint` (not kept here, or not one this caller may read: a token '
    + 'bound to a peer sees only what the sync door would serve it), `against_needs_fp` (`against` alone), and `schema_index_building` '
    + '(503) while a collection\'s schema version index is still being built.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      // No pattern on either: the act refuses a malformed one as `bad_fingerprint`, the words the route answers too.
      fp: { type: 'string', description: 'A version\'s fingerprint (64 lowercase hex): read it, or compare it with `against`. Omit it for the list.' },
      against: { type: 'string', description: 'Compare `fp` with this version: `current`, or another fingerprint. Needs `fp`.' },
      skip: { type: 'integer', minimum: 0, description: 'Versions of the list to skip: the `nextSkip` of the previous page.' },
      // The size ceilings every budgeted tool takes, from their one declaration. They page the list; a version and a comparison are one unit, answered whole.
      ...budgetSizeSchema('version', ROW_PAGER),
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { fp, against, skip, maxChars, maxBytes, maxTokens } = ctx.args;
    const r = await schemaVersionsToolAct(ctx.callSpace, { fp, against, skip, maxChars, maxBytes, maxTokens }, {
      shared: networkIdsSharedWithCaller(ctx.callSpace, ctx.callerRecord), transport: ctx.transport,
    });
    if ('error' in r) {
      throw new ToolRefusal(r.status, r.code ? `${r.error} (${r.code})` : r.error, { error: r.error, ...(r.code ? { code: r.code } : {}) });
    }
    // The answer in `content` as well as `structuredContent`: a client may read either one alone.
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.body) }], structuredContent: { ...r.body } };
  },
};
