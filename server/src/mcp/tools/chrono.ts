import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { shapeError } from '../../brain/write-shape.js';
import { CHRONO_STATUSES } from '../../config/types.js';
import { usesLinkRecords } from '../../brain/link-adjacency.js';
import { arrayWriteError } from '../../brain/array-write-refusal.js';
import { UUID_V4_RE, TTL_DAYS_SCHEMA, SUPPRESS_EMBEDDINGS_SCHEMA, ttlDaysFromArgs, recurrenceSchema, unitScoreSchema, uuidSchema } from './shared.js';
import { ChronoFilter, createChrono, deleteChrono, getChronoById, listChrono, updateChrono, parseRecurrence } from '../../brain/chrono.js';
// The API layer's write gate, imported rather than reimplemented — see the note in memory.ts.
import { SchemaViolationError, type UpdateValidation } from '../../brain/write-validation.js';

/**
 * What a passed due moment means — ONE sentence, quoted everywhere that used to state it.
 *
 * It was stated five times across three schemas, each spelling out the MECHANISM ("it is derived on read
 * from the due moment"). `F-26` made that mechanism conditional on the type, and five independent sentences
 * are five chances for one of them to go on describing the old behaviour — the exact failure `CLAUDE.md`
 * records about `recall`'s `filter`, where a caller read a stale schema description, believed it, and built
 * around a capability they had been told they did not have.
 *
 * So this states the PROMISE rather than the machinery: what the value means, and what decides it.
 */
const WHAT_A_PASSED_DATE_MEANS =
  'WHAT A PASSED DUE MOMENT MEANS IS THE TYPE\'S TO DECIDE, and by default it means late. With no setting, '
  + 'an entry stored `upcoming` or `active` whose due moment has passed reads back as `overdue` from '
  + '`list_chrono`, `recall` and a single-entry get — so you never need to set `overdue` yourself. A space '
  + 'or a chrono type that sets `whenDuePasses: "nothing"` turns that off for its records, and the STORED '
  + 'status is then what you get back: for entries recording something that HAPPENED — a deploy, a backup '
  + 'run, an alert episode — a past date is the normal condition and does not mean late. `query` and sync '
  + 'always see the stored value, whatever the setting.';
import { getConfig } from '../../config/loader.js';
import { checkQuota } from '../../quota/quota.js';
import { isStrictLinkage, resolveMemberSpaces, resolveWriteTarget, findFirstAcrossMembers } from '../../spaces/proxy.js';
import { entityDeleteBlockers } from '../../brain/entity-delete-guard.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { getAllowedChronoTypes, resolveMetaRefs, validateChrono } from '../../spaces/schema-validation.js';
import { mergePropertiesOrKeep } from '../../brain/merge-fields.js';
import { validateDeleteFields } from '../../brain/delete-fields.js';
import { parseRecordSuppression } from '../../brain/suppress-embeddings.js';
import { connectionSchemas, applyConnections } from '../../brain/write-connections.js';

export const save_chronoTool: ToolHandler = {
  name: 'save_chrono',
  description: 'Create a chronological entry — something that happened, or is meant to. Default types are event, deadline, plan, prediction and milestone; a space with its own `typeSchemas.chrono` accepts ITS names INSTEAD, not in addition, so a custom schema that omits `event` refuses `event`.\n\n'
    + 'THIS IS THE RECORD FOR ANYTHING DATED, and the reason the distinction matters: a memory saying "the migration is planned for March" is a fact whose truth expires, while a chrono entry carries `startsAt`/`endsAt` and a `status`, so it can be listed by date, found by `list_chrono` in a window, and closed rather than contradicted. If it has a date, it belongs here.\n\n'
    + 'Link it with `entityIds` — that is what lets `traverse` reach it from the entity it is about (with `includeChrono`, on by default). Those references are NOT edges, so a chrono entry left unlinked is reachable only by search or by date, never from the thing it concerns.\n\n'
    + 'Always an INSERT; use `update_chrono` to change one, including to move its `status`. IF THE SPACE VALIDATES: `introduced` are violations this write caused and are what refuses it; `preExisting` were already stored, are reported, and do NOT block. Branch on `introduced`.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            // `F-27`: the `link*` fields and `edges`, from the one builder REST reads with — so a field
            // on one door and not the other cannot happen, which is how `traverse`'s link flags shipped
            // refused by the dispatcher while REST answered 200.
            ...connectionSchemas(),
            space: s.requiredSpace,
            id: uuidSchema('UUID v4 of an EXISTING record to update. It is not a way to choose an id: identity is server-generated, so an id that names nothing is ignored rather than adopted. To carry your own reference, use `name` or `description`.'),
            title: {
              type: 'string', minLength: 1,
              description: 'What happened, or is meant to. Required, and it is EMBEDDED — so this is what a '
                + '`recall` ranks the entry on, and a title like "meeting" is one nothing will ever find. '
                + 'Nothing deduplicates by it: creating the same title twice stores two entries.',
            },
            type: { type: 'string', minLength: 1, description: 'Entry type. Rejected unless it is one of the space\'s allowed chrono types: the defaults are event, deadline, plan, prediction, milestone, or the custom set declared in the space\'s typeSchemas.chrono.' },
            startsAt: {
              type: 'string', minLength: 1,
              description: 'ISO 8601 date/time the entry is ABOUT — not when you recorded it, which is '
                + '`createdAt` and is what `list_chrono`\'s `after`/`before` filter on. Required. With no '
                + '`endsAt` this is also the DUE MOMENT, so on a type that derives, a past `startsAt` on an '
                + '`upcoming` entry makes it read back as `overdue` straight away.',
            },
            endsAt: {
              type: 'string',
              description: 'Optional ISO 8601 end. When present it REPLACES `startsAt` as the due moment, so '
                + 'an entry that started last month and ends next year is not overdue. NOTHING VALIDATES THE '
                + 'ORDER — an `endsAt` before `startsAt` is stored as sent, and the entry then reads as '
                + '`overdue` immediately.',
            },
            status: {
              type: 'string', enum: [...CHRONO_STATUSES], default: 'upcoming',
              description: 'Stored status (default `upcoming`). ' + WHAT_A_PASSED_DATE_MEANS
                + ' Storing `overdue` by hand is accepted and findable, but it is a value that never '
                + 'reverts: it stays overdue after you move the dates forward, where a derived one would '
                + 'correct itself.',
            },
            confidence: unitScoreSchema('How sure you are, 0 to 1, for entries that are predictions rather '
              + 'than records. Nothing derives it, nothing ranks on it and nothing requires it — it is stored '
              + 'and returned, and `query` can sort and filter on it.'),
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'Categorisation tags. EMBEDDED along with the title, so a tag affects meaning '
                + 'ranking as well as being an exact filter for `list_chrono` and `query`.',
            },
            entityIds: {
              type: 'array', items: { type: 'string' },
              description: 'Entity IDs this entry is about. THIS IS WHAT MAKES IT REACHABLE from the graph: '
                + '`traverse` follows these (with `includeChrono`, on by default), and they are NOT edges, so '
                + 'an entry left unlinked is findable only by search or by date. Pass ids, not names.',
            },
            memoryIds: {
              type: 'array', items: { type: 'string' },
              description: 'Memory IDs this entry relates to. References rather than edges, like '
                + '`entityIds`; deleting a memory leaves the id here and nothing reports it.',
            },
            description: {
              type: 'string',
              description: 'Optional longer prose. Embedded with the title, so it widens what a `recall` can '
                + 'match this entry on — worth filling in when the title has to stay short.',
            },
            properties: {
              type: 'object',
              description: 'Optional structured key-value metadata for this entry.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            recurrence: recurrenceSchema('Optional recurrence rule,'),
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
            checkDuplicates: { type: 'boolean', default: true, description: 'Run a semantic near-duplicate check before storing (default true). When a highly similar entry already exists, the response flags it (id + summary + score) so you can update it instead of logging the same event twice. The entry is still stored regardless. Set false to skip.' },
            checkContradictions: { type: 'boolean', default: false, description: 'Also flag existing entries that CONTRADICT this one — a near-neighbour claiming a different status, or setting the same single-valued property to a different value. Deterministic only (no model call). The entry is still stored regardless.' },
            dupeThreshold: unitScoreSchema('Cosine-similarity threshold for the duplicate check (0-1, default ~0.92). Lower to flag looser matches.'),
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            ttlDays: TTL_DAYS_SCHEMA,
          },
          required: ['space', 'title', 'type', 'startsAt'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const title = String(a['title'] ?? '').trim();
    const chronoType = String(a['type'] ?? '') as import('../../config/types.js').ChronoType;
    const startsAt = String(a['startsAt'] ?? '');
    if (!title) throw new Error('title must not be empty');
    if (!startsAt) throw new Error('startsAt must not be empty');

    const chronoProps = (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties']))
      ? (a['properties'] as Record<string, string | number | boolean>)
      : undefined;

    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // `W-14`..`W-22`: the same table the REST door reads, so the two cannot disagree about a value. The
    // dispatcher has already run this tool's own schema; what reaches here is what the schema does not
    // declare.
    const shapeErr = shapeError('chrono', a);
    if (shapeErr) throw new Error(shapeErr);
    // `M-2`: on a converted space the six arrays are no longer a write surface — see `arrayWriteError`.
    // Against the WRITE TARGET, because a proxy holds no records of its own and its marker would answer
    // for a space it never writes to.
    const linkArrErr = arrayWriteError({ converted: usesLinkRecords(wt.target), spaceId: wt.target, body: a, actor: ctx.actor });
    if (linkArrErr) throw new Error(linkArrErr);

    // Schema validation (single pass)
    // Validate type against the space-specific allowlist (custom or default built-ins).
    const { meta: chronoMeta, allowed: allowedChronoTypes } = chronoTypeGate(wt.target);
    if (!allowedChronoTypes.has(chronoType)) {
      throw new Error(`type must be one of: ${[...allowedChronoTypes].join(', ')}`);
    }

    // Validated against the record this write will PRODUCE, not against the payload — see
    // `classifyChronoUpsert`. A supplied id that already names an entry converges and MERGES its properties,
    // so the payload alone is not the document being stored, and checking it refused legitimate converges
    // while letting an already-violating stored key through untouched.
    const chronoSuppliedId = typeof a['id'] === 'string' ? a['id'] : undefined;
    // The check runs inside `createChrono` now — three copies of it existed for create alone.
    let chronoCheck: UpdateValidation | undefined;

    const remQuota = await checkQuota('brain');

    // Validate entityIds and memoryIds are UUIDs (when strictLinkage is on)
    const chronoEntityIds = Array.isArray(a['entityIds']) ? (a['entityIds'] as string[]) : undefined;
    const chronoMemoryIds = Array.isArray(a['memoryIds']) ? (a['memoryIds'] as string[]) : undefined;
    if (isStrictLinkage(wt.target)) {
      if (chronoEntityIds) {
        const invalidEIds = chronoEntityIds.filter(id => !UUID_V4_RE.test(id));
        if (invalidEIds.length > 0) throw new Error(`entityIds must contain valid UUID v4 values (entity IDs), not names: ${invalidEIds.join(', ')}`);
      }
      if (chronoMemoryIds) {
        const invalidMIds = chronoMemoryIds.filter(id => !UUID_V4_RE.test(id));
        if (invalidMIds.length > 0) throw new Error(`memoryIds must contain valid UUID v4 values (memory IDs), not names: ${invalidMIds.join(', ')}`);
      }
    }

    const rec = parseRecurrence(a['recurrence']);
    if (!rec.ok) throw new Error(rec.error);

    let entry;
    try {
      const chronoSuppress = parseRecordSuppression(a);
      if (!chronoSuppress.ok) throw new Error(chronoSuppress.error);
      entry = await createChrono(wt.target, {
      id: chronoSuppliedId,
      title,
      type: chronoType,
      startsAt,
      description: typeof a['description'] === 'string' ? a['description'] : undefined,
      endsAt: typeof a['endsAt'] === 'string' ? a['endsAt'] : undefined,
      status: typeof a['status'] === 'string' ? a['status'] as import('../../config/types.js').ChronoStatus : undefined,
      confidence: typeof a['confidence'] === 'number' ? a['confidence'] : undefined,
      tags: Array.isArray(a['tags']) ? (a['tags'] as string[]) : undefined,
      entityIds: chronoEntityIds,
      memoryIds: chronoMemoryIds,
      properties: chronoProps,
      ...(rec.value ? { recurrence: rec.value } : {}),
    }, ctx.actor, ttlDaysFromArgs(a), {
      // The record tier, which no create door stated until 2026-09-02. `parseRecordSuppression` owns the
      // grammar, so a change to it reaches every create door at once rather than one at a time.
      ...(chronoSuppress.value !== undefined ? { suppressEmbeddings: chronoSuppress.value } : {}),
      // Duplicate check defaults ON for the interactive create tool, as it does for remember/upsert_entity.
      checkDuplicates: a['checkDuplicates'] !== false,
      checkContradictions: a['checkContradictions'] === true,
      dupeThreshold: typeof a['dupeThreshold'] === 'number' ? a['dupeThreshold'] : undefined,
        onValidation: c => { chronoCheck = c; },
      });
    } catch (err) {
      if (err instanceof SchemaViolationError) {
        // The violations travel as structured data rather than a JSON tail glued to the sentence: a caller
        // had to parse the message to act on them. The prose is unchanged for a client that reads only the
        // content blocks.
        return {
          content: [{ type: 'text' as const, text: 'Error: schema_violation' }],
          isError: true,
          structuredContent: err.toStructured(),
        };
      }
      throw err;
    }
    // Links REPLACE per class, edges UPSERT. Both semantics live in `applyConnections`, after the record
    // exists — a relationship needs both ends, and the `from` is what was just minted.
    await applyConnections(wt.target, entry._id, 'chrono', a, entry.author, ctx.actor);

    let text = `Chrono entry '${entry.title}' (${entry.type}) created (ID ${entry._id}, seq ${entry.seq}).`
      + (remQuota.softBreached ? `\n⚠️ Storage warning: ${remQuota.warning}` : '');
    if (entry.similar && entry.similar.length > 0) {
      text += `\n⚠️ Possible duplicate — ${entry.similar.length} existing entr${entry.similar.length === 1 ? 'y is' : 'ies are'} highly similar: ${entry.similar.map(s => `"${s.summary}" (ID ${s._id}, ${s.score.toFixed(2)})`).join('; ')}. This entry was still stored; pass checkDuplicates:false to skip this check, or update the existing one instead.`;
    }
    if (entry.contradicts && entry.contradicts.length > 0) {
      // Named field + both values: the agent should be able to see WHAT disagrees, not just that
      // something does — otherwise it cannot decide whether it is correcting or mistaken.
      const detail = entry.contradicts.map(c =>
        `"${c.summary}" (ID ${c.id}: ${c.fields.map(f => `${f.key} ${f.aValue} vs ${f.bValue}`).join(', ')})`).join('; ');
      text += `\n⚠️ Contradiction — ${entry.contradicts.length} existing entr${entry.contradicts.length === 1 ? 'y disagrees' : 'ies disagree'} with this one: ${detail}. This entry was still stored. If you are correcting an outdated entry, update or supersede the record above instead of leaving both.`;
    }
    if (chronoMeta?.validationMode === 'warn') {
      // From the classification the writer handed back, not re-derived — a second call would be a second
      // lookup per write and the second copy of the rule.
      for (const v of (chronoCheck as UpdateValidation | undefined)?.all ?? []) text += `\n⚠️ Schema: ${v.field} — ${v.reason}`;
    }
    return { content: [{ type: 'text' as const, text }] };
  },
};

/**
 * The space's resolved meta, and the chrono types it allows.
 *
 * Extracted because create and update MUST agree: `update_chrono` shipped without the allowlist check
 * `save_chrono` has, so a record could be moved to a disallowed type through the door that did not
 * check. One helper, called by both, is what stops that recurring — two copies of a validation rule is
 * how they diverged in the first place.
 */
function chronoTypeGate(spaceId: string): { meta: ReturnType<typeof resolveMetaRefs> | undefined; allowed: Set<string> } {
  const raw = getConfig().spaces.find(s => s.id === spaceId)?.meta;
  const meta = raw ? resolveMetaRefs(raw) : undefined;
  return { meta, allowed: getAllowedChronoTypes(meta) };
}

export const update_chronoTool: ToolHandler = {
  name: 'update_chrono',
  description: 'Update one chrono entry by its ID. Every field except `id` is optional; a field you omit is '
    + 'left exactly as it was.\n\n'
    + 'ONE FIELD MERGES AND THE REST REPLACE, and the split is not guessable. `properties` MERGES key by key, '
    + 'so patching one key keeps the others. `tags`, `entityIds` and `memoryIds` REPLACE — send the FULL list '
    + 'you want the entry to end up with, because sending one id drops the rest. (`update_entity` and '
    + '`update_edge` merge tags instead; `update_fact` replaces them, like this tool.)\n\n'
    + 'REMOVING SOMETHING IS `deleteFields`, NEVER AN OMISSION. An absent field means "leave it alone", so '
    + 'there is no value you can send that clears one — send its dot path in `deleteFields` instead, which is '
    + 'applied AFTER the merge above and is permanent. A path that cannot be honoured is REFUSED by name '
    + 'rather than ignored: the required fields (`title`, `startsAt`, `status`) and the server-owned ones are '
    + 'named back to you, so a delete that does nothing is not something this tool can do quietly.\n\n'
    + 'A RE-EMBED IS ALWAYS QUEUED after a successful write, whether or not you changed anything embeddable. '
    + 'The worker reads the record as STORED, so it cannot embed a stale version — deciding here would mean '
    + 'deciding from this function\'s own read, which is what made the older inline embedding wrong.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the entry\'s `_id`, as `list_chrono` and `query` report it. Required.\n'
    + '- `title` — replaced when sent.\n'
    + '- `type` — `event`, `deadline`, `plan`, `prediction`, `milestone`, or any custom type the space schema '
    + 'defines. Re-validated against the allowlist.\n'
    + '- `startsAt` / `endsAt` — ISO 8601. NOTHING VALIDATES THE ORDER: an `endsAt` before `startsAt` is '
    + 'stored as sent, and because `endsAt` becomes the due moment the entry then reads as `overdue` at '
    + 'once. Check it yourself if it matters.\n'
    + '- `status` — `upcoming`, `active`, `completed`, `overdue`, `cancelled`. What you set here is the '
    + 'STORED value. ' + WHAT_A_PASSED_DATE_MEANS + '\n'
    + '- `confidence` — 0 to 1, for entries that are predictions rather than records.\n'
    + '- `tags` / `entityIds` / `memoryIds` — each REPLACES the stored list.\n'
    + '- `description` — replaced when sent.\n'
    + '- `properties` — MERGED key by key. String, number or boolean values only. Use `deleteFields` with '
    + '`properties.<key>` to remove one.\n'
    + '- `deleteFields` — dot-notation paths to remove, permanently and with no undo. Applied after the merge. '
    + 'The only way to unset anything.\n'
    + '- `recurrence` — the repeat rule, replaced wholesale when sent. It describes the entry; it does not '
    + 'generate further entries.\n'
    + '- `suppressEmbeddings` — removes the vector, so `recall` can no longer RANK this entry by meaning. '
    + '`list_chrono`, `query`, `get` and recall\'s `traverse` expansion all still reach it — excluding an entry '
    + 'never hides it from the graph or from a time-ordered listing.\n'
    + '- `ttlDays` — this entry\'s own expiry, the MOST specific of three tiers: it beats the type\'s retention '
    + 'window, which beats the space-wide one.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the entry.\n\n'
    + 'RESPONSE: one line with the entry\'s id and its new `seq` — the sync sequence number, which increments '
    + 'on every write and is how a peer knows this version is newer. An id that does not exist is an error, not '
    + 'a silent no-op.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            id: {
              type: 'string', minLength: 1,
              description: 'The entry\'s `_id`, as `list_chrono`, `recall` and `query` report it. '
                + 'Required, and an id that names nothing is an ERROR rather than a silent no-op.',
            },
            title: {
              type: 'string',
              description: 'Replaces the stored title. It is embedded, so changing it changes what a `recall` '
                + 'matches this entry on. It is also a REQUIRED field, which is why `deleteFields: ["title"]` '
                + 'is refused by name rather than accepted and ignored.',
            },
            type: { type: 'string', description: 'Entry type (e.g. event, deadline, plan, prediction, milestone, or a custom type defined in the space schema).' },
            startsAt: {
              type: 'string',
              description: 'Replaces the stored ISO 8601 start. With no `endsAt` it is the DUE MOMENT, so '
                + 'moving it forward is what un-overdues an entry that has gone late — the status is derived '
                + 'from this, not stored.\n\n'
                + 'AND A FILTER ON `status: overdue` RETURNS BOTH KINDS: entries the clock made overdue, and '
                + 'entries somebody STORED as overdue. `overdue` is a legal value to write, so the two are '
                + 'mixed in any result. A caller who read only "derived from the clock" would not expect the '
                + 'second kind, and would treat a marked entry as a clock artefact it could fix by moving the '
                + 'date. This note lived on `list_chrono` until 5.0 folded that tool into `filter`, which is '
                + 'generic and has no business describing chrono semantics.',
            },
            endsAt: {
              type: 'string',
              description: 'Replaces the stored ISO 8601 end, and takes over from `startsAt` as the due '
                + 'moment. NOTHING VALIDATES THE ORDER — an `endsAt` before `startsAt` is stored as sent and '
                + 'makes the entry read as `overdue` at once. Clearing it needs `deleteFields: ["endsAt"]`.',
            },
            status: {
              type: 'string', enum: [...CHRONO_STATUSES],
              description: 'The new STORED status. ' + WHAT_A_PASSED_DATE_MEANS
                + ' Setting `completed` or `cancelled` stops an entry being derived-overdue at all, whatever '
                + 'the type says.',
            },
            confidence: unitScoreSchema('Confidence level 0 to 1, for entries that are predictions rather '
              + 'than records. Replaced when sent; nothing derives it, and nothing refuses a prediction that '
              + 'omits it.'),
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'REPLACES the stored tag list — send the FULL list you want the entry to end up '
                + 'with, because sending one tag drops the rest. `update_entity` and `update_edge` MERGE tags '
                + 'instead; this tool and `update_fact` replace, and the split is not guessable from the '
                + 'field name.',
            },
            entityIds: {
              type: 'array', items: { type: 'string' },
              description: 'REPLACES the stored entity links — send the FULL list, because sending one id '
                + 'drops the rest. These are what let `traverse` reach the entry from the entity it concerns; '
                + 'they are NOT edges, so an entry left with an empty list is reachable only by search or by '
                + 'date.',
            },
            memoryIds: {
              type: 'array', items: { type: 'string' },
              description: 'REPLACES the stored memory links — send the FULL list, because sending one id '
                + 'drops the rest.',
            },
            description: {
              type: 'string',
              description: 'New prose description. Replaced when sent; an omitted field is left alone, so '
                + 'there is no value that clears it — use `deleteFields: ["description"]`.',
            },
            properties: {
              type: 'object',
              description: 'Key-value properties to merge into the stored map — keys you do not name are kept.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            recurrence: recurrenceSchema('The repeat rule, replaced wholesale when sent,'),
            suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA,
            deleteFields: {
              type: 'array', items: { type: 'string' },
              description: 'Dot-notation paths to REMOVE from the entry, applied after the merge above — the '
                + 'only way to unset anything, since an absent field means "leave alone" and `properties` '
                + 'merge. E.g. `["properties.oldKey", "description"]`. Permanent, with no undo. The required '
                + 'fields (`title`, `startsAt`, `status`) and the server-owned ones (`id`, `type`, `spaceId`, '
                + '`createdAt`, `updatedAt`) are REFUSED by name rather than ignored, so a path that cannot be '
                + 'honoured tells you instead of silently doing nothing.',
            },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
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
    const shapeErr = shapeError('chrono', a);
    if (shapeErr) throw new Error(shapeErr);
    // `M-2`: on a converted space the six arrays are no longer a write surface — see `arrayWriteError`.
    // Against the WRITE TARGET, because a proxy holds no records of its own and its marker would answer
    // for a space it never writes to.
    const linkArrErr = arrayWriteError({ converted: usesLinkRecords(wt.target), spaceId: wt.target, body: a, actor: ctx.actor });
    if (linkArrErr) throw new Error(linkArrErr);

    const updates: Record<string, unknown> = {};
    const sup = parseRecordSuppression(a);
    if (!sup.ok) throw new Error(sup.error);
    if (sup.value !== undefined) updates['suppressEmbeddings'] = sup.value;
    if (typeof a['title'] === 'string') updates['title'] = a['title'];
    if (typeof a['type'] === 'string') {
      // Same allowlist check `save_chrono` runs, and the same one the REST PATCH already runs.
      // Without it this was the ONE surface of four that let a record be moved to a type the space
      // does not allow — and an asymmetry between two write paths is worse than either rule alone,
      // because the constraint looks enforced right up until someone uses the other door.
      const { allowed } = chronoTypeGate(wt.target);
      if (!allowed.has(a['type'] as string)) {
        throw new Error(`type must be one of: ${[...allowed].join(', ')}`);
      }
      updates['type'] = a['type'];
    }
    if (typeof a['startsAt'] === 'string') updates['startsAt'] = a['startsAt'];
    if (typeof a['endsAt'] === 'string') updates['endsAt'] = a['endsAt'];
    if (typeof a['status'] === 'string') updates['status'] = a['status'];
    if (typeof a['confidence'] === 'number') updates['confidence'] = a['confidence'];
    if (typeof a['description'] === 'string') updates['description'] = a['description'];
    if (Array.isArray(a['tags'])) updates['tags'] = a['tags'];
    if (Array.isArray(a['entityIds'])) {
      const eIds = a['entityIds'] as string[];
      if (isStrictLinkage(wt.target)) {
        const invalidEIds = eIds.filter(id => !UUID_V4_RE.test(id));
        if (invalidEIds.length > 0) throw new Error(`entityIds must contain valid UUID v4 values (entity IDs), not names: ${invalidEIds.join(', ')}`);
      }
      updates['entityIds'] = eIds;
    }
    if (Array.isArray(a['memoryIds'])) {
      const mIds = a['memoryIds'] as string[];
      if (isStrictLinkage(wt.target)) {
        const invalidMIds = mIds.filter(id => !UUID_V4_RE.test(id));
        if (invalidMIds.length > 0) throw new Error(`memoryIds must contain valid UUID v4 values (memory IDs), not names: ${invalidMIds.join(', ')}`);
      }
      updates['memoryIds'] = mIds;
    }
    if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
      updates['properties'] = a['properties'];
    }
    if (a['recurrence'] !== undefined) {
      const rec = parseRecurrence(a['recurrence']);
      if (!rec.ok) throw new Error(rec.error);
      updates['recurrence'] = rec.value;
    }

    // The three sibling update tools refuse a call that names no field; this one accepted it and answered
    // "updated (seq N)" for a write that changed nothing but the seq. Same asymmetry as the REST handler
    // this mirrors, and the same fix — an agent cannot tell a dropped argument from an applied one otherwise.
    // X-4: `deleteFields`, validated with the same helper and the same refusals as the REST route and the
    // three sibling tools. Chrono was the one record type without it, and since its `properties` merge, a key
    // written once could not be removed by any call at all.
    const dfResult = validateDeleteFields(a['deleteFields']);
    if (!dfResult.ok) throw new Error(dfResult.error);
    const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0
      ? a['deleteFields'] as string[]
      : undefined;

    if (Object.keys(updates).length === 0 && ttlDaysFromArgs(a) === undefined && !dfPaths) {
      throw new Error('At least one of title, type, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence, suppressEmbeddings, deleteFields, or ttlDays must be provided');
    }

    // Validate the entry AS IT WILL BE, against the meta of the member space it actually lives in. The
    // type allowlist above is not the whole schema: property constraints applied at `save_chrono` and
    // nowhere on this path, so an agent could write a value the same space refuses on creation.
        /*
     * The schema check moved into the writer, which validates the record it is about to store rather than a
     * rebuilt simulation of it. `assertUpdateAllowed` threw exactly the `SchemaViolationError` the writer now
     * throws, so nothing about this tool's failure shape changes — the block was pure duplication, and the
     * duplicate is the one that drifted.
     */

    const entry = await updateChrono(wt.target, id, updates as Parameters<typeof updateChrono>[2], dfPaths, ctx.actor, ttlDaysFromArgs(a));
    if (!entry) throw new Error(`Chrono entry '${id}' not found`);
    return { content: [{ type: 'text' as const, text: `Chrono entry '${entry.title}' updated (seq ${entry.seq}).` }] };
  },
};

/** Delete one chrono entry. Mirrors `DELETE /api/brain/spaces/:spaceId/chrono/:id`. */
export const delete_chronoTool: ToolHandler = {
  name: 'delete_chrono',
  description: 'Delete one chrono entry by its ID. IRREVERSIBLE — there is no undelete and no trash.\n\n'
    + 'A PAST OR CANCELLED ENTRY IS USUALLY NOT A DELETE. An entry whose moment has passed reads back as '
    + '`overdue` — derived from the clock — which is the system telling you it is unresolved, not that it is '
    + 'rubbish. Set `status: "completed"` or `"cancelled"` with `update_chrono` and the entry stops being '
    + 'derived-overdue while staying as the record that it happened. Deleting is for '
    + 'entries that should never have existed. If you only want it out of meaning-ranking, set '
    + '`suppressEmbeddings` — it stays listable by `list_chrono` and reachable by traversal.\n\n'
    + 'THE ENTITIES AND MEMORIES IT LINKS ARE NOT TOUCHED. `entityIds` and `memoryIds` are references; '
    + 'deleting the entry drops the references and leaves every referenced record in place.\n\n'
    + 'IT IS REFUSED IF SOMETHING STILL POINTS AT IT, in a space with strict linkage on — a file listing '
    + 'this entry in `chronoIds` blocks the delete, and the error names it.\n\n'
    + 'THIS CHANGED IN 4.0 AND A RUNNING SCRIPT CAN HIT IT. Until then the delete always succeeded, because '
    + '`file.chronoIds` had no reader anywhere in the server. With strict linkage OFF it still does.\n\n'
    + 'A RECURRENCE RULE DOES NOT SPREAD THE DELETE, because it never created anything to delete. '
    + '`recurrence` describes one entry as repeating; it does not generate further entries, so there is no '
    + 'series here and no "this and all future occurrences" to choose between.\n\n'
    + 'A TOMBSTONE IS WRITTEN, so the deletion propagates to peer instances on the next sync and the entry is '
    + 'not quietly resurrected from a peer that still has it. That is also why re-creating it with the same '
    + 'id does not undo this — the tombstone outranks it.\n\n'
    + 'PARAMETERS:\n'
    + '- `id` — the entry\'s `_id`, as `list_chrono` and `query` report it. Required. An id that does not '
    + 'exist is an ERROR, not a silent success.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the entry.\n\n'
    + 'RESPONSE: one line confirming the id that was deleted.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      id: {
        type: 'string', minLength: 1,
        description: 'The entry\'s `_id`. An id that does not exist is an ERROR, not a silent success. '
          + 'The entities and memories it links are NOT touched — those are references, and deleting the '
          + 'entry only drops them. A tombstone is written, so re-creating it with the same id does not '
          + 'undo this.',
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
    const block = await findFirstAcrossMembers(wt.target, mid => entityDeleteBlockers(mid, id, 'chrono'));
    if (block) throw new Error(block.message);
    const deleted = await findFirstAcrossMembers(wt.target, mid => deleteChrono(mid, id, ctx.actor));
    if (!deleted) throw new Error(`Chrono entry '${id}' not found`);
    return { content: [{ type: 'text' as const, text: `Chrono entry deleted (ID ${id}).` }] };
  },
};
