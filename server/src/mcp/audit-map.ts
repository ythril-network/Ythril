/**
 * Which audit operation each MCP tool records.
 *
 * ## Why this file exists
 *
 * MCP tool calls were not audited **at all**. Every write an agent made — `saveFact`, `save_entity`,
 * `save_bulk`, `delete_space_data` — left the audit log unchanged, while the REST equivalent of each one wrote
 * an entry. For a product whose primary write path is an agent, that is most of the trail missing.
 *
 * The gap was not an oversight nobody had considered. The HTTP audit middleware explicitly admits `/mcp`:
 *
 *     if (!fullPath.startsWith('/api/') && !fullPath.startsWith('/mcp')) return;
 *
 * and then drops it one line later, because no `ROUTE_RULES` entry matches. Someone intended this to
 * work. What kept it from being noticed was `audit-route-coverage`, whose `/mcp` exemption read *"MCP has
 * its own tool-level audit path"* — describing a path that did not exist.
 *
 * ## Why the existing vocabulary, and not `mcp.tool_call`
 *
 * A compliance reader asks "who created this fact", not "who invoked a tool". Recording
 * `mcp.remember` would make the audit log unanswerable across surfaces: the same act, performed through
 * REST and through MCP, would appear under two names, and every query would have to know both. So a tool
 * records the operation its REST counterpart records, and the transport is a separate field.
 *
 * ## Why every tool must appear here
 *
 * The entries are not an allowlist with silent gaps — `mcp-audit-coverage.test.js` asserts this map's
 * keys are exactly the registered tool names. A new tool fails the build until it is classified, which is
 * the opposite of how the original gap survived: there, the absence of a rule *was* the default.
 *
 * `null` means "not an audited operation", and each `null` carries its reason. That is the same
 * exemption-with-a-reason discipline the route gates use — and two of those reasons turned out to be
 * false when checked this week, so a reason here is written to be checkable against the code.
 */

/** Tool name → the audit operation it performs, or `null` with the reason it is not one. */
export const MCP_TOOL_OPERATIONS: Record<string, string | null> = {
  // ── Mutations. Each records exactly what its REST counterpart records. ──────────────────────────
  save_fact: 'fact.create',
  update_fact: 'fact.update',
  delete_fact: 'fact.delete',
  save_entity: 'entity.create',
  update_entity: 'entity.update',
  delete_entity: 'entity.delete',
  delete_entity_preview: 'entity.cascade_preview',
  graph_merge: 'entity.merge',
  save_edge: 'edge.create',
  update_edge: 'edge.update',
  delete_edge: 'edge.delete',
  save_link: 'link.create',
  delete_link: 'link.delete',
  graph_link_preflight: 'link.convert_preflight',
  save_chrono: 'chrono.create',
  update_chrono: 'chrono.update',
  delete_chrono: 'chrono.delete',
  save_bulk: 'bulk.write',
  update_space: 'space.update',
  schema_update: 'space.update',
  save_space: 'space.create',
  space_reindex: 'space.reindex',
  // Under the operation its REST twin already records, not a new one: a compliance reader asks who
  // backfilled a space's embeddings, and two names for one act makes every query have to know both.
  space_reembed: 'space.embeddings.reembed',
  delete_space_data: 'space.wipe',
  write_file: 'file.create',
  move_file: 'file.update',
  delete_file: 'file.delete',
  // Same operation string the REST route audits under, so one query finds a retry however it arrived.
  retry_embed_file: 'file.retry_embedding',
  // Same operation string the REST route audits under, so one query finds a record retry however it arrived.
  // Same operation as the REST route it mirrors: one capability, one audit name.
  // The route's own operation: one capability, one audit name, whichever door it came through.
  update_file_meta: 'file.meta.update',
  retry_embed_media: 'file.retry_embedding_all',
  retry_embed_record: 'brain.retry_embedding',
  create_dir: 'file.mkdir',
  // The tool registry flags this `mutating: true`, and it is right: a sync cycle pulls records from
  // peers and writes them locally, so "who started the run that brought in these records" is a fair
  // audit question. `/api/notify` is exempt on the REST side as "peer notifications + the admin sync
  // trigger — not a data mutation"; the peer half is right and the trigger half was not, so
  // `/api/notify/trigger` records `sync.trigger` too and the two surfaces agree.
  network_sync: 'sync.trigger',

  // ── Reads. Recorded only when `logReads` is on, exactly as the REST reads are. ──────────────────
  filter: 'brain.filter',
  recall: 'brain.recall',
  graph_traverse: 'brain.traverse',
  space_stats: 'brain.stats',
  // Audited for the same reason `space_stats` is: it reports what a space CONTAINS — type names, edge labels
  // and counts. The REST route was not audited while `stats` was, which was an asymmetry rather than a
  // decision; both are now.
  list_spaces: 'space.list',
  list_dir: 'file.list',
  read_file: 'file.read',
  /*
   * `brain.find_similar`, matching the REST route this tool mirrors.
   *
   * It said `entity.list`, with the reason *"a vector-similarity search over existing entries — a read of
   * the same records `entity.list` covers"*. That reasoning had a fact missing: `brain.find_similar` is a
   * real operation, and `POST /api/brain/spaces/:id/find-similar` logs it. So one capability was audited
   * under two names depending on which door the caller used — an operator filtering for
   * `brain.find_similar` saw only REST calls, and one filtering `entity.list` found similarity searches
   * mixed in with entity listings.
   *
   * Every sibling already agreed with its route: `filter`, `recall`, `graph_traverse`, `space_stats`.
   * This was the one that did not, and it was found by joining the two tables rather than by reading them.
   *
   * `get_space_meta: 'space.list'` below is NOT the same case and stays: `GET /api/spaces/:id/meta` has no
   * rule of its own, so there is no operation for it to disagree with.
   */
  similar: 'brain.similar',
  // Returns the space's schema and counts. `space.list` is the REST read that exposes the same shape.
  space_meta: 'space.list',

  // ── Not audited operations, with the reason each. ──────────────────────────────────────────────
  // Returns this instance's own documentation. Reads no space and no record.
  help: null,
  // Lists configured peers from local config. There is no `network.list` operation on the REST side
  // either — peer topology is read from `/api/networks`, which is itself unaudited as a read.
  network_peers: null,
  // Reads the token inventory from local config. `GET /api/tokens` is not audited either — it is a
  // read, and the acts worth an entry are the mint, the edit and the revoke, all of which are.
  list_tokens: null,
  // Reads the embed queue's own bookkeeping. `GET .../embedding-queue/records` is not audited either: the queue is
  // already the record of what happened, so an audit entry for reading it would only say that someone looked at a log.
  // The RETRY beside it IS audited, because that one changes the queue.
  list_embed_jobs: null,
};

/**
 * The operation for a tool call, or `null` when the tool is deliberately not an audited operation.
 *
 * An UNKNOWN tool also returns `null` rather than throwing: the dispatcher already reports unknown tools
 * to the caller, and an audit helper is the wrong place to turn a bad tool name into a 500. The coverage
 * test is what guarantees no *registered* tool reaches here unclassified.
 */
export function mcpAuditOperation(toolName: string): string | null {
  return MCP_TOOL_OPERATIONS[toolName] ?? null;
}

/** Operations that are reads — logged only when `logReads` is enabled, matching the REST convention. */
const READ_OPERATIONS = new Set([
  'brain.query', 'brain.recall', 'brain.traverse', 'brain.stats',
  'chrono.list', 'space.list', 'file.list', 'file.read', 'entity.list',
]);

export function isMcpReadOperation(operation: string): boolean {
  return READ_OPERATIONS.has(operation);
}
