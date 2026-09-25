/**
 * Capabilities that exist over REST and not over MCP, declared rather than discovered.
 *
 * ## Why this file exists
 *
 * The canary operator, 2026-08-11T1722Z, and the principle is theirs: *"The rights matrix decides what a token may
 * do; the surface should not also decide whether it can."* They hit five of these in one day of ordinary work —
 * none from auditing the API — and the worst part of the report is not the five. It is that they could not tell
 * **absent** from **gated**: a capability hidden behind a right they lacked and a capability that was never
 * built look identical from outside, and one is a documentation fix while the other is an afternoon.
 *
 * So the gap is written down, machine-readable, with the reason beside it. A hole becomes a row with a blank
 * rather than a discovery. Their own smaller ask was exactly this, and it is worth shipping ahead of parity
 * itself because it makes the remaining work legible to the people waiting on it.
 *
 * ## The rule this file is under
 *
 * A row here is a PROMISE THAT SOMETHING IS MISSING. `mcp-rest-parity.test.js` asserts both halves of every row:
 * the REST route named actually exists, and no MCP tool by that name exists. So a row cannot rot in either
 * direction — the day someone builds `reindex` as a tool, the gate fails until the row is deleted, and the day
 * someone renames the REST route, the gate fails until the row is corrected.
 *
 * That is deliberate. A hand-maintained list is what produced five gaps; a hand-maintained list of the gaps
 * would produce the same problem one level up.
 */

/** One capability reachable over REST and not over MCP. */
export interface RestOnlyCapability {
  /** What an operator would call it. */
  capability: string;
  /** The REST route, exactly as the router declares it. Asserted to exist. */
  restEndpoint: string;
  /**
   * HTTP method, for a caller building the request.
   *
   * `PUT` was missing until 5.0 and the omission was invisible while the list was empty — the union
   * described the methods the rows happened to use rather than the ones the API has.
   */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The tool name it WOULD have, asserted NOT to exist while this row stands. */
  wouldBeTool: string;
  /** Why it is not on MCP yet — never "no reason", because that is what a blank invites. */
  why: string;
}

/**
 * The five they reported, minus the ones now built. Nothing invented alongside them.
 *
 * Confirmed absent rather than gated on 2026-08-12 by reading the tool registry: 34 tools, none of which was a
 * reindex, a token list, a `retry_embed_file` or a space create. `update_space` existed but accepted only `label`,
 * `purpose` and `description`, so nothing on MCP wrote a schema — their reading was right on every one.
 *
 * **Four of the five rows have now been deleted by being built**, which is the only way a row leaves this list:
 * `retry_embed_file`, `list_tokens`, `schema_update`, `save_space`. Two of those needed their route's
 * validation extracted into a shared function first, because `createSpace()` and `updateSpace()` both already
 * existed — which is what made a "just add a tool" fix dangerous rather than easy.
 *
 * **And then the fifth, `reindex`.** This said *"one row left"* and that the extraction was its own future work — it
 * has since been done: the re-embedding loop moved out of the route handler into `brain/reindex.ts` and
 * `space_reindexTool` calls it. Nothing is left, which is what the empty array below says.
 *
 * `mcp-rest-parity.test.js` asserts both halves of every surviving row — the REST route exists, and no MCP tool by
 * that name does — so a row cannot rot in either direction.
 */
export const REST_ONLY_CAPABILITIES: readonly RestOnlyCapability[] = [
  /*
   * THE LIST WAS EMPTY AND THE EMPTINESS WAS FALSE. It said so itself — *"EMPTY, and that is the finished
   * state rather than an oversight"* — and `help` published that to every caller as a promise that the two
   * surfaces reach the same things.
   *
   * Two capabilities were missing the whole time, and nobody could have found them from here.
   * `mcp-rest-parity.test.js` asserts both halves of every ROW, so with zero rows it asserted nothing, for
   * ever. A gate whose title is a claim about a whole surface, reading a list that is empty.
   *
   * `every-rest-route-is-answered-or-declared.test.js` is the fix and it works the other way round: it
   * DERIVES all 222 mounted routes and requires each to be answered by a named tool, declared here, or
   * classified as not a capability with a reason. A route in none of the three fails. So this list can no
   * longer be empty-and-wrong — it can only be wrong by somebody writing a reason they do not believe.
   */
  {
    capability: "a file's ORIGINAL BYTES",
    restEndpoint: '/api/files/:spaceId',
    method: 'GET',
    wouldBeTool: 'download_file',
    why: '`read_file` returns EXTRACTED TEXT, which is the right answer for a document and the wrong one for a PNG, a zip or a signed PDF. There is no MCP route to the bytes at all, and the two are easy to mistake for each other because the text answer succeeds.',
  },
  {
    capability: 'the MEDIA embedding queue',
    restEndpoint: '/api/brain/spaces/:spaceId/embedding-queue/media',
    method: 'GET',
    wouldBeTool: 'list_media_jobs',
    why: '`list_embed_jobs` lists RECORD jobs. Media — images, audio, video — is a separate queue with its own failures, and it is priced `files: read` where the record queue is `knowledge: read`, so the two are not one capability wearing two paths. `retry_embed_media` can RETRY what an MCP caller cannot list.',
  },
  {
    capability: 'the rights catalogue',
    restEndpoint: '/api/tokens/rights-catalog',
    method: 'GET',
    wouldBeTool: 'rights_catalog',
    why: '`help` publishes WHICH spaces you reach and where you administer, and then points at this REST URL for the definition of the rungs — so our own help text tells an MCP caller to leave MCP.',
  },
  {
    capability: 'write ONE type schema',
    restEndpoint: '/api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName',
    method: 'PUT',
    wouldBeTool: 'schema_type_update',
    why: 'MCP can only replace the WHOLE schema map, through `schema_update`. That needs `schema: admin` where this route needs `schema: write`, and it is a read-modify-write, so two agents editing different types can lose one of the edits. The narrow write has no tool.',
  },
  {
    capability: 'join a network',
    restEndpoint: '/api/networks/:id/join',
    method: 'POST',
    wouldBeTool: 'network_join',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
  {
    capability: 'join a REMOTE network',
    restEndpoint: '/api/networks/join-remote',
    method: 'POST',
    wouldBeTool: 'network_join_remote',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
  {
    capability: 'add a member',
    restEndpoint: '/api/networks/:id/members',
    method: 'POST',
    wouldBeTool: 'network_member_add',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
  {
    capability: 'remove a member',
    restEndpoint: '/api/networks/:id/members/:instanceId',
    method: 'DELETE',
    wouldBeTool: 'network_member_remove',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
  {
    capability: 'adopt a member',
    restEndpoint: '/api/networks/:id/members/:instanceId/adopt',
    method: 'POST',
    wouldBeTool: 'network_member_adopt',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
  {
    capability: "revert a member's parent",
    restEndpoint: '/api/networks/:id/members/:instanceId/revert-parent',
    method: 'POST',
    wouldBeTool: 'network_member_revert_parent',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
  {
    capability: 'reparent this instance',
    restEndpoint: '/api/networks/:id/reparent-self',
    method: 'POST',
    wouldBeTool: 'network_reparent_self',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
  {
    capability: "set a member's signing key",
    restEndpoint: '/api/networks/:id/members/:instanceId/signing-key',
    method: 'PUT',
    wouldBeTool: 'network_signing_key',
    why: 'governing a network is partly on MCP: an agent can read, create, update and leave one, add a space to it, see and cast its votes, read its sync history, mint an invite key and fork it (`network_get`, `network_create`, `network_update`, `network_leave`, `network_add_space`, `network_votes`, `network_vote`, `network_sync_history`, `network_invite`, `network_fork`), see peers and trigger a sync — and cannot yet join one or manage its members.',
  },
] as const;

/**
 * The capability map `help()` reports, so a caller can see the gap without asking anyone.
 *
 * Shaped as rows rather than prose because they asked for something machine-readable: their agents branch on it.
 */
export function restOnlyCapabilityMap(): {
  note: string;
  capabilities: { capability: string; mcpTool: null; restEndpoint: string; method: string; why: string }[];
} {
  return {
    note: 'These capabilities exist over REST and are NOT yet on MCP. Each row is a confirmed absence, not a '
      + 'permission you lack — a tool you cannot see because of your token is hidden from tools/list instead.',
    capabilities: REST_ONLY_CAPABILITIES.map(c => ({
      capability: c.capability,
      mcpTool: null,
      restEndpoint: c.restEndpoint,
      method: c.method,
      why: c.why,
    })),
  };
}
