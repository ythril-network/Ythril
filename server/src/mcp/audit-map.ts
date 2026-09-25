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

// The REST rules are where `read: true` is declared, beside the route it describes.
// Importing them is what stops this file holding a second copy of that decision; there is no
// cycle, because the middleware does not import the MCP door.
import { ROUTE_RULES } from '../audit/middleware.js';

/**
 * Tool name → the audit operation it performs, or `null` with the reason it is not one.
 *
 * **A LIST NAMES A CAPABILITY WHOSE REST HALF IS MORE THAN ONE ROUTE**, and it exists because pairing a
 * tool with its route goes through this map. `network_sync` syncs every network or one named peer, and
 * REST spells those as two routes because a path has to name its subject — so with a single operation
 * here the parity gate compared the tool against half of itself and reported `peerId` as a parameter no
 * route accepts. The FIRST entry is the one an audit record is written under.
 */
export const MCP_TOOL_OPERATIONS: Record<string, string | string[] | null> = {
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
  save_chrono: 'chrono.create',
  update_chrono: 'chrono.update',
  delete_chrono: 'chrono.delete',
  save_bulk: 'bulk.write',
  ingest: 'brain.ingest',
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
  // audit question.
  //
  // IT SAID `sync.trigger` UNTIL 5.0, which was `POST /api/notify/trigger`'s operation — and that route
  // is gone, so the name would have become one only the MCP door ever wrote. An operator filtering by
  // what the REST route records would have seen no agent traffic, and the cross-door parity gate would
  // have gone quiet rather than red, because an unpaired tool is skipped.
  //
  // BOTH ROUTES, because this one tool is both of them: a full cycle over every network, or one named
  // peer across every network it belongs to. A peer-scoped call is still RECORDED under the first name —
  // the map is keyed by tool alone, so it cannot see the arguments — and that residue is `Q-28`.
  network_sync: ['network.sync_trigger', 'peer.sync_trigger'],
  // F-36: the same operations their routes record, so an operator filtering the audit log sees both doors.
  network_create: 'network.create',
  network_update: 'network.update',
  network_leave: 'network.delete',
  network_add_space: 'network.space.add',
  space_schema_layers: null,
  space_set_network_precedence: 'space.precedence.update',

  // ── Reads. Recorded only when `logReads` is on, exactly as the REST reads are. ──────────────────
  filter: 'brain.filter',
  recall: 'brain.recall',
  graph_traverse: 'brain.traverse',
  space_stats: 'brain.stats',
  ingest_status: 'brain.ingest.status',
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
  // A read, like `GET /api/networks/:id`, which has no audit rule.
  network_get: null,
  // Reads the token inventory from local config. `GET /api/tokens` is not audited either — it is a
  // read, and the acts worth an entry are the mint, the edit and the revoke, all of which are.
  list_tokens: null,
  // Reads the embed queue's own bookkeeping. `GET .../embedding-queue/records` is not audited either: the queue is
  // already the record of what happened, so an audit entry for reading it would only say that someone looked at a log.
  // The RETRY beside it IS audited, because that one changes the queue.
  list_embed_jobs: null,
};

/**
 * Which of a capability's operations THIS call performs, for the tools whose subject is an argument.
 *
 * ## Why the list alone was not enough — `Q-37`
 *
 * A list above says which REST operations one capability is reachable through, and the first entry was
 * what every call was written under. `network_sync` with a `peerId` does exactly what
 * `POST /api/networks/peers/:peerId/sync` does, and that route records `peer.sync_trigger` — but the
 * tool recorded `network.sync_trigger` for both subjects, because the resolver only ever saw the tool
 * NAME. An operator filtering the audit log for `peer.sync_trigger` saw the browser's peer syncs and
 * none of the agent's.
 *
 * It is the defect `a-tool-and-its-route-log-one-operation` exists for, one level down, and invisible to
 * that gate because the tool's first operation IS a name a route records.
 *
 * ## Why here rather than on the tool definition
 *
 * A tool could declare its own operation the way it declares `heavy` and `admin`, and for ONE tool that
 * looked lighter. It puts the audit name somewhere the coverage gate does not read, and it answers the
 * question this file already answers — what does this call record — so it would be the same rule in two
 * places, which is the shape this repo produces most. This map answers it with enough information
 * instead of a second map answering it again.
 *
 * ## The guard that cannot be skipped
 *
 * A chooser is a function of CALLER input, so `mcpAuditOperation` never trusts it: it catches, and it
 * rejects a result that is not one of the tool's own declared operations. Both failures fall back to the
 * first name, because **an unaudited call is worse than one under a slightly-wrong name** and that is
 * the direction this must not fail in. `mcp-audit-coverage.test.js` asserts the rule for every chooser,
 * not for the one tool that has one.
 */
export const MCP_OPERATION_SUBJECTS: Record<string, (args: unknown) => string> = {
  // One peer named, or the whole network: the same split REST spells as two routes, because a path has
  // to name its subject and an argument does not.
  network_sync: (args) =>
    typeof (args as { peerId?: unknown })?.peerId === 'string' && (args as { peerId: string }).peerId
      ? 'peer.sync_trigger'
      : 'network.sync_trigger',
};

/**
 * The operation for a tool call, or `null` when the tool is deliberately not an audited operation.
 *
 * An UNKNOWN tool also returns `null` rather than throwing: the dispatcher already reports unknown tools
 * to the caller, and an audit helper is the wrong place to turn a bad tool name into a 500. The coverage
 * test is what guarantees no *registered* tool reaches here unclassified.
 *
 * `args` is the call's own arguments, and it is OPTIONAL on purpose: a caller that does not have them
 * gets the capability's first operation, which is what every caller got before `Q-37`. Only a tool with
 * a chooser reads them.
 */
export function mcpAuditOperation(toolName: string, args?: unknown): string | null {
  const op = MCP_TOOL_OPERATIONS[toolName] ?? null;
  if (!Array.isArray(op)) return op;

  // The first of a list is the default and the fallback. A list says which REST operations the same
  // capability is reachable through; it does not make one call produce two audit entries.
  const first = op[0] ?? null;
  const choose = MCP_OPERATION_SUBJECTS[toolName];
  if (!choose) return first;

  try {
    const picked = choose(args);
    // A chooser that names an operation outside its own capability would write an audit row no route
    // records, which is unqueryable — worse than the default, so it is refused rather than trusted.
    return op.includes(picked) ? picked : first;
  } catch {
    return first;
  }
}

/**
 * Which operations are READS — logged only when `audit.logReads` is on, which it is not by default.
 *
 * ## Derived from the route rules, and it used to be a second list
 *
 * This was nine operation names written out here, beside the eighteen the REST rules already declare
 * with `read: true`. One rule, two implementations, and the weaker one winning silently — the defect
 * class this repo produces most, sitting on a switch an operator sets deliberately.
 *
 * **The 5.0 renames broke it and the break shipped.** `query` became `filter` and `find_similar` became
 * `similar`; the map above was updated and the hand-written set was not. So it still named
 * `brain.query`, which nothing records any more, and named neither `brain.filter` nor `brain.similar` —
 * the two highest-volume read paths an agent has. An operator on the default configuration got every one
 * of those calls in an audit log they had configured not to log reads, and nothing said so: a read
 * logged as a write is an extra row, not an error.
 *
 * A dead name in a hand-written set is invisible for the same reason — a classification nothing consults
 * is never wrong out loud — which is how `brain.query` survived the rename that removed it.
 *
 * ## So the ROUTE RULES are the declaration and this reads them
 *
 * `read: true` sits on the rule, next to the route it describes, where the person adding a route sees
 * it. Deriving from there means a capability cannot be a read on one door and not the other, and a new
 * read route classifies the MCP tool that mirrors it without anybody remembering to.
 *
 * `mcp-audit-coverage.test.js` holds the three halves of that: nothing here is a name no door records,
 * every REST read is one here, and every non-mutating TOOL records an operation that is one here.
 */
export const MCP_READ_OPERATIONS: ReadonlySet<string> =
  new Set(ROUTE_RULES.filter(r => r.read && r.operation).map(r => r.operation));

export function isMcpReadOperation(operation: string): boolean {
  return MCP_READ_OPERATIONS.has(operation);
}
