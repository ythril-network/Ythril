import type { ToolHandler, ToolContext, ToolResult } from './types.js';
import { readSpillAct } from '../../brain/read-spill-act.js';

/**
 * `read_spill` — the MCP half of `GET /api/brain/spills/:id` (Q-92). Same act, same parameters, same refusals.
 *
 * No `space`: a spill is found by its id, and which spaces it touches is what the spill itself records. The
 * act checks the rule the dispatcher cannot: the issuing token, with knowledge read on every one of them.
 */
export const read_spillTool: ToolHandler = {
  name: 'read_spill',
  description: 'Read a spill: the part of a `recall` or `similar` answer that did not fit, kept for the token that '
    + 'asked. An answer names one as `graphComplete.spillId` (the whole traversal past the inline cap) or '
    + '`remainder.spillId` (the matches past the byte budget, when you sent `remainderDump: true`).\n\n'
    + 'ONLY THE TOKEN THAT RAN THE SEARCH CAN READ IT, and only while it still holds knowledge read on every space '
    + 'whose records are inside. Anyone else — and an unknown or expired id — gets the same "not found".\n\n'
    + 'A SPILL LIVES UP TO ONE DAY, and may go sooner: past its token\'s share (count or size) the token\'s own '
    + 'oldest spills are evicted, and reading an evicted one says so. Repeat the search to make a new one.\n\n'
    + 'PAGED LIKE EVERY SEARCH: `items` is a whole-item window under the budget (`maxChars`, `maxBytes`, '
    + '`maxTokens`), `total` is the whole spill, and `nextSkip` — present exactly when `truncated` — is the `skip` '
    + 'to send next. A graph spill\'s items are its NODES, flat, each with `depth`, `via` (the edge that reached it '
    + 'and its parent) and `paths`, so a large traversal can page.\n\n'
    + 'Nothing about a spill is written into any space: it is not a file, it does not sync, and no backup carries it.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The `spillId` from `graphComplete` or `remainder` — not the deprecated `path`, and only a '
          + 'spill your own token made: any other id answers "not found", exactly like one that never existed.',
      },
      skip: { type: 'integer', minimum: 0, description: 'Items to skip — send the previous page\'s `nextSkip`.' },
      maxChars: {
        type: 'integer', minimum: 1,
        description: 'Ceiling on the window in characters. Default 25000 on this door, 50000 on REST.',
      },
      maxBytes: { type: 'integer', minimum: 1, description: 'Ceiling on the window in UTF-8 bytes. No default.' },
      maxTokens: { type: 'integer', minimum: 1, description: 'Converted to characters at 3.5 per token; the lower of this and `maxChars` applies.' },
    },
    required: ['id'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const a = ctx.args;
    const r = await readSpillAct({
      id: a['id'], skip: a['skip'], maxChars: a['maxChars'], maxBytes: a['maxBytes'], maxTokens: a['maxTokens'],
      tokenId: ctx.actor?.tokenId, rights: ctx.rights, accessibleSpaceIds: ctx.accessibleSpaceIds,
      transport: ctx.transport,
    });
    if (r.status !== 200) {
      const error = String(r.body['error']);
      return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true,
        structuredContent: { status: r.status, error } };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.body) }], structuredContent: r.body };
  },
};
