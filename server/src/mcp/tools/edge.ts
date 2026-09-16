import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { shapeError } from '../../brain/write-shape.js';
import { UUID_V4_RE, TTL_DAYS_SCHEMA, SUPPRESS_EMBEDDINGS_SCHEMA, ttlDaysFromArgs, unitScoreSchema } from './shared.js';
import { validateDeleteFields, applyDeleteFields as applyDeleteFieldsPaths } from '../../brain/delete-fields.js';
import { deleteEdge, getEdgeById, traverseGraph, updateEdgeById, upsertEdge, EdgeSchemaViolation } from '../../brain/edges.js';
// The shared write gate, imported rather than reimplemented — see the note in memory.ts.
import { type UpdateValidation } from '../../brain/write-validation.js';
import { getConfig } from '../../config/loader.js';
import { isStrictLinkage, resolveMemberSpaces, resolveWriteTarget, findFirstAcrossMembers } from '../../spaces/proxy.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { assertRefsResolve, edgeEndpointKind, edgeEndpointKindSchema, isWellFormedRef } from '../../brain/entity-refs.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { resolveMetaRefs, validateEdge } from '../../spaces/schema-validation.js';
import { mergePropertiesOrKeep } from '../../brain/merge-fields.js';
import { parseRecordSuppression } from '../../brain/suppress-embeddings.js';

export const save_edgeTool: ToolHandler = {
  name: 'save_edge',
  description: 'Create or update a directed relationship between two entities.\n\n'
    + 'IDENTITY IS THE TRIPLET `(from, to, label)` — there is no id anywhere in the call, so EVERY repeat of the same triplet is an update of the existing edge and nothing in the arguments suggests it. Properties merge over what is stored; an absent `properties` means "leave them alone", not "clear them". Change the label and you have a second, different edge rather than a renamed one.\n\n'
    + 'DIRECTION IS PART OF THE MEANING. `from`/`to` are not interchangeable, and `depends_on` reversed is a different claim about the world. A traversal follows them separately (`direction: outbound|inbound|both`), so a reversed edge is not merely untidy — it is unreachable from the side that should have found it.\n\n'
    + 'Both endpoints must be entity ids that exist when the space uses strict linkage; that is a refusal, not a dangling edge. And an edge IS a searchable record: it carries its own embedding and competes with knowledge for a recall\'s result slots, which is why `recall` has a `types` filter.\n\n'
    + 'A LABEL CAN DICTATE WHAT SITS AT EACH END, AND HOW MANY. A space may declare that `reports_to` runs from a person to a person, and that a person reports to at most one manager; this write is REFUSED when it breaks either, with `fromType`, `toType` or `functional` as the violation field and the admitted types in the reason. Read `typeSchemas.edge` from `space_meta` before inventing a label, or expect the refusal to teach you the model one edge at a time. Re-writing the same triplet is never a cardinality breach — an edge is not its own duplicate — and an endpoint that resolves to nothing is not a type breach, because a space may permit dangling references.\n\n'
    + 'IF THE SPACE VALIDATES: `introduced` are violations this write caused and are what refuses it; `preExisting` were already stored, are reported, and do NOT block. Branch on `introduced`.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            from: {
              type: 'string', minLength: 1,
              description: 'Source record ID — an entity ID (UUID v4) unless `fromKind` says otherwise, and '
                + 'a space-relative PATH when `fromKind` is `file`. Required to name a record that exists '
                + 'when the space uses strict linkage, looked up in the collection `fromKind` names.',
            },
            to: {
              type: 'string', minLength: 1,
              description: 'Target record ID — an entity ID (UUID v4) unless `toKind` says otherwise, and a '
                + 'space-relative PATH when `toKind` is `file`. Required to name a record that exists when '
                + 'the space uses strict linkage, looked up in the collection `toKind` names.',
            },
            fromKind: edgeEndpointKindSchema('from'),
            toKind: edgeEndpointKindSchema('to'),
            label: { type: 'string', minLength: 1, description: 'Relationship label (e.g. "works_at", "knows").' },
            type: { type: 'string', description: 'Optional edge type (e.g. "causal", "attribution").' },
            weight: unitScoreSchema('Optional strength for this relationship, 0 to 1. Nothing derives it '
              + 'and nothing ranks on it — it is stored, returned, and sortable by `query`, so it means '
              + 'whatever you decide it means. The 0–1 bound is enforced HERE and not on `save_bulk`, whose '
              + 'per-item schemas are for discovery only.'),
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'Categorisation tags. MERGED over the stored tags when the same triplet already '
                + 'exists, so no value here removes one. They are part of what gets embedded, so a tag '
                + 'affects how this edge ranks in a `recall` as well as being filterable.',
            },
            description: { type: 'string', description: 'Optional prose description of why this relationship exists.' },
            properties: {
              type: 'object',
              description: 'Optional structured key-value metadata for this edge.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            ttlDays: TTL_DAYS_SCHEMA,
          },
          required: ['space', 'from', 'to', 'label'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace, name } = ctx;
    const from = String(a['from'] ?? '');
    const to = String(a['to'] ?? '');
    const label = String(a['label'] ?? '');
    if (!from) throw new Error('from must not be empty');
    if (!to) throw new Error('to must not be empty');
    if (!label) throw new Error('label must not be empty');
    const weight = typeof a['weight'] === 'number' ? a['weight'] : undefined;
    const edgeType = typeof a['type'] === 'string' ? a['type'] : undefined;
    const description = typeof a['description'] === 'string' ? a['description'] : undefined;
    const edgeTags = Array.isArray(a['tags']) ? (a['tags'] as string[]) : undefined;
    const edgeProps = (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties']))
      ? (a['properties'] as Record<string, string | number | boolean>)
      : undefined;
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // `W-14`..`W-22`: the same table the REST door reads, so the two cannot disagree about a value. The
    // dispatcher has already run this tool's own schema; what reaches here is what the schema does not
    // declare.
    const shapeErr = shapeError('edge', a);
    if (shapeErr) throw new Error(shapeErr);
    const fromKind = edgeEndpointKind(a['fromKind'] as RefKind | undefined);
    const toKind = edgeEndpointKind(a['toKind'] as RefKind | undefined);
    if (isStrictLinkage(wt.target)) {
      // The shape a valid endpoint has depends on its kind: a UUID v4 for three of the four, and a
      // space-relative path for a file. Testing both ends against `UUID_V4_RE` regardless — which is what
      // this did — refuses every legitimate file endpoint with a message about entity IDs.
      if (!isWellFormedRef(fromKind, from)) throw new Error(`from must be a valid ${fromKind} reference, not a name`);
      if (!isWellFormedRef(toKind, to)) throw new Error(`to must be a valid ${toKind} reference, not a name`);
      // Shape is not existence. A UUID v4 that names a CHRONO passes both checks above, and the edge then
      // stores fine and is invisible to every graph query — `traverse` and `recall(traverse:1)` hydrate
      // neighbours from the entity collection, so a non-entity endpoint yields no node and no edge. The
      // caller gets an id back for a link that does not exist.
      //
      // Reported by the canary, who lost a 33-day incident timeline to it. The REST route has always
      // called this; only the MCP surface checked the shape and stopped there.
      await assertRefsResolve(wt.target, 'from', fromKind, [from]);
      await assertRefsResolve(wt.target, 'to', toKind, [to]);
    }

    // Schema validation of the record this upsert will PRODUCE. An edge's identity is (from, to, label)
    // with no id in the call at all, so EVERY repeat upsert merges into the stored edge — and nothing in
    // the payload hints at it. Validating the payload alone made a one-property patch look incomplete.
    const edgeMetaRaw = getConfig().spaces.find(s => s.id === wt.target)?.meta;
    const edgeMeta = edgeMetaRaw ? resolveMetaRefs(edgeMetaRaw) : undefined;
    /*
     * The schema check lives in `upsertEdge` now, not here — see the note at its definition. It sat at this
     * tool and at the REST route, one rule written twice and reachable around both.
     * `onValidation` hands the classification back so the `warn`-mode tail below is unchanged and no second
     * `findEdgeByTriplet` runs.
     */
    const edgeTtlDays = ttlDaysFromArgs(a);
    let edgeCheck: UpdateValidation | undefined;
    let edge;
    try {
      // The record tier, which no create door stated until 2026-09-02. `parseRecordSuppression` owns the
      // grammar, so a change to it reaches every create door at once rather than one at a time.
      const supCreate = parseRecordSuppression(a);
      if (!supCreate.ok) throw new Error(supCreate.error);
      edge = await upsertEdge(wt.target, from, to, label, weight, edgeType, description, edgeProps, edgeTags, ctx.actor, edgeTtlDays,
        {
          ...(supCreate.value !== undefined ? { suppressEmbeddings: supCreate.value } : {}),
          ...(a['fromKind'] !== undefined ? { fromKind } : {}),
          ...(a['toKind'] !== undefined ? { toKind } : {}),
          onValidation: c => { edgeCheck = c; },
        });
    } catch (err) {
      if (!(err instanceof EdgeSchemaViolation)) throw err;
      const c = err.check;
      // The violations travel as structured data rather than a JSON tail glued to the sentence: a
      // caller had to parse the message to act on them. The prose is unchanged for a client that
      // reads only the content blocks.
      return {
        content: [{ type: 'text' as const, text: `Error: schema_violation: ${c.message}` }],
        isError: true,
        structuredContent: { error: 'schema_violation', message: c.message, introduced: c.introduced, preExisting: c.preExisting, violations: c.all },
      };
    }
    const edgeSchemaViolations = edgeCheck?.all ?? [];
    let edgeMsg = `Edge '${label}' (${from} → ${to}) upserted (ID ${edge._id}).`;
    if (edgeMeta?.validationMode === 'warn') {
      for (const v of edgeSchemaViolations) edgeMsg += `\n⚠️ Schema: ${v.field} — ${v.reason}`;
    }
    return {
      content: [{ type: 'text' as const, text: edgeMsg }],
    };
  },
};

export const update_edgeTool: ToolHandler = {
  name: 'update_edge',
  description: 'Update one edge by its ID. Every field except `id` is optional; a field you omit is left '
    + 'exactly as it was.\n\n'
    + 'IT CANNOT REPOINT AN EDGE. There is no `from`/`to` here, deliberately: an edge that changes either end '
    + 'is a different relationship, not an edited one, and rewriting it in place would silently invalidate '
    + 'anything already traversed through it. Delete this edge and `save_edge` the new one.\n\n'
    + 'CHANGING THE `label` MOVES THE EDGE UNDER A DIFFERENT RULE. A space can declare what sits at each end of '
    + 'a label and whether a subject may have more than one; the ends cannot change here, but the label can, so '
    + 'the check is against the NEW label\'s rule and this update is refused when the existing ends do not fit '
    + 'it. A violation the edge already had does not block an edit that leaves the ends and the label alone.\n\n'
    + 'MERGE, NOT REPLACE, for `tags` and `properties`. Sending `tags: ["b"]` on an edge tagged `["a"]` leaves '
    + 'it tagged `["a","b"]`. Note that `update_fact` REPLACES tags instead — one word of difference between '
    + 'tools that otherwise take the same arguments. To remove a tag or a property here, use `deleteFields` '
    + 'with its dot path; there is no way to shrink either by sending a smaller value.\n\n'
    + 'EDGES ARE SEARCHABLE RECORDS, which is why `suppressEmbeddings` exists on this tool at all: an edge '
    + 'carries a label and a description, they get embedded, and they compete with knowledge records for a '
    + 'recall `topK`. Excluding a busy structural edge is how you stop it crowding out the records it '
    + 'connects.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the edge\'s `_id`, as `traverse`, `query` and `recall`\'s `_graph` report it. Required.\n'
    + '- `label` — the relationship\'s name, replaced when sent. Re-embeds, AND CHANGES THE `_id`: since 3.6 an edge id is derived from `(from, to, label)` so two peers creating one relationship agree on its id without talking, and a label is part of that identity. The result carries the NEW `_id` and the old one 404s — read it back rather than reusing the id you sent. Every other field patches in place. The same happens to an edge whose endpoint moves in an entity merge.\n'
    + '- `type` — replaced when sent, and re-validated against the space\'s edge-type allowlist.\n'
    + '- `weight` — 0 to 1. Ranking uses it; traversal does not filter on it.\n'
    + '- `description` — replaced when sent.\n'
    + '- `tags` — MERGED into the existing tags, never replacing them.\n'
    + '- `properties` — MERGED key by key. String, number or boolean values only.\n'
    + '- `deleteFields` — dot-notation paths to remove, permanently and with no undo. System fields are '
    + 'refused. This is the ONLY way to unset anything, and it runs AFTER the merge above.\n'
    + '- `suppressEmbeddings` — see its own description. It removes the vector, so `recall` can no longer '
    + 'RANK this edge by meaning. It does NOT remove the edge from the graph: `traverse` still walks it, and a '
    + 'recall on either endpoint still expands through it into `_graph`. Excluding an edge hides it from '
    + 'ranking, never from traversal.\n'
    + '- `ttlDays` — this edge\'s own expiry, the MOST specific of three tiers: it beats the type\'s retention '
    + 'window, which beats the space-wide one.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the edge.\n\n'
    + 'RESPONSE: one line with the edge\'s id and its new `seq` — the sync sequence number, which increments on '
    + 'every write and is how a peer knows this version is newer. An id that does not exist is an error, not a '
    + 'silent no-op.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            id: {
              type: 'string', minLength: 1,
              description: 'The edge\'s `_id`, as `traverse`, `recall` and `query` report it. Required, '
                + 'and an id that names nothing is an ERROR rather than a silent no-op. Note this addresses '
                + 'the edge by id, while `save_edge` addresses it by the from/to/label TRIPLET.',
            },
            label: {
              type: 'string',
              description: 'Replaces the relationship label. It is part of the identity `save_edge` uses '
                + '(from + to + label), so renaming it here means a later `save_edge` with the OLD label '
                + 'creates a second edge instead of updating this one. It is also embedded, so it changes '
                + 'how this edge ranks.',
            },
            type: {
              type: 'string',
              description: 'Replaces the edge type (e.g. "causal", "attribution"). Free text — nothing '
                + 'validates it against a list, and it is not part of the edge\'s identity.',
            },
            weight: unitScoreSchema('Replaces the stored weight, 0 to 1. Omitting it leaves the old value '
              + 'in place, so there is no value here that clears one — use `deleteFields: ["weight"]`.'),
            description: {
              type: 'string',
              description: 'Replaces the prose explanation of why this relationship exists. Embedded with '
                + 'the label, so it widens what a `recall` can match this edge on. Clearing it needs '
                + '`deleteFields: ["description"]`.',
            },
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'MERGED into the stored tags, never replacing them — so no value here removes a '
                + 'tag. `update_fact` and `update_chrono` REPLACE the same field; this tool and '
                + '`update_entity` merge. Removing one is `deleteFields`, with `tags` for all of them.',
            },
            properties: {
              type: 'object',
              description: 'Key-value properties to merge with existing. Values must be string, number, or boolean.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            fromKind: edgeEndpointKindSchema('from'),
            toKind: edgeEndpointKindSchema('to'),
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
            deleteFields: { type: 'array', items: { type: 'string' }, description: 'Dot-notation paths to delete from the edge (e.g. ["properties.oldKey", "description"]). System fields (id, name, type, spaceId, createdAt, updatedAt) cannot be deleted. Deletions are permanent.' },
            ttlDays: TTL_DAYS_SCHEMA,
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
    // `W-14`..`W-22`: the same table the REST door reads, so the two cannot disagree about a value. The
    // dispatcher has already run this tool's own schema; what reaches here is what the schema does not
    // declare.
    const shapeErr = shapeError('edge', a);
    if (shapeErr) throw new Error(shapeErr);
    // Validate deleteFields
    const dfResult = validateDeleteFields(a['deleteFields']);
    if (!dfResult.ok) throw new Error(dfResult.error);
    const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0 ? a['deleteFields'] as string[] : undefined;
    const updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string; suppressEmbeddings?: boolean; fromKind?: RefKind; toKind?: RefKind } = {};
    const sup = parseRecordSuppression(a);
    if (!sup.ok) throw new Error(sup.error);
    if (sup.value !== undefined) updates.suppressEmbeddings = sup.value;
    if (typeof a['label'] === 'string') updates.label = (a['label'] as string).trim();
    if (typeof a['description'] === 'string') updates.description = a['description'] as string;
    if (Array.isArray(a['tags'])) updates.tags = a['tags'] as string[];
    if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
      updates.properties = a['properties'] as Record<string, string | number | boolean>;
    }
    if (typeof a['weight'] === 'number') updates.weight = a['weight'] as number;
    if (typeof a['type'] === 'string') updates.type = (a['type'] as string).trim();
    // Correcting an endpoint's kind, on the same door as every other correction. The enum is enforced by the
    // dispatcher before this handler runs, so an unknown value never reaches here — unlike REST, where the
    // route has to refuse it itself. Same allowed set on both, from one definition.
    if (typeof a['fromKind'] === 'string') updates.fromKind = a['fromKind'] as RefKind;
    if (typeof a['toKind'] === 'string') updates.toKind = a['toKind'] as RefKind;
    const ttlDays = ttlDaysFromArgs(a);
    if (Object.keys(updates).length === 0 && !dfPaths && ttlDays === undefined) throw new Error('At least one of label, description, tags, properties, weight, type, fromKind, toKind, suppressEmbeddings, deleteFields, or ttlDays must be provided');

    // Validate the edge AS IT WILL BE, against the meta of the member space it actually lives in. This
    // path had no schema validation at all, so `label` could be moved outside the allowlist that
    // `save_edge` enforces on the very same record.
        /*
     * The schema check moved into the writer, which validates the record it is about to store rather than a
     * rebuilt simulation of it. `assertUpdateAllowed` threw exactly the `SchemaViolationError` the writer now
     * throws, so nothing about this tool's failure shape changes — the block was pure duplication, and the
     * duplicate is the one that drifted.
     */

    const updatedEdge = await findFirstAcrossMembers(wt.target, mid => updateEdgeById(mid, id, updates, dfPaths, ctx.actor, ttlDays));
    if (!updatedEdge) throw new Error(`Edge '${id}' not found`);
    return {
      content: [{ type: 'text' as const, text: `Edge '${updatedEdge.label}' updated (ID ${updatedEdge._id}, seq ${updatedEdge.seq}).` }],
    };
  },
};

export const graph_traverseTool: ToolHandler = {
  name: 'graph_traverse',
  description: 'Follow edges from a starting entity and return reachable nodes up to `maxDepth` hops. For dependency analysis, impact assessment and lineage.\n\n'
    + 'NOT THE SAME AS `recall(traverse: n)`, and the difference decides which one you want:\n'
    + '• This starts from a node you ALREADY KNOW, by id. `recall`\'s expansion starts from whatever a search matched, so it answers "what is near the things about X" rather than "what is near THIS".\n'
    + '• This can follow `entityIds` references — chrono entries, memories and files that point AT a node — which are not edges. `includeChrono`, `includeMemories` and `includeFiles` turn each kind on, and `includeChrono` is ON by default here because you came to explore a graph rather than to search. `recall` takes the SAME three flags inside its `traverse` object, all three defaulting OFF there because its answer is budgeted — so the difference between the two tools is the default, not the capability.\n'
    + '• This returns a flat node list with a depth on each; `recall` nests its walk under the match that reached it.\n\n'
    + 'It is also blind to meaning, which is the point: a node reached in three hops is reached whether or not it resembles anything, and nothing here is embedded or ranked. A record retired from semantic ranking is reached exactly as any other.\n\n'
    + 'THE RESPONSE: `nodes` — each with `id`, `name`, `type`, `kind` ("entity" unless it arrived via one of the include flags) and the `depth` it was found at, `startId` itself at depth 0. `edges` — the connecting relationships, unless `includeEdges` is false. `truncated` — true when `limit` cut the walk, and worth reading: a truncated walk is a PARTIAL graph, so an impact assessment run on one is answering a smaller question than it was asked.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            startId: { type: 'string', minLength: 1, description: 'UUID of the starting entity. It is returned as the first node at depth 0, so a walk that finds nothing still comes back with one node rather than empty — an empty `nodes` means the id resolved to nothing, which is a different answer from "it has no neighbours".' },
            direction: {
              type: 'string',
              enum: ['outbound', 'inbound', 'both'],
              default: 'outbound',
              description: 'Follow edges from the node (outbound), to the node (inbound), or both directions. Default: outbound. It narrows STORED EDGES ONLY. A link is a record with a from and a to since 4.0, but which way it runs is fixed by the KINDS at its ends, not by the data: a memory names entities and entities name nothing, so there is no second direction to choose. includeChrono/includeMemories/includeFiles reach the records naming this entity whatever direction says. The traverse expansion inside recall behaves identically.',
            },
            edgeLabels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter traversal to specific edge labels only. Omit to traverse all labels.',
            },
            maxDepth: { type: 'number', minimum: 1, maximum: 10, default: 3, description: 'Maximum hops from startId (clamped to 1–10). Default 3.' },
            limit: { type: 'number', minimum: 1, maximum: 1000, default: 100, description: 'Maximum total nodes returned (clamped to 1–1000). Default 100.' },
            includeChrono: { type: 'boolean', default: true, description: 'Follow chrono.entityIds as inbound links, so chrono entries about a node are reached too. Chrono nodes carry kind:"chrono"; entity nodes are unchanged. Set false for entity-only results.' },
            includeMemories: { type: 'boolean', default: false, description: 'Follow memory.entityIds as inbound links, so memories about a node are reached too. Memory nodes carry kind:"fact". Opt-IN rather than on by default, unlike includeChrono: memories are usually the most numerous record type and every node counts against `limit`, so enabling it on a memory-heavy space can truncate away the entities you traversed for. Raise `limit` with it.' },
            includeFiles: { type: 'boolean', default: false, description: 'Follow file.entityIds as inbound links, so documents about a node are reached too. File nodes carry kind:"file" and file META ONLY — the path as `name`, plus `description` and `tags`. Never passage text: a file body is its chunks, they are the largest thing stored, and a structural walk must not pay for them. Read a chunk with the file API once you know which document you want. Opt-in, like includeMemories.' },
            includeEdges: { type: 'boolean', default: true, description: 'Whether the response carries the edge list. This does NOT change the walk — edges are how the graph is traversed, so declining to follow them would return different nodes rather than a smaller answer. Set false when you only want the reachable nodes and the connecting relationships would be wasted tokens.' },
          },
          required: ['space', 'startId'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace , accessibleSpaceIds } = ctx;
    const startId = String(a['startId'] ?? '').trim();
    if (!startId) throw new Error('startId must not be empty');
    const directionRaw = typeof a['direction'] === 'string' ? a['direction'] : 'outbound';
    const validDirections = new Set(['outbound', 'inbound', 'both']);
    const direction: 'outbound' | 'inbound' | 'both' = validDirections.has(directionRaw)
      ? (directionRaw as 'outbound' | 'inbound' | 'both')
      : 'outbound';
    const edgeLabels = Array.isArray(a['edgeLabels'])
      ? (a['edgeLabels'] as unknown[]).filter((l): l is string => typeof l === 'string')
      : undefined;
    const maxDepth = typeof a['maxDepth'] === 'number' ? Math.min(Math.max(1, a['maxDepth']), 10) : 3;
    const limit = typeof a['limit'] === 'number' ? Math.min(Math.max(1, a['limit']), 1000) : 100;

    const memberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
    // Same default and same opt-out as REST — a rule that reaches one door and not the other is the defect
    // four brain-API fixes were about.
    const result = await traverseGraph(memberIds, startId, direction, edgeLabels, maxDepth, limit,
      a['includeChrono'] !== false, a['includeMemories'] === true, a['includeFiles'] === true,
      a['includeEdges'] !== false);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result),
      }],
    };
  },
};

/**
 * Delete one edge.
 *
 * This tool is the reported gap, in the reporter's words: an agent could `delete_space_data` but could not delete
 * a single edge. REST has deleted all four record types since it existed; MCP had `delete_fact` and
 * nothing else — so the only edge-removal an agent could reach was destroying the entire space.
 */
export const delete_edgeTool: ToolHandler = {
  name: 'delete_edge',
  description: 'Delete one edge by its ID. IRREVERSIBLE — there is no undelete and no trash.\n\n'
    + 'THE ENTITIES AT EITHER END ARE NOT TOUCHED. Deleting an edge removes the RELATIONSHIP and nothing '
    + 'else: both endpoints stay exactly as they were, and every other edge between them survives. This is '
    + 'the tool for "these two are not related after all", not for removing a record.\n\n'
    + 'IT IS ALSO HOW YOU REPOINT AN EDGE. `update_edge` deliberately has no `from`/`to` — an edge whose end '
    + 'changed is a different relationship — so the sequence is delete this one, then `save_edge` the new '
    + 'one.\n\n'
    + 'IF YOU WANT IT OUT OF SEARCH RATHER THAN GONE, set `suppressEmbeddings` with `update_edge` '
    + 'instead. Edges are searchable records and compete with knowledge for a recall `topK`; excluding one '
    + 'stops it being ranked while `traverse` still walks it and recall still expands through it. Deleting it '
    + 'removes it from the graph as well, which is a much larger change than "it was crowding my results".\n\n'
    + 'IT IS NEVER REFUSED FOR BEING REFERENCED, and unlike memories and chrono entries that did not change '
    + 'in 4.0: nothing can point AT an edge. Links run from a memory, chrono entry or file to what it is '
    + 'about, and an edge is never the target of one.\n\n'
    + 'A TOMBSTONE IS WRITTEN, so the deletion propagates to peer instances on the next sync and the edge is '
    + 'not quietly resurrected from a peer that still has it. That is also why re-creating it with the same '
    + 'id does not undo this — the tombstone outranks it. Use a new id.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the edge\'s `_id`, as `traverse`, `query` and recall\'s `_graph` report it. Required. An id '
    + 'that does not exist is an ERROR, not a silent success.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the edge.\n\n'
    + 'RESPONSE: one line confirming the id that was deleted.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      id: {
        type: 'string', minLength: 1,
        description: 'The edge\'s `_id`. An id that does not exist is an ERROR, not a silent success. '
          + 'Deleting an edge NEVER touches the two entities it joined — it removes the relationship only. A '
          + 'tombstone is written, so re-creating it with the same id does not undo this.',
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

    const deleted = await findFirstAcrossMembers(wt.target, mid => deleteEdge(mid, id, ctx.actor));
    if (!deleted) throw new Error(`Edge '${id}' not found`);
    return { content: [{ type: 'text' as const, text: `Edge deleted (ID ${id}).` }] };
  },
};
