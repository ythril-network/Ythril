import type { ToolHandler } from './types.js';
import { list_spacesTool, space_statsTool, space_metaTool, update_spaceTool, schema_updateTool, save_spaceTool, space_reindexTool, delete_space_dataTool , list_tokensTool } from './spaces.js';
import { save_factTool, update_factTool, delete_factTool } from './fact.js';
import { recallTool, find_similarTool, queryTool } from './search.js';
import { save_bulkTool } from './bulk.js';
import { graph_mergeTool, save_entityTool, update_entityTool, delete_entityTool } from './entity.js';
import { save_edgeTool, graph_traverseTool, update_edgeTool, delete_edgeTool } from './edge.js';
import { save_linkTool, delete_linkTool, graph_link_preflightTool } from './link.js';
import { delete_entity_previewTool } from './entity-cascade.js';
import { save_chronoTool, update_chronoTool, delete_chronoTool } from './chrono.js';
import { read_fileTool, write_fileTool, update_file_metaTool, list_dirTool, delete_fileTool, create_dirTool, move_fileTool, retry_embed_fileTool } from './file.js';
import { network_peersTool, network_syncTool } from './sync.js';
import { helpTool } from './help.js';
import { list_embed_jobsTool, retry_embed_recordTool, retry_embed_mediaTool } from './embed.js';

export type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';

/**
 * The MCP tool registry - the single source of truth.
 *
 * `tools/list`, the read-only gate, the admin gate and the space-required gate are
 * ALL derived from these entries, so adding a tool means adding it here and nowhere
 * else. Order is preserved so `tools/list` stays stable.
 */
export const ALL_TOOLS: ToolHandler[] = [
  helpTool,
  list_spacesTool,
  save_factTool,
  recallTool,
  find_similarTool,
  graph_mergeTool,
  update_factTool,
  delete_factTool,
  space_statsTool,
  space_metaTool,
  queryTool,
  save_entityTool,
  save_edgeTool,
  graph_traverseTool,
  update_entityTool,
  update_edgeTool,
  // The three deletes an agent could not reach: REST has deleted all four record types since it existed,
  // MCP had `delete_fact` alone, so the only way to remove one edge was to wipe the whole space.
  delete_entityTool,
  delete_edgeTool,
  save_linkTool,
  delete_linkTool,
  graph_link_preflightTool,
  delete_entity_previewTool,
  save_chronoTool,
  update_chronoTool,
  delete_chronoTool,
  read_fileTool,
  write_fileTool,
  update_file_metaTool,
  list_dirTool,
  delete_fileTool,
  retry_embed_fileTool,
  create_dirTool,
  move_fileTool,
  update_spaceTool,
  schema_updateTool,
  save_spaceTool,
  space_reindexTool,
  delete_space_dataTool,
  list_tokensTool,
  save_bulkTool,
  network_peersTool,
  network_syncTool,
  list_embed_jobsTool,
  retry_embed_recordTool,
  retry_embed_mediaTool,
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolHandler> =
  new Map(ALL_TOOLS.map(t => [t.name, t]));
