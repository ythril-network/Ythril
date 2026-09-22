/**
 * MCP fact CRUD tools — `saveFact`, `update_fact`, `delete_fact`.
 *
 * The cross-type retrieval tools (`recall`/`find_similar`/`query`) live in `search.ts` and the
 * cross-type batch writer (`save_bulk`) in `bulk.ts`; this file is just fact create/update/delete.
 */

import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { shapeError } from '../../brain/write-shape.js';
import { validateDeleteFields } from '../../brain/delete-fields.js';
import { findEntitiesByIds } from '../../brain/entities.js';
import { assertRefsResolve, UUID_V4_PATTERN } from '../../brain/entity-refs.js';
import { deleteFact, listFacts, saveFact, updateFact } from '../../brain/fact.js';
import { applyDeleteFields as applyDeleteFieldsPaths } from '../../brain/delete-fields.js';
// The API layer's write gate, imported rather than reimplemented: `update_chrono` once shipped without
// the allowlist `save_chrono` enforced, and two copies of a validation rule is how that happens.
import { getConfig } from '../../config/loader.js';
import { checkQuota } from '../../quota/quota.js';
import { resolveWriteTarget, findFirstAcrossMembers, isStrictLinkage } from '../../spaces/proxy.js';
import { entityDeleteBlockers } from '../../brain/entity-delete-guard.js';
import { resolveMetaRefs } from '../../spaces/schema-validation.js';
import { type UpdateValidation } from '../../brain/write-validation.js';
import { TTL_DAYS_SCHEMA, SUPPRESS_EMBEDDINGS_SCHEMA, SUPERSEDED_SCHEMA, ttlDaysFromArgs, unitScoreSchema, uuidSchema } from './shared.js';
import { mergePropertiesOrKeep } from '../../brain/merge-fields.js';
import { parseRecordSuppression } from '../../brain/suppress-embeddings.js';
import { parseRecordSuperseded } from '../../brain/record-flag.js';
import { connectionSchemas, applyConnections, desiredLinksFrom, edgeInputsFrom } from '../../brain/write-connections.js';

export const save_factTool: ToolHandler = {
  name: 'save_fact',
  description: 'Store a fact in the knowledge graph. It is embedded for semantic search, so write it as a SENTENCE that carries its own context — a fact retrieved months later arrives without the conversation it was written in, and "he agreed to the change" is unusable on its own.\n\n'
    + 'WITHOUT `id` IT IS ALWAYS AN INSERT, and nothing deduplicates by content: remembering the same fact twice stores it twice, and both then compete for the same result slots in a recall. Search before writing if a fact may already be there, and use `update_fact` when you mean to revise one.\n\n'
    + 'WITH an `id` that already names a record it CONVERGES instead of duplicating — that is the retry-safety contract, and it is why a repeated call after a timeout is safe. Convergence MERGES, the same way `save_entity` does: tags are unioned and properties shallow-merged over what is stored, so a partial payload does not erase the rest. An id that names nothing is ignored rather than adopted; identity is server-generated.\n\n'
    + 'Embedding is ASYNCHRONOUS. The write returns as soon as the record is stored and a queued job computes the vector. `recall` covers the second half of that gap for you — it always scans the newest records straight from the collection, so a record the vector index has not ingested yet is still found, with no parameter and nothing to wait for. What it cannot cover is a record whose embedding job has NOT RUN yet: the scan compares vectors, so there has to be one. `list_embed_jobs` says whether the queue is behind.\n\n'
    + 'IF THE SPACE VALIDATES, a refusal names WHOSE FAULT it is: `introduced` are violations this write caused and are what refuses it; `preExisting` were already stored, are reported, and do NOT block. Branch on `introduced`.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            id: uuidSchema('UUID v4 of an EXISTING record to update. It is not a way to choose an id: identity is server-generated, so an id that names nothing is ignored rather than adopted. To carry your own reference, use `name` or `description`.'),
            space: s.requiredSpace,
            fact: { type: 'string', minLength: 1, maxLength: 50000, description: 'The fact, observation, or fact to store (1–50 000 characters).' },
            entityIds: {
              type: 'array',
              items: { type: 'string', pattern: UUID_V4_PATTERN },
              description: 'Entity IDs (UUID v4) to link this fact to. Pass IDs, not names — look the entity up first (search_entities / list) and use its id. Every id must reference an existing entity; an unknown id is rejected rather than stored as a dead link.',
            },
            /*
             * `F-27`: the one-call write. SPREAD from the shared builder rather than written out, so a
             * fifth kind gets its field here on the day it is declared — and because this tool's schema is
             * `additionalProperties: false`, a field declared on one door and not the other is refused by
             * the dispatcher before the handler runs.
             */
            // `F-27`: the `link*` fields and `edges`, from the one builder REST reads with. The operator's
            // objection to edges on create tools — *"writing edge support into six endpoints"* — is answered
            // by there being one implementation rather than six.
            ...connectionSchemas(),
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Categorisation tags. They are part of what gets EMBEDDED, so a tag influences '
                + 'meaning-ranking as well as being a filter — and they are filterable exactly, by `filter` on '
                + '`tags` and by `recall`\'s own `filter`. On the idempotent path (an `id` naming an entry '
                + 'that already exists) they are MERGED over the stored list rather than replacing it.',
            },
            description: { type: 'string', description: 'Optional prose context or rationale for this fact.' },
            type: { type: 'string', description: 'Optional fact type (e.g. "note", "decision"). Selects the per-type schema used to validate `properties` — see the space\'s typeSchemas.fact.' },
            properties: {
              type: 'object',
              description: 'Optional structured key-value metadata (filterable via query).',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
            checkDuplicates: { type: 'boolean', default: true, description: 'Run a semantic near-duplicate check before storing (default true). When a highly similar fact already exists, the response flags it (id + summary + score) so you can update it instead of creating a redundant one. The fact is still stored regardless. Set false to skip the check.' },
            waitForEmbedding: { type: 'boolean', default: false, description: 'Block until this fact is embedded, so it is searchable the moment this returns (default false). Normally the vector is computed moments later by the embedding queue and the write does not pay the model latency. Set true when you will immediately search for what you just wrote, or when a failure to embed should fail the write rather than be repaired in the background. Note: checkDuplicates (default true) already requires the vector up front, so it implies this.' },
            checkContradictions: { type: 'boolean', default: false, description: 'Also flag existing facts that CONTRADICT this one — a near-neighbour that sets the same single-valued property to a different value (e.g. status="active" vs status="retired"). Different question from checkDuplicates: "is this redundant?" vs "does this conflict with what we already believe?". Deterministic only (no model call, no added latency). The fact is still stored regardless — if you are correcting an outdated fact, that is expected; consider updating or superseding the record named in the warning.' },
            dupeThreshold: unitScoreSchema('Cosine-similarity threshold for the duplicate check (0-1, default ~0.92). Lower to flag looser matches.'),
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            superseded: SUPERSEDED_SCHEMA,
            ttlDays: TTL_DAYS_SCHEMA,
          },
          required: ['space', 'fact'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const fact = String(a['fact'] ?? '');
    if (!fact.trim()) throw new Error('fact must not be empty');
    if (fact.length > 50_000) throw new Error('fact must not exceed 50 000 characters');
    const tags = Array.isArray(a['tags']) ? (a['tags'] as string[]) : [];
    const entityIdsArg = Array.isArray(a['entityIds']) ? (a['entityIds'] as string[]) : [];
    const description = typeof a['description'] === 'string' ? a['description'] : undefined;
    const props = (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties']))
      ? (a['properties'] as Record<string, string | number | boolean>)
      : undefined;
    // `type` selects the per-type schema. Without it, validateFact() looks up
    // `typeSchemas.fact[undefined]`, finds nothing, and returns NO violations — so the
    // strict-mode gate below could never fire and schema validation was a total no-op on
    // MCP, the surface agents actually use. REST has always accepted `type`.
    const memType = typeof a['type'] === 'string' && a['type'].trim() ? a['type'] : undefined;

    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // `W-14`..`W-22`: the same table the REST door reads, so the two cannot disagree about a value. The
    // dispatcher has already run this tool's own schema; what reaches here is what the schema does not
    // declare.
    const shapeErr = shapeError('fact', a);
    if (shapeErr) throw new Error(shapeErr);
    const ts = wt.target;

    // Schema validation (single pass — reuse for both strict gate and warn output)
    const remMetaRaw = getConfig().spaces.find(s => s.id === ts)?.meta;
    const remMeta = remMetaRaw ? resolveMetaRefs(remMetaRaw) : undefined;
    // The check runs inside `saveFact` now. This copy validated the INCOMING payload rather than the record
    // the write would produce — the defect fact's classifier was written to close, since a converging write
    // merges into a stored record whose required properties the payload need not restate.
    let remCheck: UpdateValidation | undefined;

    // Quota check — throws QuotaError (caught below) on hard limit
    const remQuota = await checkQuota('brain');

    // Entity linkage is by ID. This used to accept names and silently store the fact UNLINKED
    // when a name did not resolve — a dropped edge in a graph store, invisible until a traversal
    // that should have found it came back empty. Now: wrong shape or unknown id, the write is
    // refused and the agent is told which value was bad.
    const entityIds: string[] = entityIdsArg;
    if (isStrictLinkage(ts)) {
      await assertRefsResolve(ts, 'entityIds', 'entity', entityIds);
    }
    // Names still go into the embedded text (they are what a search actually matches on), but they
    // are now derived FROM the ids rather than being the input.
    // The entity-name lookup that used to feed the embedding is gone with it (A-3): one fewer round trip
    // per remembered fact, and the names were never part of what the record says.
    // Insert-time duplicate check defaults ON for the interactive remember tool.
    // NOTE: `checkDuplicates` defaults to TRUE on this tool, and a duplicate check needs the vector
    // before the insert — so an MCP remember still embeds inline unless the caller passes
    // `checkDuplicates: false`. The queue's latency win therefore reaches REST today and MCP only on
    // request. Whether that default should flip is a product call, not one to make inside this change.
    const remDupeCheck = a['checkDuplicates'] !== false;
    const remContraCheck = a['checkContradictions'] === true;
    const remDupeThreshold = typeof a['dupeThreshold'] === 'number' ? a['dupeThreshold'] : undefined;
    const remTtlDays = ttlDaysFromArgs(a);
    // The record tier, which no create door stated until 2026-09-02. `parseRecordSuppression` owns the
    // grammar, so a change to it reaches every create door at once rather than one at a time.
    const supCreate = parseRecordSuppression(a);
    if (!supCreate.ok) throw new Error(supCreate.error);
    const susCreate = parseRecordSuperseded(a);
    if (!susCreate.ok) throw new Error(susCreate.error);
    const mem = await saveFact(ts, fact, entityIds, tags, description, props, memType,
      {
        checkDuplicates: remDupeCheck, checkContradictions: remContraCheck, dupeThreshold: remDupeThreshold,
        ...(a['waitForEmbedding'] === true ? { waitForEmbedding: true } : {}),
        ...(supCreate.value !== undefined ? { suppressEmbeddings: supCreate.value } : {}),
        ...(susCreate.value !== undefined ? { superseded: susCreate.value } : {}),
        onValidation: c => { remCheck = c; },
      }, ctx.actor, remTtlDays,
      typeof a['id'] === 'string' ? a['id'] : undefined);

    /*
     * The links asked for in the same call, through the writer that already exists.
     *
     * A class NAMED is replaced wholesale; a class omitted is untouched. That is `reconcileLinks`'s own
     * rule, and it is the unlink semantics the report asked us to state — so `linkEntities: []` detaches
     * every entity and says nothing about the facts, and links are never add-only the way tags are.
     */
    // Links REPLACE per class, edges UPSERT. Both semantics live in `applyConnections`.
    await applyConnections(ts, mem._id, 'fact', a, mem.author, ctx.actor);
    const warnings: string[] = [];
    if (mem.similar && mem.similar.length > 0) {
      warnings.push(`⚠️ Possible duplicate — ${mem.similar.length} existing memor${mem.similar.length === 1 ? 'y is' : 'ies are'} highly similar: ${mem.similar.map(s => `"${s.summary}" (ID ${s._id}, ${s.score.toFixed(2)})`).join('; ')}. This fact was still stored; pass checkDuplicates:false to skip this check, or update the existing one instead.`);
    }
    if (mem.contradicts && mem.contradicts.length > 0) {
      // Named field + both values: the agent should be able to see WHAT disagrees, not just that
      // something does — otherwise it cannot decide whether it is correcting or mistaken.
      const detail = mem.contradicts.map(c =>
        `"${c.summary}" (ID ${c.id}: ${c.fields.map(f => `${f.key} ${f.aValue} vs ${f.bValue}`).join(', ')})`).join('; ');
      warnings.push(`⚠️ Contradiction — ${mem.contradicts.length} existing memor${mem.contradicts.length === 1 ? 'y disagrees' : 'ies disagree'} with this one: ${detail}. This fact was still stored. If you are correcting an outdated fact, update or supersede the record above instead of leaving both.`);
    }
    // (An unresolved or ambiguous reference is now a hard error above, not a warning on a write
    // that already happened.)
    // Schema warnings (reuse violations from pre-write check)
    if (remMeta?.validationMode === 'warn') {
      for (const v of (remCheck as UpdateValidation | undefined)?.all ?? []) warnings.push(`⚠️ Schema: ${v.field} — ${v.reason}`);
    }
    const remText = `Stored fact (seq ${mem.seq}, ID ${mem._id}).`
      + (remQuota.softBreached ? `\n⚠️ Storage warning: ${remQuota.warning}` : '')
      + (warnings.length > 0 ? `\n${warnings.join('\n')}` : '');
    return {
      content: [{ type: 'text' as const, text: remText }],
      structuredContent: { ...mem },
    };
  },
};

export const update_factTool: ToolHandler = {
  name: 'update_fact',
  description: 'Update one fact by its ID. Every field except `id` is optional; a field you omit is left '
    + 'exactly as it was. Changing content re-embeds the record automatically — you never queue that '
    + 'yourself.\n\n'
    + 'TAGS REPLACE HERE. THEY MERGE ON `update_entity` AND `update_edge`. Read that twice: it is one word of '
    + 'difference between three tools that otherwise take the same arguments. Sending `tags: ["b"]` on a fact '
    + 'tagged `["a"]` leaves it tagged `["b"]` — `"a"` is gone. The same call on an entity would leave it '
    + 'tagged `["a","b"]`. The difference is deliberate and pinned by a test rather than an accident waiting to '
    + 'be unified, so do not expect it to change: send the FULL tag list you want this fact to end up with. '
    + '`entityIds` replaces the same way.\n\n'
    + '`properties` MERGES, on this tool and on the other two. Keys you do not name are kept, so patching one '
    + 'key is safe. It used to replace, which silently destroyed every other property on the record; removing a '
    + 'key is `deleteFields`\' job, and an absence never means "delete".\n\n'
    + 'VALIDATION IS OF THE RESULT, and it refuses only what your edit BREAKS. The fact as it will be — your '
    + 'fields plus the stored ones — is checked against the space schema. A record that was ALREADY invalid '
    + 'before you touched it is reported and still saved, because refusing your edit would not fix a problem '
    + 'that is already stored, it would only stop you maintaining the record. Violations your change introduces '
    + 'are refused as before, in a `strict` space.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the fact\'s `_id`, as `recall` and `filter` report it. Required.\n'
    + '- `fact` — the fact\'s text, replaced when sent. Re-embeds. Must not be empty.\n'
    + '- `tags` — REPLACES the stored list. See above.\n'
    + '- `entityIds` — REPLACES the stored links. UUID v4 each, and in a space with strict linkage every one '
    + 'must resolve to an entity that exists in the member space this write lands in. Before 3.0 this path '
    + 'checked nothing and wrote any string through as a link.\n'
    + '- `description` — replaced when sent.\n'
    + '- `properties` — MERGED key by key. String, number or boolean values only.\n'
    + '- `deleteFields` — dot-notation paths to remove, permanently and with no undo. System fields are '
    + 'refused. This is the ONLY way to unset a property; applied AFTER the merge above.\n'
    + '- `suppressEmbeddings` — see its own description. In short: it removes the vector, so `recall` can '
    + 'no longer RANK this fact by meaning, but `filter`, `list`, `get` and recall\'s `traverse` expansion all '
    + 'still reach it. Excluding a record does not hide it from the graph.\n'
    + '- `ttlDays` — this record\'s own expiry, the MOST specific of three tiers: it beats the type\'s '
    + 'retention window, which beats the space-wide one.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the record.\n\n'
    + 'RESPONSE: one line with the fact\'s id and its new `seq` — the sync sequence number, which increments '
    + 'on every write and is how a peer knows this version is newer. An id that does not exist is an error, not '
    + 'a silent no-op.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            id: {
              type: 'string',
              description: 'The fact\'s `_id`, as `recall`, `filter` and the list endpoints report it. '
                + 'Required. An id that names nothing is an ERROR, not a silent no-op — so a failed update '
                + 'is something you find out about rather than something you assume worked.',
            },
            type: {
              type: 'string',
              description: 'New fact type. An empty string clears it. Omit to leave unchanged — the store '
                + 'distinguishes absent (leave alone) from empty (write empty), and so does this parameter.',
            },
            fact: {
              type: 'string',
              description: 'Replaces the stored fact. Write it as a SENTENCE carrying its own context: it is '
                + 'what gets embedded, and a fact read back months later arrives without the conversation '
                + 'it was written in. A re-embed is queued after EVERY successful update, not only when this '
                + 'field changes, so there is nothing to trigger by hand.',
            },
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'REPLACES the stored tag list — send the FULL list you want the fact to end up '
                + 'with, because sending one tag drops the rest. `update_entity` and `update_edge` MERGE tags '
                + 'instead; this tool and `update_chrono` replace, and the split is not guessable from the '
                + 'field name. To clear them, send `deleteFields: ["tags"]`.',
            },
            entityIds: { type: 'array', items: { type: 'string', pattern: UUID_V4_PATTERN }, description: 'New entity ID links (UUID v4, replaces existing). Every id must reference an existing entity.' },
            description: {
              type: 'string',
              description: 'Replaces the stored prose context. Embedded alongside the fact, so it widens what '
                + 'a `recall` can match this fact on. An omitted field is left alone, so there is no value '
                + 'that clears it — use `deleteFields: ["description"]`.',
            },
            properties: {
              type: 'object',
              description: 'Key-value properties to merge into the stored map (e.g. {"source": "manual"}) — keys you do not name are kept. Use deleteFields to remove one. Values must be string, number, or boolean.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            superseded: SUPERSEDED_SCHEMA,
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
            deleteFields: { type: 'array', items: { type: 'string' }, description: 'Dot-notation paths to delete from the fact (e.g. ["properties.oldKey", "description"]). System fields (id, name, type, spaceId, createdAt, updatedAt) cannot be deleted. Deletions are permanent.' },
            ttlDays: TTL_DAYS_SCHEMA,
            // `Q-30`: the same connection fields the CREATE tool takes, from the one builder both read —
            // a field on one verb and not the other is the gap this closes, and two hand-written copies
            // is how they would drift apart again.
            ...connectionSchemas(),
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
    const shapeErr = shapeError('fact', a);
    if (shapeErr) throw new Error(shapeErr);

    // Validate deleteFields
    const dfResult = validateDeleteFields(a['deleteFields']);
    if (!dfResult.ok) throw new Error(dfResult.error);
    const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0 ? a['deleteFields'] as string[] : undefined;

    const updates: { type?: string; fact?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean>; suppressEmbeddings?: boolean; superseded?: boolean } = {};
    const sup = parseRecordSuppression(a);
    if (!sup.ok) throw new Error(sup.error);
    if (sup.value !== undefined) updates.suppressEmbeddings = sup.value;
    const sus = parseRecordSuperseded(a);
    if (!sus.ok) throw new Error(sus.error);
    if (sus.value !== undefined) updates.superseded = sus.value;
    if (typeof a['fact'] === 'string') {
      if (!a['fact'].trim()) throw new Error('fact must not be empty');
      updates.fact = a['fact'] as string;
    }
    /*
     * `type` was declared by REST's PATCH and not by this tool, under `additionalProperties: false` — so the
     * MCP door HARD-REFUSED a parameter the REST door accepted and applied. One capability, two doors, one of
     * them offering less, which is the parity rule's central case.
     *
     * An empty string clears the type, matching REST: the store distinguishes `undefined` (leave alone) from
     * `''` (write empty), and a door that collapsed the two would make the field unclearable.
     */
    if (typeof a['type'] === 'string') {
      updates.type = (a['type'] as string).trim();
    }
    if (Array.isArray(a['tags'])) updates.tags = a['tags'] as string[];
    if (Array.isArray(a['entityIds'])) {
      const ids = a['entityIds'] as string[];
      // This path had NO validation at all — not even the strict gate the other tools carried — so
      // any string was written through as a link.
      // Validate against the resolved write target — for a proxy space that is the concrete member
      // the fact will be written to, so the entity must exist where the link will live.
      if (isStrictLinkage(wt.target)) await assertRefsResolve(wt.target, 'entityIds', 'entity', ids);
      updates.entityIds = ids;
    }
    if (typeof a['description'] === 'string') updates.description = a['description'] as string;
    if (a['properties'] !== null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
      updates.properties = a['properties'] as Record<string, string | number | boolean>;
    }

    const ttlDays = ttlDaysFromArgs(a);
    // A connection field IS a field. Both helpers return `null` for absent, never `undefined` — comparing
    // against `undefined` would be true for `null` and would DISABLE this refusal rather than widen it.
    const hasConnections = desiredLinksFrom(a) !== null || edgeInputsFrom(a) !== null;
    if (Object.keys(updates).length === 0 && !dfPaths && ttlDays === undefined && !hasConnections) throw new Error('At least one of fact, tags, entityIds, description, properties, suppressEmbeddings, deleteFields, ttlDays, or a connection field must be provided');

    // Validate the fact AS IT WILL BE, against the meta of the member space it actually lives in.
    // This path had no schema validation at all, so an agent could write through MCP a value the same
    // space refuses at `saveFact` time — and, since #571, one the REST route refuses too.
        /*
     * The schema check moved into the writer, which validates the record it is about to store rather than a
     * rebuilt simulation of it. `assertUpdateAllowed` threw exactly the `SchemaViolationError` the writer now
     * throws, so nothing about this tool's failure shape changes — the block was pure duplication, and the
     * duplicate is the one that drifted.
     */

    // Search member spaces sequentially — consistent with REST endpoint behaviour.
    const updated = await findFirstAcrossMembers(wt.target, mid => updateFact(mid, id, updates, dfPaths, ctx.actor, ttlDays));
    if (!updated) throw new Error(`Fact '${id}' not found`);
    // `Q-30`: connections on the UPDATE too. Links REPLACE per class and edges UPSERT; both semantics
    // live in `applyConnections`, after the record write, exactly as the create tool does it.
    // `updated.spaceId` rather than `wt.target`: a proxy write lands where the record actually is.
    await applyConnections(updated.spaceId, updated._id, 'fact', a, updated.author, ctx.actor);
    return {
      content: [{ type: 'text' as const, text: `Fact updated (ID ${updated._id}, seq ${updated.seq}).` }],
      structuredContent: { ...updated },
    };
  },
};

export const delete_factTool: ToolHandler = {
  name: 'delete_fact',
  description: 'Delete one fact by its ID. IRREVERSIBLE — there is no undelete and no trash.\n\n'
    + 'IF YOU WANT IT OUT OF SEARCH RATHER THAN GONE, this is the wrong tool. Set '
    + '`suppressEmbeddings` with `update_fact` instead: the record stays readable, listable and '
    + 'traversable, and only stops being ranked by meaning. Deleting is for records that should not exist.\n\n'
    + 'IT IS REFUSED IF SOMETHING STILL POINTS AT IT, in a space with strict linkage on. A chrono entry '
    + 'listing this fact in `memoryIds`, or a file listing it, blocks the delete and the error names what '
    + 'is referring to it. Clear those first.\n\n'
    + 'THIS CHANGED IN 4.0 AND A RUNNING SCRIPT CAN HIT IT. Until then the same delete always succeeded, '
    + 'because those two link fields had no reader anywhere in the server — the reference was stored and '
    + 'replicated and nothing could see it, so the referring record was quietly left pointing at a fact '
    + 'that no longer existed. With strict linkage OFF the delete still always succeeds.\n\n'
    + 'A TOMBSTONE IS WRITTEN, so the deletion propagates to peer instances on the next sync and the record '
    + 'is not quietly resurrected from a peer that still has it. That is also why this cannot be undone by '
    + 'writing the record back with the same id — the tombstone outranks it.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the fact\'s `_id`. Required. An id that does not exist is an ERROR, not a silent success, '
    + 'so a successful reply means a record really was deleted.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the fact. Without it '
    + 'the call is refused rather than guessing which member you meant.\n\n'
    + 'RESPONSE: one line confirming the id that was deleted.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            id: {
              type: 'string', minLength: 1,
              description: 'The fact\'s `_id`, as `recall` and `filter` report it. An id that does not exist '
                + 'is an ERROR, not a silent success, so a successful reply means a record really was '
                + 'deleted. A tombstone is written under this id, which is why re-creating the record with '
                + 'it does not undo the delete.',
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

    /*
     * `M-2`: what points at this record can be SEEN now, so under strict linkage it can also block.
     *
     * The SAME guard the REST door uses, which is the point: this tool and that route each used to word
     * their own refusal for entities and said different things. The sentence and the rows come from
     * `entityDeleteBlockers`; a door decides only how to report them.
     */
    const block = await findFirstAcrossMembers(wt.target, mid => entityDeleteBlockers(mid, id, 'fact'));
    if (block) throw new Error(block.message);
    const deleted = await findFirstAcrossMembers(wt.target, mid => deleteFact(mid, id, ctx.actor));
    if (!deleted) throw new Error(`Fact '${id}' not found`);
    return {
      content: [{ type: 'text' as const, text: `Fact deleted (ID ${id}).` }],
      structuredContent: { _id: id, deleted: true },
    };
  },
};
