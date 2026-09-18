/**
 * Which MCP tool answers which REST route — the classification, held once.
 *
 * ## Why it is here and not in three places
 *
 * It was in three. `scripts/surface-matrix.mjs` kept a list to RENDER the published capability table,
 * `mcp-rest-parity.test.js` kept the inverse as a list of gaps, and a third would have gone into the
 * route-coverage gate. The renderer's copy is the one that shows what that costs: it mapped
 * `GET /api/files/:spaceId` to `read_file` and published that for a month — **the bytes route answered by
 * the tool that returns extracted TEXT**, which is the exact gap `B-7` found by hand. One rule, three
 * implementations, and the one nobody ran was the one being published.
 *
 * So: this module says what is answered, `parity.ts` says what is missing, and both consumers read them.
 *
 * ## What the SUBJECT set is, and why this list is not it
 *
 * The routes are derived — `mountedRoutes()` reads them out of the source, and
 * `every-rest-route-is-answered-or-declared.test.js` requires every one to appear here, in `parity.ts`, or
 * in `NOT_A_CAPABILITY`. So a new route cannot go unclassified.
 *
 * What cannot be derived is the JUDGEMENT. Whether `POST /api/spaces/:id/reembed` is the same capability
 * as `space_reindex` is a question about meaning, and a heuristic reading the path would be confidently
 * wrong in both directions — `filter` answers eight routes whose paths share nothing with its name.
 */

/**
 * Route → the tool that does the same thing, grouped the way the published table reads.
 *
 * `section` is presentation only. `tool` is asserted to exist, and `method`+`path` are asserted to be a
 * route this server actually mounts, so an entry cannot rot in either direction.
 */
export const CAPABILITIES = [
  ['Brain — facts', 'save_fact', 'POST /api/brain/spaces/:spaceId/facts'],
  ['Brain — facts', 'update_fact', 'PATCH /api/brain/spaces/:spaceId/facts/:id'],
  ['Brain — facts', 'delete_fact', 'DELETE /api/brain/spaces/:spaceId/facts/:id'],

  ['Brain — entities', 'save_entity', 'POST /api/brain/spaces/:spaceId/entities'],
  ['Brain — entities', 'update_entity', 'PATCH /api/brain/spaces/:spaceId/entities/:id'],
  ['Brain — entities', 'delete_entity', 'DELETE /api/brain/spaces/:spaceId/entities/:id'],
  ['Brain — entities', 'delete_entity_preview', 'GET /api/brain/spaces/:spaceId/entities/:id/cascade-preview'],
  ['Brain — entities', 'graph_merge', 'POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId'],

  ['Brain — edges', 'save_edge', 'POST /api/brain/spaces/:spaceId/edges'],
  ['Brain — edges', 'update_edge', 'PATCH /api/brain/spaces/:spaceId/edges/:id'],
  ['Brain — edges', 'delete_edge', 'DELETE /api/brain/spaces/:spaceId/edges/:id'],

  ['Brain — chrono', 'save_chrono', 'POST /api/brain/spaces/:spaceId/chrono'],
  ['Brain — chrono', 'update_chrono', 'PATCH /api/brain/spaces/:spaceId/chrono/:id'],
  ['Brain — chrono', 'delete_chrono', 'DELETE /api/brain/spaces/:spaceId/chrono/:id'],

  ['Brain — links', 'save_link', 'POST /api/brain/spaces/:spaceId/links'],
  ['Brain — links', 'delete_link', 'DELETE /api/brain/spaces/:spaceId/links/:id'],
  ['Brain — links', 'graph_link_preflight', 'GET /api/brain/spaces/:spaceId/links/convert-preflight'],

  ['Brain — search', 'recall', 'POST /api/brain/recall'],
  ['Brain — search', 'filter', 'POST /api/brain/filter'],
  ['Brain — search', 'similar', 'POST /api/brain/similar'],
  ['Brain — search', 'graph_traverse', 'POST /api/brain/spaces/:spaceId/traverse'],

  ['Brain — bulk', 'save_bulk', 'POST /api/brain/spaces/:spaceId/bulk'],

  // ONE route, because it was five — each hard-coding a collection against a tool taking `types[]`.
  // `delete_space_data` had a row here and no longer needs one: it is reached through the generic tool
  // door below, like every other tool. A row per tool would be forty-five hand-written copies of a
  // mapping that is now the route's own definition.

  /*
   * `DELETE /api/brain/spaces/:spaceId/files?path=` deletes ONE file's metadata record, and `B-7` filed
   * it here under the wipe — which is how it nearly went with the five, taking a real capability with it.
   * It is `delete_file`'s metadata half and belongs beside the other file rows, not in a bulk wipe.
   */

  ['Brain — ops', 'space_stats', 'GET /api/brain/spaces/:spaceId/stats'],
  ['Brain — ops', 'space_reindex', 'POST /api/brain/spaces/:spaceId/reindex'],
  ['Brain — ops', 'list_embed_jobs', 'GET /api/brain/spaces/:spaceId/embedding-queue/records'],
  // The MEDIA queue is a different queue from the record one, and priced differently — `files: read`
  // against `list_embed_jobs`'s `knowledge: read`. Mapping them together claimed a coverage that would
  // also have been a rung claim, and `mcp-tool-rights` said so. Declared as a gap in `parity.ts`.
  ['Brain — ops', 'retry_embed_record', 'POST /api/brain/spaces/:spaceId/embedding-queue/records/retry'],
  ['Brain — ops', 'retry_embed_media', 'POST /api/brain/spaces/:spaceId/embedding-queue/media/retry-failed'],

  // `read_file` answers the EXTRACTED-TEXT route and nothing else. The bytes route is a declared gap in
  // `parity.ts`; mapping it here is the error that published a false claim for a month.
  ['Files', 'write_file', 'POST /api/files/:spaceId'],
  ['Files', 'move_file', 'PATCH /api/files/:spaceId'],
  ['Files', 'delete_file', 'DELETE /api/files/:spaceId'],
  ['Files', 'create_dir', 'POST /api/files/:spaceId/mkdir'],
  ['Files', 'retry_embed_file', 'POST /api/files/:spaceId/retry_embedding'],
  ['Files', 'read_file', 'GET /api/brain/spaces/:spaceId/files/extract'],
  ['Files', 'update_file_meta', 'PATCH /api/brain/spaces/:spaceId/files'],

  ['Spaces', 'list_spaces', 'GET /api/spaces'],
  ['Spaces', 'save_space', 'POST /api/spaces'],
  ['Spaces', 'update_space', 'PATCH /api/spaces/:id'],
  ['Spaces', 'space_meta', 'GET /api/spaces/:id/meta'],
  ['Spaces', 'schema_update', 'PUT /api/spaces/:id/schema'],
  // The PER-TYPE write is NOT `schema_update` and mapping it here overstated the coverage.
  // `schema_update` replaces the whole map at `schema: admin`; this route edits ONE type at
  // `schema: write`. An agent reaching it through the whole-map replace needs a higher rung and a
  // read-modify-write, which can lose a concurrent edit. Declared as a gap in `parity.ts`.
  /*
   * PAIRED WITH `space_reembed`, NOT `space_reindex`, and the correction is the point.
   *
   * This row said `space_reindex` and the docblock above flags exactly this as the judgement that cannot
   * be derived. It was the wrong one: reindex re-embeds EVERY record with the configured model and
   * returns immediately; this backfills records with NO vector and the counts it returns are the answer.
   * So the route was REST-only, and the parity gate read a covered capability because the map said so.
   */
  ['Spaces', 'space_reembed', 'POST /api/spaces/:id/reembed'],

  ['Tokens', 'list_tokens', 'GET /api/tokens'],
  ['Tokens', 'list_tokens', 'GET /api/brain/spaces/:spaceId/token-access'],
  // `help` publishes which spaces this connection reaches and where it administers — the substance of
  // `GET /api/tokens/me`, delivered on connect rather than on request.
  ['Tokens', 'help', 'GET /api/tokens/me'],

  // `network_peers` lists PEERS. The sync HISTORY is a different answer and is a declared gap —
  // mapping it here was the same mistake the file-bytes row documents, caught by the gate below.
  // `network_peers` is the READ of what this instance is connected to, flattened across networks —
  // the same question `GET /api/networks` answers, in the shape an agent wants. Everything else about
  // a network is a declared gap in `parity.ts`.
  ['Networks', 'network_peers', 'GET /api/networks'],
  ['Networks', 'network_sync', 'POST /api/networks/:id/sync'],
  ['Networks', 'network_sync', 'POST /api/networks/peers/:peerId/sync'],
];

/**
 * Routes that are not a capability an MCP caller would reach for, each with the reason.
 *
 * Keyed by PREFIX where a family shares one reason — a reason repeated twenty-eight times is a reason
 * nobody reads. A prefix claims its whole subtree, so the risk is a real capability hiding under one:
 * each entry therefore says what the family IS, not merely that it is exempt.
 */
export const NOT_A_CAPABILITY = new Map(Object.entries({
  '/api/sync': 'the peer-to-peer wire protocol. Spoken by instances, never by an agent — a tool here would '
    + "let a caller forge another instance's replication traffic.",
  '/api/admin': 'instance administration: backups, restores, offsite targets, audit retention, the model '
    + 'registry. An operator surface behind instanceAdmin, deliberately not reachable by an agent holding '
    + 'space rights.',
  '/api/schema-library': 'the instance-wide schema library. Owner ruling: read is instance-wide and helps '
    + "nobody without write on a space's schema; write, manage and govern are instance-admin. A "
    + 'space-scoped agent has nothing to do here.',
  '/api/setup': 'first-run setup, before any token exists.',
  '/api/auth': 'browser session login.',
  '/api/mfa': 'browser second factor.',
  '/api/invite': 'operator invitation flow, consumed in a browser.',
  '/api/theme': "the UI's own colour theme.",
  '/api/notify': 'outbound notification plumbing configured by an operator.',
  '/api/about': 'build and version metadata. `help` already carries what an agent needs.',
  '/metrics': 'the Prometheus scrape endpoint.',
  '/mcp': 'the MCP transport itself.',
  '/api/files/mcp-oauth/consent': 'the browser consent screen for an MCP OAuth client.',
  '/api/files/:spaceId/upload-status': 'progress of an upload in flight, polled by the uploader that '
    + 'started it. An MCP `write_file` is one call that returns when it is done.',
  '/api/brain/spaces/:spaceId/events': 'the server-sent event stream the UI subscribes to for live '
    + 'updates, and its short-lived ticket. A long-lived stream is not a tool call.',
  '/api/brain/spaces/:spaceId/activity': 'the per-space usage dashboard — an operator question about '
    + 'demand, not a knowledge capability.',
  '/api/brain/spaces/:spaceId/reindex-status': 'the poll target while a reindex runs. `space_meta` '
    + 'carries `needsReindex`, which is what an agent branches on — and this route is priced '
    + '`knowledge: read` while `space_meta` is `schema: read`, so they are not one call.',
  '/api/spaces/:id/activity/reset': 'clears that usage dashboard.',
  '/api/spaces/reorder': 'the order spaces appear in the UI sidebar.',
  '/api/spaces/:id/rename': 'renaming a space moves every collection it owns. Space-admin, and a '
    + 'destructive-adjacent operation deliberately kept off the agent surface.',
  '/api/spaces/:id/rebuild-indexes': 'rebuilds the Atlas search indexes — a repair for a broken index, '
    + 'which is an operator diagnosis rather than something an agent can know it needs.',
  '/api/spaces/:id/validate-schema': 'dry-runs a schema against stored records, for the schema editor.',
  '/api/spaces/:id/completeness': 'the schema-completeness meter the UI draws.',
  '/api/spaces/:id': 'DELETE removes a space and everything in it. Instance-admin — `delete_space_data` is '
    + 'the agent-reachable half, which empties a space without destroying it.',
  '/api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName': 'GET and DELETE of one type schema. '
    + '`space_meta` returns them all and `schema_update` writes them; deleting one is schema-admin.',
  '/api/conflicts': 'the sync conflict queue an operator resolves by hand.',
  '/api/duplicates': 'the duplicate-review queue an operator resolves by hand.',
  '/api/contradictions': 'the contradiction-review queue an operator resolves by hand.',
  // The credential surface. `list_tokens` gives an agent visibility; MINTING is the line.
  '/api/tokens/:id': 'editing, deleting and regenerating a token. An agent that can mint or re-issue '
    + 'credentials can outlive and out-scope the session it was given, so the write half of the token '
    + 'surface is deliberately operator-only. `list_tokens` provides the visibility.',
}));

/*
 * `POST /api/tokens` MINTS one, and it shares a path with `GET /api/tokens`, which `list_tokens` answers.
 *
 * So this entry is keyed `METHOD /path` rather than by path alone: a key containing a space matches that
 * one route exactly, a key without one claims a whole subtree. A bare `/api/tokens` prefix here would have
 * swallowed the two token routes that ARE answered, and a future token capability with them — an
 * exemption that quietly widens is the thing this file's reasons exist to prevent.
 */
NOT_A_CAPABILITY.set('POST /api/tokens', NOT_A_CAPABILITY.get('/api/tokens/:id'));

/**
 * The generic tool door — the one route that answers EVERY tool.
 *
 * `POST /api/<tool-name>` is served by a single `/:tool` route that hands the body to `callTool`, the same
 * function the MCP dispatcher calls. So it is neither one capability (it is all of them) nor an exemption
 * (nothing about it is un-tooled), and classifying it as either would say something false in a file whose
 * whole job is the classification.
 *
 * It gets its own bucket, and the sweep treats it as covering every tool at once. What keeps that honest is
 * that the coverage is STRUCTURAL: there is no per-tool code behind this path to be missing.
 */
export const THE_TOOL_DOOR = 'POST /api/:tool';
