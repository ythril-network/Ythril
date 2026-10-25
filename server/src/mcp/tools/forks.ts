/**
 * Review's forks over MCP: `list_forks` and `resolve_fork`.
 *
 * ## Both surfaces from the first commit
 *
 * `GET /api/brain/spaces/:id/forks` and `POST .../forks/:forkId/resolve` exist beside these (`api/brain/forks.ts`). Both doors call the same two
 * functions (`brain/forks.ts`), which own the paging, the caps and the sentence of every refusal; what a handler owns here is the MCP-shaped part:
 * the argument schema and text a model can act on. The schema declares no `enum` for `keep` on purpose: the validator would refuse a `keep` that is
 * neither side in its own words and REST in ours, and a caller would meet two sentences for one refusal; `keep` is checked once, in `parseKeep`. (The
 * `limit` bound is declared, as every bound a caller sends must be: an out-of-range `limit` is refused by the validator here and by `brain/forks.ts` on
 * REST, both `400` for the same bound.)
 */
import { listForks, resolveFork, FORK_KEEPS, DEFAULT_FORK_PAGE, MAX_FORK_PAGE, MAX_FORKS_PER_RECORD } from '../../brain/forks.js';
import type { ToolContext, ToolHandler, ToolResult, ToolSchemas } from './types.js';

/** What a fork's text is shown as in the one-line summary of a row. */
const snippet = (text: unknown): string => {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};

export const list_forksTool: ToolHandler = {
  name: 'list_forks',
  description: 'List the forks of a space: facts that two instances wrote DIFFERENTLY at one version, which sync kept both of instead of '
    + 'choosing one silently. Each row is `{ forkId, parentId, fork, parent, edgeCount, linkCount, siblings }`: the fork beside the fact it forks, '
    + 'how many edges and links point at the fork, and how many forks that fact holds altogether. Newest first. '
    + `A fact may hold ${MAX_FORKS_PER_RECORD} forks (\`maxForksPerRecord\` in the answer); at that many, the next differing copy is dropped, so a record `
    + 'at the limit needs one resolved before another version can be kept. The answer carries `total` (every fork of the space that still has its '
    + 'parent), `skip` and `limit`. Settling a fork is a write, and `help()` lists the tool that does it only for a token that may write.',
  mutating: false,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      limit: { type: 'integer', minimum: 1, maximum: MAX_FORK_PAGE, description: `Forks to return (default ${DEFAULT_FORK_PAGE}, ${MAX_FORK_PAGE} at most; more is refused, not served smaller).` },
      skip: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Forks to skip before the page, newest first: how you reach past the first page when `total` says there are more.' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const page = await listForks(ctx.callSpace, { skip: ctx.args['skip'], limit: ctx.args['limit'] });
    const head = `Forks of '${ctx.callSpace}': ${page.total} in all, ${page.forks.length} on this page.`;
    const body = page.forks.length === 0
      ? ' None on this page.'
      : '\n' + page.forks.map(r => `- ${r.forkId} forks ${r.parentId}: "${snippet(r.fork.fact)}" against "${snippet(r.parent.fact)}"`
        + ` (edges pointing at the fork: ${r.edgeCount}, links: ${r.linkCount}; forks of the record: ${r.siblings})`).join('\n');
    return { content: [{ type: 'text' as const, text: head + body }], structuredContent: { ...page } };
  },
};

export const resolve_forkTool: ToolHandler = {
  name: 'resolve_fork',
  description: 'Resolve one fork: keep one version of the fact and delete the other. `keep: \'fork\'` writes the fork\'s text, tags, description, '
    + 'properties and type onto the parent fact; `keep: \'parent\'` leaves the parent\'s as they are. Either way the parent is written as a new edit of its '
    + 'own, newer than both versions (so a peer holding either one takes it), the fork is deleted and peers are told it is gone, and every edge and link '
    + 'that pointed at the fork points at the parent instead (one the parent already has is not duplicated). Get `forkId` from `list_forks`. '
    + 'Refused: an id that is not stored, a record that is not a fork, a fork whose parent is no longer stored, a `keep` that is neither side.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      forkId: { type: 'string', minLength: 1, description: 'The fork\'s id (`forkId` of a `list_forks` row).' },
      keep: { type: 'string', description: `Which version stays: one of ${FORK_KEEPS.map(k => `'${k}'`).join(' or ')}. 'fork' puts the fork's text on the parent; 'parent' keeps the parent's. The fork is deleted either way.` },
    },
    required: ['space', 'forkId', 'keep'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const out = await resolveFork(ctx.callSpace, ctx.args['forkId'], ctx.args['keep'], ctx.actor);
    const text = `Resolved fork '${out.forkId}' of '${out.parentId}' in '${ctx.callSpace}': kept the ${out.keep === 'fork' ? "fork's" : "parent's"} version on the parent and deleted the fork; `
      + `${out.edgesRepointed} edge(s) and ${out.linksRepointed} link(s) now point at the parent.`;
    return { content: [{ type: 'text' as const, text }], structuredContent: { ...out } };
  },
};
