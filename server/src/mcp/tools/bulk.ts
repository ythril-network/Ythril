/**
 * MCP `save_bulk` tool — batch upsert across knowledge types in one call.
 *
 * A cross-type writer (facts + entities + edges + chrono), so it lives in its own file rather
 * than with fact CRUD. The actual batch logic is the shared `bulkWrite()` in `brain/bulk.ts`
 * (one source of truth with the REST `POST /bulk` route); this tool only coerces input, fires the
 * single `bulk.write` summary webhook, and shapes the response.
 */

import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { TTL_DAYS_SCHEMA, uuidSchema } from './shared.js';
import { bulkWrite, bulkWriteTotal } from '../../brain/bulk.js';
import { resolveWriteTarget } from '../../spaces/proxy.js';
import { emitWebhookEvent } from '../../webhooks/dispatcher.js';
import { edgeEndpointKindSchema } from '../../brain/entity-refs.js';
import { CHRONO_STATUSES } from '../../config/types.js';
import { refDeclareSchema } from '../../brain/batch-refs.js';

export const save_bulkTool: ToolHandler = {
  name: 'save_bulk',
  description: 'Write facts, entities, edges and chrono entries in one call. Every array is optional; send '
    + 'any combination.\n\n'
    + 'A SUCCESSFUL CALL MAY HAVE WRITTEN NOTHING. This is partial-success by design: a bad item is reported '
    + 'in `errors` and the rest of the batch proceeds, so there is no failure status to check. ALWAYS read '
    + '`inserted` and `errors` from the response — `inserted` counts what landed, per collection, and `errors` '
    + 'names each rejection by `type` and by its INDEX in the array you sent. Treating a returned result as '
    + 'proof of success is the mistake this tool most invites.\n\n'
    + 'ANYTHING BEYOND 500 PER COLLECTION IS SILENTLY DROPPED. Not an error, not a warning, and not counted in '
    + '`errors` — items 501 and beyond are discarded before validation, so `inserted` plus `errors` can be far '
    + 'short of what you sent and nothing in the reply says so. The cap is per collection, so 500 facts AND '
    + '500 entities in one call is fine. Split larger imports yourself and check the counts add up.\n\n'
    + 'REFERENCES ARE CHECKED FOR SHAPE, AND FOR EXISTENCE ONLY ON A CONVERTED SPACE — which differs from the '
    + 'single-record tools, where existence is always checked. On a space using link records a reference that '
    + 'resolves to nothing is refused here as it is everywhere else; on any other space it is stored. A '
    + 'resolved `$ref` always exists, so the correlation key never pays for this. '
    + 'On an UNCONVERTED space this door can therefore still write a dangling link the single-record path '
    + 'would have refused — that is the deliberate trade for an import whose records arrive in an order '
    + 'nobody controls. Verify with `graph_traverse` after a large import if linkage matters.\n\n'
    + 'ORDER IS facts → entities → chrono → edges, EDGES LAST so that a `$ref` can name a record of any '
    + 'kind. It also matters for records this call UPDATES: an entity '
    + 'addressed by an id that already exists is written before an edge in the same batch reads it. Facts go '
    + 'first of all, so a fact\'s `linkEntities` cannot name an entity from this same call under any ordering.\n\n'
    + 'A RECORD THIS CALL CREATES IS REFERENCED BY A CORRELATION KEY. Put `"$ref": "post-1"` on an item and later items name it as `"$ref:post-1"` — in an edge\'s `from`/`to`, or in a link field. The key is scoped to this call, is never stored, and is NOT the id: identities are still minted here. Every record array is written before any edge, so an edge can reference any record in the payload; within one array a reference cannot point FORWARDS. A key used twice is refused rather than resolved, and a stated kind that disagrees with the array the key was declared in is refused too — the array decides. A LITERAL id you invent is still not the id the record gets, and still points at nothing.\n\n'
    + 'PARAMETERS: each collection takes the same fields as its single-record tool — `facts` as `saveFact`, '
    + '`entities` as `save_entity`, `edges` as `save_edge`, `chrono` as `save_chrono` — including '
    + '`ttlDays` per item. `targetSpace` is required when `space` is a proxy.\n\n'
    + 'RESPONSE: `inserted` (a count per collection) and `errors` (one entry per rejected item, with its '
    + 'collection and index). Neither tells you about items dropped by the 500 cap; only your own count does.',
  mutating: true,
  spaceRequired: true,
  // Partial-success contract: invalid items are reported per-item in `errors`, not rejected up front.
  // The rich item schemas below are for tools/list discovery; per-item validation is done in the handler.
  skipSchemaValidation: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            facts: {
              type: 'array',
              maxItems: 500,
              description: 'Fact entries to insert (max 500; excess entries are dropped). Same fields as the `saveFact` tool.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  '$ref': refDeclareSchema('fact'),
                  fact:        { type: 'string', minLength: 1, maxLength: 50000, description: 'The fact or fact to store (1–50 000 characters).' },
                  tags:        {
                    type: 'array', items: { type: 'string' },
                    description: 'Categorisation tags. Every fact item is an INSERT, so there is nothing '
                      + 'to merge with. They are embedded along with the fact, so a tag affects ranking as '
                      + 'well as being an exact filter.',
                  },
                  linkEntities: {
                    type: 'array', items: { type: 'string' },
                    description: 'Entity IDs to link this fact to. NEVER checked for existence on this '
                      + 'door — `saveFact` refuses an id that does not resolve, and here a well-formed UUID '
                      + 'pointing at nothing is stored as a dangling link. The ids have to come from an '
                      + 'EARLIER call: facts are written before the entities in this same payload, and an '
                      + 'id you invent for one of them is not the id it gets — identities are minted here.',
                  },
                  description: {
                    type: 'string',
                    description: 'Optional prose context or rationale. Embedded with the fact, so it widens '
                      + 'what a `recall` can match this fact on.',
                  },
                  type:        { type: 'string', description: 'Optional fact type — selects the per-type schema used to validate `properties`.' },
                  properties:  {
                    type: 'object',
                    description: 'Key-value metadata. String, number or boolean values only — a nested '
                      + 'object or array is not accepted. Validated against the per-type schema when `type` '
                      + 'is set, and a failure REJECTS this item alone rather than the batch.',
                    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
                  },
                  ttlDays:     TTL_DAYS_SCHEMA,
                },
                required: ['fact'],
              },
            },
            entities: {
              type: 'array',
              maxItems: 500,
              description: 'Entity entries to upsert (max 500; excess entries are dropped). Same fields as the `save_entity` tool.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id:          uuidSchema('UUID v4 of an EXISTING entity to update. It is not a way to choose an id: identity is server-generated, so an id that names nothing is ignored rather than adopted. To carry your own reference, use `name` or `description`.'),
                  '$ref': refDeclareSchema('entity'),
                  name:        { type: 'string', description: 'Entity name. Nothing deduplicates by name — an item with no `id` always INSERTS, even when a record of the same name already exists.' },
                  type:        { type: 'string', description: 'Entity type (person, place, concept, …). Validated against the space schema when the space validates.' },
                  tags:        {
                    type: 'array', items: { type: 'string' },
                    description: 'Categorisation tags. MERGED over the stored tags when `id` names an '
                      + 'existing entity, exactly as `save_entity` merges — so no value here removes a tag.',
                  },
                  description: { type: 'string', description: 'Optional prose description or summary of this entity. Replaced when sent.' },
                  properties:  {
                    type: 'object',
                    description: 'Key-value metadata (string, number or boolean values only). MERGED key by '
                      + 'key when `id` names an existing entity, and validated in its MERGED form — which is '
                      + 'why a partial item can be accepted where the fragment alone would fail a '
                      + 'required-property rule.',
                    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
                  },
                  ttlDays:     TTL_DAYS_SCHEMA,
                },
                required: ['name', 'type'],
              },
            },
            edges: {
              type: 'array',
              maxItems: 500,
              description: 'Edge entries to upsert (max 500; excess entries are dropped). Same fields as the `save_edge` tool.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  '$ref': refDeclareSchema('edge'),
                  from:        {
                    type: 'string',
                    description: 'The record the relationship starts at — a UUID v4 unless `fromKind` says '
                      + 'otherwise, and a space-relative PATH when `fromKind` is `file`. Part of the identity '
                      + '(from + to + label), so the same triplet twice UPDATES rather than duplicating. '
                      + 'Checked for shape only under strict linkage, and never for existence.',
                  },
                  to:          {
                    type: 'string',
                    description: 'The record the relationship points at — a UUID v4 unless `toKind` says '
                      + 'otherwise, and a space-relative PATH when `toKind` is `file`. Direction matters: '
                      + 'reversing `from` and `to` is a different edge, not the same one.',
                  },
                  fromKind:    edgeEndpointKindSchema('from'),
                  toKind:      edgeEndpointKindSchema('to'),
                  label:       {
                    type: 'string',
                    description: 'What the relationship IS, e.g. "works_at" or "knows". Required, part of '
                      + 'the identity alongside `from` and `to`, and embedded — so it is what a `recall` '
                      + 'ranks this edge on.',
                  },
                  type:        { type: 'string', description: 'Optional edge type (e.g. "causal", "attribution"). Free text; nothing validates it against a list.' },
                  weight:      {
                    type: 'number',
                    description: 'Optional edge weight. `save_edge` BOUNDS this to 0–1 and this door does '
                      + 'NOT — the per-item schemas here are for discovery only (`skipSchemaValidation`), so '
                      + 'a weight outside 0–1 is stored as sent rather than refused. Send 0–1 to match what '
                      + 'the single-record tool would have accepted. A non-number is dropped silently and '
                      + 'does not appear in `errors`.',
                  },
                  description: { type: 'string', description: 'Optional prose description of why this relationship exists. Replaced when sent.' },
                  tags:        {
                    type: 'array', items: { type: 'string' },
                    description: 'Categorisation tags. MERGED over the stored tags when the triplet already '
                      + 'exists, exactly as `save_edge` merges — so no value here removes a tag.',
                  },
                  properties:  {
                    type: 'object',
                    description: 'Key-value metadata (string, number or boolean values only). MERGED key by '
                      + 'key over an existing edge and validated in its merged form.',
                    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
                  },
                  ttlDays:     TTL_DAYS_SCHEMA,
                },
                required: ['from', 'to', 'label'],
              },
            },
            chrono: {
              type: 'array',
              maxItems: 500,
              description: 'Chrono entries to insert (max 500; excess entries are dropped). Same fields as the `save_chrono` tool.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  '$ref': refDeclareSchema('chrono'),
                  title:       { type: 'string', description: 'Entry title. Required — an item without one is rejected by index in `errors`.' },
                  type:        { type: 'string', description: 'Entry type (e.g. event, deadline, plan, prediction, milestone, or a custom type defined in the space schema). Checked against the space\'s allowlist, and a type outside it rejects THIS item by index.' },
                  startsAt:    {
                    type: 'string',
                    description: 'ISO 8601 date/time the entry is ABOUT, not when it was recorded. Required. '
                      + 'With no `endsAt` it is also the due moment, so a past value on an `upcoming` entry '
                      + 'makes it read back as `overdue` at once.',
                  },
                  endsAt:      {
                    type: 'string',
                    description: 'Optional ISO 8601 end. When present it REPLACES `startsAt` as the due '
                      + 'moment. Nothing validates the order — an `endsAt` before `startsAt` is stored as '
                      + 'sent and the entry then reads as `overdue` immediately.',
                  },
                  status:      {
                    type: 'string', enum: [...CHRONO_STATUSES],
                    description: 'Stored status (default `upcoming`). A value outside this list is DISCARDED '
                      + 'SILENTLY — the entry is still written, with the default, and nothing appears in '
                      + '`errors`. `save_chrono` refuses the same value, because the per-item schemas here '
                      + 'are for discovery only (`skipSchemaValidation`). You do not need `overdue`: it is '
                      + 'derived on read from the due moment, so leaving an entry `upcoming` is what makes it '
                      + 'overdue, and a stored one never reverts when the dates move.',
                  },
                  confidence:  { type: 'number', description: 'Confidence 0 to 1, for entries that are predictions. A non-number is dropped silently and does not appear in `errors`; unlike `save_chrono`, the 0–1 bound is not enforced on this door.' },
                  description: { type: 'string', description: 'Optional longer description of the entry.' },
                  tags:        { type: 'array', items: { type: 'string' }, description: 'Categorisation tags. Every chrono item is an INSERT, so there is nothing to merge with.' },
                  linkEntities: { type: 'array', items: { type: 'string' }, description: 'Entity IDs this entry concerns — what lets `graph_traverse` reach it from that entity. NEVER checked for existence on this door, and checked for UUID shape only when the space uses strict linkage, so a well-formed id pointing at nothing is stored as a dangling link.' },
                  linkFacts:   { type: 'array', items: { type: 'string' }, description: 'Fact IDs this entry relates to. Shape-checked under strict linkage only, and never for existence — like `linkEntities`.' },
                  properties:  {
                    type: 'object',
                    description: 'Key-value metadata (string, number or boolean values only), validated '
                      + 'against the space\'s schema for this chrono type.',
                    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
                  },
                  ttlDays:     TTL_DAYS_SCHEMA,
                },
                required: ['title', 'type', 'startsAt'],
              },
            },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
          },
          required: ['space'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    const ts = wt.target;

    const result = await bulkWrite(ts, {
      facts: a['facts'], entities: a['entities'], edges: a['edges'], chrono: a['chrono'],
      // `F-25`: who wrote it, for the conversion pre-flight.
    });
    if (bulkWriteTotal(result) > 0) {
      // Bulk suppresses per-item webhooks; emit ONE summary a workflow can inspect.
      emitWebhookEvent({ event: 'bulk.write', spaceId: ts, entry: { inserted: result.inserted, updated: result.updated, errorCount: result.errors.length }, ...(ctx.actor ?? {}) });
    }
    const summary = `bulk_write complete — inserted: ${JSON.stringify(result.inserted)}, updated: ${JSON.stringify(result.updated)}, errors: ${result.errors.length}`;
    return {
      content: [{ type: 'text' as const, text: summary + (result.errors.length > 0 ? '\n' + JSON.stringify(result.errors) : '') }],
      structuredContent: { ...result },
      isError: false,
    };
  },
};
