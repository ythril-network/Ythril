import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { refusalsForSpaceUpdate, describeFieldRequirement } from '../../auth/space-field-rights.js';
import { BRAIN_COLLECTIONS } from '../../config/types.js';
import { getConfig } from '../../config/loader.js';
import { col } from '../../db/mongo.js';
import { resolveMemberSpaces } from '../../spaces/proxy.js';
import { canWriteAnywhere } from '../../auth/write-anywhere.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { WIPE_COLLECTION_TYPES, type WipeCollectionType, wipeSpace } from '../../spaces/lifecycle.js';
import { planSpaceWipe, notifyPeersOfWipe } from '../../spaces/wipe-vote.js';
import { updateSpace, spacePurpose } from '../../spaces/spaces.js';
import { SPACE_PURPOSE_MAX, needsReindex } from '../../spaces/_shared.js';
import { measureSpaceUsage } from '../../spaces/space-usage.js';

export const list_spacesTool: ToolHandler = {
  name: 'list_spaces',
  description: 'List every space this token can reach, with ids, labels, purposes and entry counts. CALL THIS FIRST in an unfamiliar instance: every other tool takes a space id, and the ids are not guessable from the labels.\n\n'
    + 'READ THE `purpose`. It is the space owner telling you what belongs there and how to behave in it — conventions, what to write, what not to. A space with a purpose has one because somebody needed you to follow it.\n\n'
    + 'The counts are what make this a planning tool rather than a directory: an empty space is not worth a recall, and a space with 40 000 records needs a filter rather than a broad query. A PROXY space reports its members\' totals combined and is marked as a proxy — writes to one need `targetSpace`.\n\n'
    + 'STORAGE: `maxGiB` is the space\'s quota and `usageGiB` what its files occupy, the same figures `GET /api/spaces` reports and from the same measurement. `usageGiB` is a FLOOR whenever `usageIncomplete` is present — a directory the instance could not read contributes nothing, and an unreadable space would otherwise be indistinguishable from an empty one. A space with no `maxGiB` has no quota rather than a quota of zero.\n\n'
    + 'Accessibility is per TOKEN. A space absent here is not a space that does not exist; it is one this token holds no rung in.',
  inputSchema: (_s: ToolSchemas) => ({ type: 'object', properties: {}, required: [], additionalProperties: false }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { accessibleSpaces , accessibleSpaceIds } = ctx;
    /*
     * Storage, through the SAME measurement REST uses.
     *
     * This tool returned counts and nothing else while `help()` told callers *"Call list_spaces for
     * storage/quota details"* — so a caller who read the authoritative reference and believed it found no
     * storage anywhere on this door. A capability present on one surface and absent from the other, arriving as
     * an omission, and the schema description was the surface that was wrong.
     */
    const usageBySpaceId = await measureSpaceUsage(accessibleSpaces.map(sp => sp.id));
    const spaceCountResults = await Promise.allSettled(
      accessibleSpaces.map(async s => {
        const memberIds = memberSpacesWithin(s.id, accessibleSpaceIds);
        const perMember = await Promise.all(memberIds.map(async mid => ({
          memories: await col(`${mid}_memories`).countDocuments(),
          entities: await col(`${mid}_entities`).countDocuments(),
          edges:    await col(`${mid}_edges`).countDocuments(),
          chrono:   await col(`${mid}_chrono`).countDocuments(),
        })));
        return {
          id: s.id,
          counts: {
            memories: perMember.reduce((n, c) => n + c.memories, 0),
            entities: perMember.reduce((n, c) => n + c.entities, 0),
            edges:    perMember.reduce((n, c) => n + c.edges, 0),
            chrono:   perMember.reduce((n, c) => n + c.chrono, 0),
          },
        };
      }),
    );
    const countsBySpaceId: Record<string, { memories: number; entities: number; edges: number; chrono: number }> = {};
    for (const r of spaceCountResults) {
      if (r.status === 'fulfilled') countsBySpaceId[r.value.id] = r.value.counts;
    }
    // `purpose` is the field an admin can edit, the one `get_space_meta` returns, and since 3.0 the only
    // spelling — its `description` alias was removed from every surface in the same release.
    const result = accessibleSpaces.map(s => ({
      id: s.id,
      label: s.label ?? null,
      purpose: spacePurpose(s) ?? null,
      counts: countsBySpaceId[s.id] ?? { memories: 0, entities: 0, edges: 0, chrono: 0 },
      // `null` rather than an omission: a space with no quota is a FACT about that space, and a missing key
      // reads as "this tool does not report quotas" — which is the misunderstanding this whole change fixes.
      maxGiB: s.maxGiB ?? null,
      usageGiB: usageBySpaceId.get(s.id)?.usageGiB ?? 0,
      // Present only when the figure is a floor, exactly as on REST. An absent field means it is a total.
      ...((usageBySpaceId.get(s.id)?.incomplete.length ?? 0) > 0
        ? { usageIncomplete: usageBySpaceId.get(s.id)!.incomplete }
        : {}),
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  },
};

export const get_statsTool: ToolHandler = {
  name: 'get_stats',
  description: 'Return counts of memories, entities, edges, chrono entries and files for one space — the cheapest call there is, and the right way to check whether a space holds anything before spending a recall on it.\n\n'
    + 'These are TOTALS, not search coverage. A record retired from semantic ranking is counted here and cannot be reached by `recall`, and a record written seconds ago is counted before its embedding exists. So a count that exceeds what a search returns is normal and is not evidence of a broken index — `list_embed_jobs` is what answers "is anything still queued or failed".\n\n'
    + 'On a PROXY space the numbers are the members\' totals combined, so a per-member breakdown means asking each member by id.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
          },
          required: ['space'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { callSpace , accessibleSpaceIds } = ctx;
    const memberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
    const counts = await Promise.all(memberIds.map(async mid => ({
      memories: await col(`${mid}_memories`).countDocuments(),
      entities: await col(`${mid}_entities`).countDocuments(),
      edges: await col(`${mid}_edges`).countDocuments(),
      chrono: await col(`${mid}_chrono`).countDocuments(),
      files: await col(`${mid}_files`).countDocuments(),
    })));
    const memories = counts.reduce((s, c) => s + c.memories, 0);
    const entities = counts.reduce((s, c) => s + c.entities, 0);
    const edges = counts.reduce((s, c) => s + c.edges, 0);
    const chrono = counts.reduce((s, c) => s + c.chrono, 0);
    const files = counts.reduce((s, c) => s + c.files, 0);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ spaceId: callSpace, memories, entities, edges, chrono, files }),
      }],
    };
  },
};

/**
 * The space's entity-relationship model — REST-only until now, and it is the question an agent asks first.
 *
 * `get_space_meta` returns the DECLARED schema: what may exist. This returns what DOES exist — which types are
 * actually present, which relationships actually occur between them, and how many of each. An agent deciding how
 * to write into an unfamiliar space wants both, and only one of them was reachable.
 *
 * Found by the capability matrix (`scripts/surface-matrix.mjs`), which put `GET /er-model` in the REST-only
 * column. Filed as B-21.
 *
 * **On a proxy space the members are reported SEPARATELY rather than merged**, exactly as the REST route does.
 * Merging would add up counts for two types that share a name and mean different things in different spaces, and
 * would invent relationships between types that can never be joined, because an edge cannot cross a space. A
 * union would look richer and be false — so the shape differs by design, not by omission.
 */
export const er_modelTool: ToolHandler = {
  name: 'er_model',
  description:
        'Return the space\'s entity-relationship model: which entity types actually exist, which edge labels '
        + 'connect which types, and the counts of each — inferred from the stored records AND the declared '
        + 'schema. Use it to learn how a space is actually shaped before writing into it; `get_space_meta` gives '
        + 'the declared schema (what MAY exist), this gives what DOES. A type with zero records is reported '
        + 'rather than omitted. On a proxy space each member is reported separately, because merging would '
        + 'invent relationships that cannot exist across spaces.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
          },
          required: ['space'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { callSpace, accessibleSpaceIds } = ctx;
    const { buildErModel } = await import('../../brain/er-model.js');
    // The same narrowing every MCP read uses: the connection's accessible spaces, not the request's.
    const memberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
    const models = await Promise.all(memberIds.map(mid => buildErModel(mid)));
    const output = memberIds.length === 1 && memberIds[0] === callSpace
      ? models[0]
      : { spaceId: callSpace, members: models };
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
  },
};

export const get_space_metaTool: ToolHandler = {
  name: 'get_space_meta',
  description:
        // Deliberately NOT the words "reindex state": `mcp-help.test.js` holds that a read-only token is never told
        // the name of a tool it cannot call, and `reindex` is one. Naming the STATE rather than the repair is also
        // the more useful sentence for a reader who cannot perform the repair — `needsReindex` still names the field.
        'What this space DECLARES: its purpose, usage notes, per-type schemas, validation posture and entry '
        + 'counts. Call it before writing to an unfamiliar space, so the write is shaped to what the space '
        + 'expects instead of being refused by it.\n\n'
        + 'DECLARED, NOT ACTUAL — and the difference matters. This returns what MAY exist: the types somebody '
        + 'defined, with their naming patterns and required properties. `er_model` returns what DOES exist: '
        + 'the types that actually hold records, and which edge labels really connect which types. A space '
        + 'can declare twenty types and hold three, or hold records of a type nobody declared. Read this to '
        + 'learn the rules, `er_model` to learn the shape.\n\n'
        + 'WHAT `validationMode` MEANS FOR YOUR WRITE: `off` accepts anything; `warn` accepts the write and '
        + 'reports violations; `strict` REFUSES a write that breaks a schema. With `strictLinkage` on, a '
        + 'reference that does not resolve is refused too. A space with no `typeSchemas` yet accepts every '
        + 'type even on `strict`, because there is nothing to violate — so `strict` plus an empty schema is '
        + 'not a contradiction.\n\n'
        + 'AND A SUBTLETY ON `strict`: it refuses what your change BREAKS, not what was already broken. '
        + 'Editing a record that was invalid before you touched it reports the pre-existing violation and '
        + 'still saves, because refusing would not fix a problem that is already stored.\n\n'
        + '`needsReindex` IS TRUE WHEN THE STORED VECTORS WERE MADE BY A DIFFERENT EMBEDDING MODEL from the '
        + 'one configured now. Recall still answers while it is true, but it compares new queries against old '
        + 'vectors, so results degrade quietly rather than erroring. Treat a true value as the explanation '
        + 'for poor ranking, and as something for whoever administers the instance — not a reason to stop '
        + 'reading.\n\n'
        + 'RESPONSE: `purpose` and `usageNotes` (prose written for whoever reads this space), `typeSchemas` '
        + 'per knowledge type, `validationMode`, `strictLinkage`, the entry counts, `needsReindex`, and '
        + '`version` — which increments on every meta write and is what a conditional update is checked '
        + 'against.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
          },
          required: ['space'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { callSpace , accessibleSpaceIds } = ctx;
    const metaCfg = getConfig();
    const metaSpace = metaCfg.spaces.find(s => s.id === callSpace);
    // Always resolve library `$ref` types so the agent sees the effective schema (propertySchemas from
    // the linked library entry), not a bare `{ $ref }` — this is a read-for-use surface, like
    // GET /api/spaces/:id/meta?resolve=1.
    const { resolveMetaRefs } = await import('../../spaces/schema-validation.js');
    const metaBlock = resolveMetaRefs(metaSpace?.meta ?? {});
    const metaMemberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
    const metaCounts = await Promise.all(metaMemberIds.map(async mid => ({
      memories: await col(`${mid}_memories`).countDocuments(),
      entities: await col(`${mid}_entities`).countDocuments(),
      edges: await col(`${mid}_edges`).countDocuments(),
      chrono: await col(`${mid}_chrono`).countDocuments(),
      files: await col(`${mid}_files`).countDocuments(),
    })));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { previousVersions: _pv, ...metaPublic } = metaBlock;
    const metaResult = {
      spaceId: callSpace,
      spaceName: metaSpace?.label ?? callSpace,
      ...metaPublic,
      stats: {
        memories: metaCounts.reduce((s, c) => s + c.memories, 0),
        entities: metaCounts.reduce((s, c) => s + c.entities, 0),
        edges: metaCounts.reduce((s, c) => s + c.edges, 0),
        chrono: metaCounts.reduce((s, c) => s + c.chrono, 0),
        files: metaCounts.reduce((s, c) => s + c.files, 0),
      },
      // The field `reindex`'s description has always told callers to poll for. It was only ever on the REST
      // route, so an MCP-only client could START a multi-minute job and never learn it had finished. Same
      // `.some()` over members the REST side uses: a proxy needs a reindex when any member does.
      needsReindex: metaMemberIds.some(mid => needsReindex(mid)),
    };
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(metaResult),
      }],
    };
  },
};

export const update_spaceTool: ToolHandler = {
  name: 'update_space',
  description: 'Update the label, purpose or face-descriptor width of the specified space. Needs EITHER instance-admin rights OR the '
    + '`admin` rung on all four areas (knowledge, files, schema, dataQuality) of the space named in `space` — '
    + 'administering a different space does not grant this one. `purpose` is the space-level directive MCP '
    + 'clients receive at handshake. Its `description` alias was removed in 3.0 — sending `description` is now '
    + 'rejected, not silently folded into `purpose`. To change the space\'s storage quota you need instance-admin '
    + 'rights and the REST route: `maxGiB` is the space\'s share of the host disk, so it is not a space setting. `faceDescriptorDims` is accepted here and refused by the space\'s STATE rather than by this surface: 409 if the gallery already holds descriptors, or if its index is built at a different width. On a space that has never held a face it succeeds, which is the case an operator was blocked on.',
  mutating: true,
  spaceAdmin: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            label: { type: 'string', minLength: 1, maxLength: 200, description: 'New display label for the space (1–200 chars).' },
            purpose: { type: 'string', maxLength: SPACE_PURPOSE_MAX, description: `New purpose for the space (max ${SPACE_PURPOSE_MAX} chars) — the space-level directive injected into MCP instructions at handshake.` },
            faceDescriptorDims: {
              type: 'integer', minimum: 64, maximum: 4096,
              description: 'New face-descriptor width: 128 for MobileFaceNet-class models, 512 for ArcFace / AdaFace / FaceNet / EdgeFace. REFUSED BY STATE, NOT BY SURFACE — 409 if this space already holds face descriptors (nothing re-derives a stored face vector, so re-declaring the width would leave every one unmatchable while reporting success), or if its face index is already built at a different width. It SUCCEEDS on a space that has never held a face, which is the case the create-only rule used to block for no reason. READ THIS BEFORE POINTING AN EXTERNAL RECOGNISER AT AN INSTANCE: a space with no width set resolves to 128, and nothing derives it from your endpoint, so a 512-d model against an unset space builds a 128-wide index and skips every descriptor it is handed — one warning per process, silent after that.',
            },
          },
          required: ['space'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // No second copy of the authorisation rule here. `spaceAdmin: true` is decided in the dispatcher by
    // `spaceAdminRefusal`, against the rights matrix and the space this call names. The `if (!isAdmin)` that
    // used to sit here read the LEGACY boolean, which `ToolContext` says outright nothing should read for a
    // new decision — and left in place it would have refused exactly the space administrator this feature
    // admits, silently, one layer below the guard that let them in.
    const { args: a, callSpace } = ctx;
    const newLabel = typeof a['label'] === 'string' ? a['label'].trim() : undefined;
    const newDesc = typeof a['purpose'] === 'string' ? a['purpose'] : undefined;
    const newDims = typeof a['faceDescriptorDims'] === 'number' ? a['faceDescriptorDims'] : undefined;
    if (newLabel === undefined && newDesc === undefined && newDims === undefined) {
      throw new Error('At least one of label, purpose or faceDescriptorDims must be provided');
    }
    if (newLabel !== undefined && newLabel.length === 0) throw new Error('label must not be empty');
    if (newDesc !== undefined && newDesc.length > SPACE_PURPOSE_MAX) throw new Error(`purpose must not exceed ${SPACE_PURPOSE_MAX} characters`);
    if (newLabel !== undefined && newLabel.length > 200) throw new Error('label must not exceed 200 characters');
    // `meta.purpose` directly. Until 3.0 this sent `description` and let the planner fold it in — that fold is
    // gone with the alias, so a tool still sending the old spelling would now be dropped by a `.strict()` body
    // rather than rewritten. The planner is the same one the REST route uses, so both doors keep one rule.
    const updates: { label?: string; meta?: { purpose: string }; faceDescriptorDims?: number } = {};
    if (newLabel !== undefined) updates.label = newLabel;
    if (newDesc !== undefined) updates.meta = { purpose: newDesc };

    // The state check runs HERE, before the planner, exactly where the REST route puts it — one implementation
    // of the rule, called from both doors, rather than a second copy of the two queries. `runSpaceMetaUpdate`
    // below reports a refusal's status alongside its text, so an agent sees the same 409 a REST caller does.
    if (newDims !== undefined) {
      const { refuseFaceWidthChange } = await import('../../spaces/face-width-change.js');
      const current = getConfig().spaces.find(sp => sp.id === callSpace);
      const refusal = await refuseFaceWidthChange(callSpace, newDims, current?.faceDescriptorDims);
      if (refusal) throw new Error(`Error (${refusal.status}): ${refusal.reason}`);
      updates.faceDescriptorDims = newDims;
    }

    // Through the planner, NOT `updateSpace` directly — and this was a live governance bypass, not a tidy-up.
    //
    // `updateSpace` folds `description` into `meta.purpose` and bumps the meta version, so writing it here was a
    // META write. On a networked space `PATCH /api/spaces/:id` opens a `meta_change` vote for exactly that edit;
    // this tool applied it immediately. So a directive change made over MCP skipped the vote in precisely the
    // spaces that had voted to govern directive changes — the same *two surfaces, one rule, one weaker* defect the
    // rest of this batch is about, one field over. Found while adding `update_space_schema` below.
    return await runSpaceMetaUpdate(callSpace, updates, `Space '${callSpace}' updated.`, ctx.rights);
  },
};

/**
 * Plan → apply, and report the outcome in words.
 *
 * Both space-writing tools go through here so neither can drift from the REST route's rules: the same refusals, the
 * same normalisation, the same network vote. The refusal's HTTP status is reported alongside the message rather
 * than translated away — an agent that sees `412` can re-read and retry, where "it failed" leaves it guessing.
 */
async function runSpaceMetaUpdate(
  spaceId: string,
  body: Record<string, unknown>,
  okText: string,
  rights: TokenRights | undefined,
): Promise<ToolResult> {
  const { planSpaceMetaUpdate, applySpaceMetaUpdate } = await import('../../spaces/meta-update.js');
  const space = getConfig().spaces.find(s => s.id === spaceId);

  /*
   * THE SAME per-field table the REST door uses, and it is here rather than in each tool for the reason
   * this function exists at all: two callers, one rule.
   *
   * `PATCH /api/spaces/:id` stopped demanding Space-admin for its whole body on 2026-09-08 and now asks
   * each field's own area. Leaving these two tools on the four-area demand would have made a `files` writer
   * able to set a media level through one door and refused through the other -- with the MCP side being the
   * stricter one, which is the shape the canary reports from outside and nobody sees from in here.
   */
  const refused = refusalsForSpaceUpdate(body, spaceId, !!rights?.instanceAdmin, rights);
  if (refused.length) {
    return {
      content: [{ type: 'text' as const, text: `Error (403): Not allowed to change `
        + `${refused.map(describeFieldRequirement).join(', ')}.` }],
      isError: true,
    };
  }

  // No `If-Match`: MCP has no header to carry one, and absence means "no precondition asked for" — the same
  // default a REST caller gets. A tool parameter for it would be inventing a concurrency protocol for a surface
  // that has not asked for one.
  const decision = planSpaceMetaUpdate({ spaceId, space, body, ifMatch: undefined });
  if (!decision.ok) {
    return {
      content: [{ type: 'text' as const, text: `Error (${decision.refusal.status}): ${decision.refusal.body.error}` }],
      isError: true,
    };
  }

  const result = await applySpaceMetaUpdate(decision.plan);
  if (result.outcome === 'not_found') {
    return { content: [{ type: 'text' as const, text: `Space '${spaceId}' not found` }], isError: true };
  }
  if (result.outcome === 'vote_pending') {
    // NOT reported as success. The space belongs to a network that votes on meta changes, so nothing is stored yet
    // and an agent that read this as "done" would build on a schema that does not exist.
    const nets = result.rounds.map(r => r.networkLabel).join(', ');
    return {
      content: [{ type: 'text' as const, text:
        `Proposed, NOT yet applied: '${spaceId}' belongs to ${result.rounds.length === 1 ? 'a network' : 'networks'} `
        + `that votes on meta changes (${nets}), so this opened a vote round instead of writing. The change takes `
        + `effect if and when the round concludes in favour.` }],
      structuredContent: { outcome: 'vote_pending', rounds: result.rounds },
    };
  }
  return { content: [{ type: 'text' as const, text: okText }], structuredContent: { outcome: 'applied' } };
}

/**
 * Write a space's type schemas — the second of the three REST-only capabilities that needed an extraction first.
 *
 * ## The report
 *
 * The canary operator listed it among five capabilities a token could HOLD and not exercise, and gave the case that
 * makes it more than ergonomics: they designed an 11-entity / 7-memory / 13-edge / 10-chrono research model with an
 * agent, and the agent could not apply it. `get_space_meta` reads the schema; nothing wrote it. A sixth instance
 * arrived on 2026-08-12 with the sharper consequence — under `validationMode: 'strict'` a stale enum makes every
 * write fail, and a schema write is the documented way out. So this is the recovery path for a wedged space.
 *
 * ## Why it is not a wrapper
 *
 * `updateSpace()` exists, but `PATCH /api/spaces/:id` wraps it in a chain of refusals: the strict parse, the
 * server-owned strip, the schema-library `$ref` check, and the network vote. A tool calling `updateSpace()` directly
 * would skip all of them — so the chain was extracted first (`spaces/meta-update.ts`, pinned by
 * `space-meta-update-contract.test.js`) and this tool calls it. **Merge semantics are the REST default**: types not
 * mentioned are preserved, and `typeSchemasMode: 'replace'` is how a deletion is expressed.
 */
/**
 * The keys `update_space_schema` forwards into `meta` — read from the tool's OWN schema, once.
 *
 * `space` and `typeSchemasMode` are the two arguments that are NOT meta: one names the space, the other says
 * how `typeSchemas` combines. Everything else the tool declares is a meta field by construction, so this is a
 * derivation rather than a list, and the omission it replaces cannot recur: a field added to the schema is
 * forwarded by the same commit.
 */
const NOT_META = new Set(['space', 'typeSchemasMode']);

/**
 * `create_space` declares `purpose`, which the create body still calls `description` — so it is translated
 * at the call site rather than forwarded, and must not be forwarded under its own name as well.
 */
const NOT_BODY = new Set(['purpose']);

/**
 * The argument names a tool forwards: everything its own `inputSchema` declares, minus the ones that are not
 * part of the payload.
 *
 * Written once because two tools had hand-written copies of their own schemas beside them, and one of those
 * copies was already wrong — a field declared, accepted by the dispatcher, and dropped before the write,
 * with the other door storing it. The schema is the contract, so the schema is the list, and a field added
 * to it is forwarded by the same commit.
 */
function forwardedArgNames(tool: ToolHandler, exclude: ReadonlySet<string>): string[] {
  const props = (tool.inputSchema({} as ToolSchemas).properties ?? {}) as Record<string, unknown>;
  return Object.keys(props).filter(k => !exclude.has(k));
}

export const update_space_schemaTool: ToolHandler = {
  name: 'update_space_schema',
  description: 'Write a space\'s type schemas (and its other meta fields). Needs EITHER instance-admin rights OR '
    + 'the `admin` rung on the `schema` area of the space named in `space` — holding it on a different space does '
    + 'not grant this one. '
    + 'MERGES by default: types you do not mention are preserved, so editing one type does not require resending '
    + 'the others. Pass `typeSchemasMode: "replace"` to make the payload authoritative — that is the only way to '
    + 'DELETE a type. Knowledge-type keys are singular: entity, memory, edge, chrono. A `$ref` to a schema-library '
    + 'entry that does not exist is refused (422) rather than silently stored as an empty schema. On a space whose '
    + 'network votes on meta changes this opens a vote round instead of writing — the reply says so, and nothing is '
    + 'stored until the round concludes.',
  mutating: true,
  /*
   * NOT `spaceAdmin: true`, since 2026-09-08, and the REST door is why.
   *
   * `PUT /api/spaces/:id/schema` is the `schema` area's `admin` rung and admits a token holding it. Keeping
   * the four-area demand here would leave one capability reachable through one door and refused through the
   * other, which is the divergence this repo pays most for and always discovers from outside.
   *
   * A space administrator holds `admin` on all four areas, so everyone who reached this tool yesterday still
   * does. What changed is that a token whose only admin rung is `schema` now reaches it on both doors.
   */
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      typeSchemas: {
        type: 'object',
        description: 'Per knowledge type, a map of type name to its schema. Keys are singular: `entity`, `memory`, '
          + '`edge`, `chrono`. A schema is either `{"$ref": "library:<name>"}` or an inline definition. Its '
          + 'fields are collection-scoped and the complete, current list is the `TypeSchema` block in '
          + '`docs/integration-guide/06a-schema-api.md` — `namingPattern` (entity), `propertySchemas`, '
          + '`retention` (`contentDays` chrono-only), `suppressEmbeddings`, `whenDuePasses` (chrono-only), '
          + 'and `endpoints`/`functional` (edge-only). A field sent on the wrong collection is REFUSED and '
          + 'the message names the one it belongs to.',
      },
      typeSchemasMode: {
        type: 'string', enum: ['merge', 'replace'],
        description: 'How `typeSchemas` combines with what is stored. `merge` (default) adds and updates named '
          + 'types and preserves the rest; `replace` makes the payload authoritative, so types absent from it are '
          + 'REMOVED. Use `replace` to delete a type.',
      },
      validationMode: {
        type: 'string', enum: ['off', 'warn', 'strict'],
        description: 'Whether records are validated against the schemas: not at all, warn on violation, or refuse '
          + 'the write.',
      },
      strictLinkage: { type: 'boolean', description: 'Refuse a write whose entity references do not resolve.' },
      usageNotes: { type: 'string', maxLength: 50_000, description: 'Free-text guidance about the space, returned to MCP clients with its meta.' },
      suppressEmbeddings: { type: 'boolean', description: 'Space-level default for suppressing embeddings; a type schema can override it.' },
      whenDuePasses: {
        type: 'string', enum: ['overdue', 'nothing'],
        description: 'Space-level default for what a PASSED chrono due moment means: `overdue` (the built-in '
          + 'behaviour) or `nothing`, which returns the STORED status for entries recording something that '
          + 'happened rather than a deadline. A chrono type schema can override it. Absent leaves it unset, '
          + 'which is the built-in behaviour.',
      },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // Authorised by `spaceAdmin: true` in the dispatcher — see the note on `update_space`. The legacy
    // `isAdmin` check that stood here would have refused a space administrator the guard had just admitted.
    const { args: a, callSpace } = ctx;

    /*
     * Everything except `space`/`typeSchemasMode` belongs inside `meta`, which is where the planner's
     * `.strict()` schema expects it. Still built by PICKING rather than spreading `args`: a spread would
     * carry `space` into `meta` and earn a 400 for a field the caller never sent.
     *
     * **The names come from this tool's own `inputSchema`, not from a second list beside it.** They were a
     * hard-coded array of five, and adding `whenDuePasses` to the schema without also adding it there meant
     * the field was declared, accepted by the dispatcher, and then SILENTLY DROPPED before the write — the
     * REST door storing it and this one not, which `CLAUDE.md` names as worse than either door refusing.
     * The schema is the contract, so the schema is the list.
     */
    const declared = forwardedArgNames(update_space_schemaTool, NOT_META);
    const meta: Record<string, unknown> = {};
    for (const k of declared) {
      if (a[k] !== undefined) meta[k] = a[k];
    }
    if (Object.keys(meta).length === 0) {
      throw new Error(`At least one of ${declared.join(', ')} must be provided`);
    }

    const body: Record<string, unknown> = { meta };
    if (a['typeSchemasMode'] !== undefined) body['typeSchemasMode'] = a['typeSchemasMode'];

    const wrote = Object.keys(meta).join(', ');
    return await runSpaceMetaUpdate(callSpace, body, `Space '${callSpace}' schema updated (${wrote}).`, ctx.rights);
  },
};

/**
 * Create a space — the last of the five REST-only capabilities that needed an extraction first.
 *
 * ## Why it is not a wrapper over `createSpace()`
 *
 * `createSpace()` has existed all along, which is exactly what made this dangerous rather than easy. The REST route
 * wraps it in checks a direct call skips: proxy member existence, proxy nesting, the schema-library `$ref`, and the
 * strict-posture seeding. A tool calling it directly would let a token holding `createSpaces` produce spaces that a
 * REST caller could not — an un-seeded space with no validation, or a proxy pointing at a space that does not exist.
 * That is the *two surfaces, one rule, one weaker* defect this batch closes, so the chain was extracted first
 * (`spaces/space-create.ts`, pinned by `space-create-contract.test.js`) and this calls it.
 *
 * ## `faceDescriptorDims` is on the tool deliberately
 *
 * It is the parameter the canary operator was blocked on for a week. Leaving it off the tool would mean an agent could
 * create a space but never one that works with a 512-float recogniser — the exact shape of their complaint.
 *
 * It used to be described here as **create-only by design**, on the grounds that a populated gallery cannot be
 * re-dimensioned. That reason is sound and the conclusion was too broad: the guard is about STORED VECTORS, and a
 * space that has never held a face has none to strand. `update_space` now accepts it and refuses by state — the
 * same operator asked the question on 2026-08-20, and neither the schema nor the guide covered the empty case.
 * Setting it at creation is still the reliable path, because it is the only one that cannot be refused.
 */
export const create_spaceTool: ToolHandler = {
  name: 'create_space',
  description: 'Create a new space. Requires an admin token. The id is derived from the label when omitted. '
    + 'A new space is seeded with a fully strict schema posture (validationMode: strict, strictLinkage: true) '
    + 'unless you pass meta saying otherwise — with no typeSchemas defined yet that accepts every type, so it does '
    + 'not block an empty space. A proxy space (proxyFor) holds no data of its own and is left un-seeded. '
    + 'Set `faceDescriptorDims` HERE if you are bringing your own recogniser: it can be changed later with `update_space`, but ONLY while the space has never held a face descriptor, so getting it right at creation is the reliable path. Refusals match POST /api/spaces exactly, including 422 for a $ref to a schema-library entry that '
    + 'does not exist and 409 when the id is taken.',
  mutating: true,
  admin: true,
  inputSchema: (_s: ToolSchemas) => ({
    type: 'object',
    properties: {
      label: {
        type: 'string', minLength: 1, maxLength: 200,
        description: 'Human-readable name for the space, 1 to 200 characters. Required, and it is NOT the '
          + 'identity — the `id` is, and it is derived from this label when you omit one. Two spaces may '
          + 'carry the same label; nothing deduplicates on it. Changing it later never moves data, because '
          + 'nothing is keyed on it.',
      },
      id: {
        type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9-]+$',
        description: 'Space id — lowercase letters, digits and hyphens. Derived from the label when omitted.',
      },
      purpose: {
        type: 'string', maxLength: SPACE_PURPOSE_MAX,
        description: `The space-level directive injected into MCP instructions at handshake (max ${SPACE_PURPOSE_MAX} chars).`,
      },
      maxGiB: { type: 'number', exclusiveMinimum: 0, description: 'Storage quota in GiB. Omit for unlimited.' },
      proxyFor: {
        type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, minItems: 1,
        description: 'Make this a PROXY space that reads across the listed member spaces, or ["*"] for all of them. '
          + 'Members must exist and must not themselves be proxies — nesting is refused. A proxy holds no data of '
          + 'its own.',
      },
      faceDescriptorDims: {
        type: 'integer', minimum: 64, maximum: 4096,
        description: 'Face-descriptor width for this space: 128 for MobileFaceNet-class models, 512 for '
          + 'ArcFace / AdaFace / FaceNet / EdgeFace. OMITTING IT DOES NOT MEAN "decide later" — it resolves to '
          + '128, and nothing derives it from the recogniser you configure, so a 512-d model against an unset '
          + 'space builds a 128-wide index and silently skips every descriptor. Changeable afterwards with '
          + '`update_space`, but only while the space has never held a face descriptor.',
      },
      meta: {
        type: 'object',
        description: 'Initial meta: typeSchemas, validationMode, strictLinkage, usageNotes, suppressEmbeddings. '
          + 'An explicit value here wins over the seeded strict defaults.',
      },
    },
    required: ['label'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // Authorised by `admin: true` in the dispatcher, which refuses this tool unless the token's matrix says
    // `instanceAdmin`. The `if (!isAdmin)` that stood here was a second copy of that rule, reading the legacy
    // boolean — and a second copy of an authorization rule is what this codebase pays most for.
    const { args: a } = ctx;

    // `purpose` is the current name for what the create body still calls `description`. Translated here rather than
    // widening the body schema: the REST field is the deprecated spelling, and a tool that took the deprecated name
    // would be a new surface adopting an old one on the day it is written.
    /*
     * The forwarded names come from this tool's OWN schema, not from an array written beside it.
     *
     * `update_space_schema` had the same shape and it FAILED: an array of five key names sitting next to a
     * schema that declared six, so `whenDuePasses` was declared, accepted by the dispatcher, and silently
     * dropped before the write. This one is correct today and is the same accident waiting — the two lists
     * have to agree and nothing makes them. `RENAMED` is the only exception, and it is an exception because
     * it is a TRANSLATION rather than an omission.
     */
    const body: Record<string, unknown> = {};
    for (const k of forwardedArgNames(create_spaceTool, NOT_BODY)) {
      if (a[k] !== undefined) body[k] = a[k];
    }
    // `purpose` is the current name for what the create body still calls `description`. Translated here
    // rather than widening the body schema: the REST field is the deprecated spelling, and a tool that took
    // the deprecated name would be a new surface adopting an old one on the day it is written.
    if (a['purpose'] !== undefined) body['description'] = a['purpose'];

    const { planSpaceCreate, applySpaceCreate } = await import('../../spaces/space-create.js');
    const decision = planSpaceCreate(body);
    if (!decision.ok) {
      return {
        content: [{ type: 'text' as const, text: `Error (${decision.refusal.status}): ${decision.refusal.body.error}` }],
        isError: true,
      };
    }

    const result = await applySpaceCreate(decision.plan);
    if (result.outcome === 'conflict') {
      // 409, and reported as its own thing rather than as a generic failure: the id being taken is often a successful
      // retry of a request whose response was lost, and an agent that can tell the two apart stops retrying.
      return {
        content: [{ type: 'text' as const, text: `Error (409): ${result.error}` }],
        isError: true,
        structuredContent: { outcome: 'conflict' },
      };
    }
    if (result.outcome === 'failed') {
      return { content: [{ type: 'text' as const, text: `Error (500): ${result.error}` }], isError: true };
    }

    const s = result.space;
    return {
      content: [{ type: 'text' as const, text:
        `Created space '${s.id}' (${s.label})`
        + `${s.proxyFor ? ` as a proxy over ${s.proxyFor.join(', ')}` : ''}`
        + `${s.meta?.validationMode ? `, validationMode: ${s.meta.validationMode}` : ''}.` }],
      structuredContent: { outcome: 'created', id: s.id, label: s.label },
    };
  },
};

/**
 * Re-embed a space — the LAST of the five REST-only capabilities, and the one their workaround measured best.
 *
 * They reindexed 14 spaces plus 5 personal ones by curl in a shell loop, by hand, because the agent that planned their
 * embedder migration could not run it. That is the whole case: the surface that plans a migration was the surface that
 * could not execute it.
 *
 * ## Why it took three PRs
 *
 * There was nothing to wrap. The re-embedding work was inline in the route handler as five near-identical batch loops,
 * so it was pinned by characterization tests, extracted to `brain/reindex.ts`, and only then given a tool. A tool that
 * had re-implemented the loops would have been a second copy of five embed-text call sites, and the copy that drifts is
 * the one nobody watches.
 *
 * ## The one argument that differs per surface
 *
 * `memberIds`. REST narrows by request; here it comes from the token's accessible spaces via `memberSpacesWithin`.
 * Getting that wrong is how a tool would re-embed a member of a proxy that the token cannot reach — so the planner
 * takes it as an argument rather than resolving it, and each surface supplies the list it is entitled to.
 */
export const reindexTool: ToolHandler = {
  name: 'reindex',
  description: 'Re-embed every record in a space with the currently configured embedding model — the recovery path '
    + 'after changing embedder or model. Requires an admin token. Returns as soon as the job STARTS: it runs in the '
    + 'background and may take minutes, so poll `get_space_meta` — its `needsReindex` field — rather than waiting '
    + 'on this call. One job per instance at a time; a second call while one is running is refused. A PROXY space is '
    + 'refused by name — it has no index of its own, and its members are listed in the error so you can reindex them '
    + 'instead. Idempotent: re-embedding a record that is already current is harmless.',
  mutating: true,
  admin: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: { space: s.requiredSpace },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // Authorised by `admin: true` in the dispatcher, which refuses this tool unless the token's matrix says
    // `instanceAdmin`. The `if (!isAdmin)` that stood here was a second copy of that rule, reading the legacy
    // boolean — and a second copy of an authorization rule is what this codebase pays most for.
    const { callSpace, accessibleSpaceIds } = ctx;

    const { planReindex, startReindex } = await import('../../brain/reindex.js');
    const space = getConfig().spaces.find(s => s.id === callSpace);

    // The member list comes from what this TOKEN may reach, not from the space's full membership. A proxy is refused
    // below regardless, but a scoped admin reindexing a normal space must never walk a member it cannot see.
    const decision = planReindex({
      spaceId: callSpace,
      space,
      memberIds: memberSpacesWithin(callSpace, accessibleSpaceIds),
    });
    if (!decision.ok) {
      // The status is reported alongside the message: 409 means "one is already running, try later" and 400 means
      // "this can never work, reindex the members instead". An agent that cannot tell those apart retries the wrong one.
      return {
        content: [{ type: 'text' as const, text: `Error (${decision.refusal.status}): ${decision.refusal.body.error}` }],
        isError: true,
        ...(decision.refusal.body.proxyFor ? { structuredContent: { proxyFor: decision.refusal.body.proxyFor } } : {}),
      };
    }

    startReindex(decision.plan);
    return {
      content: [{ type: 'text' as const, text:
        `Reindex STARTED for '${callSpace}' (${decision.plan.memberIds.length === 1 ? '1 space' : `${decision.plan.memberIds.length} member spaces`}). `
        + 'It runs in the background — this reply does not mean it finished. Progress is in the server log, and '
        + 'get_space_meta reflects the result once it completes.' }],
      structuredContent: { status: 'started', spaceId: callSpace, memberSpaces: decision.plan.memberIds },
    };
  },
};

export const wipe_spaceTool: ToolHandler = {
  name: 'wipe_space',
  description: 'Empty a space of its DATA while keeping the space itself — its id, label, purpose, schema, '
    + 'rights and network membership all survive. Requires instance-admin rights. IRREVERSIBLE: there is no '
    + 'undo, no trash, and no confirmation step, so the call that arrives is the call that runs.\n\n'
    + 'ON A NETWORKED SPACE IT OPENS A VOTE AND WIPES NOTHING YET. Emptying a space the network shares is a '
    + 'governed act, like deleting one: a round opens in every network that holds the space, this instance '
    + 'votes yes, and the wipe happens on EVERY member when a round passes. A single veto stops it there. So '
    + 'a reply saying `vote_pending` is the success case — do not retry it, and do not read the absence of '
    + 'counts as a failure. Watch the rounds.\n\n'
    + 'ON A SPACE IN NO NETWORK it wipes immediately and finally, exactly as it always has. Nothing about an '
    + 'unnetworked instance changed.\n\n'
    + 'WHY IT VOTES RATHER THAN PROPAGATING. A wipe writes NO tombstones and deletes the existing ones, and '
    + 'tombstones are the only thing that tells a peer a record is gone — so a local wipe on a shared space '
    + 'used to be undone by the next sync, which offered everything back to an instance with no record of any '
    + 'deletion. Voting removes that problem rather than solving it: the peers are wiping too.\n\n'
    + 'IT IS IDEMPOTENT. Wiping an empty space succeeds and returns zeroes rather than erroring, so a retry '
    + 'after a dropped connection is safe.\n\n'
    + 'WHAT ELSE GOES WITH IT: the review queues are cleared for whatever you wiped — duplicate and '
    + 'contradiction findings are claims ABOUT two records, so once those records are gone the finding is not '
    + 'merely stale, it is unopenable. Wiping `files` also deletes the space\'s file directory on disk and '
    + 'recreates it empty.\n\n'
    + 'PARAMETERS:\n'
    + '- `types` — a subset of `memories`, `entities`, `edges`, `chrono`, `files`. OMIT IT TO WIPE ALL FIVE; '
    + 'an omitted `types` is not a safe default. A partial wipe clears only the tombstones and review findings '
    + 'belonging to the types you named.\n'
    + '- `space` — the space to empty. On a proxy this is the proxy\'s own id and there is no `targetSpace` '
    + 'here, so do not reach for this tool to empty one member.\n\n'
    + 'RESPONSE: a per-collection count of what was deleted. Zeroes mean the space was already empty, not '
    + 'that anything refused.',
  mutating: true,
  admin: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            types: {
              type: 'array',
              items: { type: 'string', enum: [...BRAIN_COLLECTIONS] },
              description: 'Optional subset of collection types to wipe. Omit to wipe all.',
            },
          },
          required: ['space'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // Authorised by `admin: true` in the dispatcher, which refuses this tool unless the token's matrix says
    // `instanceAdmin`. The `if (!isAdmin)` that stood here was a second copy of that rule, reading the legacy
    // boolean — and a second copy of an authorization rule is what this codebase pays most for.
    const { args: a, callSpace } = ctx;
    const rawTypes = Array.isArray(a['types']) ? (a['types'] as unknown[]) : undefined;
    if (rawTypes !== undefined && rawTypes.some(t => typeof t !== 'string' || !WIPE_COLLECTION_TYPES.includes(t as WipeCollectionType))) {
      throw new Error(`types must be an array of: ${WIPE_COLLECTION_TYPES.join(', ')}`);
    }
    const wipeTypes = rawTypes as WipeCollectionType[] | undefined;
    const typesLabel = wipeTypes && wipeTypes.length > 0 ? wipeTypes.join(', ') : 'all';

    // X-5: the SAME planner the REST route calls. Both doors ask one function whether this space is governed
    // and it opens the rounds; neither decides for itself, because a second copy of that rule is how one
    // surface ends up wiping immediately while the other votes.
    const plan = planSpaceWipe(callSpace, wipeTypes);
    if (plan.governed) {
      notifyPeersOfWipe(callSpace, wipeTypes);
      const where = plan.rounds.map(r => r.networkLabel).join(', ');
      return {
        content: [{
          type: 'text' as const,
          text: `Nothing has been wiped yet. '${callSpace}' belongs to ${plan.rounds.length} network`
            + `${plan.rounds.length === 1 ? '' : 's'} (${where}), so emptying it is a governed act: a vote is `
            + `now open in each, and this instance has voted yes. [${typesLabel}] is wiped on every member `
            + 'when a round passes, and a single veto stops it there. Watch the rounds rather than expecting '
            + 'counts from this call.',
        }],
        structuredContent: { status: 'vote_pending', rounds: plan.rounds, types: wipeTypes ?? null },
      };
    }

    const result = await wipeSpace(callSpace, wipeTypes);
    const summary = `Wiped [${typesLabel}] in space '${callSpace}': ${result.memories} memories, ${result.entities} entities, ${result.edges} edges, ${result.chrono} chrono, ${result.files} files.`;
    return {
      content: [{ type: 'text' as const, text: summary }],
    };
  },
};

/**
 * List the instance's tokens.
 *
 * ## Why this is a tool
 *
 * The canary operator, 2026-08-11T1722Z, third of five: *"The rights matrix decides what a token may do; the
 * surface should not also decide whether it can."* Their workaround was a Kubernetes CronJob that curls
 * `GET /api/tokens` and posts the result into a space as a chrono entry so an agent can read it — a scheduler
 * standing in for a tool call. That workaround also means the inventory an agent reads is as stale as the last
 * tick, which is the part that makes it wrong rather than merely inconvenient.
 *
 * ## The hash cannot leak from here, and not because this code is careful
 *
 * `listTokens()` is typed `Omit<TokenRecord, 'hash'>[]` and destructures the hash out, so the omission is the
 * function's contract rather than this call site's discipline. That matters: a tool that stripped the hash
 * itself would be one edit away from forgetting to, and the compiler would not object.
 *
 * Admin-gated exactly as the REST route is. The response is credential METADATA — names, prefixes, expiry,
 * rights — which is what an audit of who-can-reach-what needs and is no wider than the REST answer.
 */
export const list_tokensTool: ToolHandler = {
  name: 'list_tokens',
  description: 'List this instance\'s API tokens — names, prefixes, expiry and rights matrix. Requires '
    + 'instance-admin rights. Read-only.\n\n'
    + 'SECRETS ARE NEVER INCLUDED, and there is no parameter that changes that. A token\'s value exists only '
    + 'at the moment it is minted; what is stored is a hash, and the hash is not returned by this or any other '
    + 'surface. If a token\'s value is lost the answer is to rotate it, never to look it up.\n\n'
    + 'THE `prefix` IS HOW YOU IDENTIFY A TOKEN FROM A LOG. Audit entries and error reports carry the prefix '
    + 'rather than the secret, so matching one to a row here is how you find out who did something.\n\n'
    + 'READ `rights`, NOT THE LEGACY FLAGS. `rights` is the matrix that actually governs access: a `floor` '
    + 'applying to every space including ones created later, a `perSpace` row per space, and `instanceAdmin` / '
    + '`createSpaces`. The older `admin` and `readOnly` booleans still appear on records that predate the '
    + 'matrix and are on their way out — a token showing `legacy scope` has no matrix and is governed by its '
    + '`spaces` allowlist instead. That distinction matters for an audit: the two are not different spellings '
    + 'of the same thing.\n\n'
    + 'An expired token is still LISTED. Expiry is enforced when the token is used, not by removing the row, '
    + 'so seeing it here does not mean it works — check `expiresAt` before concluding anything about who has '
    + 'access.\n\n'
    + 'THE QUOTA IS TWO FIELDS AND YOU WANT THE SECOND ONE. `rateLimitPerMinute` is what an admin SET on '
    + 'this token, and it is absent on most of them — absent means "inherit the instance value", which is '
    + 'not the same as unlimited. `rateLimitEffective` is the number actually enforced, resolved from the '
    + 'token, then YTHRIL_RATE_LIMIT_PER_MINUTE, then the 300/minute default. Read the effective one to '
    + 'answer "why is this client getting 429"; read the stored one to answer "did somebody set this".\n\n'
    + 'RESPONSE: one row per token with its id, name, prefix, expiry, whether it carries a rights matrix or '
    + 'legacy scope, the matrix itself, and both quota fields. Use it to answer "which tokens reach this '
    + 'space, and at what level" — the question the rights editor answers one token at a time.',
  admin: true,
  inputSchema: () => ({
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  async handle(_ctx: ToolContext): Promise<ToolResult> {
    // Same call the REST route makes, and its return type is what guarantees no hash rides along.
    const { listTokens } = await import('../../auth/tokens.js');
    const tokens = listTokens();

    const lines = tokens.map(t => {
      const bits = [
        // Derived from the MATRIX (D-8d): `admin` is gone from the record, and the matrix is what every
        // guard has read since the predicate was unified.
        t.rights?.instanceAdmin ? 'instance-admin' : null,
        // Derived from the MATRIX, not from the deleted `readOnly` flag (D-8d). "Read-only" is now a
        // property of what the rights say — no write rung anywhere — rather than a boolean somebody set,
        // which also makes it correct for a token that was never given the flag but holds only `read`.
        canWriteAnywhere(t.rights as TokenRights | undefined) ? null : 'read-only',
        t.expiresAt ? `expires ${t.expiresAt}` : 'no expiry',
        t.rights ? 'rights matrix' : 'legacy scope',
      ].filter(Boolean).join(', ');
      return `- ${t.name} (${t.id}) — ${bits}`;
    });

    const text = tokens.length > 0
      ? `${tokens.length} token(s):\n${lines.join('\n')}`
      : 'No tokens are configured on this instance.';

    // The full records ride here so an audit can branch on the matrix rather than parse the summary above.
    return { content: [{ type: 'text' as const, text }], structuredContent: { tokens } };
  },
};
