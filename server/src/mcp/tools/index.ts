import type { ToolHandler } from './types.js';
import { space_schema_layersTool, space_set_network_precedenceTool } from './schema-layers.js';
import { list_spacesTool, space_statsTool, space_metaTool, update_spaceTool, schema_updateTool, save_spaceTool, delete_space_dataTool , list_tokensTool } from './spaces.js';
import { save_factTool, update_factTool, delete_factTool } from './fact.js';
import { recallTool, find_similarTool } from './search.js';
import { queryTool } from './filter.js';
import { save_bulkTool } from './bulk.js';
import { ingestTool, ingest_statusTool } from './ingest.js';
import { graph_mergeTool, save_entityTool, update_entityTool, delete_entityTool } from './entity.js';
import { save_edgeTool, graph_traverseTool, update_edgeTool, delete_edgeTool } from './edge.js';
import { save_linkTool, delete_linkTool } from './link.js';
import { delete_entity_previewTool } from './entity-cascade.js';
import { save_chronoTool, update_chronoTool, delete_chronoTool } from './chrono.js';
import { read_fileTool, write_fileTool, update_file_metaTool, list_dirTool, delete_fileTool, create_dirTool, move_fileTool, retry_embed_fileTool } from './file.js';
import { network_peersTool, network_syncTool } from './sync.js';
import { network_member_admitTool, network_member_signing_keyTool, network_reparent_selfTool, network_member_adoptTool, network_member_revert_parentTool } from './network-topology.js';
import { network_join_remoteTool, network_member_addTool, network_member_removeTool } from './network-join.js';
import { network_getTool, network_createTool, network_updateTool, network_leaveTool, network_add_spaceTool, network_pending_spaceTool, network_votesTool, network_voteTool, network_sync_historyTool, network_inviteTool, network_forkTool } from './networks.js';
import { helpTool } from './help.js';
import { list_embed_jobsTool, retry_embed_recordTool, retry_embed_mediaTool, space_reindexTool, space_reembedTool } from './embed.js';

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
  space_schema_layersTool,
  space_set_network_precedenceTool,
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
  space_reembedTool,
  delete_space_dataTool,
  list_tokensTool,
  save_bulkTool,
  ingestTool,
  ingest_statusTool,
  network_peersTool,
  network_syncTool,
  network_getTool,
  network_createTool,
  network_updateTool,
  network_leaveTool,
  network_add_spaceTool,
  network_pending_spaceTool,
  network_votesTool,
  network_voteTool,
  network_sync_historyTool,
  network_inviteTool,
  network_forkTool,
  network_join_remoteTool,
  network_member_addTool,
  network_member_removeTool,
  network_member_admitTool,
  network_member_signing_keyTool,
  network_reparent_selfTool,
  network_member_adoptTool,
  network_member_revert_parentTool,
  list_embed_jobsTool,
  retry_embed_recordTool,
  retry_embed_mediaTool,
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolHandler> =
  new Map(ALL_TOOLS.map(t => [t.name, t]));
