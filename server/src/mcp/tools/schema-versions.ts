/**
 * MCP `space_schema_versions` (bundle-267, Q-742): a space's schema versions listed, one read, two compared - the tool half of
 * `GET /api/spaces/:id/schema-versions` (`fp`, `against` and the rest as query parameters). Both run `spaces/schema-versions-acts.ts`, so the doors take the same
 * parameters and answer the same bodies and refusals. Rights come from `TOOL_RIGHTS`: `schema: read`.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { schemaVersionsToolAct } from '../../spaces/schema-versions-acts.js';
import { networkIdsSharedWithCaller } from '../../networks/network-spaces.js';
import { toolRefusalOfAct } from '../../util/errors.js';
import { SCHEMA_FINGERPRINT_FIELD } from '../../spaces/schema-stamp.js';
import { budgetSizeSchema } from './_page-budget-schema.js';
import { ROW_PAGER } from '../../brain/result-budget.js';

export const space_schema_versionsTool: ToolHandler = {
  name: 'space_schema_versions',
  description: 'List, read and compare the schema versions of a space. Every record written while it conformed carries the fingerprint of '
    + `the schema it conformed to (\`${SCHEMA_FINGERPRINT_FIELD}\`); a version is that fingerprint and the schema it names.\n\n`
    + 'WITHOUT `fp`: the list, `{ versions: [{ fp, current, held, origin?, since?, counts }], count, total, limit, skip, truncated, nextSkip? }` (a page like every held list) - the current version first, then '
    + 'the versions this instance keeps, newest first, then the fingerprints records carry that it keeps no schema for (`held: false`). '
    + '`counts` are the records of each collection that carry the version, read from the schema version index of four collections, no '
    + 'record. The order is the listing order only, not a version history. Same as `GET /api/spaces/:id/schema-versions`.\n\n'
    + 'WITH `fp`: that version, `{ fp, current, held, schema: { typeSchemas, rules } }` (`GET .../schema-versions?fp=`).\n\n'
    + 'WITH `fp` AND `against` (`current` or a fingerprint): what changed from `fp` to `against`, per type, in four classes - `structural` '
    + '(whether a record conforms can change), `wording`, `write` and `lifecycle` (`GET .../schema-versions?fp=&against=`). A place this release '
    + 'cannot read is listed in `unread`, never answered as unchanged.\n\n'
    + 'WITH `kind` (entity, fact, edge, chrono): the kind\'s types, `{ kind, current, types: [{ type, declared, networks?, older? }], ...page }` - '
    + '`declared` is `own`, `layer` (with the `networks` whose layer declares it) or `none` (a name records carry that no current schema '
    + 'declares); `older` on an own type says whether some record of it is not on its current definition, exactly when `filter` with that '
    + 'type, `schemaVersion: "older"` and `schemaChanged: "any"` finds one.\n\n'
    + 'WITH `kind` AND `type`: the type\'s history, `{ kind, type, current, declared, cut?, definitions: [{ rep, current, since?, until?, '
    + 'origin: { edited, networks, fetched } }], ...page }` - each definition is the versions that define the type alike; `since` and '
    + '`until` are keeping times (a definition only fetched from a member has none); `cut: true` when earlier definitions are not listed.\n\n'
    + 'WITH `fps` (up to 100 fingerprints), `kind` AND `type`: `{ kind, type, current, standings: [{ fp, standing, definition? }] }`, '
    + '`standing` one of `current`, `older`, `notHeld`, `unclassified`.\n\n'
    + 'WITH `fp`, `against`, `kind` AND `type`: the comparison narrowed to that type.\n\n'
    + 'The record facts (`older` and the `none` rows) need `knowledge: read` on the space; without it the answer says '
    + '`recordFacts: "withheld"`. No form answers a count.\n\n'
    + 'REFUSALS: `bad_fingerprint` (not 64 lowercase hex), `unknown_fingerprint` (not kept here, or not one this caller may read: a token '
    + 'bound to a peer sees only what the sync door would serve it; the type forms refuse it for a current version the caller may not read), '
    + '`against_needs_fp` (`against` alone), `bad_kind`, `type_needs_kind`, `kind_needs_type`, `fps_needs_type`, `too_many_fps`, and two '
    + '503s: `schema_index_building` while a collection\'s schema version index is still being built, `schema_versions_busy` when placing the '
    + 'records took longer than a request may (what was done is kept: try again).',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      // No pattern on either: the act refuses a malformed one as `bad_fingerprint`, the words the route answers too.
      fp: { type: 'string', description: 'A version\'s fingerprint (64 lowercase hex): read it, or compare it with `against`. Omit it for the list.' },
      against: { type: 'string', description: 'Compare `fp` with this version: `current`, or another fingerprint. Needs `fp`.' },
      skip: { type: 'integer', minimum: 0, description: 'Versions of the list to skip: the `nextSkip` of the previous page.' },
      // No enum or bound on these three: the act refuses each by its own code (`bad_kind`, `too_many_fps`, the type name's bound), the words the route answers too.
      kind: { type: 'string', description: 'A kind (`entity`, `fact`, `edge`, `chrono`): its types, or with `type` that type\'s history.' },
      type: { type: 'string', description: 'A type name of `kind`: its history, or with `fps` where those versions stand for it. Needs `kind`.' },
      fps: { type: 'array', items: { type: 'string' }, description: 'Up to 100 fingerprints: where each stands for `kind` and `type`. Needs both.' },
      // The size ceilings every budgeted tool takes, from their one declaration. They page the list; a version and a comparison are one unit, answered whole.
      ...budgetSizeSchema('version', ROW_PAGER),
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { fp, against, skip, kind, type, fps, maxChars, maxBytes, maxTokens } = ctx.args;
    const r = await schemaVersionsToolAct(ctx.callSpace, { fp, against, skip, kind, type, fps, maxChars, maxBytes, maxTokens }, {
      shared: networkIdsSharedWithCaller(ctx.callSpace, ctx.callerRecord), transport: ctx.transport, rights: ctx.rights,
    });
    if ('error' in r) {
      throw toolRefusalOfAct(r.status, r.error, { error: r.error, ...(r.code ? { code: r.code } : {}) });
    }
    // The answer in `content` as well as `structuredContent`: a client may read either one alone.
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.body) }], structuredContent: { ...r.body } };
  },
};
