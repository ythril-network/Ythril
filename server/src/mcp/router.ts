import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { resolveMemberSpaces, resolveWriteTarget, isProxySpace } from '../spaces/proxy.js';
import { updateSpace, wipeSpace, WIPE_COLLECTION_TYPES, type WipeCollectionType } from '../spaces/spaces.js';

// Brain tools
import { remember, recall, recallGlobal, findSimilar, queryBrain, updateMemory, deleteMemory, type RecallKnowledgeType, type RecallResult } from '../brain/memory.js';
import { col } from '../db/mongo.js';
import { upsertEntity, updateEntityById, findEntitiesByName } from '../brain/entities.js';
import { upsertEdge, traverseGraph, updateEdgeById } from '../brain/edges.js';
import { computeMergePlan, applyResolutions, executeMerge, validateResolution, type PropertyResolution } from '../brain/merge.js';
import { validateDeleteFields } from '../brain/delete-fields.js';

/** Regex that matches a UUID v4 (case-insensitive). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Check whether strict linkage enforcement is enabled for a space. */
function isStrictLinkage(spaceId: string): boolean {
  return getConfig().spaces.find(s => s.id === spaceId)?.meta?.strictLinkage === true;
}
import { createChrono, updateChrono, listChrono, ChronoFilter } from '../brain/chrono.js';
// File tools
import {
  readFile,
  writeFile,
  listDir,
  deleteFile,
  createDir,
  moveFile,
} from '../files/files.js';
import { upsertFileMeta, deleteFileMeta, renameFileMeta } from '../files/file-meta.js';
import { validateEntity, validateEdge, validateMemory, validateChrono } from '../spaces/schema-validation.js';

// Session map: sessionId → transport
const transports = new Map<string, SSEServerTransport>();

/** Format a RecallResult as a single human-readable summary line. */
function formatRecallSummary(r: RecallResult): string {
  switch (r.type) {
    case 'memory':
      return r.fact ?? '';
    case 'entity':
      return `${r.name ?? ''} (${r.entityType ?? ''})`;
    case 'edge':
      return `${r.from ?? ''} → ${r.label ?? ''} → ${r.to ?? ''}`;
    case 'chrono':
      return r.description ? `${r.title ?? ''}: ${r.description}` : (r.title ?? '');
    case 'file':
      return r.description ? `${r.path ?? ''}: ${r.description}` : (r.path ?? '');
    default:
      return '';
  }
}

const MUTATING_TOOLS = new Set([
  'remember', 'update_memory', 'delete_memory',
  'upsert_entity', 'update_entity', 'merge_entities', 'upsert_edge', 'update_edge',
  'create_chrono', 'update_chrono',
  'write_file', 'delete_file', 'create_dir', 'move_file',
  'sync_now', 'update_space', 'wipe_space',
  'bulk_write',
]);

/** Tools that require a non-empty `space` parameter in global-mode tool calls.
 * When adding a new tool, update this set and the allTools schema accordingly. */
const SPACE_REQUIRED_TOOLS = new Set([
  'remember', 'update_memory', 'delete_memory', 'get_stats', 'get_space_meta',
  'query', 'upsert_entity', 'find_entities_by_name', 'upsert_edge',
  'traverse', 'update_entity', 'update_edge', 'merge_entities',
  'create_chrono', 'update_chrono',
  'read_file', 'write_file', 'list_dir', 'delete_file', 'create_dir', 'move_file',
  'update_space', 'wipe_space', 'bulk_write', 'find_similar',
]);

/** Create a MCP Server instance with tools operating across all accessible spaces */
function createGlobalMcpServer(tokenSpaces?: string[], readOnly?: boolean, isAdmin?: boolean): Server {
  const cfg = getConfig();
  const accessibleSpaces = cfg.spaces.filter(s => !tokenSpaces || tokenSpaces.includes(s.id));
  const accessibleSpaceIds = accessibleSpaces.map(s => s.id);
  const spacesLine = accessibleSpaces.length > 0
    ? accessibleSpaces.map(s => s.id + (s.label ? ` ("${s.label.replace(/[\x00-\x1f]/g, '').slice(0, 200)}")` : '')).join(', ')
    : '(none accessible)';
  const instructions = `Ythril knowledge graph — global mode.\nAvailable spaces: ${spacesLine}.\nEach tool requires a "space" parameter (except recall and list_chrono, where it is optional and enables cross-space results when omitted; and list_peers/sync_now which are global). Call list_spaces for details.`;

  const server = new Server(
    { name: 'ythril', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions },
  );

  const spaceEnumBase = accessibleSpaceIds.length > 0 ? { enum: accessibleSpaceIds } : {};
  const requiredSpaceSchema = { type: 'string' as const, ...spaceEnumBase, description: 'Space ID to operate on. Use list_spaces to discover available spaces.' };
  const optionalSpaceSchema = { type: 'string' as const, ...spaceEnumBase, description: 'Optional space ID. Omit to search across all accessible spaces.' };

  // ── tools/list ────────────────────────────────────────────────────────────
  const allTools = [
    {
      name: 'list_spaces',
      description: 'List all accessible spaces with their IDs, labels, and descriptions.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'remember',
      description: 'Store a fact or memory in the knowledge graph with semantic embedding.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          fact: { type: 'string', description: 'The fact, observation, or memory to store.' },
          entities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Entity names mentioned in this memory.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Categorisation tags.',
          },
          description: { type: 'string', description: 'Optional prose context or rationale for this memory.' },
          properties: {
            type: 'object',
            description: 'Optional structured key-value metadata (filterable via query).',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'fact'],
      },
    },
    {
      name: 'recall',
      description: 'Semantically search all knowledge types (memories, entities, edges, chrono entries, files). Searches the specified space if provided, otherwise searches across all accessible spaces.',
      inputSchema: {
        type: 'object',
        properties: {
          space: optionalSpaceSchema,
          query: { type: 'string', description: 'Natural language search query.' },
          topK: { type: 'number', description: 'Max results (default 10).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter — only results bearing ALL of these tags are returned (applies to memories, entities, chrono entries, and files).' },
          types: {
            type: 'array',
            items: { type: 'string', enum: ['memory', 'entity', 'edge', 'chrono', 'file'] },
            description: 'Optional knowledge-type filter — restrict results to one or more types. Omit to search all types.',
          },
          minPerType: {
            type: 'object',
            description: 'Optional minimum result count per type. Guarantees at least that many results of each type if available (e.g. {"entity": 2, "edge": 1}). Omit to use pure score ranking.',
            additionalProperties: { type: 'number' },
          },
          minScore: {
            type: 'number',
            description: 'Minimum cosine similarity score (0.0–1.0). Results below this threshold are excluded.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'find_similar',
      description: 'Find entries with high vector similarity to an existing entry. Use for deduplication, "more like this", and merge detection. Uses the entry\'s stored embedding — no re-embedding.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          entryId: { type: 'string', description: 'UUID of the source entry.' },
          entryType: { type: 'string', enum: ['memory', 'entity', 'edge', 'chrono', 'file'], description: 'Knowledge type of the source entry.' },
          targetTypes: {
            type: 'array',
            items: { type: 'string', enum: ['memory', 'entity', 'edge', 'chrono', 'file'] },
            description: 'Which knowledge types to search in. Omit to search all types.',
          },
          topK: { type: 'number', description: 'Max results (default 10).' },
          minScore: { type: 'number', description: 'Minimum cosine similarity threshold (0.0–1.0). Results below this are excluded.' },
          crossSpace: { type: 'boolean', description: 'If true, search across all spaces the token can access. Default: false.' },
        },
        required: ['space', 'entryId', 'entryType'],
      },
    },
    {
      name: 'merge_entities',
      description: 'Merge two entities into one. The survivor keeps its identity; the absorbed entity is deleted after relinking all references. Call with an empty or partial resolution map to get a conflict plan (409), or with a fully resolved map to execute. Numeric properties support fn:<avg|min|max|sum>, boolean properties support fn:<and|or|xor>, strings require "survivor", "absorbed", or "custom" with customValue.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          survivorId: { type: 'string', description: 'UUID of the entity to keep.' },
          absorbedId: { type: 'string', description: 'UUID of the entity to absorb and delete.' },
          resolutions: {
            type: 'array',
            description: 'Per-property conflict resolutions. Each entry: { key, resolution, customValue? }.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Property key to resolve.' },
                resolution: { type: 'string', description: 'One of: "survivor", "absorbed", "custom", or "fn:<name>".' },
                customValue: { description: 'Required when resolution is "custom".' },
              },
              required: ['key', 'resolution'],
            },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'survivorId', 'absorbedId'],
      },
    },
    {
      name: 'update_memory',
      description: 'Update an existing memory\'s fact, tags, entity links, description, or properties. Re-embeds automatically if any content field changes.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          id: { type: 'string', description: 'Memory ID to update.' },
          fact: { type: 'string', description: 'New fact text (triggers re-embedding).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing).' },
          entityIds: { type: 'array', items: { type: 'string' }, description: 'New entity ID links (replaces existing).' },
          description: { type: 'string', description: 'New prose description or context.' },
          properties: {
            type: 'object',
            description: 'Key-value properties to merge (e.g. {"source": "manual"}). Values must be string, number, or boolean.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
          deleteFields: { type: 'array', items: { type: 'string' }, description: 'Dot-notation paths to delete from the memory (e.g. ["properties.oldKey", "description"]). System fields (id, name, type, spaceId, createdAt, updatedAt) cannot be deleted. Deletions are permanent.' },
        },
        required: ['space', 'id'],
      },
    },
    {
      name: 'delete_memory',
      description: 'Delete a memory by ID. Creates a tombstone for sync propagation.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          id: { type: 'string', description: 'Memory ID to delete.' },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'id'],
      },
    },
    {
      name: 'get_stats',
      description: 'Return counts of memories, entities, edges, and chrono entries for the current space.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
        },
        required: ['space'],
      },
    },
    {
      name: 'get_space_meta',
      description:
        'Returns the schema, purpose, usage notes, validation mode, and entry counts for this space. ' +
        'Call this before writing to an unfamiliar space to learn what entity types, edge labels, ' +
        'required properties, and naming patterns are expected.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
        },
        required: ['space'],
      },
    },
    {
      name: 'query',
      description: 'Run a structured read-only query (MongoDB filter) against brain collections.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          collection: {
            type: 'string',
            enum: ['memories', 'entities', 'edges', 'chrono', 'files'],
            description: 'Collection to query.',
          },
          filter: { type: 'object', description: 'MongoDB filter document.' },
          projection: {
            type: 'object',
            description: 'Fields to include (1) or exclude (0).',
          },
          limit: { type: 'number', description: 'Max documents (default 20, max 100).' },
          maxTimeMS: { type: 'number', description: 'Query timeout in ms (max 30000).' },
        },
        required: ['space', 'collection', 'filter'],
      },
    },
    {
      name: 'upsert_entity',
      description: 'Create or update a named entity in the knowledge graph. Identity is by `id` — if `id` is supplied the matching record is updated (or a new record with that ID is created); if `id` is omitted a new record is always inserted regardless of name.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          id: { type: 'string', description: 'Optional UUID v4 — if provided, updates the entity with this ID (or inserts with this ID if it does not exist). If omitted, a new entity is always inserted.' },
          name: { type: 'string', description: 'Entity name.' },
          type: { type: 'string', description: 'Entity type (person, place, concept, …).' },
          tags: { type: 'array', items: { type: 'string' } },
          description: { type: 'string', description: 'Optional prose description or summary of this entity.' },
          properties: {
            type: 'object',
            description: 'Key-value properties (e.g. {"wheels": 4, "color": "red"}). Values must be string, number, or boolean.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'name', 'type'],
      },
    },
    {
      name: 'find_entities_by_name',
      description: 'Find all entities in the space that match the given name (exact, case-sensitive). Returns a list — multiple entities may share a name. Prefer this over querying by name + type to avoid missing entities with unexpected types.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          name: { type: 'string', description: 'Exact entity name to look up.' },
        },
        required: ['space', 'name'],
      },
    },
    {
      name: 'upsert_edge',
      description: 'Create or update a directed relationship edge between two entities.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          from: { type: 'string', description: 'Source entity ID.' },
          to: { type: 'string', description: 'Target entity ID.' },
          label: { type: 'string', description: 'Relationship label (e.g. "works_at", "knows").' },
          type: { type: 'string', description: 'Optional edge type (e.g. "causal", "attribution").' },
          weight: { type: 'number', description: 'Optional edge weight (0–1).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Categorisation tags.' },
          description: { type: 'string', description: 'Optional prose description of why this relationship exists.' },
          properties: {
            type: 'object',
            description: 'Optional structured key-value metadata for this edge.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'from', 'to', 'label'],
      },
    },
    {
      name: 'traverse',
      description: 'Follow edges from a starting entity and return reachable nodes up to maxDepth hops. Useful for dependency analysis, impact assessment, and lineage queries.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          startId: { type: 'string', description: 'UUID of the starting entity.' },
          direction: {
            type: 'string',
            enum: ['outbound', 'inbound', 'both'],
            description: 'Follow edges from the node (outbound), to the node (inbound), or both directions. Default: outbound.',
          },
          edgeLabels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter traversal to specific edge labels only. Omit to traverse all labels.',
          },
          maxDepth: { type: 'number', description: 'Maximum hops from startId (default 3, max 10).' },
          limit: { type: 'number', description: 'Maximum total nodes returned (default 100).' },
        },
        required: ['space', 'startId'],
      },
    },
    {
      name: 'update_entity',
      description: 'Update an existing entity by its ID. All fields are optional — only supplied fields are changed.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          id: { type: 'string', description: 'Entity ID to update.' },
          name: { type: 'string', description: 'New entity name.' },
          type: { type: 'string', description: 'New entity type.' },
          description: { type: 'string', description: 'New prose description or summary.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags to merge with existing tags.' },
          properties: {
            type: 'object',
            description: 'Key-value properties to merge with existing (e.g. {"wheels": 4}). Values must be string, number, or boolean.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
          deleteFields: { type: 'array', items: { type: 'string' }, description: 'Dot-notation paths to delete from the entity (e.g. ["properties.oldKey", "description"]). System fields (id, name, type, spaceId, createdAt, updatedAt) cannot be deleted. Deletions are permanent.' },
        },
        required: ['space', 'id'],
      },
    },
    {
      name: 'update_edge',
      description: 'Update an existing edge by its ID. All fields are optional — only supplied fields are changed.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          id: { type: 'string', description: 'Edge ID to update.' },
          label: { type: 'string', description: 'New relationship label.' },
          type: { type: 'string', description: 'New edge type.' },
          weight: { type: 'number', description: 'New edge weight (0–1).' },
          description: { type: 'string', description: 'New prose description.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags to merge with existing tags.' },
          properties: {
            type: 'object',
            description: 'Key-value properties to merge with existing. Values must be string, number, or boolean.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
          deleteFields: { type: 'array', items: { type: 'string' }, description: 'Dot-notation paths to delete from the edge (e.g. ["properties.oldKey", "description"]). System fields (id, name, type, spaceId, createdAt, updatedAt) cannot be deleted. Deletions are permanent.' },
        },
        required: ['space', 'id'],
      },
    },
    {
      name: 'create_chrono',
      description: 'Create a chronological entry (event, deadline, plan, prediction, or milestone) in the knowledge graph.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          title: { type: 'string', description: 'Entry title.' },
          type: { type: 'string', enum: ['event', 'deadline', 'plan', 'prediction', 'milestone'], description: 'Entry type.' },
          startsAt: { type: 'string', description: 'ISO 8601 start date/time.' },
          endsAt: { type: 'string', description: 'Optional ISO 8601 end date/time.' },
          status: { type: 'string', enum: ['upcoming', 'active', 'completed', 'overdue', 'cancelled'], description: 'Status (default: upcoming).' },
          confidence: { type: 'number', description: 'Confidence level 0–1 (for predictions).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Categorisation tags.' },
          entityIds: { type: 'array', items: { type: 'string' }, description: 'Related entity IDs.' },
          memoryIds: { type: 'array', items: { type: 'string' }, description: 'Related memory IDs.' },
          description: { type: 'string', description: 'Optional longer description.' },
          properties: {
            type: 'object',
            description: 'Optional structured key-value metadata for this entry.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'title', 'type', 'startsAt'],
      },
    },
    {
      name: 'update_chrono',
      description: 'Update an existing chronological entry.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          id: { type: 'string', description: 'Chrono entry ID.' },
          title: { type: 'string', description: 'New title.' },
          type: { type: 'string', enum: ['event', 'deadline', 'plan', 'prediction', 'milestone'] },
          startsAt: { type: 'string', description: 'New ISO 8601 start date/time.' },
          endsAt: { type: 'string', description: 'New ISO 8601 end date/time.' },
          status: { type: 'string', enum: ['upcoming', 'active', 'completed', 'overdue', 'cancelled'] },
          confidence: { type: 'number', description: 'Confidence level 0–1.' },
          tags: { type: 'array', items: { type: 'string' } },
          entityIds: { type: 'array', items: { type: 'string' } },
          memoryIds: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          properties: {
            type: 'object',
            description: 'Optional structured key-value metadata for this entry.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'id'],
      },
    },
    {
      name: 'list_chrono',
      description: 'List chronological entries, optionally filtered by status, type, tags, date range, or a text search. Omit space to list across all accessible spaces.',
      inputSchema: {
        type: 'object',
        properties: {
          space: optionalSpaceSchema,
          status: { type: 'string', enum: ['upcoming', 'active', 'completed', 'overdue', 'cancelled'], description: 'Filter by status.' },
          type: { type: 'string', enum: ['event', 'deadline', 'plan', 'prediction', 'milestone'], description: 'Filter by type.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Return entries containing ALL of these tags (AND semantics).' },
          tagsAny: { type: 'array', items: { type: 'string' }, description: 'Return entries containing ANY of these tags (OR semantics).' },
          after: { type: 'string', description: 'ISO 8601 timestamp — return entries created after this point in time.' },
          before: { type: 'string', description: 'ISO 8601 timestamp — return entries created before this point in time.' },
          search: { type: 'string', description: 'Case-insensitive substring match on title and description.' },
          limit: { type: 'number', description: 'Max results (default 20, max 100).' },
          skip: { type: 'number', description: 'Number of results to skip for pagination (default 0).' },
        },
        required: [],
      },
    },
    {
      name: 'read_file',
      description: 'Read the text contents of a file in the space file store.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          path: { type: 'string', description: 'File path relative to the space root.' },
        },
        required: ['space', 'path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write text content to a file in the space file store.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          path: { type: 'string', description: 'File path relative to the space root.' },
          content: { type: 'string', description: 'Text content to write.' },
          description: { type: 'string', description: 'Optional human-readable summary stored as file metadata.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering and recall.' },
          properties: {
            type: 'object',
            description: 'Optional structured key-value metadata for this file.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'path', 'content'],
      },
    },
    {
      name: 'list_dir',
      description: 'List files and directories at a path in the space file store.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          path: {
            type: 'string',
            description: 'Directory path relative to space root (default: root).',
          },
        },
        required: ['space'],
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file from the space file store.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          path: { type: 'string', description: 'File path relative to the space root.' },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'path'],
      },
    },
    {
      name: 'create_dir',
      description: 'Create a directory (and any required parents) in the space file store.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          path: { type: 'string', description: 'Directory path relative to the space root.' },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'path'],
      },
    },
    {
      name: 'move_file',
      description: 'Move or rename a file or directory within the space file store.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          src: { type: 'string', description: 'Source path.' },
          dst: { type: 'string', description: 'Destination path.' },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space', 'src', 'dst'],
      },
    },
    {
      name: 'update_space',
      description: 'Update the label or description of the specified space. Requires an admin token.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          label: { type: 'string', description: 'New display label for the space (max 200 chars).' },
          description: { type: 'string', description: 'New description for the space (max 2000 chars). Surfaced to MCP clients as space-level instructions.' },
        },
        required: ['space'],
      },
    },
    {
      name: 'wipe_space',
      description: 'Wipe data from the specified space. By default wipes all collections (memories, entities, edges, chrono, files). Pass `types` to wipe only specific collections. The space itself and its configuration are preserved. Requires an admin token. Idempotent — wiping an empty space returns zero counts.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          types: {
            type: 'array',
            items: { type: 'string', enum: ['memories', 'entities', 'edges', 'chrono', 'files'] },
            description: 'Optional subset of collection types to wipe. Omit to wipe all.',
          },
        },
        required: ['space'],
      },
    },
    {
      name: 'bulk_write',
      description: 'Batch upsert memories, entities, edges, and/or chrono entries in a single call. Processing order: memories → entities → edges → chrono, so edges referencing newly created entities within the same batch resolve correctly. Each array is optional and capped at 500 entries. Per-item validation errors are reported in `errors` without aborting the rest of the batch.',
      inputSchema: {
        type: 'object',
        properties: {
          space: requiredSpaceSchema,
          memories: {
            type: 'array',
            description: 'Memory entries to insert. Same fields as the `remember` tool.',
            items: {
              type: 'object',
              properties: {
                fact:        { type: 'string', description: 'The fact or memory to store.' },
                tags:        { type: 'array', items: { type: 'string' }, description: 'Categorisation tags.' },
                entityIds:   { type: 'array', items: { type: 'string' }, description: 'Related entity IDs.' },
                description: { type: 'string', description: 'Optional prose context.' },
                properties:  { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
              },
              required: ['fact'],
            },
          },
          entities: {
            type: 'array',
            description: 'Entity entries to upsert. Same fields as the `upsert_entity` tool.',
            items: {
              type: 'object',
              properties: {
                id:          { type: 'string', description: 'Optional UUID v4 — if provided, updates the entity with this ID (or inserts with this ID). If omitted, a new entity is always inserted.' },
                name:        { type: 'string', description: 'Entity name.' },
                type:        { type: 'string', description: 'Entity type.' },
                tags:        { type: 'array', items: { type: 'string' } },
                description: { type: 'string' },
                properties:  { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
              },
              required: ['name', 'type'],
            },
          },
          edges: {
            type: 'array',
            description: 'Edge entries to upsert. Same fields as the `upsert_edge` tool.',
            items: {
              type: 'object',
              properties: {
                from:        { type: 'string', description: 'Source entity ID.' },
                to:          { type: 'string', description: 'Target entity ID.' },
                label:       { type: 'string', description: 'Relationship label.' },
                type:        { type: 'string' },
                weight:      { type: 'number' },
                description: { type: 'string' },
                tags:        { type: 'array', items: { type: 'string' } },
                properties:  { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
              },
              required: ['from', 'to', 'label'],
            },
          },
          chrono: {
            type: 'array',
            description: 'Chrono entries to insert. Same fields as the `create_chrono` tool.',
            items: {
              type: 'object',
              properties: {
                title:       { type: 'string' },
                type:        { type: 'string', enum: ['event', 'deadline', 'plan', 'prediction', 'milestone'] },
                startsAt:    { type: 'string', description: 'ISO 8601 start date/time.' },
                endsAt:      { type: 'string' },
                status:      { type: 'string', enum: ['upcoming', 'active', 'completed', 'overdue', 'cancelled'] },
                confidence:  { type: 'number' },
                description: { type: 'string' },
                tags:        { type: 'array', items: { type: 'string' } },
                entityIds:   { type: 'array', items: { type: 'string' } },
                memoryIds:   { type: 'array', items: { type: 'string' } },
                properties:  { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
              },
              required: ['title', 'type', 'startsAt'],
            },
          },
          targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
        },
        required: ['space'],
      },
    },
    {
      name: 'list_peers',
      description: 'List all configured peer ythril instances (for Brain Networks).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'sync_now',
      description:
        'Trigger an immediate sync cycle. ' +
        'If peerId is supplied, syncs only that one peer (across all networks it belongs to). ' +
        'If omitted, runs a full cycle for every network. ' +
        'peerId must be an exact instanceId from the member list — it is never used as a URL.',
      inputSchema: {
        type: 'object',
        properties: {
          peerId: {
            type: 'string',
            description: 'instanceId of the peer to sync. Omit to sync all networks.',
          },
        },
        required: [],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: readOnly ? allTools.filter(t => !MUTATING_TOOLS.has(t.name)) : allTools,
  }));

  // ── tools/call ────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    // Block mutating tools for read-only tokens
    if (readOnly && MUTATING_TOOLS.has(name)) {
      return {
        content: [{ type: 'text' as const, text: 'Error: this token has read-only access' }],
        isError: true,
      };
    }

    // Validate space parameter
    const rawSpace = typeof a['space'] === 'string' ? a['space'].trim() : '';
    if (SPACE_REQUIRED_TOOLS.has(name) && !rawSpace) {
      return { content: [{ type: 'text' as const, text: `Error: tool '${name}' requires a 'space' parameter` }], isError: true };
    }
    if (rawSpace) {
      if (!cfg.spaces.some(s => s.id === rawSpace)) {
        return { content: [{ type: 'text' as const, text: `Error: Space '${rawSpace}' not found` }], isError: true };
      }
      if (tokenSpaces && !tokenSpaces.includes(rawSpace)) {
        return { content: [{ type: 'text' as const, text: `Error: token does not have access to space '${rawSpace}'` }], isError: true };
      }
    }
    const callSpace = rawSpace;

    try {
      mcpToolCallsTotal.inc({ tool: name, space: callSpace || 'global' });
      switch (name) {
        case 'list_spaces': {
          const result = accessibleSpaces.map(s => ({
            id: s.id,
            label: s.label ?? null,
            description: s.description ?? null,
          }));
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // ── Brain ──────────────────────────────────────────────────────────
        case 'remember': {
          const fact = String(a['fact'] ?? '');
          if (!fact.trim()) throw new Error('fact must not be empty');
          if (fact.length > 50_000) throw new Error('fact must not exceed 50 000 characters');
          const tags = Array.isArray(a['tags']) ? (a['tags'] as string[]) : [];
          const entityNames = Array.isArray(a['entities']) ? (a['entities'] as string[]) : [];
          const description = typeof a['description'] === 'string' ? a['description'] : undefined;
          const props = (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties']))
            ? (a['properties'] as Record<string, string | number | boolean>)
            : undefined;

          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          const ts = wt.target;

          // Schema validation (single pass — reuse for both strict gate and warn output)
          const remMeta = getConfig().spaces.find(s => s.id === ts)?.meta;
          const remSchemaViolations = remMeta ? validateMemory(remMeta, { properties: props }) : [];
          if (remSchemaViolations.length > 0 && remMeta?.validationMode === 'strict') {
            return { content: [{ type: 'text' as const, text: `Error: schema_violation\n${JSON.stringify(remSchemaViolations, null, 2)}` }], isError: true };
          }

          // Quota check — throws QuotaError (caught below) on hard limit
          const remQuota = await checkQuota('brain');

          // Resolve entity names to existing entity IDs (Defect 3 fix).
          // Never auto-create ghost stubs — warn on unresolved names instead.
          const entityIds: string[] = [];
          const unresolvedNames: string[] = [];
          const multiMatchWarnings: string[] = [];
          for (const eName of entityNames) {
            const matches = await findEntitiesByName(ts, eName);
            if (matches.length === 0) {
              unresolvedNames.push(eName);
            } else {
              if (matches.length > 1) {
                multiMatchWarnings.push(`'${eName}' matched ${matches.length} entities — linked to all`);
              }
              for (const m of matches) entityIds.push(m._id);
            }
          }

          const resolvedNames = entityNames.filter(n => !unresolvedNames.includes(n));
          const mem = await remember(ts, fact, entityIds, tags, description, props, resolvedNames);
          const warnings: string[] = [];
          if (unresolvedNames.length > 0) {
            warnings.push(`⚠️ Unresolved entity names (not linked — create them first): ${unresolvedNames.map(n => `'${n}'`).join(', ')}`);
          }
          for (const w of multiMatchWarnings) warnings.push(`⚠️ ${w}`);
          // Schema warnings (reuse violations from pre-write check)
          if (remMeta?.validationMode === 'warn') {
            for (const v of remSchemaViolations) warnings.push(`⚠️ Schema: ${v.field} — ${v.reason}`);
          }
          const remText = `Stored memory (seq ${mem.seq}, ID ${mem._id}).`
            + (remQuota.softBreached ? `\n⚠️ Storage warning: ${remQuota.warning}` : '')
            + (warnings.length > 0 ? `\n${warnings.join('\n')}` : '');
          return {
            content: [{ type: 'text' as const, text: remText }],
          };
        }

        case 'recall': {
          const query = String(a['query'] ?? '');
          if (!query.trim()) throw new Error('query must not be empty');
          const topK = typeof a['topK'] === 'number' ? a['topK'] : 10;
          const tags = Array.isArray(a['tags']) ? (a['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
          const types = Array.isArray(a['types']) ? (a['types'] as unknown[]).filter((t): t is RecallKnowledgeType => typeof t === 'string') : undefined;
          const minPerType = (a['minPerType'] != null && typeof a['minPerType'] === 'object' && !Array.isArray(a['minPerType']))
            ? (a['minPerType'] as Partial<Record<RecallKnowledgeType, number>>)
            : undefined;
          const minScore = typeof a['minScore'] === 'number' ? a['minScore'] : undefined;
          if (callSpace) {
            // Search specific space
            const memberIds = resolveMemberSpaces(callSpace);
            const all = (await Promise.all(memberIds.map(mid => recall(mid, query, topK, tags, types, minPerType, minScore)))).flat();
            all.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
            const results = all.slice(0, topK);
            return {
              content: [{
                type: 'text' as const,
                text: results.length === 0
                  ? 'No results found.'
                  : results.map((r, i) => `[${i + 1}] [${r.type}] (score: ${r.score?.toFixed(3) ?? 'n/a'}) ${formatRecallSummary(r)}`).join('\n'),
              }],
            };
          } else {
            // Cross-space search across all accessible spaces
            const results = await recallGlobal(accessibleSpaceIds, query, topK, tags, types, minPerType, minScore);
            return {
              content: [{
                type: 'text' as const,
                text: results.length === 0
                  ? 'No results found across any space.'
                  : results.map((r, i) => `[${i + 1}] [${r.spaceId}] [${r.type}] (score: ${r.score?.toFixed(3) ?? 'n/a'}) ${formatRecallSummary(r)}`).join('\n'),
              }],
            };
          }
        }

        case 'find_similar': {
          const entryId = String(a['entryId'] ?? '').trim();
          if (!entryId) throw new Error('entryId must not be empty');
          if (!UUID_V4_RE.test(entryId)) throw new Error('entryId must be a valid UUID v4');
          const entryType = String(a['entryType'] ?? '').trim();
          const validTypes = new Set(['memory', 'entity', 'edge', 'chrono', 'file']);
          if (!validTypes.has(entryType)) throw new Error(`entryType must be one of: ${[...validTypes].join(', ')}`);
          const topK = typeof a['topK'] === 'number' ? Math.min(Math.max(a['topK'], 1), 100) : 10;
          const minScore = typeof a['minScore'] === 'number' ? a['minScore'] : undefined;
          const crossSpace = a['crossSpace'] === true;
          const targetTypes = Array.isArray(a['targetTypes'])
            ? (a['targetTypes'] as unknown[]).filter((t): t is RecallKnowledgeType => typeof t === 'string' && validTypes.has(t))
            : undefined;

          let crossSpaceIds: string[] | undefined;
          if (crossSpace) {
            crossSpaceIds = cfg.spaces
              .filter(s => !tokenSpaces || tokenSpaces.includes(s.id))
              .map(s => s.id);
          }

          const memberIds = resolveMemberSpaces(callSpace);
          const result = await findSimilar(
            memberIds[0] ?? callSpace,
            entryId,
            entryType as RecallKnowledgeType,
            topK,
            targetTypes,
            minScore,
            crossSpaceIds,
          );

          const lines: string[] = [];
          lines.push(`Source: [${result.source.type}] ${formatRecallSummary(result.source)} (ID: ${result.source._id})`);
          if (result.results.length === 0) {
            lines.push('No similar entries found.');
          } else {
            for (let i = 0; i < result.results.length; i++) {
              const r = result.results[i]!;
              const spaceLabel = crossSpace ? ` [${r.spaceId}]` : '';
              lines.push(`[${i + 1}]${spaceLabel} [${r.type}] (score: ${r.score?.toFixed(3) ?? 'n/a'}) ${formatRecallSummary(r)}`);
            }
          }

          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        }

        case 'merge_entities': {
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

          const mergeResult = await executeMerge(wt.target, survivor, absorbed, mergedProperties);
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
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        }

        case 'update_memory': {
          const id = String(a['id'] ?? '').trim();
          if (!id) throw new Error('id must not be empty');

          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);

          // Validate deleteFields
          const dfResult = validateDeleteFields(a['deleteFields']);
          if (!dfResult.ok) throw new Error(dfResult.error);
          const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0 ? a['deleteFields'] as string[] : undefined;

          const updates: { fact?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean> } = {};
          if (typeof a['fact'] === 'string') {
            if (!a['fact'].trim()) throw new Error('fact must not be empty');
            updates.fact = a['fact'] as string;
          }
          if (Array.isArray(a['tags'])) updates.tags = a['tags'] as string[];
          if (Array.isArray(a['entityIds'])) updates.entityIds = a['entityIds'] as string[];
          if (typeof a['description'] === 'string') updates.description = a['description'] as string;
          if (a['properties'] !== null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
            updates.properties = a['properties'] as Record<string, string | number | boolean>;
          }

          if (Object.keys(updates).length === 0 && !dfPaths) throw new Error('At least one of fact, tags, entityIds, description, properties, or deleteFields must be provided');

          const memberIds = resolveMemberSpaces(wt.target);
          // Search member spaces sequentially — consistent with REST endpoint behaviour.
          let updated = null;
          for (const mid of memberIds) {
            updated = await updateMemory(mid, id, updates, dfPaths);
            if (updated) break;
          }
          if (!updated) throw new Error(`Memory '${id}' not found`);
          return {
            content: [{ type: 'text' as const, text: `Memory updated (ID ${updated._id}, seq ${updated.seq}).` }],
          };
        }

        case 'delete_memory': {
          const id = String(a['id'] ?? '').trim();
          if (!id) throw new Error('id must not be empty');

          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);

          const memberIds = resolveMemberSpaces(wt.target);
          let deleted = false;
          for (const mid of memberIds) {
            if (await deleteMemory(mid, id)) { deleted = true; break; }
          }
          if (!deleted) throw new Error(`Memory '${id}' not found`);
          return {
            content: [{ type: 'text' as const, text: `Memory deleted (ID ${id}).` }],
          };
        }

        case 'get_stats': {
          const memberIds = resolveMemberSpaces(callSpace);
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
              text: JSON.stringify({ spaceId: callSpace, memories, entities, edges, chrono, files }, null, 2),
            }],
          };
        }

        case 'get_space_meta': {
          const metaCfg = getConfig();
          const metaSpace = metaCfg.spaces.find(s => s.id === callSpace);
          const metaBlock = metaSpace?.meta ?? {};
          const metaMemberIds = resolveMemberSpaces(callSpace);
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
          };
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(metaResult, null, 2),
            }],
          };
        }

        case 'query': {
          const collName = String(a['collection'] ?? '');
          if (!['memories', 'entities', 'edges', 'chrono', 'files'].includes(collName)) {
            throw new Error(`collection must be one of: memories, entities, edges, chrono, files`);
          }
          const filter =
            a['filter'] != null && typeof a['filter'] === 'object'
              ? (a['filter'] as Record<string, unknown>)
              : {};
          const limit = typeof a['limit'] === 'number' ? a['limit'] : 20;
          const maxTimeMS = typeof a['maxTimeMS'] === 'number' ? a['maxTimeMS'] : 5000;
          const projection =
            a['projection'] != null && typeof a['projection'] === 'object'
              ? (a['projection'] as Record<string, unknown>)
              : undefined;

          const memberIds = resolveMemberSpaces(callSpace);
          const docs = (await Promise.all(memberIds.map(mid =>
            queryBrain(
              mid,
              collName as 'memories' | 'entities' | 'edges' | 'chrono' | 'files',
              filter,
              projection,
              limit,
              maxTimeMS,
            ),
          ))).flat();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(docs, null, 2),
              },
            ],
          };
        }

        case 'upsert_entity': {
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

          // Schema validation (single pass)
          const entMeta = getConfig().spaces.find(s => s.id === wt.target)?.meta;
          const entSchemaViolations = entMeta ? validateEntity(entMeta, { name: eName.trim(), type: eType.trim(), properties: props }) : [];
          if (entSchemaViolations.length > 0 && entMeta?.validationMode === 'strict') {
            return { content: [{ type: 'text' as const, text: `Error: schema_violation\n${JSON.stringify(entSchemaViolations, null, 2)}` }], isError: true };
          }

          const { entity, warning } = await upsertEntity(wt.target, eName, eType, tags, props, description, rawId);
          let msg = `Entity '${entity.name}' (${entity.type}) upserted (ID ${entity._id}).${warning ? `\n⚠️ ${warning}` : ''}`;
          // Schema warnings (reuse violations from pre-write check)
          if (entMeta?.validationMode === 'warn') {
            for (const v of entSchemaViolations) msg += `\n⚠️ Schema: ${v.field} — ${v.reason}`;
          }
          return {
            content: [{ type: 'text' as const, text: msg }],
          };
        }

        case 'find_entities_by_name': {
          const searchName = String(a['name'] ?? '').trim();
          if (!searchName) throw new Error('name must not be empty');
          const memberIds = resolveMemberSpaces(callSpace);
          const all = (await Promise.all(memberIds.map(mid => findEntitiesByName(mid, searchName)))).flat();
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
        }

        case 'upsert_edge': {
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
          if (isStrictLinkage(wt.target)) {
            if (!UUID_V4_RE.test(from)) throw new Error('from must be a valid UUID v4 (entity ID), not a name');
            if (!UUID_V4_RE.test(to)) throw new Error('to must be a valid UUID v4 (entity ID), not a name');
          }

          // Schema validation (single pass)
          const edgeMeta = getConfig().spaces.find(s => s.id === wt.target)?.meta;
          const edgeSchemaViolations = edgeMeta ? validateEdge(edgeMeta, { label: label.trim(), properties: edgeProps }) : [];
          if (edgeSchemaViolations.length > 0 && edgeMeta?.validationMode === 'strict') {
            return { content: [{ type: 'text' as const, text: `Error: schema_violation\n${JSON.stringify(edgeSchemaViolations, null, 2)}` }], isError: true };
          }

          const edge = await upsertEdge(wt.target, from, to, label, weight, edgeType, description, edgeProps, edgeTags);
          let edgeMsg = `Edge '${label}' (${from} → ${to}) upserted (ID ${edge._id}).`;
          if (edgeMeta?.validationMode === 'warn') {
            for (const v of edgeSchemaViolations) edgeMsg += `\n⚠️ Schema: ${v.field} — ${v.reason}`;
          }
          return {
            content: [{ type: 'text' as const, text: edgeMsg }],
          };
        }

        case 'traverse': {
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

          const memberIds = resolveMemberSpaces(callSpace);
          const result = await traverseGraph(memberIds, startId, direction, edgeLabels, maxDepth, limit);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        case 'update_entity': {
          const id = String(a['id'] ?? '').trim();
          if (!id) throw new Error('id must not be empty');
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          // Validate deleteFields
          const dfResult = validateDeleteFields(a['deleteFields']);
          if (!dfResult.ok) throw new Error(dfResult.error);
          const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0 ? a['deleteFields'] as string[] : undefined;
          const updates: { name?: string; type?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean> } = {};
          if (typeof a['name'] === 'string') updates.name = a['name'].trim();
          if (typeof a['type'] === 'string') updates.type = (a['type'] as string).trim();
          if (typeof a['description'] === 'string') updates.description = a['description'] as string;
          if (Array.isArray(a['tags'])) updates.tags = a['tags'] as string[];
          if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
            updates.properties = a['properties'] as Record<string, string | number | boolean>;
          }
          if (Object.keys(updates).length === 0 && !dfPaths) throw new Error('At least one of name, type, description, tags, properties, or deleteFields must be provided');
          const memberIds = resolveMemberSpaces(wt.target);
          let updatedEnt = null;
          for (const mid of memberIds) {
            updatedEnt = await updateEntityById(mid, id, updates, dfPaths);
            if (updatedEnt) break;
          }
          if (!updatedEnt) throw new Error(`Entity '${id}' not found`);
          return {
            content: [{ type: 'text' as const, text: `Entity '${updatedEnt.name}' (${updatedEnt.type}) updated (ID ${updatedEnt._id}, seq ${updatedEnt.seq}).` }],
          };
        }

        case 'update_edge': {
          const id = String(a['id'] ?? '').trim();
          if (!id) throw new Error('id must not be empty');
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          // Validate deleteFields
          const dfResult = validateDeleteFields(a['deleteFields']);
          if (!dfResult.ok) throw new Error(dfResult.error);
          const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0 ? a['deleteFields'] as string[] : undefined;
          const updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string } = {};
          if (typeof a['label'] === 'string') updates.label = (a['label'] as string).trim();
          if (typeof a['description'] === 'string') updates.description = a['description'] as string;
          if (Array.isArray(a['tags'])) updates.tags = a['tags'] as string[];
          if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
            updates.properties = a['properties'] as Record<string, string | number | boolean>;
          }
          if (typeof a['weight'] === 'number') updates.weight = a['weight'] as number;
          if (typeof a['type'] === 'string') updates.type = (a['type'] as string).trim();
          if (Object.keys(updates).length === 0 && !dfPaths) throw new Error('At least one of label, description, tags, properties, weight, type, or deleteFields must be provided');
          const memberIds = resolveMemberSpaces(wt.target);
          let updatedEdge = null;
          for (const mid of memberIds) {
            updatedEdge = await updateEdgeById(mid, id, updates, dfPaths);
            if (updatedEdge) break;
          }
          if (!updatedEdge) throw new Error(`Edge '${id}' not found`);
          return {
            content: [{ type: 'text' as const, text: `Edge '${updatedEdge.label}' updated (ID ${updatedEdge._id}, seq ${updatedEdge.seq}).` }],
          };
        }

        // ── Chrono ─────────────────────────────────────────────────────────
        case 'create_chrono': {
          const title = String(a['title'] ?? '').trim();
          const chronoType = String(a['type'] ?? '') as import('../config/types.js').ChronoType;
          const startsAt = String(a['startsAt'] ?? '');
          if (!title) throw new Error('title must not be empty');
          if (!['event', 'deadline', 'plan', 'prediction', 'milestone'].includes(chronoType)) throw new Error('type must be event, deadline, plan, prediction, or milestone');
          if (!startsAt) throw new Error('startsAt must not be empty');

          const chronoProps = (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties']))
            ? (a['properties'] as Record<string, string | number | boolean>)
            : undefined;

          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);

          // Schema validation (single pass)
          const chronoMeta = getConfig().spaces.find(s => s.id === wt.target)?.meta;
          const chronoSchemaViolations = chronoMeta ? validateChrono(chronoMeta, { type: chronoType, properties: chronoProps }) : [];
          if (chronoSchemaViolations.length > 0 && chronoMeta?.validationMode === 'strict') {
            return { content: [{ type: 'text' as const, text: `Error: schema_violation\n${JSON.stringify(chronoSchemaViolations, null, 2)}` }], isError: true };
          }

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

          const entry = await createChrono(wt.target, {
            title,
            type: chronoType,
            startsAt,
            description: typeof a['description'] === 'string' ? a['description'] : undefined,
            endsAt: typeof a['endsAt'] === 'string' ? a['endsAt'] : undefined,
            status: typeof a['status'] === 'string' ? a['status'] as import('../config/types.js').ChronoStatus : undefined,
            confidence: typeof a['confidence'] === 'number' ? a['confidence'] : undefined,
            tags: Array.isArray(a['tags']) ? (a['tags'] as string[]) : undefined,
            entityIds: chronoEntityIds,
            memoryIds: chronoMemoryIds,
            properties: chronoProps,
          });
          let text = `Chrono entry '${entry.title}' (${entry.type}) created (ID ${entry._id}, seq ${entry.seq}).`
            + (remQuota.softBreached ? `\n⚠️ Storage warning: ${remQuota.warning}` : '');
          if (chronoMeta?.validationMode === 'warn') {
            for (const v of chronoSchemaViolations) text += `\n⚠️ Schema: ${v.field} — ${v.reason}`;
          }
          return { content: [{ type: 'text' as const, text }] };
        }

        case 'update_chrono': {
          const id = String(a['id'] ?? '').trim();
          if (!id) throw new Error('id must not be empty');
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);

          const updates: Record<string, unknown> = {};
          if (typeof a['title'] === 'string') updates['title'] = a['title'];
          if (typeof a['type'] === 'string') updates['type'] = a['type'];
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

          const entry = await updateChrono(wt.target, id, updates as never);
          if (!entry) throw new Error(`Chrono entry '${id}' not found`);
          return { content: [{ type: 'text' as const, text: `Chrono entry '${entry.title}' updated (seq ${entry.seq}).` }] };
        }

        case 'list_chrono': {
          const filter: ChronoFilter = {};
          if (typeof a['status'] === 'string') filter.status = a['status'];
          if (typeof a['type'] === 'string') filter.type = a['type'];
          if (Array.isArray(a['tags']) && (a['tags'] as unknown[]).length > 0) {
            filter.tags = a['tags'] as string[];
          }
          if (Array.isArray(a['tagsAny']) && (a['tagsAny'] as unknown[]).length > 0) {
            filter.tagsAny = a['tagsAny'] as string[];
          }
          if (typeof a['after'] === 'string') filter.after = a['after'];
          if (typeof a['before'] === 'string') filter.before = a['before'];
          if (typeof a['search'] === 'string') filter.search = a['search'];
          const limit = typeof a['limit'] === 'number' ? Math.min(a['limit'], 100) : 20;
          const skip = typeof a['skip'] === 'number' ? Math.max(a['skip'], 0) : 0;

          const memberIds = callSpace ? resolveMemberSpaces(callSpace) : accessibleSpaceIds;
          // Fetch skip+limit from each member so the combined list has enough entries
          // after global sort/slice. For large skip values this over-fetches slightly,
          // but chrono lists are expected to be small in practice.
          const all = (await Promise.all(memberIds.map(mid => listChrono(mid, filter, skip + limit)))).flat();
          all.sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
          const results = all.slice(skip, skip + limit);
          return {
            content: [{
              type: 'text' as const,
              text: results.length === 0
                ? 'No chrono entries found.'
                : results.map((e, i) => `[${i + 1}] ${e.type} | ${e.status} | ${e.startsAt} | ${e.title} (ID ${e._id})`).join('\n'),
            }],
          };
        }

        // ── Files ──────────────────────────────────────────────────────────
        case 'read_file': {
          const filePath = String(a['path'] ?? '');
          if (!filePath.trim()) throw new Error('path must not be empty');
          const memberIds = resolveMemberSpaces(callSpace);
          let content: string | null = null;
          for (const mid of memberIds) {
            try { content = await readFile(mid, filePath); break; } catch { /* try next */ }
          }
          if (content === null) throw new Error(`File not found: ${filePath}`);
          return { content: [{ type: 'text' as const, text: content }] };
        }

        case 'write_file': {
          const filePath = String(a['path'] ?? '');
          const content = String(a['content'] ?? '');
          if (!filePath.trim()) throw new Error('path must not be empty');
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          // Quota check — throws QuotaError (caught below) on hard limit
          const wfQuota = await checkQuota('files');
          const { sha256 } = await writeFile(wt.target, filePath, content);
          const sizeBytes = Buffer.byteLength(content, 'utf8');
          const metaOpts: { description?: string; tags?: string[]; properties?: Record<string, string | number | boolean> } = {};
          if (typeof a['description'] === 'string') metaOpts.description = a['description'];
          if (Array.isArray(a['tags'])) metaOpts.tags = a['tags'] as string[];
          if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
            metaOpts.properties = a['properties'] as Record<string, string | number | boolean>;
          }
          await upsertFileMeta(wt.target, filePath, sizeBytes, metaOpts);
          const wfText = `Written (sha256: ${sha256}).`
            + (wfQuota.softBreached ? `\n⚠️ Storage warning: ${wfQuota.warning}` : '');
          return {
            content: [{ type: 'text' as const, text: wfText }],
          };
        }

        case 'list_dir': {
          const dirPath = String(a['path'] ?? '');
          const memberIds = resolveMemberSpaces(callSpace);
          const seen = new Set<string>();
          const allEntries: { name: string; type: 'file' | 'dir'; size?: number }[] = [];
          for (const mid of memberIds) {
            try {
              const entries = await listDir(mid, dirPath || '.');
              for (const e of entries) {
                if (!seen.has(e.name)) { seen.add(e.name); allEntries.push(e); }
              }
            } catch { /* dir may not exist in this member */ }
          }
          const text =
            allEntries.length === 0
              ? '(empty directory)'
              : allEntries
                  .map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.name}${e.size != null ? `  (${e.size}B)` : ''}`)
                  .join('\n');
          return { content: [{ type: 'text' as const, text }] };
        }

        case 'delete_file': {
          const filePath = String(a['path'] ?? '');
          if (!filePath.trim()) throw new Error('path must not be empty');
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          await deleteFile(wt.target, filePath);
          await deleteFileMeta(wt.target, filePath);
          return { content: [{ type: 'text' as const, text: `Deleted '${filePath}'.` }] };
        }

        case 'create_dir': {
          const dirPath = String(a['path'] ?? '');
          if (!dirPath.trim()) throw new Error('path must not be empty');
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          await createDir(wt.target, dirPath);
          return { content: [{ type: 'text' as const, text: `Directory '${dirPath}' created.` }] };
        }

        case 'move_file': {
          const src = String(a['src'] ?? '');
          const dst = String(a['dst'] ?? '');
          if (!src.trim()) throw new Error('src must not be empty');
          if (!dst.trim()) throw new Error('dst must not be empty');
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          await moveFile(wt.target, src, dst);
          await renameFileMeta(wt.target, src, dst);
          return { content: [{ type: 'text' as const, text: `Moved '${src}' → '${dst}'.` }] };
        }

        // ── Sync / Peers ───────────────────────────────────────────────────
        case 'list_peers': {
          const listPeersCfg = getConfig();
          // Build a flat list of peers across all networks, scrubbing all
          // credential fields (tokenHash, inviteKeyHash must never be exposed).
          const peers = listPeersCfg.networks.flatMap(net =>
            net.members.map(m => ({
              instanceId: m.instanceId,
              label: m.label,
              url: m.url,
              direction: m.direction,
              network: net.label,
              networkId: net.id,
              networkType: net.type,
              lastSyncAt: m.lastSyncAt ?? null,
              consecutiveFailures: m.consecutiveFailures ?? 0,
              skipTlsVerify: m.skipTlsVerify ?? false,
            })),
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: peers.length === 0
                  ? 'No peers configured.'
                  : JSON.stringify(peers, null, 2),
              },
            ],
          };
        }

        case 'sync_now': {
          const peerId = a['peerId'] != null ? String(a['peerId']).trim() : null;
          const { runSyncForPeer, runSyncForNetwork } = await import('../sync/engine.js');
          const syncCfg = getConfig();

          if (peerId) {
            // SEC-16: validate peerId is a known instanceId, never use as URL
            const knownIds = new Set(syncCfg.networks.flatMap(n => n.members.map(m => m.instanceId)));
            if (!knownIds.has(peerId)) {
              return {
                content: [{ type: 'text' as const, text: `Error: peerId '${peerId}' is not a registered member in any network.` }],
                isError: true,
              };
            }
            const result = await runSyncForPeer(peerId);
            return {
              content: [{
                type: 'text' as const,
                text: result.notFound
                  ? `Peer '${peerId}' not found in any network.`
                  : `Sync complete: ${result.networksSynced} network(s) synced, ${result.errors} error(s).`,
              }],
              isError: result.errors > 0,
            };
          } else {
            // Sync all networks
            let totalSynced = 0; let totalErrors = 0;
            const lines: string[] = [];
            for (const net of syncCfg.networks) {
              const r = await runSyncForNetwork(net.id);
              totalSynced += r.synced;
              totalErrors += r.errors;
              lines.push(`${net.label}: ${r.synced} ok, ${r.errors} error(s)`);
            }
            return {
              content: [{
                type: 'text' as const,
                text: lines.length === 0
                  ? 'No networks configured.'
                  : lines.join('\n') + `\n\nTotal: ${totalSynced} synced, ${totalErrors} error(s).`,
              }],
              isError: totalErrors > 0,
            };
          }
        }

        case 'update_space': {
          if (!isAdmin) {
            return {
              content: [{ type: 'text' as const, text: 'Error: update_space requires an admin token' }],
              isError: true,
            };
          }
          const newLabel = typeof a['label'] === 'string' ? a['label'].trim() : undefined;
          const newDesc = typeof a['description'] === 'string' ? a['description'] : undefined;
          if (newLabel === undefined && newDesc === undefined) {
            throw new Error('At least one of label or description must be provided');
          }
          if (newLabel !== undefined && newLabel.length === 0) throw new Error('label must not be empty');
          if (newDesc !== undefined && newDesc.length > 2000) throw new Error('description must not exceed 2000 characters');
          if (newLabel !== undefined && newLabel.length > 200) throw new Error('label must not exceed 200 characters');
          const updates: { label?: string; description?: string } = {};
          if (newLabel !== undefined) updates.label = newLabel;
          if (newDesc !== undefined) updates.description = newDesc;
          const updated = updateSpace(callSpace, updates);
          if (!updated) throw new Error(`Space '${callSpace}' not found`);
          return {
            content: [{ type: 'text' as const, text: `Space '${callSpace}' updated.` }],
          };
        }

        case 'wipe_space': {
          if (!isAdmin) {
            return {
              content: [{ type: 'text' as const, text: 'Error: wipe_space requires an admin token' }],
              isError: true,
            };
          }
          const rawTypes = Array.isArray(a['types']) ? (a['types'] as unknown[]) : undefined;
          if (rawTypes !== undefined && rawTypes.some(t => typeof t !== 'string' || !WIPE_COLLECTION_TYPES.includes(t as WipeCollectionType))) {
            throw new Error(`types must be an array of: ${WIPE_COLLECTION_TYPES.join(', ')}`);
          }
          const wipeTypes = rawTypes as WipeCollectionType[] | undefined;
          const result = await wipeSpace(callSpace, wipeTypes);
          const typesLabel = wipeTypes && wipeTypes.length > 0 ? wipeTypes.join(', ') : 'all';
          const summary = `Wiped [${typesLabel}] in space '${callSpace}': ${result.memories} memories, ${result.entities} entities, ${result.edges} edges, ${result.chrono} chrono, ${result.files} files.`;
          return {
            content: [{ type: 'text' as const, text: summary }],
          };
        }

        case 'bulk_write': {
          const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
          if (!wt.ok) throw new Error(wt.error);
          const ts = wt.target;

          // Schema validation context
          const bwMeta = getConfig().spaces.find(s => s.id === ts)?.meta;
          const bwValidation = bwMeta?.validationMode ?? 'off';

          const BULK_MAX = 500;
          const rawMemories = Array.isArray(a['memories']) ? (a['memories'] as unknown[]).slice(0, BULK_MAX) : [];
          const rawEntities = Array.isArray(a['entities']) ? (a['entities'] as unknown[]).slice(0, BULK_MAX) : [];
          const rawEdges    = Array.isArray(a['edges'])    ? (a['edges']    as unknown[]).slice(0, BULK_MAX) : [];
          const rawChrono   = Array.isArray(a['chrono'])   ? (a['chrono']   as unknown[]).slice(0, BULK_MAX) : [];

          const inserted = { memories: 0, entities: 0, edges: 0, chrono: 0 };
          const updated  = { memories: 0, entities: 0, edges: 0, chrono: 0 };
          const errors: { type: string; index: number; reason: string }[] = [];

          // memories
          for (let i = 0; i < rawMemories.length; i++) {
            const item = rawMemories[i] as Record<string, unknown>;
            const fact = typeof item['fact'] === 'string' ? item['fact'].trim() : '';
            if (!fact) { errors.push({ type: 'memory', index: i, reason: 'missing required field: fact' }); continue; }
            const tags     = Array.isArray(item['tags'])      ? (item['tags']      as unknown[]).filter((t): t is string => typeof t === 'string') : [];
            const entityIds = Array.isArray(item['entityIds']) ? (item['entityIds'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
            const description = typeof item['description'] === 'string' ? item['description'] : undefined;
            const props = (item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties']))
              ? (item['properties'] as Record<string, string | number | boolean>) : undefined;
            try {
              // Schema validation per memory
              if (bwValidation !== 'off' && bwMeta) {
                const sv = validateMemory(bwMeta, { properties: props });
                if (sv.length > 0) {
                  if (bwValidation === 'strict') { errors.push({ type: 'memory', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
                  for (const v of sv) errors.push({ type: 'memory', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
                }
              }
              await remember(ts, fact, entityIds, tags, description, props);
              inserted.memories++;
            } catch (err) {
              errors.push({ type: 'memory', index: i, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          // entities
          for (let i = 0; i < rawEntities.length; i++) {
            const item = rawEntities[i] as Record<string, unknown>;
            const eName = typeof item['name'] === 'string' ? item['name'].trim() : '';
            const eType = typeof item['type'] === 'string' ? item['type'].trim() : '';
            if (!eName) { errors.push({ type: 'entity', index: i, reason: 'missing required field: name' }); continue; }
            if (!eType) { errors.push({ type: 'entity', index: i, reason: 'missing required field: type' }); continue; }
            const rawId = typeof item['id'] === 'string' ? item['id'].trim() : undefined;
            if (rawId !== undefined && !UUID_V4_RE.test(rawId)) {
              errors.push({ type: 'entity', index: i, reason: '`id` must be a valid UUID v4' }); continue;
            }
            const tags = Array.isArray(item['tags']) ? (item['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
            const description = typeof item['description'] === 'string' ? item['description'] : undefined;
            const props = (item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties']))
              ? (item['properties'] as Record<string, string | number | boolean>) : {};
            try {
              // Schema validation per entity
              if (bwValidation !== 'off' && bwMeta) {
                const sv = validateEntity(bwMeta, { name: eName, type: eType, properties: props });
                if (sv.length > 0) {
                  if (bwValidation === 'strict') { errors.push({ type: 'entity', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
                  for (const v of sv) errors.push({ type: 'entity', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
                }
              }
              // Check for existing entity by ID (if supplied) to determine inserted vs updated
              const existing = rawId
                ? await col<import('../config/types.js').EntityDoc>(`${ts}_entities`).findOne({ _id: rawId, spaceId: ts } as never)
                : null;
              const result = await upsertEntity(ts, eName, eType, tags, props, description, rawId);
              if (existing) { updated.entities++; } else { inserted.entities++; }
              if (result.warning) { errors.push({ type: 'entity', index: i, reason: result.warning }); }
            } catch (err) {
              errors.push({ type: 'entity', index: i, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          // edges
          for (let i = 0; i < rawEdges.length; i++) {
            const item = rawEdges[i] as Record<string, unknown>;
            const from  = typeof item['from']  === 'string' ? item['from'].trim()  : '';
            const to    = typeof item['to']    === 'string' ? item['to'].trim()    : '';
            const label = typeof item['label'] === 'string' ? item['label'].trim() : '';
            if (!from)  { errors.push({ type: 'edge', index: i, reason: 'missing required field: from' });  continue; }
            if (isStrictLinkage(ts) && !UUID_V4_RE.test(from)) { errors.push({ type: 'edge', index: i, reason: '`from` must be a valid UUID v4 (entity ID), not a name' }); continue; }
            if (!to)    { errors.push({ type: 'edge', index: i, reason: 'missing required field: to' });    continue; }
            if (isStrictLinkage(ts) && !UUID_V4_RE.test(to)) { errors.push({ type: 'edge', index: i, reason: '`to` must be a valid UUID v4 (entity ID), not a name' }); continue; }
            if (!label) { errors.push({ type: 'edge', index: i, reason: 'missing required field: label' }); continue; }
            const weight      = typeof item['weight'] === 'number' ? item['weight'] : undefined;
            const edgeType    = typeof item['type']   === 'string' ? item['type']   : undefined;
            const description = typeof item['description'] === 'string' ? item['description'] : undefined;
            const tags        = Array.isArray(item['tags']) ? (item['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
            const props       = (item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties']))
              ? (item['properties'] as Record<string, string | number | boolean>) : undefined;
            try {
              // Schema validation per edge
              if (bwValidation !== 'off' && bwMeta) {
                const sv = validateEdge(bwMeta, { label });
                if (sv.length > 0) {
                  if (bwValidation === 'strict') { errors.push({ type: 'edge', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
                  for (const v of sv) errors.push({ type: 'edge', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
                }
              }
              const existing = await col<import('../config/types.js').EdgeDoc>(`${ts}_edges`).findOne({ spaceId: ts, from, to, label } as never);
              await upsertEdge(ts, from, to, label, weight, edgeType, description, props, tags);
              if (existing) { updated.edges++; } else { inserted.edges++; }
            } catch (err) {
              errors.push({ type: 'edge', index: i, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          // chrono
          const CHRONO_KINDS_BW = new Set(['event', 'deadline', 'plan', 'prediction', 'milestone']);
          for (let i = 0; i < rawChrono.length; i++) {
            const item = rawChrono[i] as Record<string, unknown>;
            const title    = typeof item['title']    === 'string' ? item['title'].trim() : '';
            const bwType   = typeof item['type']     === 'string' ? item['type']         : '';
            const startsAt = typeof item['startsAt'] === 'string' ? item['startsAt']     : '';
            if (!title)   { errors.push({ type: 'chrono', index: i, reason: 'missing required field: title' });   continue; }
            if (!CHRONO_KINDS_BW.has(bwType)) { errors.push({ type: 'chrono', index: i, reason: '`type` must be one of: event, deadline, plan, prediction, milestone' }); continue; }
            if (!startsAt) { errors.push({ type: 'chrono', index: i, reason: 'missing required field: startsAt' }); continue; }
            const endsAt      = typeof item['endsAt']      === 'string' ? item['endsAt']      : undefined;
            const status      = typeof item['status']      === 'string' ? item['status']      : undefined;
            const confidence  = typeof item['confidence']  === 'number' ? item['confidence']  : undefined;
            const description = typeof item['description'] === 'string' ? item['description'] : undefined;
            const tags        = Array.isArray(item['tags'])       ? (item['tags']       as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
            const entityIds   = Array.isArray(item['entityIds'])  ? (item['entityIds']  as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
            const memoryIds   = Array.isArray(item['memoryIds'])  ? (item['memoryIds']  as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
            if (entityIds && isStrictLinkage(ts)) {
              const invalidEIds = entityIds.filter(id => !UUID_V4_RE.test(id));
              if (invalidEIds.length > 0) { errors.push({ type: 'chrono', index: i, reason: '`entityIds` must contain valid UUID v4 values (entity IDs), not names' }); continue; }
            }
            if (memoryIds && isStrictLinkage(ts)) {
              const invalidMIds = memoryIds.filter(id => !UUID_V4_RE.test(id));
              if (invalidMIds.length > 0) { errors.push({ type: 'chrono', index: i, reason: '`memoryIds` must contain valid UUID v4 values (memory IDs), not names' }); continue; }
            }
            const props       = (item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties']))
              ? (item['properties'] as Record<string, string | number | boolean>) : undefined;
            try {
              // Schema validation per chrono
              if (bwValidation !== 'off' && bwMeta) {
                const sv = validateChrono(bwMeta, { type: bwType, properties: props });
                if (sv.length > 0) {
                  if (bwValidation === 'strict') { errors.push({ type: 'chrono', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
                  for (const v of sv) errors.push({ type: 'chrono', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
                }
              }
              await createChrono(ts, {
                title, type: bwType as import('../config/types.js').ChronoType, startsAt, endsAt,
                status: status as import('../config/types.js').ChronoStatus | undefined,
                confidence, description, tags, entityIds, memoryIds, properties: props,
              });
              inserted.chrono++;
            } catch (err) {
              errors.push({ type: 'chrono', index: i, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          const summary = `bulk_write complete — inserted: ${JSON.stringify(inserted)}, updated: ${JSON.stringify(updated)}, errors: ${errors.length}`;
          return {
            content: [{ type: 'text' as const, text: summary + (errors.length > 0 ? '\n' + JSON.stringify(errors, null, 2) : '') }],
            isError: false,
          };
        }

        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`MCP global tool '${name}' error in space '${callSpace || 'global'}': ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Express router ───────────────────────────────────────────────────────────

import { requireAuth } from '../auth/middleware.js';
import { mcpConnectionsActive, mcpToolCallsTotal } from '../metrics/registry.js';

export const mcpRouter = Router();

// All MCP routes require authentication — unauthenticated requests must not
// fall through to the SPA and return 200.
mcpRouter.use(requireAuth);

// GET /mcp  — global SSE stream (space is a tool parameter, not a URL segment)
mcpRouter.get('/', globalRateLimit, async (req, res) => {
  const postEndpoint = '/mcp/messages';
  const transport = new SSEServerTransport(postEndpoint, res);
  transports.set(transport.sessionId, transport);
  mcpConnectionsActive.inc();

  res.on('close', () => {
    transports.delete(transport.sessionId);
    mcpConnectionsActive.dec();
    log.debug(`MCP global session ${transport.sessionId} closed`);
  });

  const server = createGlobalMcpServer(req.authToken?.spaces, req.authToken?.readOnly, req.authToken?.admin);
  log.debug(`MCP global session ${transport.sessionId} opened`);
  await server.connect(transport);
});

// POST /mcp/messages  — global tool call
mcpRouter.post('/messages', globalRateLimit, async (req, res) => {
  const sessionId = String(req.query['sessionId'] ?? '');
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: 'Unknown MCP session. Open an SSE connection first.' });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// Catch-all for unrecognised MCP paths — must not fall through to SPA
mcpRouter.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
