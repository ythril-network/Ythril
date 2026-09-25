/**
 * A space's network schema layers on MCP (`F-39.3`): see them, and reorder which network wins a clash.
 *
 * Doors onto `spaces/schema-layers-acts.ts`, the acts `GET /api/spaces/:id/schema-layers` and
 * `PUT /api/spaces/:id/network-precedence` call — same parameters, answers and refusals. Rights come from
 * `TOOL_RIGHTS`: `schema: read` to see, `schema: admin` to reorder.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { schemaLayersAct, setNetworkPrecedenceAct, type SchemaLayersActResult } from '../../spaces/schema-layers-acts.js';

function toResult(r: SchemaLayersActResult): ToolResult {
  if ('error' in r) return { content: [{ type: 'text' as const, text: `Error (${r.status}): ${r.error}` }], isError: true };
  return { content: [{ type: 'text' as const, text: JSON.stringify(r.body) }], structuredContent: r.body };
}

export const space_schema_layersTool: ToolHandler = {
  name: 'space_schema_layers',
  description: 'See where a space\'s schema comes from when it is in networks that send schema: this instance\'s own '
    + 'definitions, each network\'s layer in the order it applies, and every clash — a type, property or field two '
    + 'networks define differently, with each network\'s value. Same answer as `GET /api/spaces/:id/schema-layers`.\n\n'
    + 'WHICH ONE WINS: the network first in `precedence`, which is the order the networks were joined until someone '
    + 'reorders it. In each clash the winning network is the first listed. A clash never stops either network\'s '
    + 'records from syncing.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object', properties: { space: s.requiredSpace }, required: ['space'], additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(schemaLayersAct(ctx.callSpace));
  },
};

export const space_set_network_precedenceTool: ToolHandler = {
  name: 'space_set_network_precedence',
  description: 'Decide which network wins where two networks define the same part of a space\'s schema '
    + 'differently: list network ids, highest precedence first. Same as `PUT /api/spaces/:id/network-precedence`; '
    + 'answers the layers as `space_schema_layers` does, with the space\'s schema rebuilt.\n\n'
    + 'Networks you leave out keep the order they were joined in, after the ones you name. An id that is not a '
    + 'network carrying this space is refused, naming it. Requires `schema: admin` — the order decides which '
    + 'definition the space enforces.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      networks: {
        type: 'array', maxItems: 100, items: { type: 'string', minLength: 1 },
        description: 'Network ids, highest precedence first — `networkId` on a `space_schema_layers` layer. An empty list restores join order.',
      },
    },
    required: ['space', 'networks'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    return toResult(setNetworkPrecedenceAct(ctx.callSpace, { networks: ctx.args['networks'] }));
  },
};
