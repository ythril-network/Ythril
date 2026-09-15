/**
 * The MCP half of `F-17` — what a cascade delete would remove, and the token that authorises it.
 *
 * Same parameters, same refusals, same commit as the REST route. `delete_entity` gained `cascadeToken`
 * beside it, so neither door can enforce a rule the other does not.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { previewEntityCascade } from '../../brain/entity-delete-cascade.js';
import { getEntityById } from '../../brain/entities.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';

export const delete_entity_previewTool: ToolHandler = {
  name: 'delete_entity_preview',
  description: 'What deleting an entity would remove, and the token that lets you do it.\n\n'
    /*
     * NO OTHER TOOL IS NAMED HERE, and that is a rule rather than an omission.
     *
     * This tool is read-only, so a readOnly connection sees its description — and `mcp-help.test.js` refuses
     * any mention of a mutating tool on that surface, because advertising a capability the caller cannot use
     * sends them to a refusal instead of an answer. So it says what to DO with the token and lets `help()`
     * name the tool that takes it, which is the one place that knows what this connection may call.
     */
    + 'READ-ONLY. It deletes nothing. Call it, read the list, and if you are sure, pass the `token` it '
    + 'returns back as `cascadeToken` on the entity delete — `help()` names that tool when your connection '
    + 'may use it.\n\n'
    + 'WHY A TOKEN AND NOT A FLAG. An entity is a hub. The records a cascade removes are not visible in the '
    + 'call, there is no undo, and a flag saying "I checked" cannot be checked. A token can: it is derived '
    + 'from the exact list you were shown, so if anything is added or removed in between, the delete is '
    + 'REFUSED and tells you the list moved. A record somebody created after you looked cannot be deleted by '
    + 'a decision you took before it existed.\n\n'
    + 'IT REMOVES EDGES AND THIS ENTITY, AND NOTHING ELSE. The entity at the other end of each edge is not '
    + 'touched — a cascade takes the relationships, not the records they join. A face label is not in the '
    + 'list either: the photo survives and is unlabelled, which is what an ordinary delete already does.\n\n'
    + 'A MEMORY, CHRONO ENTRY OR FILE THAT NAMES THE ENTITY IS NOT REMOVED, and it still blocks. Those are '
    + 'records of their own rather than relationships, so edit them to drop the reference first — the '
    + 'refusal names them.\n\n'
    + 'AN EMPTY LIST STILL NEEDS THE TOKEN. Nothing would be removed today, and a delete that skipped the '
    + 'token when the list was empty would behave differently depending on a race.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the entity\'s `_id`.\n\n'
    + 'RESPONSE: `{ entityId, removes: [{ type, _id }], token }`. `removes` is exactly what would go.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      id: {
        type: 'string', minLength: 1,
        description: 'The entity\'s `_id`. Nothing is deleted by this call — it reports what WOULD be, and '
          + 'returns a token bound to that exact list.',
      },
    },
    required: ['space', 'id'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace, accessibleSpaceIds } = ctx;
    const id = String(a['id'] ?? '').trim();
    if (!id) throw new Error('id must not be empty');

    /*
     * Narrowed by the CONNECTION's accessible spaces, which is the MCP half of the same rule the route
     * expresses with `memberSpacesForRequest` — `CLAUDE.md` states it as one rule against two sources of
     * scope, and it is not one surface offering less.
     *
     * The first version of this used `resolveMemberSpaces` to match `delete_entity`, and that was the wrong
     * twin: that one resolves a WRITE TARGET. This is a READ across a proxy's members, so it must narrow by
     * what the connection reaches — otherwise a scoped token previews an entity in a member space it cannot
     * see. `proxy-fanout-inventory.test.js` caught it, which is what that inventory is for.
     */
    for (const mid of memberSpacesWithin(callSpace, accessibleSpaceIds)) {
      if (!(await getEntityById(mid, id))) continue;
      const preview = await previewEntityCascade(mid, id);
      // Not pretty-printed: indentation is billed to the caller's context and read by nothing.
      return { content: [{ type: 'text' as const, text: JSON.stringify(preview) }] };
    }
    throw new Error(`Entity '${id}' not found`);
  },
};
