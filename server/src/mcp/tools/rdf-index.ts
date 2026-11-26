/**
 * The admin door of a space's SPARQL triple index (bundle-273, Q-764 S4; contract row 6): `space_rdf_rebuild` starts a rebuild of one
 * space's index, `space_rdf_index` reads its status. Both are `POST /api/<tool>` too, so REST and MCP take the same parameters.
 *
 * The rebuild is the knowledge area's `admin` rung (`TOOL_RIGHTS`, as `space_reindex` and `space_reembed`): it rewrites what every query
 * of the space reads from. The status read is `read`: it says how a query of the space is answered. The rebuild runs in the background
 * (`rdf/triple-index/rebuild.ts` `startTripleIndexRebuild`), fenced against any other rebuild of the space, and queries read the space's
 * records until it is swapped in.
 */
import { startTripleIndexRebuild, tripleIndexStatusOf } from '../../rdf/triple-index/rebuild.js';
import type { ToolContext, ToolHandler, ToolResult, ToolSchemas } from './types.js';
import { toolErrorResult } from '../tool-error-text.js';

export const space_rdf_rebuildTool: ToolHandler = {
  name: 'space_rdf_rebuild',
  description: 'Rebuild the SPARQL triple index of one space from its records: the repair when its index is stale, missing or drifted. '
    + 'Returns as soon as the rebuild STARTS; it runs in the background, and SPARQL queries of the space read its records meanwhile '
    + '(slower, same answers). Poll `space_rdf_index` until `status` is `ready` on a new `buildId` and `rebuilding` is false. A rebuild '
    + 'reads every record of the space once. A second call while one runs joins it. A space with RDF off is refused (409 `rdf_off`). '
    + 'Needs the knowledge admin right on the space.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: { space: s.requiredSpace },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const started = startTripleIndexRebuild(ctx.callSpace);
    if (!started.ok) return toolErrorResult(`${started.error} (${started.code})`, started.status);
    const out = { status: started.status, spaceId: started.spaceId };
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out };
  },
};

export const space_rdf_indexTool: ToolHandler = {
  name: 'space_rdf_index',
  description: 'The status of one space\'s SPARQL triple index: `status` (`ready`: queries read the index; `catching-up` or `stale`: '
    + 'they read the records; `absent`: none yet), `buildId` (the rebuild it came from, or null), `appliedPos` and `rebuilding` (a rebuild '
    + 'runs now). One read of the index\'s state; it changes nothing.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: { space: s.requiredSpace },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const out = await tripleIndexStatusOf(ctx.callSpace);
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out as unknown as Record<string, unknown> };
  },
};
