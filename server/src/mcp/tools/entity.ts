import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { shapeError } from '../../brain/write-shape.js';
import { UUID_V4_RE, TTL_DAYS_SCHEMA, SUPPRESS_EMBEDDINGS_SCHEMA, ttlDaysFromArgs, uuidSchema, unitScoreSchema } from './shared.js';
import { validateDeleteFields, applyDeleteFields as applyDeleteFieldsPaths } from '../../brain/delete-fields.js';
import { deleteEntity, findEntitiesByName, getEntityById, updateEntityById, upsertEntity } from '../../brain/entities.js';
import { entityDeleteBlockers } from '../../brain/entity-delete-guard.js';
import { deleteEntityCascade } from '../../brain/entity-delete-cascade.js';
// The shared write gate, imported rather than reimplemented — see the note in memory.ts.
import { SchemaViolationError, type UpdateValidation } from '../../brain/write-validation.js';
import { type PropertyResolution, type EndpointRuleWarning, applyResolutions, computeMergePlan, executeMerge, validateResolution } from '../../brain/merge.js';
import { getConfig } from '../../config/loader.js';
import { isProxySpace, isStrictLinkage, resolveMemberSpaces, resolveWriteTarget, findFirstAcrossMembers, collectAcrossMembers } from '../../spaces/proxy.js';
import { resolveMetaRefs, validateEntity } from '../../spaces/schema-validation.js';
import { mergePropertiesOrKeep, mergeTagsOrKeep } from '../../brain/merge-fields.js';
import { parseRecordSuppression } from '../../brain/suppress-embeddings.js';
import { connectionSchemas, applyConnections } from '../../brain/write-connections.js';

export const save_entityTool: ToolHandler = {
  name: 'save_entity',
  description: 'Create or update a named entity in the knowledge graph. Identity is by `id` — supply one and the matching record is updated, omit it and a NEW record is always inserted regardless of name. Two entities may share a name; nothing deduplicates for you. Use `find_entities_by_name` first if you meant to update.\n\n'
    + 'An upsert onto an existing record MERGES: properties and tags are merged over what is stored, so you can set one field without restating the rest, and the record is validated in its MERGED form rather than as the fragment you sent. That is why a partial upsert of a conformant record is accepted even when the fragment alone would fail a required-property rule.\n\n'
    + 'IF THE SPACE VALIDATES, a refusal names WHOSE FAULT it is. `introduced` are violations your write caused — fix those. `preExisting` were already stored and your write neither caused nor fixed them; in `strict` mode they are REPORTED and do NOT refuse the write, so an unrelated edit is never blocked by a field somebody else broke. Branch on `introduced` and treat `preExisting` as a repair opportunity rather than an error.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            // `F-27`: the `link*` fields and `edges`, from the one builder REST reads with — so a field
            // on one door and not the other cannot happen.
            ...connectionSchemas(),
            space: s.requiredSpace,
            id: uuidSchema('UUID v4 of an EXISTING record to update. It is not a way to choose an id: identity is server-generated, so an id that names nothing is ignored rather than adopted. To carry your own reference, use `name` or `description`.'),
            name: {
              type: 'string', minLength: 1,
              description: 'Entity name. NOTHING DEDUPLICATES BY IT — omit `id` and a NEW record is always '
                + 'inserted, even when an entity of the same name already exists, so two entities may share '
                + 'a name. Call `find_entities_by_name` first if you meant to update one. The name is '
                + 'embedded, so it also affects how `recall` ranks this entity.',
            },
            type: { type: 'string', minLength: 1, description: 'Entity type (person, place, concept, …).' },
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'Categorisation tags. MERGED over the stored tags when this upsert lands on an '
                + 'existing record, so sending `["b"]` on an entity tagged `["a"]` leaves it `["a","b"]` — '
                + 'there is no value here that removes a tag. Clearing them is `update_entity` with '
                + '`deleteFields: ["tags"]`.',
            },
            description: { type: 'string', description: 'Optional prose description or summary of this entity.' },
            properties: {
              type: 'object',
              description: 'Key-value properties (e.g. {"wheels": 4, "color": "red"}). Values must be string, number, or boolean.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
            checkContradictions: { type: 'boolean', default: false, description: 'Also flag existing entities that CONTRADICT this one — a near-neighbour setting the same single-valued property to a different value. Deterministic only (no model call). The entity is still stored regardless.' },
            checkDuplicates: { type: 'boolean', default: true, description: 'On a NEW entity insert (no id / unknown id), run a semantic near-duplicate check first (default true). Flags highly similar existing entities (id + summary + score) so you can merge or update instead of creating a duplicate. Does not fire on updates. Set false to skip.' },
            dupeThreshold: unitScoreSchema('Cosine-similarity threshold for the duplicate check (0-1, default ~0.92). Lower to flag looser matches.'),
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            ttlDays: TTL_DAYS_SCHEMA,
          },
          required: ['space', 'name', 'type'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace, name } = ctx;
    const eName = String(a['name'] ?? '');
    const eType = String(a['type'] ?? '');
    if (!eName.trim()) throw new Error('name must not be empty');
    if (!eType.trim()) throw new Error('type must not be empty');
    const tags = Array.isArray(a['tags']) ? (a['tags'] as string[]) : [];
    const props = (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties']))
      ? (a['properties'] as Record<string, string | number | boolean>)
      : {};
    const description = typeof a['description'] === 'string' ? a['description'] : undefined;
    const rawId = typeof a['id'] === 'string' ? a['id'].trim() : undefined;
    if (rawId !== undefined && !UUID_V4_RE.test(rawId)) throw new Error('id must be a valid UUID v4');
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // `W-14`..`W-22`: the same table the REST door reads, so the two cannot disagree about a value. The
    // dispatcher has already run this tool's own schema; what reaches here is what the schema does not
    // declare.
    const shapeErr = shapeError('entity', a);
    if (shapeErr) throw new Error(shapeErr);

    // Schema validation of the record this upsert will PRODUCE, not of the payload. With an `id` that
    // matches, `upsertEntity` merges into the stored record, so validating the payload alone refused
    // partial patches whose merged result was perfectly conformant.
    const entMetaRaw = getConfig().spaces.find(s => s.id === wt.target)?.meta;
    const entMeta = entMetaRaw ? resolveMetaRefs(entMetaRaw) : undefined;
    // The check runs inside `upsertEntity` now — this tool, the REST route and `bulk.ts` each held a copy of
    // it, and `bulk.ts`'s enforced a different rule. The refusal arrives as `SchemaViolationError`, whose
    // `toStructured()` produces exactly the body this tool used to build by hand.
    let entCheck: UpdateValidation | undefined;

    // Insert-time duplicate check defaults ON for the interactive upsert tool
    // (only fires on inserts, not updates — see upsertEntity).
    const entDupeCheck = a['checkDuplicates'] !== false;
    const entContraCheck = a['checkContradictions'] === true;
    const entDupeThreshold = typeof a['dupeThreshold'] === 'number' ? a['dupeThreshold'] : undefined;
    const entTtlDays = ttlDaysFromArgs(a);
    let upserted;
    try {
      // The record tier, which no create door stated until 2026-09-02. `parseRecordSuppression` owns the
      // grammar, so a change to it reaches every create door at once rather than one at a time.
      const supCreate = parseRecordSuppression(a);
      if (!supCreate.ok) throw new Error(supCreate.error);
      upserted = await upsertEntity(wt.target, eName, eType, tags, props, description, rawId,
        {
          checkDuplicates: entDupeCheck, checkContradictions: entContraCheck, dupeThreshold: entDupeThreshold,
          ...(supCreate.value !== undefined ? { suppressEmbeddings: supCreate.value } : {}),
        },
        ctx.actor, entTtlDays, c => { entCheck = c; });
    } catch (err) {
      if (err instanceof SchemaViolationError) {
        // The violations travel as structured data rather than a JSON tail glued to the sentence: a caller
        // had to parse the message to act on them. The prose is unchanged for a client that reads only the
        // content blocks.
        return {
          content: [{ type: 'text' as const, text: `Error: schema_violation: ${err.check.message}` }],
          isError: true,
          structuredContent: err.toStructured(),
        };
      }
      throw err;
    }
    const { entity, warning, similar, contradicts } = upserted;

    // Links REPLACE per class, edges UPSERT. Both semantics live in `applyConnections`, after the record
    // exists — a relationship needs both ends, and the `from` is what was just minted.
    await applyConnections(wt.target, entity._id, 'entity', a, entity.author, ctx.actor);

    let msg = `Entity '${entity.name}' (${entity.type}) upserted (ID ${entity._id}).${warning ? `\n⚠️ ${warning}` : ''}`;
    if (similar && similar.length > 0) {
      msg += `\n⚠️ Possible duplicate — ${similar.length} existing entit${similar.length === 1 ? 'y is' : 'ies are'} highly similar: ${similar.map(s => `"${s.summary}" (ID ${s._id}, ${s.score.toFixed(2)})`).join('; ')}. Pass checkDuplicates:false to skip, or provide the existing id to update it instead.`;
    }
    if (contradicts && contradicts.length > 0) {
      const detail = contradicts.map(c =>
        `"${c.summary}" (ID ${c.id}: ${c.fields.map(f => `${f.key} ${f.aValue} vs ${f.bValue}`).join(', ')})`).join('; ');
      msg += `
⚠️ Contradiction — ${contradicts.length} existing entit${contradicts.length === 1 ? 'y disagrees' : 'ies disagree'} with this one: ${detail}. The entity was still stored. If you are correcting an outdated fact, update the record above instead of leaving both.`;
    }
    // Schema warnings, taken from the classification the writer handed back rather than re-derived — which
    // would be a second lookup per write and the second copy of the rule this change exists to remove.
    if (entMeta?.validationMode === 'warn') {
      for (const v of (entCheck as UpdateValidation | undefined)?.all ?? []) msg += `\n⚠️ Schema: ${v.field} — ${v.reason}`;
    }
    return {
      content: [{ type: 'text' as const, text: msg }],
    };
  },
};

export const update_entityTool: ToolHandler = {
  name: 'update_entity',
  description: 'Update one entity by its ID. Every field except `id` is optional; a field you omit is left '
    + 'exactly as it was.\n\n'
    + 'MERGE, NOT REPLACE, for `tags` and `properties` — this is the trap. Sending `tags: ["b"]` on an entity '
    + 'tagged `["a"]` leaves it tagged `["a","b"]`, and sending `properties: {"colour":"red"}` keeps every '
    + 'other property. There is no way to shrink either by sending a smaller value; to REMOVE something use '
    + '`deleteFields` with its dot path (`properties.colour`, or `tags` for all of them). Scalar fields — '
    + '`name`, `type`, `description` — do replace, because there is nothing to merge.\n\n'
    + 'VALIDATION IS OF THE RESULT, and it refuses only what your edit BREAKS. The record as it will be — your '
    + 'fields plus the ones already stored — is checked against the space schema. A record that was already '
    + 'invalid before you touched it (written before the schema was tightened, imported, or synced from a peer) '
    + 'is REPORTED and still saved: the problem is already stored, so refusing your edit would not fix it, only '
    + 'stop you maintaining the record. Before 3.1 it did refuse, which quietly froze every record that no '
    + 'longer fitted a tightened schema. Violations your change introduces are refused as before, in a '
    + '`strict` space.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the entity\'s `_id`, as `query`, `recall` and `find_entities_by_name` report it. Required.\n'
    + '- `name` / `type` / `description` — replaced when sent. Changing `type` is re-validated against the '
    + 'space\'s type allowlist, so it cannot be moved somewhere `save_entity` would have refused.\n'
    + '- `tags` — MERGED into the existing tags, never replacing them.\n'
    + '- `properties` — MERGED key by key. Values must be string, number or boolean; nested objects are not '
    + 'stored.\n'
    + '- `deleteFields` — dot-notation paths to remove, permanently and with no undo. The system fields (`id`, '
    + '`name`, `type`, `spaceId`, `createdAt`, `updatedAt`) are refused. This is the ONLY way to unset '
    + 'anything.\n'
    + '- `suppressEmbeddings` — see its own description. In short: it removes the vector, so `recall` can '
    + 'no longer RANK this record by meaning, but `query`, `list`, `get` and recall\'s own `traverse` expansion '
    + 'all still reach it. An excluded entity linked to an embedded one still appears in that neighbour\'s '
    + '`_graph`.\n'
    + '- `ttlDays` — this record\'s own expiry, and the MOST specific of three tiers: it beats the type\'s '
    + 'retention window, which beats the space-wide one.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the record. Without it the '
    + 'call is refused rather than guessing which member you meant.\n\n'
    + 'RESPONSE: one line naming the entity, its type, its id and its new `seq` — the sync sequence number, '
    + 'which increments on every write and is how a peer knows this version is newer. An id that does not exist '
    + 'is an error, not a silent no-op, so a successful reply means a record really changed.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            id: {
              type: 'string', minLength: 1,
              description: 'The entity\'s `_id`, as `find_entities_by_name`, `recall` and `query` report '
                + 'it. Required, and an id that names nothing is an ERROR rather than a silent no-op.',
            },
            name: {
              type: 'string',
              description: 'Replaces the stored name. Renaming does not merge anything: edges point at the '
                + 'id, so they follow automatically, but a SECOND entity that already carries the new name '
                + 'stays a separate record — use `graph_merge` for that.',
            },
            type: {
              type: 'string',
              description: 'Replaces the stored type. It selects the per-type schema used to validate '
                + '`properties`, so changing it re-validates the record against a DIFFERENT set of rules — a '
                + 'move that was valid under the old type can be refused under the new one.',
            },
            description: {
              type: 'string',
              description: 'Replaces the stored description. Embedded alongside the name and type, so it '
                + 'widens what a `recall` can match. An omitted field is left alone, so clearing it needs '
                + '`deleteFields: ["description"]`.',
            },
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'MERGED into the stored tags, never replacing them — sending `["b"]` on an entity '
                + 'tagged `["a"]` leaves it `["a","b"]`, so no value here removes a tag. `update_fact` and '
                + '`update_chrono` REPLACE the same field. Removing one is `deleteFields`, with `tags` for '
                + 'all of them.',
            },
            properties: {
              type: 'object',
              description: 'Key-value properties to merge with existing (e.g. {"wheels": 4}). Values must be string, number, or boolean.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
            deleteFields: { type: 'array', items: { type: 'string' }, description: 'Dot-notation paths to delete from the entity (e.g. ["properties.oldKey", "description"]). System fields (id, name, type, spaceId, createdAt, updatedAt) cannot be deleted. Deletions are permanent.' },
            ttlDays: TTL_DAYS_SCHEMA,
          },
          additionalProperties: false,
          required: ['space', 'id'],
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace, name } = ctx;
    const id = String(a['id'] ?? '').trim();
    if (!id) throw new Error('id must not be empty');
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // `W-14`..`W-22`: the same table the REST door reads, so the two cannot disagree about a value. The
    // dispatcher has already run this tool's own schema; what reaches here is what the schema does not
    // declare.
    const shapeErr = shapeError('entity', a);
    if (shapeErr) throw new Error(shapeErr);
    // Validate deleteFields
    const dfResult = validateDeleteFields(a['deleteFields']);
    if (!dfResult.ok) throw new Error(dfResult.error);
    const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0 ? a['deleteFields'] as string[] : undefined;
    const updates: { name?: string; type?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; suppressEmbeddings?: boolean } = {};
    const sup = parseRecordSuppression(a);
    if (!sup.ok) throw new Error(sup.error);
    if (sup.value !== undefined) updates.suppressEmbeddings = sup.value;
    if (typeof a['name'] === 'string') updates.name = a['name'].trim();
    if (typeof a['type'] === 'string') updates.type = (a['type'] as string).trim();
    if (typeof a['description'] === 'string') updates.description = a['description'] as string;
    if (Array.isArray(a['tags'])) updates.tags = a['tags'] as string[];
    if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
      updates.properties = a['properties'] as Record<string, string | number | boolean>;
    }
    const ttlDays = ttlDaysFromArgs(a);
    if (Object.keys(updates).length === 0 && !dfPaths && ttlDays === undefined) throw new Error('At least one of name, type, description, tags, properties, suppressEmbeddings, deleteFields, or ttlDays must be provided');

    // Validate the entity AS IT WILL BE, against the meta of the member space it actually lives in. This
    // path had no schema validation at all, so `type` could be moved outside the allowlist that
    // `save_entity` enforces on the very same record.
        /*
     * The schema check moved into the writer, which validates the record it is about to store rather than a
     * rebuilt simulation of it. `assertUpdateAllowed` threw exactly the `SchemaViolationError` the writer now
     * throws, so nothing about this tool's failure shape changes — the block was pure duplication, and the
     * duplicate is the one that drifted.
     */

    const updatedEnt = await findFirstAcrossMembers(wt.target, mid => updateEntityById(mid, id, updates, dfPaths, ctx.actor, ttlDays));
    if (!updatedEnt) throw new Error(`Entity '${id}' not found`);
    return {
      content: [{ type: 'text' as const, text: `Entity '${updatedEnt.name}' (${updatedEnt.type}) updated (ID ${updatedEnt._id}, seq ${updatedEnt.seq}).` }],
    };
  },
};

/**
 * Render the endpoint-rule rows onto a merge's text output.
 *
 * One function for the preview and the result, because they are the same sentence at two moments and the
 * duplicate-edge block above is already written out twice — which is how the two came to differ in wording
 * elsewhere in this file.
 */
function appendEndpointRuleWarnings(lines: string[], warnings: readonly EndpointRuleWarning[]): void {
  if (warnings.length === 0) return;
  lines.push('Edges that will break their label\'s rule after relinking (reported, not refused):');
  for (const w of warnings) {
    lines.push(`  ⚠ edge ${w.edgeId} [${w.label}] — its ${w.end} end moves to the survivor: ${w.reason}`);
  }
  lines.push('  These are NOT refused: a merge is how a mistyped record gets fixed, so a rule declared later '
    + 'must not make duplicates unmergeable. Fix them with update_edge/delete_edge, or change the label\'s '
    + 'endpoints in the space schema.');
}

export const graph_mergeTool: ToolHandler = {
  name: 'graph_merge',
  description: 'Merge two entities into one. IRREVERSIBLE: the survivor keeps its identity and id, every reference to the absorbed entity is relinked to it, and the absorbed record is then DELETED. There is no unmerge.\n\n'
    + 'TWO-PHASE BY DESIGN, and the 409 is the feature rather than an error. Call it with an empty or partial `resolution` and you get a CONFLICT PLAN back with status 409: every property where the two disagree, with both values. Call it again with a fully resolved map and it executes. A 409 on the first call is the expected path — treat it as the question being asked, not as a failure to retry.\n\n'
    + 'RESOLVE EVERY CONFLICT OR NOTHING HAPPENS. A partial map returns the plan again rather than merging what it can, because a half-merge would leave two records that are neither separate nor one.\n\n'
    + 'Per type: numeric properties accept `fn:avg|min|max|sum`, booleans accept `fn:and|or|xor`, and strings take "survivor", "absorbed", or "custom" with `customValue` — there is no function that can combine two strings sensibly, so you have to choose. Properties that do NOT conflict are carried over without appearing in the plan.\n\n'
    + 'IT CAN LEAVE AN EDGE BREAKING ITS LABEL\'S RULE, AND IT TELLS YOU WHICH. Relinking rewrites the ends of stored edges, so merging two entities of different types can move an edge onto an end its label forbids — and that is a legitimate thing to do, because a merge is how a mistyped record gets fixed. Any such edge is listed on both the plan and the result, naming the end that moved and what the label admits. It is REPORTED, not refused: a rule declared after the data existed must not make duplicates unmergeable. Fix them afterwards with `update_edge`/`delete_edge`, or widen the label\'s endpoints in the space schema.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            survivorId: uuidSchema('UUID v4 of the entity to keep (must differ from absorbedId).'),
            absorbedId: uuidSchema('UUID v4 of the entity to absorb and delete (must differ from survivorId).'),
            resolutions: {
              type: 'array',
              description: 'Per-property conflict resolutions. Each entry: { key, resolution, customValue? }.',
              items: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description: 'The property name, exactly as the 409 conflict plan reported it. Only '
                      + 'CONFLICTING properties appear there and only those need resolving — ones the two '
                      + 'records agree on, or that only one of them has, are carried over without being '
                      + 'listed and must not be sent here.',
                  },
                  resolution: { type: 'string', pattern: '^(survivor|absorbed|custom|fn:(avg|min|max|sum|and|or|xor))$', description: 'One of: "survivor", "absorbed", "custom" (requires customValue), or "fn:<name>" where <name> is a numeric merge (avg, min, max, sum) or boolean merge (and, or, xor).' },
                  customValue: {
                    description: 'The value to store, required when `resolution` is "custom" and ignored '
                      + 'otherwise. This is the escape hatch for strings: no function can combine two of '
                      + 'them sensibly, so a string conflict is "survivor", "absorbed", or a value you '
                      + 'write yourself.',
                  },
                },
                required: ['key', 'resolution'],
                additionalProperties: false,
              },
            },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
          },
          required: ['space', 'survivorId', 'absorbedId'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const survivorId = String(a['survivorId'] ?? '').trim();
    const absorbedId = String(a['absorbedId'] ?? '').trim();
    if (!survivorId || !UUID_V4_RE.test(survivorId)) throw new Error('survivorId must be a valid UUID v4');
    if (!absorbedId || !UUID_V4_RE.test(absorbedId)) throw new Error('absorbedId must be a valid UUID v4');
    if (survivorId === absorbedId) throw new Error('Cannot merge an entity with itself');

    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);

    if (isProxySpace(callSpace)) throw new Error('Entity merge not supported on proxy spaces');

    const resolutions: PropertyResolution[] = [];
    if (Array.isArray(a['resolutions'])) {
      for (const r of a['resolutions'] as Array<Record<string, unknown>>) {
        if (typeof r?.key !== 'string' || typeof r?.resolution !== 'string') {
          throw new Error('Each resolution must have key (string) and resolution (string)');
        }
        resolutions.push({
          key: r.key,
          resolution: r.resolution,
          ...(r.customValue !== undefined ? { customValue: r.customValue } : {}),
        });
      }
    }

    const result = await computeMergePlan(wt.target, survivorId, absorbedId, resolutions);
    if ('error' in result) throw new Error(result.error);

    const { plan, fullyResolved, survivor, absorbed } = result;

    // Validate resolutions
    for (const c of plan.propertyConflicts) {
      if (!c.resolved) continue;
      const err = validateResolution(c.resolution!, c.type, c.customValue !== undefined);
      if (err) throw new Error(`Invalid resolution for '${c.key}': ${err}`);
    }

    if (!fullyResolved) {
      const lines: string[] = ['Merge plan — unresolved conflicts remain:'];
      for (const c of plan.propertyConflicts) {
        const status = c.resolved ? '✓' : '✗';
        lines.push(`  ${status} ${c.key} (${c.type}): survivor=${JSON.stringify(c.survivorValue)}, absorbed=${JSON.stringify(c.absorbedValue)}${c.suggestedFn ? ` [suggested: fn:${c.suggestedFn}]` : ''}`);
      }
      if (plan.absorbedOnlyProperties.length > 0) {
        lines.push('Absorbed-only properties (auto-added):');
        for (const p of plan.absorbedOnlyProperties) {
          lines.push(`  + ${p.key}=${JSON.stringify(p.value)}`);
        }
      }
      if (plan.duplicateEdgeWarnings.length > 0) {
        lines.push('Duplicate edge warnings:');
        for (const w of plan.duplicateEdgeWarnings) {
          lines.push(`  ⚠ (${w.from} → ${w.to} [${w.label}]) survivor edge: ${w.survivorEdgeId}, absorbed edge: ${w.absorbedEdgeId}`);
        }
      }
      appendEndpointRuleWarnings(lines, plan.endpointRuleWarnings);
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    }

    // Execute merge
    const mergedProperties = applyResolutions(
      survivor.properties ?? {},
      absorbed.properties ?? {},
      plan.propertyConflicts,
      plan.absorbedOnlyProperties,
    );

    const mergeResult = await executeMerge(wt.target, survivor, absorbed, mergedProperties, ctx.actor);
    const mergedEntity = mergeResult.entity;

    const lines: string[] = [
      `Entities merged successfully.`,
      `Survivor: ${mergedEntity._id} (${mergedEntity.name})`,
      `Absorbed: ${absorbed._id} (${absorbed.name}) — deleted`,
    ];
    if (mergeResult.deletedDuplicateEdgeIds.length > 0) {
      lines.push(`🗑 ${mergeResult.deletedDuplicateEdgeIds.length} duplicate edge(s) auto-deleted after relinking.`);
    }
    if (plan.duplicateEdgeWarnings.length > mergeResult.deletedDuplicateEdgeIds.length) {
      const remaining = plan.duplicateEdgeWarnings.length - mergeResult.deletedDuplicateEdgeIds.length;
      lines.push(`⚠ ${remaining} near-duplicate edge(s) remain (differing properties/tags) — resolve via delete_edge.`);
    }
    // On the RESULT too, not only on the preview: the merge has happened and these edges are now stored
    // breaking their label's rule. A plan with no property conflicts never produces a preview at all, so
    // reporting them there alone would mean the commonest merge says nothing.
    appendEndpointRuleWarnings(lines, plan.endpointRuleWarnings);
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
};

export const find_entities_by_nameTool: ToolHandler = {
  name: 'find_entities_by_name',
  description: 'Look up entities by their EXACT name. Case-sensitive, whole-string: "Acme" does not find '
    + '"acme", "Acme Corp" or " Acme". If you are not certain of the exact stored spelling, this is the wrong '
    + 'tool — use `recall` for meaning, or `query` with a `$regex` filter for a pattern.\n\n'
    + 'IT RETURNS A LIST, AND THE LIST IS THE POINT. Names are not unique in a space: the same name can exist '
    + 'as several entities, often with different types, and that is usually a duplicate somebody should merge '
    + 'rather than a fact about the world. Getting more than one back is the signal to look, not a result to '
    + 'index into: taking `[0]` and moving on is how the second copy survives and goes on accumulating edges. '
    + 'A token that may write will find a merge tool in `help()`; one that may not will not, because `help()` '
    + 'lists only what your token can reach.\n\n'
    + 'PREFER IT OVER FILTERING BY NAME AND TYPE TOGETHER. A name/type predicate silently misses the copy '
    + 'stored under an unexpected type, which is exactly the copy you were looking for when you asked this '
    + 'question. Look up by name, then read the types you get back.\n\n'
    + 'PARAMETERS:\n'
    + '- `name` — the exact stored name. Not trimmed for you and not case-folded.\n'
    + '- `space` — required. This tool does not search across spaces; `recall` with `space` omitted does.\n\n'
    + 'RESPONSE: every matching entity with its id, name, type, tags and properties. An empty list means no '
    + 'entity carries that exact name — it is not an error, and it does NOT mean the thing is absent from the '
    + 'space. It may be there under a different spelling, which is the case `recall` is for.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            name: {
              type: 'string', minLength: 1,
              description: 'The name to look up, matched EXACTLY and case-sensitively — no substring, no '
                + 'fuzzy, no synonym. An empty result therefore does NOT mean the entity is absent, only that '
                + 'nothing carries that exact string; `recall` is what answers "is there anything about X". '
                + 'Several results is the normal signal that duplicates exist.',
            },
          },
          required: ['space', 'name'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace, name } = ctx;
    const searchName = String(a['name'] ?? '').trim();
    if (!searchName) throw new Error('name must not be empty');
    const all = await collectAcrossMembers(callSpace, mid => findEntitiesByName(mid, searchName));
    if (all.length === 0) {
      return { content: [{ type: 'text' as const, text: `No entities found with name '${searchName}'.` }] };
    }
    return {
      content: [{
        type: 'text' as const,
        text: `Found ${all.length} entit${all.length === 1 ? 'y' : 'ies'} with name '${searchName}':\n` +
          all.map((e, i) => `[${i + 1}] ${e.name} (${e.type}) — ID ${e._id}`).join('\n'),
      }],
    };
  },
};

/**
 * Delete one entity — through the same guard the REST route uses, not a re-implementation of it.
 *
 * `entityDeleteBlockers` owns the whole decision: the `strictLinkage` check, the blocking set, the face
 * exemption, and the sentence. Both doors used to do all four themselves and answered differently — this one
 * threw prose with no structured rows, while REST claimed "inbound references" about a check that reads both
 * ends of every edge. An agent could not tell which end of which edge to clear, and a REST client was told
 * the wrong one.
 */
export const delete_entityTool: ToolHandler = {
  name: 'delete_entity',
  description: 'Delete an entity by id. IRREVERSIBLE, and it is a DELETE rather than a retire — if you want the record to stop appearing in semantic search while staying readable and traversable, set `suppressEmbeddings` on it instead.\n\n'
    + 'A REFUSAL HERE IS USUALLY CORRECT. With `strictLinkage` on, an entity is refused while an edge, memory, chrono entry or file still references it, and the refusal names each one — for an EDGE, including which of its ends this entity is, because that is the end you have to clear. Note that BOTH ends count: an edge pointing FROM this entity blocks the delete exactly as one pointing at it does, since either would be left dangling. Resolve them first, or `graph_merge` into the record that should have held them. There is no cascade.\n\n'
    + 'It writes a TOMBSTONE, so the deletion propagates to peer instances on the next sync. A space that syncs will not quietly resurrect the record from a peer, and the tombstone is why.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      id: {
        type: 'string', minLength: 1,
        description: 'The entity\'s `_id`. An id that does not exist is an ERROR, not a silent success. In '
          + 'a space with strict linkage the delete is REFUSED while anything still references this entity, '
          + 'which is the one delete tool that behaves that way. A tombstone is written, so re-creating the '
          + 'record with the same id does not undo it.',
      },
      cascadeToken: {
        type: 'string', minLength: 1,
        description: 'The `token` from `delete_entity_preview`, which turns this into a CASCADE: it '
          + 'removes the edges that block the delete, and then the entity. Refused if the list has changed '
          + 'since the preview — so a record created after you looked cannot be deleted by a decision taken '
          + 'before it existed. Nothing at the other end of those edges is touched.',
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

    for (const mid of resolveMemberSpaces(wt.target)) {
      const existing = await getEntityById(mid, id);
      if (!existing) continue;
      /*
       * `F-17`: the CASCADE, when the caller quotes back a token from `delete_entity_preview`.
       *
       * Same parameter, same refusals, same commit as the REST door — and the same function under both, so
       * neither can enforce a rule the other does not. The token binds to the SET, so a record added since
       * the preview cannot be removed by a decision taken before it existed.
       */
      const cascadeToken = a['cascadeToken'];
      if (cascadeToken !== undefined) {
        const r = await deleteEntityCascade(mid, id, cascadeToken, ctx.actor);
        if (r.ok) {
          return { content: [{ type: 'text' as const,
            text: `Entity deleted (ID ${id}), with ${r.removed.length} edge(s).` }] };
        }
        // Not pretty-printed: indentation is billed to the caller's context and read by nothing —
        // `mcp-recall-payload.test.js` refuses it, and an agent pays for every space.
        throw new Error(`${r.error}

What would go now: ${JSON.stringify(r.preview)}`);
      }
      // The SAME sentence REST answers, from the same function — see `entityDeleteBlockers`. Both doors
      // wording one rule separately is how this one ended up claiming a direction it never checked.
      const block = await entityDeleteBlockers(mid, id);
      if (block) throw new Error(block.message);
      if (await deleteEntity(mid, id, ctx.actor)) {
        return { content: [{ type: 'text' as const, text: `Entity deleted (ID ${id}).` }] };
      }
    }
    throw new Error(`Entity '${id}' not found`);
  },
};
