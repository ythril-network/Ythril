/**
 * The link tools — the MCP half of `POST /api/brain/spaces/:spaceId/links` and its delete.
 *
 * Same parameters, same defaults, same refusals as the REST door, in the same commit. Both call `addLink` /
 * `removeLink`, so neither surface can enforce a rule the other does not.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { addLink, removeLink, LINK_PAIRS, linkLabel } from '../../brain/links.js';
import { assertRefsResolve } from '../../brain/entity-refs.js';
import { REF_KINDS } from '../../config/types-knowledge.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { resolveWriteTarget, isStrictLinkage, findFirstAcrossMembers } from '../../spaces/proxy.js';

/** Every legal class, as the arrays spell them — used in the schema text and in the refusal. */
const PAIR_LABELS = LINK_PAIRS.map(([f, t]) => linkLabel(f, t)).join(', ');

/** The shared sentence, so the tool description and the parameter text cannot drift apart. */
const WHAT_A_LINK_IS =
  'A LINK IS NOT AN EDGE. A link says one record CONCERNS another — a fact about an entity, a file about '
  + 'a chrono entry. It carries no label, no weight, no properties and no type, because those are what an '
  + 'edge is for. If you want to say HOW two things relate, use `save_edge`.';

const THE_SIX = `THE SIX CLASSES, and there is no seventh: ${PAIR_LABELS}. An entity is only ever the TO end — `
  + 'nothing hangs off an entity, which is why there is no `entity.…` class. A pair outside this list is an '
  + 'ERROR naming the ones that are allowed.';

function kindSchema(side: 'from' | 'to') {
  return {
    type: 'string' as const,
    enum: [...REF_KINDS],
    description: `What kind of record \`${side}\` is. Required — it is not guessed from the id, because the `
      + 'same UUID could name records in two collections and a wrong guess produces a link that reads as '
      + 'correct and points at nothing.',
  };
}

export const save_linkTool: ToolHandler = {
  name: 'save_link',
  description: 'Record that one record concerns another.\n\n'
    + WHAT_A_LINK_IS + '\n\n'
    + THE_SIX + '\n\n'
    + 'IT IS AN UPSERT AND RE-RUNNING IT IS A NO-OP. A link\'s id is DERIVED from the two records and the '
    + 'class, so one connection has exactly one id for ever. Creating a link that already exists succeeds '
    + 'and changes nothing — safe to retry, and it can never produce a duplicate.\n\n'
    + 'A LINK IS A RECORD OF ITS OWN and that is the only place it lives. Neither record at the ends is '
    + 'rewritten, so an ordinary edit of a fact cannot drop a link somebody else made. Asking for the same '
    + 'connection on a write door is `linkEntities` and its siblings, which reach this same writer.\n\n'
    + 'UNDER STRICT LINKAGE BOTH ENDS MUST EXIST. Otherwise a well-formed id pointing at nothing is stored, '
    + 'and the dangling link only shows up later as a traversal that comes back empty.\n\n'
    + 'PARAMETERS:\n'
    + '- `from` / `fromKind` — the record the link hangs off, and what kind it is. It must exist; a missing '
    + 'one is an ERROR: a link hanging off a record that does not exist is the dangling half this refuses '
    + 'to create.\n'
    + '- `to` / `toKind` — the record it concerns.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space to write to.\n\n'
    + 'RESPONSE: the link record, including the derived `_id` you would pass to `delete_link`.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      from: {
        type: 'string', minLength: 1,
        description: 'The record the link hangs off — its array is what gains the entry. It MUST exist: '
          + 'there is no array to write into otherwise, so a missing one is an error rather than a link '
          + 'that quietly goes nowhere.',
      },
      fromKind: kindSchema('from'),
      to: {
        type: 'string', minLength: 1,
        description: 'The record the link points AT. It does not have to be an entity — a chrono entry '
          + 'can concern a fact, and a file can concern all three. Under strict linkage it must exist, '
          + 'because a well-formed id pointing at nothing stores silently and only shows up later as a '
          + 'traversal that comes back empty.',
      },
      toKind: kindSchema('to'),
      targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
    },
    required: ['space', 'from', 'fromKind', 'to', 'toKind'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const from = String(a['from'] ?? '').trim();
    const to = String(a['to'] ?? '').trim();
    if (!from) throw new Error('from must not be empty');
    if (!to) throw new Error('to must not be empty');
    const fromKind = a['fromKind'] as RefKind;
    const toKind = a['toKind'] as RefKind;
    if (!LINK_PAIRS.some(([f, t]) => f === fromKind && t === toKind)) {
      throw new Error(`a ${fromKind} cannot link to a ${toKind} — the link classes are: ${PAIR_LABELS}`);
    }

    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);

    if (isStrictLinkage(wt.target)) {
      await assertRefsResolve(wt.target, 'from', fromKind, [from]);
      await assertRefsResolve(wt.target, 'to', toKind, [to]);
    }

    const link = await addLink(wt.target, from, fromKind, to, toKind, ctx.actor);
    // Built once and carried in BOTH halves — see the note on `save_edge`'s return.
    const written = { ...link, label: linkLabel(link.fromKind, link.toKind) };
    return {
      content: [{
        type: 'text' as const,
        // Not pretty-printed: indentation is billed to the caller's context and read by nothing.
        text: JSON.stringify(written),
      }],
      structuredContent: written,
    };
  },
};

export const delete_linkTool: ToolHandler = {
  name: 'delete_link',
  description: 'Remove one link by its ID — the two records at either end are NOT touched.\n\n'
    + WHAT_A_LINK_IS + '\n\n'
    + 'THE LINK RECORD IS THE WHOLE CONNECTION, so removing it removes the connection. There is no second '
    + 'copy on either end to contradict it, and nothing an ordinary edit of those records could restore.\n\n'
    + 'A TOMBSTONE IS WRITTEN, so the deletion reaches peer instances on the next sync instead of being '
    + 'quietly restored by one that still holds the link.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the link\'s `_id`, as `save_link` and `filter` report it. An id that is not a link is an '
    + 'ERROR, not a silent success.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the link.\n\n'
    + 'RESPONSE: one line confirming the id that was removed.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      id: {
        type: 'string', minLength: 1,
        description: 'The link\'s `_id`. An id that is not a link is an ERROR, not a silent success. The two '
          + 'records at either end are never touched.',
      },
      targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
    },
    required: ['space', 'id'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const id = String(a['id'] ?? '').trim();
    if (!id) throw new Error('id must not be empty');

    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);

    const removed = await findFirstAcrossMembers(wt.target, mid => removeLink(mid, id, ctx.actor));
    if (!removed) throw new Error(`Link '${id}' not found`);
    return { content: [{ type: 'text' as const, text: `Link removed (ID ${id}).` }],
      structuredContent: { _id: id, deleted: true } };
  },
};
