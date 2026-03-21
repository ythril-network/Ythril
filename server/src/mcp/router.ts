import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { requireSpaceAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { checkQuota, QuotaError } from '../quota/quota.js';

// Brain tools
import { remember, recall, recallGlobal, queryBrain } from '../brain/memory.js';
import { upsertEntity, listEntities } from '../brain/entities.js';
import { upsertEdge, listEdges } from '../brain/edges.js';
// File tools
import {
  readFile,
  writeFile,
  listDir,
  deleteFile,
  createDir,
  moveFile,
} from '../files/files.js';

// Session map: sessionId → transport
const transports = new Map<string, SSEServerTransport>();

/** Create a MCP Server instance with all tools bound to the given space */
function createMcpServer(spaceId: string, tokenSpaces?: string[]): Server {
  const server = new Server(
    { name: 'ythril', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ── tools/list ────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'remember',
        description: 'Store a fact or memory in the knowledge graph with semantic embedding.',
        inputSchema: {
          type: 'object',
          properties: {
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
          },
          required: ['fact'],
        },
      },
      {
        name: 'recall',
        description: 'Semantically search memories in this space.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query.' },
            topK: { type: 'number', description: 'Max results (default 10).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'recall_global',
        description: 'Semantically search memories across ALL accessible spaces in parallel.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query.' },
            topK: { type: 'number', description: 'Max results per space before merging (default 5).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'query',
        description: 'Run a structured read-only query (MongoDB filter) against brain collections.',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              enum: ['memories', 'entities', 'edges'],
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
          required: ['collection', 'filter'],
        },
      },
      {
        name: 'upsert_entity',
        description: 'Create or update a named entity in the knowledge graph.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Entity name.' },
            type: { type: 'string', description: 'Entity type (person, place, concept, …).' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'type'],
        },
      },
      {
        name: 'upsert_edge',
        description: 'Create or update a directed relationship edge between two entities.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source entity ID.' },
            to: { type: 'string', description: 'Target entity ID.' },
            label: { type: 'string', description: 'Relationship label (e.g. "works_at", "knows").' },
            weight: { type: 'number', description: 'Optional edge weight (0–1).' },
          },
          required: ['from', 'to', 'label'],
        },
      },
      {
        name: 'read_file',
        description: 'Read the text contents of a file in the space file store.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the space root.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write text content to a file in the space file store.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the space root.' },
            content: { type: 'string', description: 'Text content to write.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'list_dir',
        description: 'List files and directories at a path in the space file store.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to space root (default: root).',
            },
          },
          required: [],
        },
      },
      {
        name: 'delete_file',
        description: 'Delete a file from the space file store.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the space root.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'create_dir',
        description: 'Create a directory (and any required parents) in the space file store.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path relative to the space root.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'move_file',
        description: 'Move or rename a file or directory within the space file store.',
        inputSchema: {
          type: 'object',
          properties: {
            src: { type: 'string', description: 'Source path.' },
            dst: { type: 'string', description: 'Destination path.' },
          },
          required: ['src', 'dst'],
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
    ],
  }));

  // ── tools/call ────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        // ── Brain ──────────────────────────────────────────────────────────
        case 'remember': {
          const fact = String(a['fact'] ?? '');
          if (!fact.trim()) throw new Error('fact must not be empty');
          const tags = Array.isArray(a['tags']) ? (a['tags'] as string[]) : [];
          const entityNames = Array.isArray(a['entities']) ? (a['entities'] as string[]) : [];

          // Quota check — throws QuotaError (caught below) on hard limit
          const remQuota = await checkQuota('brain');

          // Upsert entities and collect their IDs
          const entityIds: string[] = [];
          for (const eName of entityNames) {
            const entity = await upsertEntity(spaceId, eName, 'entity', []);
            entityIds.push(entity._id);
          }

          const mem = await remember(spaceId, fact, entityIds, tags);
          const remText = `Stored memory (seq ${mem.seq}, ID ${mem._id}).`
            + (remQuota.softBreached ? `\n⚠️ Storage warning: ${remQuota.warning}` : '');
          return {
            content: [{ type: 'text' as const, text: remText }],
          };
        }

        case 'recall': {
          const query = String(a['query'] ?? '');
          if (!query.trim()) throw new Error('query must not be empty');
          const topK = typeof a['topK'] === 'number' ? a['topK'] : 10;
          const results = await recall(spaceId, query, topK);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  results.length === 0
                    ? 'No memories found.'
                    : results
                        .map(
                          (r, i) =>
                            `[${i + 1}] (score: ${r.score?.toFixed(3) ?? 'n/a'}) ${r.fact}`,
                        )
                        .join('\n'),
              },
            ],
          };
        }

        case 'recall_global': {
          const query = String(a['query'] ?? '');
          if (!query.trim()) throw new Error('query must not be empty');
          const topK = typeof a['topK'] === 'number' ? a['topK'] : 5;
          const cfg = getConfig();
          // Only search spaces allowed by the calling token (tokenSpaces undefined = all spaces).
          const spaceIds = cfg.spaces
            .filter(s => !tokenSpaces || tokenSpaces.includes(s.id))
            .map(s => s.id);
          const results = await recallGlobal(spaceIds, query, topK);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  results.length === 0
                    ? 'No memories found across any space.'
                    : results
                        .map(
                          (r, i) =>
                            `[${i + 1}] [${r.spaceId}] (score: ${r.score?.toFixed(3) ?? 'n/a'}) ${r.fact}`,
                        )
                        .join('\n'),
              },
            ],
          };
        }

        case 'query': {
          const collName = String(a['collection'] ?? '');
          if (!['memories', 'entities', 'edges'].includes(collName)) {
            throw new Error(`collection must be one of: memories, entities, edges`);
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

          const docs = await queryBrain(
            spaceId,
            collName as 'memories' | 'entities' | 'edges',
            filter,
            projection,
            limit,
            maxTimeMS,
          );
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
          const entity = await upsertEntity(spaceId, eName, eType, tags);
          return {
            content: [{ type: 'text' as const, text: `Entity '${entity.name}' (${entity.type}) upserted (ID ${entity._id}).` }],
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
          const edge = await upsertEdge(spaceId, from, to, label, weight);
          return {
            content: [{ type: 'text' as const, text: `Edge '${label}' (${from} → ${to}) upserted (ID ${edge._id}).` }],
          };
        }

        // ── Files ──────────────────────────────────────────────────────────
        case 'read_file': {
          const filePath = String(a['path'] ?? '');
          if (!filePath.trim()) throw new Error('path must not be empty');
          const content = await readFile(spaceId, filePath);
          return { content: [{ type: 'text' as const, text: content }] };
        }

        case 'write_file': {
          const filePath = String(a['path'] ?? '');
          const content = String(a['content'] ?? '');
          if (!filePath.trim()) throw new Error('path must not be empty');
          // Quota check — throws QuotaError (caught below) on hard limit
          const wfQuota = await checkQuota('files');
          const { sha256 } = await writeFile(spaceId, filePath, content);
          const wfText = `Written (sha256: ${sha256}).`
            + (wfQuota.softBreached ? `\n⚠️ Storage warning: ${wfQuota.warning}` : '');
          return {
            content: [{ type: 'text' as const, text: wfText }],
          };
        }

        case 'list_dir': {
          const dirPath = String(a['path'] ?? '');
          const entries = await listDir(spaceId, dirPath || '.');
          const text =
            entries.length === 0
              ? '(empty directory)'
              : entries
                  .map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.name}${e.size != null ? `  (${e.size}B)` : ''}`)
                  .join('\n');
          return { content: [{ type: 'text' as const, text }] };
        }

        case 'delete_file': {
          const filePath = String(a['path'] ?? '');
          if (!filePath.trim()) throw new Error('path must not be empty');
          await deleteFile(spaceId, filePath);
          return { content: [{ type: 'text' as const, text: `Deleted '${filePath}'.` }] };
        }

        case 'create_dir': {
          const dirPath = String(a['path'] ?? '');
          if (!dirPath.trim()) throw new Error('path must not be empty');
          await createDir(spaceId, dirPath);
          return { content: [{ type: 'text' as const, text: `Directory '${dirPath}' created.` }] };
        }

        case 'move_file': {
          const src = String(a['src'] ?? '');
          const dst = String(a['dst'] ?? '');
          if (!src.trim()) throw new Error('src must not be empty');
          if (!dst.trim()) throw new Error('dst must not be empty');
          await moveFile(spaceId, src, dst);
          return { content: [{ type: 'text' as const, text: `Moved '${src}' → '${dst}'.` }] };
        }

        // ── Sync / Peers ───────────────────────────────────────────────────
        case 'list_peers': {
          const cfg = getConfig();
          // Build a flat list of peers across all networks, scrubbing all
          // credential fields (tokenHash, inviteKeyHash must never be exposed).
          const peers = cfg.networks.flatMap(net =>
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
          const cfg = getConfig();

          if (peerId) {
            // SEC-16: validate peerId is a known instanceId, never use as URL
            const knownIds = new Set(cfg.networks.flatMap(n => n.members.map(m => m.instanceId)));
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
            for (const net of cfg.networks) {
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

        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`MCP tool '${name}' error in space '${spaceId}': ${message}`);
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

export const mcpRouter = Router();

// All MCP routes require authentication — unauthenticated requests must not
// fall through to the SPA and return 200.
mcpRouter.use(requireAuth);

// GET /mcp/:spaceId  — open SSE stream
mcpRouter.get('/:spaceId', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const postEndpoint = `/mcp/${spaceId}/messages`;
  const transport = new SSEServerTransport(postEndpoint, res);
  transports.set(transport.sessionId, transport);

  res.on('close', () => {
    transports.delete(transport.sessionId);
    log.debug(`MCP session ${transport.sessionId} closed (space: ${spaceId})`);
  });

  const server = createMcpServer(spaceId, req.authToken?.spaces);
  log.debug(`MCP session ${transport.sessionId} opened (space: ${spaceId})`);
  await server.connect(transport);
});

// POST /mcp/:spaceId/messages?sessionId=xxx  — receive tool call
mcpRouter.post('/:spaceId/messages', globalRateLimit, requireSpaceAuth, async (req, res) => {
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
