/**
 * Review's forks over MCP: `list_forks` and `resolve_fork`, for every kind that forks (Q-624).
 *
 * ## Both surfaces, the same parameters
 *
 * `GET /api/brain/spaces/:id/forks` and `POST .../forks/:forkId/resolve` exist beside these (`api/brain/forks.ts`). Both doors call the same two
 * functions (`brain/forks.ts`), which own the paging, the caps and the sentence of every refusal; the parameters are `ForkListParams` and
 * `ForkResolveParams`, and the bounds declared here are theirs (`kind` from `FORK_KIND_NAMES`, each version up to `MAX_SYNC_SEQ`). A missing
 * parameter is said in the validator's words here and in the same words by REST (`mcp/argument-sentence.ts`). `keep` declares no `enum` on purpose:
 * its refusal is the module's one sentence on both doors.
 */
import { listForks, resolveFork, FORK_KEEPS, FORK_KIND_NAMES, DEFAULT_FORK_PAGE, MAX_FORK_PAGE, MAX_FORKS_PER_RECORD } from '../../brain/forks.js';
import { MAX_SYNC_SEQ } from '../../util/seq-ceiling.js';
import type { ToolContext, ToolHandler, ToolResult, ToolSchemas } from './types.js';

/** What a version's main field is shown as in the one-line summary of a row. */
const snippet = (text: unknown): string => {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};

const KIND_LIST = FORK_KIND_NAMES.map(k => `'${k}'`).join(', ');

export const list_forksTool: ToolHandler = {
  name: 'list_forks',
  description: `List the forks of a space: records (${KIND_LIST}) that two instances wrote DIFFERENTLY at one version, which sync kept both of `
    + 'instead of choosing one silently. Each row is `{ kind, forkId, parentId, fork, parent, orphaned, edgeCount, linkCount, siblings, resolvedElsewhere }`: '
    + 'the fork beside the record it forks (`parent: null, orphaned: true` when that record is gone), how many edges and links point at the fork, how '
    + 'many forks the record holds, and `resolvedElsewhere`: the other instances that already resolved THEIR copy of this fork, each `{ by, at, proven, '
    + 'via?, kept }` where `kept` is `original`, `this version` or `not yet known`. A resolve elsewhere never removes the copy here: this instance decides '
    + 'its own. Newest first; `kind` narrows the page to one kind. The answer carries `total`, `skip`, `limit`, `counts` (every kind, with '
    + '`counts.resolvedElsewhere` per kind), `kinds` (per kind, the compared `fields` and the `mainField`) and `maxForksPerRecord`: a record may hold '
    + `${MAX_FORKS_PER_RECORD} forks, and the next differing copy is dropped. A fork row is an unchosen version: it cannot be edited, only resolved or deleted.`,
  mutating: false,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      kind: { type: 'string', enum: [...FORK_KIND_NAMES], description: 'Only the forks of this kind. Omit for every kind.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_FORK_PAGE, description: `Forks to return (default ${DEFAULT_FORK_PAGE}, ${MAX_FORK_PAGE} at most; more is refused, not served smaller).` },
      skip: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Forks to skip before the page, newest first: how you reach past the first page when `total` says there are more.' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const page = await listForks(ctx.callSpace, { kind: ctx.args['kind'], skip: ctx.args['skip'], limit: ctx.args['limit'] });
    const head = `Forks of '${ctx.callSpace}': ${page.total} in all, ${page.forks.length} on this page.`;
    const body = page.forks.length === 0
      ? ' None on this page.'
      : '\n' + page.forks.map(r => {
        const main = page.kinds[r.kind].mainField;
        const against = r.parent ? `"${snippet(r.parent[main])}"` : 'a deleted record';
        const elsewhere = r.resolvedElsewhere.length > 0 ? `; resolved elsewhere by ${r.resolvedElsewhere.map(m => `${m.by} (${m.kept})`).join(', ')}` : '';
        return `- ${r.kind} ${r.forkId} forks ${r.parentId}: "${snippet(r.fork[main])}" against ${against}`
          + ` (edges pointing at the fork: ${r.edgeCount}, links: ${r.linkCount}; forks of the record: ${r.siblings}${elsewhere})`;
      }).join('\n');
    return { content: [{ type: 'text' as const, text: head + body }], structuredContent: { ...page } };
  },
};

export const resolve_forkTool: ToolHandler = {
  name: 'resolve_fork',
  description: 'Resolve one fork on THIS instance: keep one version of the record and delete this instance\'s copy of the other. All five parameters are '
    + 'required, read from the `list_forks` row: `kind`, `forkId`, `keep`, `ifMatchSeq` (the fork\'s `seq`) and `ifMatchParentSeq` (the parent\'s `seq`; '
    + 'send 0 for an orphaned fork, whose parent is gone, and only then). `keep: \'fork\'` writes the fork\'s WHOLE body onto the parent; '
    + '`keep: \'parent\'` keeps the parent\'s. Either way the parent is written as a new edit newer than both versions, so every peer takes it, the fork '
    + 'is deleted here behind a tombstone this instance issues, and every edge and link that pointed at the fork points at the parent. A peer applies '
    + 'that tombstone only where its deletion rules accept it; another instance keeps its copy, lists it as resolved elsewhere and decides it there. '
    + 'For an orphan, `keep: \'parent\'` lets the deletion stand and `keep: \'fork\'` makes the fork the record. Refused: a missing parameter (400), an '
    + 'id that is not stored (404), a row that is not a fork or does not derive from its parent (409), a fork or parent changed since it was listed '
    + '(409: list again), `ifMatchParentSeq: 0` while the parent is stored (400), a `keep` that is neither side (400).',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      kind: { type: 'string', enum: [...FORK_KIND_NAMES], description: 'The fork\'s kind (`kind` of the `list_forks` row): ids are unique per kind only.' },
      forkId: { type: 'string', minLength: 1, description: 'The fork\'s id (`forkId` of the `list_forks` row).' },
      keep: { type: 'string', description: `Which version stays: one of ${FORK_KEEPS.map(k => `'${k}'`).join(' or ')}. 'fork' puts the fork's whole body on the parent; 'parent' keeps the parent's. This instance's copy of the fork is deleted either way.` },
      ifMatchSeq: { type: 'integer', minimum: 0, maximum: MAX_SYNC_SEQ, description: 'The fork\'s `seq` as listed: a fork that changed since is refused (409).' },
      ifMatchParentSeq: { type: 'integer', minimum: 0, maximum: MAX_SYNC_SEQ, description: 'The parent\'s `seq` as listed: a parent that changed since is refused (409). 0 for an orphaned fork, whose parent is gone, and only then.' },
    },
    required: ['space', 'kind', 'forkId', 'keep', 'ifMatchSeq', 'ifMatchParentSeq'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { resolution: out, audit } = await resolveFork(ctx.callSpace, {
      kind: ctx.args['kind'], forkId: ctx.args['forkId'], keep: ctx.args['keep'], ifMatchSeq: ctx.args['ifMatchSeq'], ifMatchParentSeq: ctx.args['ifMatchParentSeq'],
    }, ctx.actor);
    ctx.recordAuditChanges?.(audit);
    const text = out.parent === null
      ? `Resolved ${out.kind} fork '${out.forkId}' in '${ctx.callSpace}': its parent was gone and the deletion stands.`
      : `Resolved ${out.kind} fork '${out.forkId}' of '${out.parentId}' in '${ctx.callSpace}': kept the ${out.keep === 'fork' ? "fork's" : "parent's"} version and deleted this instance's copy of the fork; `
        + `${out.edgesRepointed} edge(s) and ${out.linksRepointed} link(s) now point at the parent.`;
    return { content: [{ type: 'text' as const, text }], structuredContent: { ...out } };
  },
};
