/**
 * MCP retrieval tools — cross-type semantic search over the brain.
 *
 * `recall` (vector search across all knowledge types, with optional graph traversal),
 * `find_similar` (nearest-neighbour to an existing record), and `query` (structured MongoDB
 * read) were split out of the memory-tools bundle: they search memories, entities, edges, chrono
 * entries, and files alike, so they belong with the read/search surface rather than memory CRUD.
 */

import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { BRAIN_COLLECTIONS, type BrainCollection } from '../../config/types.js';
import { RECORD_TYPES } from '../../config/types.js';
import { UUID_V4_RE, formatRecallSummary, toRecallRecord, uuidSchema, unitScoreSchema, QUERY_FILTER_OPERATORS } from './shared.js';
import { MAX_RECALL_TRAVERSE } from '../../brain/recall-seed-traversal.js';
import { mapGraphNodes, graphNodeRecord } from '../../brain/recall-graph.js';
import { stripRecordMeta } from '../../brain/recall-record-meta.js';
import { applyProjection, normaliseProjection } from '../../brain/projection.js';
import { resolveBudget, resolvePaging, budgetedEnvelope, applyBudget, budgetFields, type BudgetRequest, MCP_DEFAULT_MAX_CHARS } from '../../brain/result-budget.js';
import { buildGraphWithSpill, spillResultSet, countGraphNodes } from '../../brain/graph-spill.js';
import { parseTraverseOption, traverseOptionSchema } from '../../brain/traverse-option.js';
import { type FilterExpression } from '../../brain/filter.js';
import { resolveRecallFilter, type RawMongoFilter } from '../../brain/recall-filter.js';
import {
  queryBrain, countBrain, compareBySort, DEFAULT_QUERY_SORT, QUERY_PAGE_MAX, PROXY_PAGE_CEILING,
} from '../../brain/query.js';
import { parseSortParam, toMongoSort, SORTABLE_FIELDS } from '../../brain/list-sort.js';
import { type RecallKnowledgeType, type RecallResult, findSimilar, recall, recallGlobal } from '../../brain/recall.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { pageAcrossMembers } from '../../spaces/page-across-members.js';
import { NotFoundError } from '../../util/errors.js';
import {
  rankOf, byRankThenId, mergeRecallResults, rankingFields,
} from '../../brain/recall-shape.js';

/**
 * Space scope for find_similar — mirrors recall's omit-space idiom (F1 consistency).
 *
 * - `space` given, without `crossSpace`: locate the source in that proxy-resolved space and search only
 *   there (searchIds `undefined` → findSimilar searches just the base space).
 * - `space` omitted, or `crossSpace: true`: locate the source across ALL accessible spaces (first base that
 *   holds the entry wins) and search across all of them.
 *
 * **`crossSpace` is NOT deprecated, and this docblock called it that in both bullets** — the word was
 * removed from the tool's own schema description on purpose, and left standing here. It looked like a pure
 * duplicate of omitting `space`, and removing it from the tool turned the MCP/REST parity gate's
 * `find-similar ↔ find_similar` case red: **the REST route takes the space in its PATH**, so *"omit the
 * space"* is not expressible there and `crossSpace: true` is REST's only route to the same capability.
 * Dropping it on one door alone is exactly the parameter-level divergence that gate exists to catch.
 *
 * Pure (proxy resolver injected) so the scope logic is unit-testable without a database.
 */
export function resolveFindSimilarScope(
  callSpace: string | undefined,
  crossSpace: boolean,
  accessibleSpaceIds: string[],
  /**
   * Expand a space to its members, ALREADY narrowed to what the caller may see.
   *
   * Injected rather than imported so this stays testable without a config — and that injection is what made the Q-6
   * narrowing a one-line change here instead of a signature rewrite. It is also why the parameter is documented: a
   * caller passing the raw `resolveMemberSpaces` would compile, run, and quietly widen a proxy back to every member.
   */
  resolveMembers: (space: string) => string[],
): { candidateBases: string[]; searchIds: string[] | undefined } {
  if (callSpace && !crossSpace) {
    const members = resolveMembers(callSpace);
    return { candidateBases: [members[0] ?? callSpace], searchIds: undefined };
  }
  return { candidateBases: accessibleSpaceIds, searchIds: accessibleSpaceIds };
}

export const recallTool: ToolHandler = {
  name: 'recall',
  description: 'Search all knowledge types (memories, entities, edges, chrono entries, files) by MEANING and by exact tokens: a semantic vector ranking is fused with a lexical (BM25) ranking, so identifiers such as article numbers or form ids rank even though their embeddings carry little meaning. A cross-encoder refines the top candidates when the operator has configured one. Searches the specified space if provided, otherwise across all accessible spaces.\n\n'
    + 'THE RESPONSE, because knowing the parameters is only half of it:\n'
    + '• `results` — the ranked matches. Each carries `_id`, its name/fact/title, type, tags, properties, `spaceId`, timestamps and `score` (vector similarity).\n'
    + '• WHAT THIS DOOR DOES NOT SEND YOU, so you do not go looking for a flag to switch it off: the embedding VECTOR (never returned by anything here, and no parameter can ask for it), `matchedText` (the pre-embedding source string — for a file chunk it is the passage a SECOND time), `embeddingModel` (identical for every record in a space), and `seq` (a sync counter that is not an input to any tool). Withheld on REST too, with the same default, since 3.1.0 — `includeDiagnostics: true` restores them on either door and applies recursively, so a `traverse` answer\'s `_graph` follows it at every depth. Leave it off: each of these is multiplied by `topK` and paid for in your context, and you want them only to answer WHY something ranked where it did. The other size lever is `includeContent: false`, which drops file-passage bodies and keeps their locations.\n'
    + '• `count` — the number of MATCHES. Traversed nodes are NOT counted in it.\n'
    + '• `graphNodes` — an integer COUNT of what a traversal reached, not the content. The content is nested per-result under `_graph`, and a result with no edges simply has no `_graph` at all: reading `results[0]` and concluding the feature is absent is the mistake to avoid.\n'
    + '• THE SIZE ANSWER, and it is a slope now rather than a cliff. `returned`, `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned` and `bytesReturned` are on EVERY response, so you never have to interpret an absence (`budgetBytes` is null unless you asked for a byte ceiling). `results` is a PREFIX of the ranked matches that fits BOTH ceilings you set, and every record in it is WHOLE — full body, full properties, its complete `_graph`, byte-identical to that record from an unbudgeted call. A match is counted together with its whole `_graph` subtree, so a deeper or wider traversal means fewer matches fit — they are absent, not shortened. When `truncated` is true, `nextSkip` says where to continue from — send it back as `skip` for the next prefix. The matches that did not fit are also written to the space as a JSON file (authenticated download, valid one day) and reported as `remainder`, but ONLY if you ask with `remainderDump: true`.\n'
    + '  Until 3.2.0 this was a record CAP that collapsed a large answer to three inline records plus a download of the whole set — including the three you already had. That roughly doubled what a caller had to read, so most abandoned the remainder. If you have logic keyed on `complete` or on a hard 25, it is `remainder` and a byte budget now.\n'
    + '• `graphTruncated` + `graphComplete` — the same arrangement for an oversized neighbourhood, so a short graph is never silent either. `graphTruncated` can arrive ALONE: the link scans are bounded per hop, and a hop that spends its budget on already-visited records leaves a graph that is short with no complete copy to write, because the records missing from it were never read.',
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.optionalSpace,
            query: { type: 'string', minLength: 1, description: 'REQUIRED, non-empty. The natural-language search string. It is EMBEDDED for the vector half and TOKENISED for the BM25 half, so it does double duty — which is why an exact identifier (an article number, a form id) survives a query written as a sentence.' },
            /*
             * NO MAXIMUM, on EITHER door — owner's ruling on `P-34`. REST used to clamp this to 100
             * silently while this door accepted anything, so `topK: 500` returned 100 through one and 500
             * through the other. His question settled it: the byte budget already returns whole records
             * and reports truncation, so the answer never needed a cap, and the bound belongs on the WORK
             * instead — see `MAX_PER_TYPE_CANDIDATES` and `MAX_GRAPH_NODES`.
             */
            topK: { type: 'number', minimum: 1, default: 10, description: 'Max results to return. Default 10, and NO ceiling — the same on both doors since 4.0, where REST used to clamp to 100 silently. What comes back is bounded by the byte budget instead: every record whole, `truncated` on every response, and `nextSkip` when it bit. It is filled from records that SATISFY `filter` — never applied to an already-truncated shortlist — so a filtered recall cannot silently miss a matching record. Large values are slower, and every field of every result is paid for in tokens. Note the response cap, which is BYTES and not a count: the answer is a prefix that fits `maxBytes` (default 25000 on this door), `truncated` says whether it bit, and `nextSkip` is how you continue. So asking for 80 does not return 80 inline — how many it does return depends on how big they are, which is why the old sentence here saying "past roughly 25 results" was wrong from 3.2.0 onward.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter — only results bearing ALL of these tags are returned (applies to memories, entities, chrono entries, and files).' },
            types: {
              type: 'array',
              items: { type: 'string', enum: [...RECORD_TYPES] },
              description: 'Optional knowledge-type filter — restrict results to one or more types. Omit to search all five. EDGES ARE SEARCHABLE RECORDS and compete for your topK: a topK 20 on a persona space came back with 2 of them, so structural relationships displace knowledge unless you exclude them here.',
            },
            minPerType: {
              type: 'object',
              description: 'Optional minimum result count per type — a FLOOR. Guarantees at least that many results of each type if available (e.g. {"entity": 2, "edge": 1}). Omit to use pure score ranking. This is the cheap fix for one type crowding out another: memories are numerous and score well, so principles and entities lose slots to them without a floor.',
              // `minimum: 0` and integers only, matching the `maxPerType` beside it and the REST door,
              // which answers `400 minPerType.<key> must be a non-negative integer`. This declared a
              // bare number, so MCP admitted a negative and a fraction where REST refused both — an
              // omission rather than a policy, one line from the neighbour that got it right.
              additionalProperties: { type: 'integer', minimum: 0 },
            },
            maxPerType: {
              type: 'object',
              description: 'Optional MAXIMUM result count per type — the ceiling to minPerType\'s floor (e.g. {"file": 2, "memory": 4}). A slot freed by the cap goes to another type, so this is how you stop one long file chunk from crowding out several one-line records that would answer the query more cheaply. At least 1 per type; use `types` to exclude a type entirely. Must not be below minPerType for the same type — a contradictory pair is refused rather than silently resolved.',
              additionalProperties: { type: 'number', minimum: 1 },
            },
            maxTimeMS: {
              type: 'number',
              minimum: 1,
              description: 'Optional deadline for this recall, in milliseconds. It can only LOWER the instance budget, never raise it, and is clamped to a small floor so a tiny value is not a guaranteed empty answer. On expiry you get a PARTIAL answer rather than an error or a hang: whichever collections finished are returned, and the response says it degraded. Use it when a slow recall would cost more than a thin one — a memory that can only ever delay you by a known amount is one you can put in a workflow.',
            },
            minScore: unitScoreSchema('Minimum COSINE SIMILARITY (0.0–1.0). It filters on `score` ONLY — never on the fused or the reranked ordering — so it is a vector-side gate rather than a relevance gate, and a result the reranker would have promoted can be cut by it before the reranker sees it.'),
            includeFreshWrites: { type: 'boolean', default: false, description: 'Also scan the newest records straight from the collection, so a record written seconds ago is findable before the vector index has ingested it. Costs an extra scan per knowledge type — turn it on when searching for something you just wrote, not by default.' },
            includeContent: {
              type: 'boolean',
              default: true,
              description: 'Whether to return each file chunk’s `content` — the passage body (default true). '
                + 'Set false to get locations and metadata only: path, heading, chunk index, tags, properties. '
                + 'Use it for a two-phase flow — recall to find WHERE something is, then read only the chunk '
                + 'you decided you need.\n\n'
                + 'WHAT IT DOES NOT COVER, because the general argument below invites the wrong conclusion: '
                + 'this is FILE CHUNKS ONLY. On a search returning entities, memories, edges or chrono '
                + 'entries it changes nothing at all — their bodies are `description` and `properties`, and '
                + 'this flag does not touch them. An integrator lost a call finding that out. The lever for '
                + 'those is `projection`, which names fields on any type.\n\n'
                + 'The general argument is still true and is why both exist: every field a result carries is '
                + 'multiplied by topK and paid for in tokens, and passage bodies are by far the largest.',
            },
            includeRecordMeta: {
              type: 'boolean',
              default: false,
              description: 'Add back the fields that describe where a record SITS rather than what it says: `createdAt`, `updatedAt` and the link-id arrays (default false, and false is what you want almost always). Measured on a real corpus, only 30% of a recall answer was content and most of the rest was this. `createdAt` is the one to be careful of: it is when the RECORD was written, not when the remembered thing happened - that lives in the record\'s own properties, put there by whoever stored it. Turn this on when you need to act on the record\'s place in the store, not to read what it says. REST takes the same parameter with the same default.',
            },
            includeDiagnostics: {
              type: 'boolean',
              default: false,
              description: 'Add back the three RECORD fields a result carries for the SYSTEM rather than for you (default false, and false is what you want almost always): `matchedText` — the exact pre-embedding source string, which for a file chunk is the heading plus the passage, so the passage a SECOND time; `embeddingModel`, identical for every record in a space; and `seq`, a sync counter that is not an input to any tool. Turn it on to see WHICH TEXT was embedded, then turn it off — `matchedText` especially is multiplied by `topK` and paid for in your context. REST takes the same parameter with the same default. **THIS NO LONGER GOVERNS THE PER-STAGE SCORES.** `lexicalScore`, `fusedScore` and `rerankScore` come back on EVERY recall, on both doors, each present only if that stage ran — because they are the ORDERING, not payload. `score` is vector similarity, and precedence in a fused recall is `rerankScore > fusedScore > score`, so on an instance with a reranker the number that decided a result’s position was previously the one you could not see. Three floats are not a cost, so they do not belong behind a flag whose purpose is removing cost.',
            },
            projection: {
              type: 'object',
              description: 'Fields to include (1) or exclude (0), the same grammar `query` takes and applied to each result\'s `record` — dotted paths work, so `{"name": 1, "properties.status": 1}` is valid. REACH FOR THIS RATHER THAN SKIPPING IT: it is the difference between an answer you can read inline and one that overruns your context. Measured by an integrator before this existed — a search for fifteen names, a `from`, a `kind` and a `status` returned 100,547 characters where the wanted data was about 1.5 KB, and their client refused the response outright. IT APPLIES RECURSIVELY: a `traverse` answer\'s `_graph` nodes and edges are projected at every depth, which is where a large answer actually comes from. Inclusion and exclusion cannot be mixed (the non-`_id` fields decide which you meant), `_id` survives an inclusion projection unless you send `_id: 0`, and the embedding VECTOR can never be projected back in — an explicit `embedding: 1` is dropped rather than honoured. The ranking envelope (`score`, `spaceId`, `type`) sits outside `record` here and is never projected away, so you cannot lose the score you searched for.',
            },
            maxChars: {
              type: 'integer',
              minimum: 1000,
              description: 'Ceiling on the serialised response body, in CHARACTERS. **DEFAULT 25000 ON THIS DOOR, and 50000 on REST — the one place the two doors deliberately differ.** Both accept the same parameter with the same floor, the same ceiling and the same refusal; only the number applied when you say nothing differs, because an MCP tool result meets a hard per-result ceiling inside YOUR client that you cannot raise, while a REST body lands in a buffer its caller allocated. Measured: a caller received a 98356-character answer that was correct, in budget and fully specified, and their client refused it outright. 25000 is about 6 whole records at ~4 KB each, roughly 7000 tokens. RAISE IT IF YOUR CLIENT CAN TAKE MORE — up to 5000000. THIS IS THE PARAMETER THAT USED TO BE CALLED `maxBytes`: it always counted characters, which equal bytes only for ASCII. If your limit is really in bytes, use `maxBytes` — it counts real UTF-8 bytes now, and both apply when you set both.',
            },
            maxBytes: {
              type: 'integer',
              minimum: 1000,
              description: 'Ceiling on the serialised response body, in real UTF-8 BYTES. **NO DEFAULT — opt-in.** Set it when your limit is genuinely a byte limit, which a transport or buffer limit is. It is not defaulted because bytes are always ≥ characters, so a byte default equal to the character one would silently become the binding constraint on every non-ASCII answer. WHEN YOU SET BOTH, BOTH APPLY: the answer stops at whichever ceiling it reaches first, which for German or Polish content is about 26% sooner in bytes than the same number of characters suggests, and about 35% sooner for emoji. **THIS PARAMETER CHANGED MEANING IN 3.7** — it used to bound characters while its name, its refusal and its response field all said bytes. If you set it before and want the old behaviour, send the same number as `maxChars`.',
            },
            maxTokens: {
              type: 'integer',
              minimum: 1,
              description: 'A convenience onto `maxBytes`, converted with `charsPerToken` (default 3.5). If you send both, the SMALLER resulting byte figure applies — stating two ceilings means you meant both. It is an approximation and cannot be anything else, because the server does not know your tokeniser: the realistic span across these payloads is 3.0–3.9 chars/token, and 3.5 was chosen because the customary 4.0 UNDER-counts tokens and is worst exactly on graph-heavy responses. Undershooting costs one more page; overshooting costs a blown context, and those are not symmetric.',
            },
            charsPerToken: {
              type: 'number',
              exclusiveMinimum: 0,
              description: 'Override the chars-per-token ratio used to convert `maxTokens` into bytes (default 3.5). Only meaningful alongside `maxTokens`. Lower it if your tokeniser is denser than this payload shape assumes; there is no reason to raise it above ~4.',
            },
            skip: {
              type: 'integer',
              minimum: 0,
              description: 'How many of the ranked matches to skip before filling the byte budget (default 0). THIS IS HOW YOU READ A TRUNCATED ANSWER: a response with `truncated: true` also carries `nextSkip`, and sending that back gets you the next prefix — no match repeated, none missed. The ranking is recomputed per call, so this is a continuation over one ordered answer rather than a cursor over a snapshot; a write between two pages can shift what lands where. Skipping past the end returns zero results with `truncated: false`, which is how a loop knows it is done.',
            },
            remainderDump: {
              type: 'boolean',
              description: 'Also WRITE the matches that did not fit to the space as a JSON file, and report it as `remainder` (default false). Only meaningful when the answer truncates. Leave it off unless you actually want the whole set as one artifact — the file is a write on a read path, it counts against space storage, and paging with `skip`/`nextSkip` reaches the same records without creating one. It used to happen unconditionally on every truncated call, which meant a caller that only wanted the next page paid for a download it never opened.',
            },
            traverse: {
              // A depth, or a whole traversal minus its start node. Built from `TRAVERSE_OPTION_FIELDS` rather
              // than spelled out here — see `traverseOptionSchema`, which exists because these two tools each
              // held their own copy and both were left behind when the parser gained three flags.
              ...traverseOptionSchema(MAX_RECALL_TRAVERSE),
              description: 'Optional graph expansion depth (integer 0–5, default 0). When > 0, each semantic match is expanded along knowledge-graph edges up to this many hops, and what the walk reached is NESTED under the match that reached it in a `_graph` array: {edge, node, paths} per node, where `edge` is the whole edge document (description and tags included), `node` is the reached entity, and `paths` is every route to it as record ids, match first — so paths[0] is the nesting route and paths[0].length-1 is the hop count. A nested node carries its own `_graph`, so depth is a tree. `count` stays the number of MATCHES (traversed nodes are not in the ranked list and carry no score); `graphNodes` reports how many were reached. LINKS, since 3.6: a walk follows stored edges always, and the `entityIds` field a memory, chrono entry or file carries naming what it is about only when you ask — `{depth: 2, includeChrono: true, includeMemories: true, includeFiles: true}`, one flag per kind, ALL THREE DEFAULT FALSE. Off by default because you asked for matches and the answer is budgeted: a match is counted with its whole `_graph` subtree, so every record admitted by default is paid for in matches that no longer fit. Turn one on and two things change. A linked node arrives carrying `kind` (chrono|memory|file) and the fields that say what it is — the title and type of a chrono, the fact of a memory, the path/description/tags of a file, NEVER file chunk text. And a NON-ENTITY SEED stops being a dead end: a matched memory has no edges of its own, so the walk starts from the entities named by its `entityIds`, at hop 1. The reaching edge is SYNTHETIC — id `<label>:<from>:<to>`, label `chrono.entityIds`/`memory.entityIds`/`file.entityIds`, and no author/createdAt/seq because a derived edge has none; do not look one up by that id. `edgeLabels` filters them like any other label. With every flag off the behaviour is exactly what it was: a non-entity seed comes back with an empty `_graph` at any depth. If the neighbourhood is bigger than the inline cap the COMPLETE graph is written to the space as JSON and the response adds `graphTruncated: true` and `graphComplete: {nodes, path, download, expiresAt}` — an authenticated download, valid one day — so a short graph is never silent. `graphTruncated` WITHOUT `graphComplete` is a different and equally real case: the link scans are bounded per hop, and a hop can spend its budget on records it discards as already visited, leaving a graph that is short with nothing complete to write, because the records missing from it were never read. Narrow `edgeLabels` or ask for fewer hops. Use with filter/tags to narrow the seed set — traverse > 2 on dense graphs can be slow. Example: recall "auth token scoping" with traverse: 1 returns the matching records, each carrying everything one edge away. NARROWING, since 3.5: pass an OBJECT instead of a number to walk the graph the way the standalone `traverse` tool does — `{depth, edgeLabels, direction}`, which is a traverse call without its start node because the matches ARE the start nodes. `edgeLabels` follows only those labels; `direction` is one of outbound, inbound or both (default both, which is what a bare number does) and it narrows STORED EDGES ONLY. A link is a record with a from and a to since 4.0, but which way it runs is fixed by the KINDS at its ends rather than by the data — a memory names entities and entities name nothing — so there is nothing for direction to select between, and both traversals reach the entity it names whatever direction says. `{direction: inbound, includeMemories: true}` on a matched memory still returns the entities that memory NAMES. Before this the expansion followed EVERY edge in BOTH directions with no way to say otherwise, so one hop off a well-connected node returned whichever neighbours the cap happened to keep — narrow it and you get the neighbourhood you asked for instead. `limit` is deliberately not accepted here: in a recall the node cap comes from topK and the byte budget, and a traverse that could raise it would overrule the budget governing the rest of the answer. Example: recall "the dog" with `traverse: {depth: 2, edgeLabels: [owns, lives_in], direction: outbound}`.',
            },
            filter: {
              type: 'object',
              description: 'Optional property filter, in EITHER of two grammars. RAW MONGODB is accepted — the same operators `query` takes (`$or`, `$and`, `$not`, `$nor`, `$in`, `$regex`, `$elemMatch`, comparisons) nested to depth 8 — and so is the older one-operator-object-per-key form (`{"properties.status": {"eq": "x"}}`), which is ANDed across keys. A filter MIXING both is refused rather than resolved. Keys are allowlisted either way, including inside `$or`. A raw filter takes the exhaustive path (it cannot become a native index pre-filter), which is slower and returns the same records. **`topK` is filled from records that SATISFY the filter** — it is never applied to an already-truncated shortlist, so a filtered recall cannot silently miss a matching record. Two mechanisms deliver that: `tags`, `type`, `name`, `status`, `label` and schema-DECLARED `properties.<key>` with eq/in/gt/gte/lt/lte are pushed into the vector index as a native pre-filter, restricting the search to the matching subset; an undeclared `properties.*`, or `exists`/`ne`, falls back to scoring the whole space exhaustively and filtering after — slower, same results, still nothing dropped by `topK`. Declare a heavily-filtered property in the space schema to keep it on the fast path. Keys must use dot-notation and start with "properties.", "tags", "type", "name", "status", or "label" (any other key is rejected). Each value is an operator object with one or more of: eq, ne, in (array), exists (boolean), gt, gte, lt, lte. Example: { "properties.status": { "eq": "accepted" }, "properties.count": { "gt": 10 } }. Records not matching ALL filter conditions are excluded.',
              /*
               * NO STRUCTURAL CONSTRAINT HERE, and that is the fix rather than an omission.
               *
               * This declared `propertyNames: { pattern: RECALL_FILTER_KEY_PATTERN }` plus an
               * `additionalProperties` requiring every value to be an operator object of
               * eq/ne/in/exists/gt/gte/lt/lte with `additionalProperties: false`. So the schema accepted the
               * LEGACY grammar and nothing else — while the description two lines above promised raw MongoDB,
               * and REST delivers it.
               *
               * Measured on one instance, one space, the same instant, with the canary operator's own filter
               * `{type: 'message', 'properties.readBy': {$not: {$regex: 'ythril'}}}`:
               *
               *     REST  POST /recall  ->  200, returns the record
               *     MCP   recall        ->  isError: /filter/type: must be object;
               *                                      /filter/properties.readBy: unexpected property '$not'
               *
               * TWO refusals in one filter, and both are the schema being narrower than the server: a bare
               * `type: 'message'` is valid raw-Mongo equality, and `$not` is on the allowlist `query` takes.
               *
               * **The dispatcher validates arguments BEFORE the handler runs**, so a schema stricter than the
               * resolver is not a hint — it is a hard refusal the resolver never gets to answer. That is why
               * relaxing the schema is the whole fix: `resolveRecallFilter` already accepts either grammar,
               * refuses a MIXED one, and enforces the key allowlist RECURSIVELY so `$or` cannot smuggle a key
               * past it. Its errors are better than the schema's, because it knows which grammar you meant.
               *
               * `query`'s own filter is declared exactly this way — `type: 'object'` and a description — for
               * exactly this reason. Two tools, one grammar, and this was the copy that constrained it.
               */
            },
          },
          required: ['query'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace, accessibleSpaceIds } = ctx;
    const query = String(a['query'] ?? '');
    if (!query.trim()) throw new Error('query must not be empty');
    const topK = typeof a['topK'] === 'number' ? a['topK'] : 10;
    const tags = Array.isArray(a['tags']) ? (a['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    const types = Array.isArray(a['types']) ? (a['types'] as unknown[]).filter((t): t is RecallKnowledgeType => typeof t === 'string') : undefined;
    const minPerType = (a['minPerType'] != null && typeof a['minPerType'] === 'object' && !Array.isArray(a['minPerType']))
      ? (a['minPerType'] as Partial<Record<RecallKnowledgeType, number>>)
      : undefined;
    const minScore = typeof a['minScore'] === 'number' ? a['minScore'] : undefined;
    const includeContent = a['includeContent'] !== false;
    const includeDiagnostics = a['includeDiagnostics'] === true;
    const includeRecordMeta = a['includeRecordMeta'] === true;
    const recallProjection = normaliseProjection(a['projection'] as Record<string, unknown> | undefined);
    const budget = resolveBudget(a as BudgetRequest, MCP_DEFAULT_MAX_CHARS);
    if (!budget.ok) throw new Error(budget.error);
    const paging = resolvePaging(a as { skip?: unknown; remainderDump?: unknown });
    if (!paging.ok) throw new Error(paging.error);

    // The ceiling to minPerType's floor. Validated here as well as in the schema, because
    // `additionalProperties: { minimum: 1 }` cannot express "not below minPerType for the same type" — and
    // the REST route enforces both, so leaving MCP with only half is exactly the two-surfaces-one-rule gap
    // that #695, #697 and #700 were.
    let maxPerType: Partial<Record<RecallKnowledgeType, number>> | undefined;
    if (a['maxPerType'] != null) {
      if (typeof a['maxPerType'] !== 'object' || Array.isArray(a['maxPerType'])) {
        throw new Error('maxPerType must be an object mapping knowledge type -> maximum count');
      }
      const acc: Partial<Record<RecallKnowledgeType, number>> = {};
      for (const [key, raw] of Object.entries(a['maxPerType'] as Record<string, unknown>)) {
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
          throw new Error(`maxPerType.${key} must be an integer of at least 1 (use \`types\` to exclude a knowledge type entirely)`);
        }
        acc[key as RecallKnowledgeType] = Math.min(raw, topK);
      }
      if (Object.keys(acc).length > 0) maxPerType = acc;
    }
    // Per-call deadline — lowers the instance budget, never raises it. Clamped in `recall` rather than
    // refused here: a caller asking for longer than the operator allows means "as long as you allow".
    let recallMaxTimeMS: number | undefined;
    if (a['maxTimeMS'] != null) {
      if (typeof a['maxTimeMS'] !== 'number' || !Number.isInteger(a['maxTimeMS']) || a['maxTimeMS'] < 1) {
        throw new Error('maxTimeMS must be a positive integer (milliseconds)');
      }
      recallMaxTimeMS = a['maxTimeMS'];
    }
    /** Collected across every member/space so a partial answer is declared once, not per space. */
    const degraded: string[] = [];

    // A floor above its own ceiling is refused, not resolved. Same message as REST.
    if (minPerType && maxPerType) {
      for (const [t, floor] of Object.entries(minPerType) as [RecallKnowledgeType, number][]) {
        const ceiling = maxPerType[t];
        if (ceiling !== undefined && floor > ceiling) {
          throw new Error(`minPerType.${t} (${floor}) is greater than maxPerType.${t} (${ceiling}) — the two contradict, so neither can be applied`);
        }
      }
    }

    // Graph-traversal expansion: a depth, or a whole traversal minus its start node. Parsed by the SAME
    // function the REST route uses, so the two doors cannot disagree about what a valid narrowing is or what
    // the refusal says — which is the rule this repo states first and breaks most.
    const parsedTraverse = parseTraverseOption(a['traverse'], MAX_RECALL_TRAVERSE);
    if (!parsedTraverse.ok) throw new Error(parsedTraverse.error);
    const traverseOpt = parsedTraverse.value;
    const traverse = traverseOpt.depth;

    let filter: FilterExpression | RawMongoFilter | undefined;
    if (a['filter'] != null) {
      if (typeof a['filter'] !== 'object' || Array.isArray(a['filter'])) {
        throw new Error('filter must be an object');
      }
      // EITHER grammar, same resolver the REST route uses — the parity rule applies to the parameters, not only to the
      // capability. The operator-object form keeps the native pre-filter path; raw MongoDB takes the exhaustive one.
      const resolved = resolveRecallFilter(a['filter']);
      if (!resolved.ok) throw new Error(resolved.error);
      if (resolved.kind === 'expression') filter = resolved.expression;
      else if (resolved.kind === 'mongo') filter = resolved.filter;
    }

    // Resolve the seed set and the authorized space set (same guard for both).
    let seeds: RecallResult[];
    let traverseSpaces: string[];
    if (callSpace) {
      // Narrowed to what this connection may see, not every member of the proxy. `accessibleSpaceIds` is built
      // once per connection from the rights matrix (#786), so intersecting with it is the same answer the HTTP side
      // gets from `memberSpacesForRequest` — without threading rights down into every tool.
      const memberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
      const all = (await Promise.all(memberIds.map(mid => recall(mid, query, topK, tags, types, minPerType, minScore, filter, { maxPerType, maxTimeMS: recallMaxTimeMS, degraded, includeFreshWrites: a['includeFreshWrites'] === true })))).flat();
      // Same rule as everywhere else: rankOf, not `.score`. See the note on the REST recall route.
      all.sort(byRankThenId);
      // And the ceiling is re-applied to the merged set for the same reason it is on the REST route: each
      // member honoured it alone, so N members would multiply it.
      seeds = maxPerType
        ? mergeRecallResults([], all, topK, undefined, maxPerType)
        : all.slice(0, topK);
      traverseSpaces = memberIds;
    } else {
      /*
       * `includeFreshWrites` IS FORWARDED HERE, and it was not — so the one parameter whose entire
       * purpose is *"find the record I just wrote"* did nothing on this branch, with a 200.
       *
       * This is the branch a caller takes by OMITTING `space`, which is the form this tool's own first
       * paragraph promotes and the form `remember` and `write_file` both point at after a write. So the
       * documented remedy for "I wrote it and cannot find it" was inert on the idiomatic call, and the
       * existing test could not see it: it drives REST, where the space is in the path and this branch
       * cannot be reached.
       */
      seeds = await recallGlobal(accessibleSpaceIds, query, topK, tags, types, minPerType, minScore, filter,
        { maxPerType, maxTimeMS: recallMaxTimeMS, degraded, includeFreshWrites: a['includeFreshWrites'] === true });
      traverseSpaces = accessibleSpaceIds;
    }

    if (traverse === 0) {
      // A large answer spills with NO traversal too: `topK: 100` is a hundred records, and for a tool result
      // that is a model's context window rather than a page of JSON. The spill used to live in the graph branch
      // alone, which meant the plainest large call was the one that returned everything.
      const plain = seeds.map(r => ({
        score: r.score,
        ...rankingFields(r as unknown as Record<string, unknown>),
        spaceId: r.spaceId,
        type: r.type,
        record: stripRecordMeta(
          applyProjection(toRecallRecord(r, { includeContent, includeDiagnostics }), recallProjection),
          { includeRecordMeta },
        ),
      }));
      const plainBudgeted = await budgetedEnvelope({
        results: plain,
        budget,
        skip: paging.skip,
        remainderDump: paging.remainderDump,
        spillRemainder: remainder => spillResultSet({
          memberSpaceId: seeds[0]?.spaceId ?? traverseSpaces[0] ?? callSpace,
          results: remainder,
          request: { query, topK, traverse: 0, types: types ?? null },
        }),
      });
      const output = {
        results: plainBudgeted.results,
        ...plainBudgeted.fields,
        // Only when something degraded — an always-present field that is almost always empty is one an agent
        // learns to skip, and this is the field that matters on the call where the answer came back thin.
        ...(degraded.length > 0 ? { degraded } : {}),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
    }

    // Graph-augmented recall: expand seeds along edges, cap the traversed NODES, and nest each one under the
    // seed that reached it. The envelope is the non-traverse one plus `_graph`, so `count` keeps meaning
    // matches — it used to be matches plus neighbours, and `topK: 1` answered `count: 6`.
    const totalCap = topK * (traverse + 1) * 4;
    // Same spill as REST. The write space is chosen inside the builder, from a seed — `callSpace` can be a
    // proxy, and a proxy space owns no file store.
    const { graph, spill, truncated: graphTruncated } = await buildGraphWithSpill(
      traverseSpaces,
      seeds.map(s => ({ _id: s._id, spaceId: s.spaceId })),
      traverse,
      Math.max(0, totalCap - seeds.length),
      traverseOpt,
    );
    const results = seeds.map(r => {
      const nested = mapGraphNodes(graph.bySeed.get(r._id), graphNodeRecord, includeDiagnostics, recallProjection);
      return {
        score: r.score,
        ...rankingFields(r as unknown as Record<string, unknown>),
        spaceId: r.spaceId, type: r.type,
        record: applyProjection(toRecallRecord(r, { includeContent, includeDiagnostics }), recallProjection),
        ...(nested ? { _graph: nested } : {}),
      };
    });
    // Same rule as REST, and it matters more here: a tool result is a model's context window, so returning a
    // hundred matches with their graphs is the difference between an answer and an overflow.
    const budgeted = await budgetedEnvelope({
      results,
      budget,
      skip: paging.skip,
      remainderDump: paging.remainderDump,
      spillRemainder: remainder => spillResultSet({
        memberSpaceId: seeds[0]?.spaceId ?? traverseSpaces[0]!,
        results: remainder,
        request: { query, topK, traverse, types: types ?? null },
      }),
    });
    const output = {
      results: budgeted.results,
      ...budgeted.fields,
      traverseDepth: traverse,
      // Counted from the payload actually being sent, not from what the traversal REACHED.
      //
      // `graph.nodes` is the total across every seed the walk visited — including seeds the byte budget then
      // evicted, so the number described an answer the caller did not receive. The integration guide already
      // said this field is "how many traversed nodes came back", which was simply false.
      //
      // `countGraphNodes` walks the emitted structure, so it is correct for both doors' shapes by
      // construction — flat with `_graph` alongside on REST, nested under `record` on MCP — and it is the
      // same function the spill file uses to describe itself, for the same reason: a count passed in
      // alongside a payload can describe a different set of records than the payload does.
      graphNodes: countGraphNodes(budgeted.results),
      ...(graphTruncated ? { graphTruncated: true } : {}),
      ...(spill ? { graphComplete: spill } : {}),
      ...(degraded.length > 0 ? { degraded } : {}),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
  },
};

export const find_similarTool: ToolHandler = {
  name: 'similar',
  description: 'Find entries with high vector similarity to an EXISTING entry — deduplication, "more like this", merge detection. It uses that entry\'s STORED embedding rather than re-embedding anything, which is what separates it from `recall`: no query string, no BM25 half, no reranker. Pure cosine distance from one record to the rest.\n\n'
    + 'Two consequences of using the stored vector, and both are silent if you do not know them:\n'
    + '• A source entry retired from semantic ranking has NO vector, so there is nothing to be similar to and the answer is empty — not an error, and not evidence that nothing resembles it.\n'
    + '• A record written seconds ago may not be indexed yet. There is no `includeFreshWrites` here as there is on `recall`, because the source entry\'s own embedding has to exist before this can start.\n\n'
    + 'THE RESPONSE, and it is the same JSON at every depth — matching `recall`, which is the point:\n'
    + '• `source` — the entry you asked about, as {type, id, summary}. This tool has one and `recall` does not.\n'
    + '• `results` — the matches, each {score, spaceId, type, record}, the SAME per-result shape `recall` returns. With `traverse > 0` each carries its own `_graph`.\n'
    + '• `count` — how many matches, and `traverseDepth` — the depth echoed back, present at every depth including 0.\n'
    + '• `graphNodes` — a COUNT of what a traversal reached, not its content, and only when one ran.\n'
    + '• THE SIZE ANSWER, and it is the same envelope `recall` returns. `returned`, `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned` and `bytesReturned` are on EVERY response, so you never have to interpret an absence (`budgetBytes` is null unless you asked for a byte ceiling). `results` is a PREFIX of the ranked matches that fits both ceilings you set, and every record in it is WHOLE — a match is counted together with its whole `_graph` subtree, so a deeper or wider traversal means FEWER MATCHES fit: they are absent, not shortened. When `truncated` is true, `nextSkip` says where to continue from — send it back as `skip` for the next prefix. The matches that did not fit are also written to the space as a JSON file (authenticated download, valid one day) and reported as `remainder`, but ONLY if you ask with `remainderDump: true`. THIS PARAGRAPH USED TO NAME A `complete` FIELD — there is no such field, and has not been since the record cap became a byte budget, so a caller waiting for it waited for something nothing sends while `nextSkip` and `remainder` went unmentioned.\n'
    + '• `graphTruncated` + `graphComplete` — the same arrangement for an oversized neighbourhood. `graphTruncated` alone means the graph is short and no complete copy exists, because a bounded link scan stopped reading.\n\n'
    + 'IT ANSWERED PLAIN TEXT AT `traverse: 0` UNTIL 3.1.0, and JSON only above it. If you built against that, this is the break: parse JSON at every depth now. Two things arrive with it — the default depth gains the size cap it never had, and `includeContent`/`includeDiagnostics` start doing something there, having been accepted and unobservable on a summary line.\n\n'
    + 'Provide `space` to scope to one space, or omit it to search every space the token can reach. `score` is raw cosine similarity — the same number `recall` reports, but here it is the ONLY ranking, so `minScore` is a genuine relevance gate rather than the vector-side gate it is on `recall`.\n\n'
    + 'With `traverse: 0` the answer is a plain-text summary; above 0 it is JSON, because a graph does not summarise.',
  spaceRequired: false,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.optionalSpace,
            entryId: uuidSchema('UUID v4 of the source entry — the record everything else is compared AGAINST. It is never itself in the results.'),
            entryType: { type: 'string', enum: [...RECORD_TYPES], description: 'Knowledge type of the SOURCE entry, which is how the id is resolved — a wrong type is a not-found rather than a wrong answer. It does not constrain what comes back: use `targetTypes` for that, and note a memory can legitimately be most similar to an entity.' },
            includeContent: { type: 'boolean', default: true, description: 'Whether to return each file chunk’s `content` (default true). Same meaning as on `recall`, including the limit: it is FILE CHUNKS ONLY and does nothing on a search returning entities, memories, edges or chrono entries. Use `projection` to trim those.' },
            targetTypes: {
              type: 'array',
              items: { type: 'string', enum: [...RECORD_TYPES] },
              description: 'Which knowledge types to search in. Omit to search all types.',
            },
            includeDiagnostics: {
              type: 'boolean',
              default: false,
              description: 'Add back the three RECORD fields a result carries for the SYSTEM rather than for you (default false, and false is what you want almost always): `matchedText` — the exact pre-embedding source string, which for a file chunk is the heading plus the passage, so the passage a SECOND time; `embeddingModel`, identical for every record in a space; and `seq`, a sync counter that is not an input to any tool. Turn it on to see WHICH TEXT was embedded, then turn it off — `matchedText` especially is multiplied by `topK` and paid for in your context. REST takes the same parameter with the same default. **THIS NO LONGER GOVERNS THE PER-STAGE SCORES.** `lexicalScore`, `fusedScore` and `rerankScore` come back on EVERY recall, on both doors, each present only if that stage ran — because they are the ORDERING, not payload. `score` is vector similarity, and precedence in a fused recall is `rerankScore > fusedScore > score`, so on an instance with a reranker the number that decided a result’s position was previously the one you could not see. Three floats are not a cost, so they do not belong behind a flag whose purpose is removing cost.',
            },
            projection: {
              type: 'object',
              description: 'Fields to include (1) or exclude (0), the same grammar `query` takes and applied to each result\'s `record` — dotted paths work, so `{"name": 1, "properties.status": 1}` is valid. REACH FOR THIS RATHER THAN SKIPPING IT: it is the difference between an answer you can read inline and one that overruns your context. Measured by an integrator before this existed — a search for fifteen names, a `from`, a `kind` and a `status` returned 100,547 characters where the wanted data was about 1.5 KB, and their client refused the response outright. IT APPLIES RECURSIVELY: a `traverse` answer\'s `_graph` nodes and edges are projected at every depth, which is where a large answer actually comes from. Inclusion and exclusion cannot be mixed (the non-`_id` fields decide which you meant), `_id` survives an inclusion projection unless you send `_id: 0`, and the embedding VECTOR can never be projected back in — an explicit `embedding: 1` is dropped rather than honoured. The ranking envelope (`score`, `spaceId`, `type`) sits outside `record` here and is never projected away, so you cannot lose the score you searched for.',
            },
            maxChars: {
              type: 'integer',
              minimum: 1000,
              description: 'Ceiling on the serialised response body, in CHARACTERS. **DEFAULT 25000 ON THIS DOOR, and 50000 on REST — the one place the two doors deliberately differ.** Both accept the same parameter with the same floor, the same ceiling and the same refusal; only the number applied when you say nothing differs, because an MCP tool result meets a hard per-result ceiling inside YOUR client that you cannot raise, while a REST body lands in a buffer its caller allocated. Measured: a caller received a 98356-character answer that was correct, in budget and fully specified, and their client refused it outright. 25000 is about 6 whole records at ~4 KB each, roughly 7000 tokens. RAISE IT IF YOUR CLIENT CAN TAKE MORE — up to 5000000. THIS IS THE PARAMETER THAT USED TO BE CALLED `maxBytes`: it always counted characters, which equal bytes only for ASCII. If your limit is really in bytes, use `maxBytes` — it counts real UTF-8 bytes now, and both apply when you set both.',
            },
            maxBytes: {
              type: 'integer',
              minimum: 1000,
              description: 'Ceiling on the serialised response body, in real UTF-8 BYTES. **NO DEFAULT — opt-in.** Set it when your limit is genuinely a byte limit, which a transport or buffer limit is. It is not defaulted because bytes are always ≥ characters, so a byte default equal to the character one would silently become the binding constraint on every non-ASCII answer. WHEN YOU SET BOTH, BOTH APPLY: the answer stops at whichever ceiling it reaches first, which for German or Polish content is about 26% sooner in bytes than the same number of characters suggests, and about 35% sooner for emoji. **THIS PARAMETER CHANGED MEANING IN 3.7** — it used to bound characters while its name, its refusal and its response field all said bytes. If you set it before and want the old behaviour, send the same number as `maxChars`.',
            },
            maxTokens: {
              type: 'integer',
              minimum: 1,
              description: 'A convenience onto `maxBytes`, converted with `charsPerToken` (default 3.5). If you send both, the SMALLER resulting byte figure applies — stating two ceilings means you meant both. It is an approximation and cannot be anything else, because the server does not know your tokeniser: the realistic span across these payloads is 3.0–3.9 chars/token, and 3.5 was chosen because the customary 4.0 UNDER-counts tokens and is worst exactly on graph-heavy responses. Undershooting costs one more page; overshooting costs a blown context, and those are not symmetric.',
            },
            charsPerToken: {
              type: 'number',
              exclusiveMinimum: 0,
              description: 'Override the chars-per-token ratio used to convert `maxTokens` into bytes (default 3.5). Only meaningful alongside `maxTokens`. Lower it if your tokeniser is denser than this payload shape assumes; there is no reason to raise it above ~4.',
            },
            skip: {
              type: 'integer',
              minimum: 0,
              description: 'How many of the ranked matches to skip before filling the byte budget (default 0). THIS IS HOW YOU READ A TRUNCATED ANSWER: a response with `truncated: true` also carries `nextSkip`, and sending that back gets you the next prefix — no match repeated, none missed. The ranking is recomputed per call, so this is a continuation over one ordered answer rather than a cursor over a snapshot; a write between two pages can shift what lands where. Skipping past the end returns zero results with `truncated: false`, which is how a loop knows it is done.',
            },
            remainderDump: {
              type: 'boolean',
              description: 'Also WRITE the matches that did not fit to the space as a JSON file, and report it as `remainder` (default false). Only meaningful when the answer truncates. Leave it off unless you actually want the whole set as one artifact — the file is a write on a read path, it counts against space storage, and paging with `skip`/`nextSkip` reaches the same records without creating one. It used to happen unconditionally on every truncated call, which meant a caller that only wanted the next page paid for a download it never opened.',
            },
            topK: { type: 'number', minimum: 1, maximum: 100, default: 10, description: 'Max results to return (clamped to 1–100). Default 10.' },
            minScore: unitScoreSchema('Minimum cosine similarity (0.0–1.0). Results below it are excluded. Unlike on `recall`, this IS the relevance gate — cosine distance is the only ranking here, so raising it narrows the answer honestly rather than cutting candidates a reranker would have rescued. For deduplication, start high: near-duplicates sit well above 0.9 and everything below that is a topic match rather than a repeat.'),
            traverse: {
              // Literally `recall`'s, not merely the same shape: one builder, so a parameter cannot mean one
              // thing on one search and something else on the next.
              ...traverseOptionSchema(MAX_RECALL_TRAVERSE),
              default: 0,
              description: `Optional graph-expansion depth (integer 0–${MAX_RECALL_TRAVERSE}, default 0). When > 0, each similar match is expanded along knowledge-graph edges up to this many hops and what the walk reached is NESTED under the match that reached it in a \`_graph\` array — {edge, node, paths} per node, identical to \`recall\`'s shape: \`edge\` is the whole edge document, \`node\` the reached record, \`paths\` every route to it as record ids with the match first. LINKS, since 3.6, and identical to \`recall\` here too: a walk follows stored edges always, and the \`entityIds\` field a memory, chrono entry or file carries naming what it is about only when you ask — \`{depth: 2, includeChrono: true, includeMemories: true, includeFiles: true}\`, one flag per kind, ALL THREE DEFAULT FALSE. Turn one on and two things change. A linked node arrives carrying \`kind\` (chrono|memory|file) and the fields that say what it is — a chrono's title and type, a memory's fact, a file's path/description/tags, NEVER file chunk text — so \`node\` is not always an entity. And its reaching edge is SYNTHETIC: id \`<label>:<from>:<to>\`, label \`chrono.entityIds\`/\`memory.entityIds\`/\`file.entityIds\`, and no author/createdAt/seq, because a derived edge has none — do not look one up by that id. \`direction\` narrows STORED EDGES ONLY, so an inbound walk still reaches the records that name an entity. \`count\` is the number of matches and \`graphNodes\` how many nodes were reached. A neighbourhood past the inline cap is written out in full and reported as \`graphTruncated\` + \`graphComplete\` (an authenticated download, valid one day), exactly as on \`recall\`. \`graphTruncated\` alone means a bounded link scan stopped reading, so the graph is short and no complete copy exists. With traverse > 0 the response is JSON instead of the plain text summary.`,
            },
            crossSpace: { type: 'boolean', default: false, description: 'Forces a cross-space search even when `space` is given. On MCP the idiomatic form is to OMIT `space`, which does the same thing; this flag exists because the REST route takes the space in its PATH and has no way to omit it, and both doors must accept the same parameters. Not slated for removal.' },
          },
          required: ['entryId', 'entryType'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace, accessibleSpaceIds } = ctx;
    const entryId = String(a['entryId'] ?? '').trim();
    if (!entryId) throw new Error('entryId must not be empty');
    if (!UUID_V4_RE.test(entryId)) throw new Error('entryId must be a valid UUID v4');
    const entryType = String(a['entryType'] ?? '').trim();
    const validTypes = new Set<string>(RECORD_TYPES);
    if (!validTypes.has(entryType)) throw new Error(`entryType must be one of: ${[...validTypes].join(', ')}`);
    const topK = typeof a['topK'] === 'number' ? Math.min(Math.max(a['topK'], 1), 100) : 10;
    const minScore = typeof a['minScore'] === 'number' ? a['minScore'] : undefined;
    const crossSpace = a['crossSpace'] === true;
    const targetTypes = Array.isArray(a['targetTypes'])
      ? (a['targetTypes'] as unknown[]).filter((t): t is RecallKnowledgeType => typeof t === 'string' && validTypes.has(t))
      : undefined;

    // The same parser `recall` uses, so a narrowing valid on one search is valid on the other.
    const parsedFsTraverse = parseTraverseOption(a['traverse'], MAX_RECALL_TRAVERSE);
    if (!parsedFsTraverse.ok) throw new Error(parsedFsTraverse.error);
    const fsTraverseOpt = parsedFsTraverse.value;
    const traverse = fsTraverseOpt.depth;

    // Locate the source entry: with a space, use it; without, try each accessible space (first match
    // wins — the lookup fails fast before any search, so misses are cheap).
    // The resolver is NARROWED. `resolveFindSimilarScope` takes it as a parameter, so this is the whole fix — no
    // signature change was needed, which is the opposite of what the plan for this site predicted.
    const { candidateBases, searchIds } = resolveFindSimilarScope(
      callSpace || undefined, crossSpace, accessibleSpaceIds, sp => memberSpacesWithin(sp, accessibleSpaceIds));
    let result: Awaited<ReturnType<typeof findSimilar>> | undefined;
    let usedBase: string | undefined;
    for (const base of candidateBases) {
      try {
        result = await findSimilar(base, entryId, entryType as RecallKnowledgeType, topK, targetTypes, minScore, searchIds);
        usedBase = base;
        break;
      } catch (e) {
        if (e instanceof NotFoundError && candidateBases.length > 1) continue;
        throw e;
      }
    }
    if (!result || !usedBase) throw new NotFoundError(`Entry '${entryId}' not found in any accessible space (type: ${entryType}).`);

    const includeContent = a['includeContent'] !== false;
    const includeDiagnostics = a['includeDiagnostics'] === true;
    const recallProjection = normaliseProjection(a['projection'] as Record<string, unknown> | undefined);
    const budget = resolveBudget(a as BudgetRequest, MCP_DEFAULT_MAX_CHARS);
    if (!budget.ok) throw new Error(budget.error);
    const paging = resolvePaging(a as { skip?: unknown; remainderDump?: unknown });
    if (!paging.ok) throw new Error(paging.error);

    if (traverse === 0) {
      // JSON here too, since 3.1.0. Owner ruled it — *"json at every depth of course"* — after the docs audit
      // found that this tool answered TEXT at the default depth and JSON above it, while `recall` on the same
      // door is JSON throughout. A client that parsed one answer from this tool could not parse the other,
      // and nothing said so.
      //
      // Two things the text path could not have, and now does:
      //  - **a size cap.** The JSON answer spills past a size threshold and says `truncated`; the text answer
      //    was bounded by nothing but `topK`, so a large call returned everything inline.
      //  - **`includeContent` and `includeDiagnostics` that DO something.** A summary line carried neither
      //    passage bodies nor system fields, so both flags were accepted here and unobservable.
      //
      // The shape is `recall`'s plain branch plus `source`, which is this tool's own — you asked about a
      // specific entry and the answer names it back.
      const plain = result.results.map(r => ({
        score: r.score,
        ...rankingFields(r as unknown as Record<string, unknown>),
        spaceId: r.spaceId,
        type: r.type,
        record: applyProjection(toRecallRecord(r, { includeContent, includeDiagnostics }), recallProjection),
      }));
      const plainBudgeted = await budgetedEnvelope({
        results: plain,
        budget,
        skip: paging.skip,
        remainderDump: paging.remainderDump,
        spillRemainder: remainder => spillResultSet({
          memberSpaceId: result.results[0]?.spaceId ?? usedBase,
          results: remainder,
          request: { entryId, entryType, topK, traverse: 0 },
        }),
      });
      const output = {
        source: { type: result.source.type, id: result.source._id, summary: formatRecallSummary(result.source) },
        results: plainBudgeted.results,
        ...plainBudgeted.fields,
        traverseDepth: 0,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
    }

    // Graph-augmented: expand the similar seeds along edges (mirrors recall's traverse).
    const traverseSpaces = searchIds ?? [usedBase];
    const totalCap = topK * (traverse + 1) * 4;
    const { graph, spill, truncated: graphTruncated } = await buildGraphWithSpill(
      traverseSpaces,
      result.results.map(sd => ({ _id: sd._id, spaceId: sd.spaceId })),
      traverse,
      Math.max(0, totalCap - result.results.length),
      fsTraverseOpt,
    );
    const results = result.results.map(r => {
      const nested = mapGraphNodes(graph.bySeed.get(r._id), graphNodeRecord, includeDiagnostics, recallProjection);
      return {
        score: r.score,
        ...rankingFields(r as unknown as Record<string, unknown>),
        spaceId: r.spaceId, type: r.type,
        record: applyProjection(toRecallRecord(r, { includeContent, includeDiagnostics }), recallProjection),
        ...(nested ? { _graph: nested } : {}),
      };
    });
    const itemsBudgeted = await budgetedEnvelope({
      results,
      budget,
      skip: paging.skip,
      remainderDump: paging.remainderDump,
      spillRemainder: remainder => spillResultSet({
        memberSpaceId: result.results[0]?.spaceId ?? usedBase,
        results: remainder,
        request: { entryId, entryType, topK, traverse },
      }),
    });
    const output = {
      source: { type: result.source.type, id: result.source._id, summary: formatRecallSummary(result.source) },
      results: itemsBudgeted.results,
      ...itemsBudgeted.fields,
      traverseDepth: traverse,
      // Counted from the payload actually being sent, not from what the traversal REACHED.
      //
      // `graph.nodes` is the total across every seed the walk visited — including seeds the byte budget then
      // evicted, so the number described an answer the caller did not receive. The integration guide already
      // said this field is "how many traversed nodes came back", which was simply false.
      //
      // `countGraphNodes` walks the emitted structure, so it is correct for both doors' shapes by
      // construction — flat with `_graph` alongside on REST, nested under `record` on MCP — and it is the
      // same function the spill file uses to describe itself, for the same reason: a count passed in
      // alongside a payload can describe a different set of records than the payload does.
      graphNodes: countGraphNodes(itemsBudgeted.results),
      ...(graphTruncated ? { graphTruncated: true } : {}),
      ...(spill ? { graphComplete: spill } : {}),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
  },
};

export const queryTool: ToolHandler = {
  name: 'filter',
  description: 'Run a structured read-only query (MongoDB filter) against brain collections. This is the EXACT counterpart to `recall`: no embedding, no ranking, no score — a predicate, and every row that satisfies it. Reach for it when you know what you are looking for, and for `recall` when you know what it is about.\n\n'
    + 'It also reaches records `recall` cannot: a record retired from semantic ranking has no vector, and this reads the collection.\n\n'
    + 'PAY FOR THE FIELDS YOU BRANCH ON, AND NOTHING ELSE: `projection` is the field-selection lever, and '
    + 'this is the only tool that has one. The embedding vector is never returned by anything here and '
    + 'cannot be asked for, so there is no flag to hunt for — what costs you is the record BODIES, and a '
    + 'projection of the four fields you actually read turns a page of them into something small.\n\n'
    + 'THE RESPONSE:\n'
    + '• `results` — the matching documents, `embedding` always stripped. Ordered seq/updatedAt/createdAt descending unless you pass `sort`.\n'
    + '• `count` — how many rows are in THIS page. `total` — how many satisfy the filter overall. They differ whenever `limit` bit, and that difference is the only signal that there is more to page through.\n'
    + '• `limit`, `skip` — echoed back, so a pager can carry on without keeping its own state.\n\n'
    + 'A count with no rows is a BUG, not an empty page: `results` is carried in both `content` and `structuredContent`, and a client that reads only one of them gets the whole answer either way. Before 3.1 the rows were in `content` alone, so a client preferring `structuredContent` saw {"count":15,"total":40} and not a single row — reported independently by the canary operator and reproduced here. If you ever see a positive `count` with nothing in it, the instance predates that fix.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            collection: {
              type: 'string',
              enum: [...BRAIN_COLLECTIONS],
              description: 'Which collection to read. ONE per call — there is no cross-collection query, so '
                + 'answering "everything about X" means one call each. The listed names are the whole set, '
                + 'and they also decide which `sort` fields are legal and which `filter` keys exist: an '
                + '`edges` filter has `from`/`to`/`label`, a `chrono` one has `startsAt`/`status`, and a '
                + 'predicate naming a field the collection does not have simply matches nothing rather than '
                + 'failing.',
            },
            filter: {
              type: 'object',
              description: `MongoDB filter document. Only these operators are allowed (any other $-operator is rejected): ${QUERY_FILTER_OPERATORS.join(', ')}. Nesting is capped at depth 8. $regex must be a string, length-limited, and rejected if it risks catastrophic backtracking; $options is allowed only alongside $regex and only with flags i, m, s, x. Results are ordered seq/updatedAt/createdAt descending — there is no sort parameter, but 'skip' pages through that order.`,
            },
            projection: {
              type: 'object',
              description: 'Fields to include (1) or exclude (0). The `embedding` field is always excluded and cannot be re-included. Worth using rather than skipping: a bare query over a dozen records with full bodies is the cheapest way to overrun a token budget, and a projection of the four fields you actually branch on turns that into a page you can read.',
            },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20, description: 'Max documents in this page, clamped to 1–100. Default 20. Compare `count` against `total` in the response to know whether more rows satisfy the filter — a full page is not evidence that it is the last one.' },
            skip: { type: 'number', minimum: 0, description: 'Rows to discard before the page, for paging. The result order is total (`_id` breaks every tie), so no row can be seen twice or missed between pages. On a proxy space the page is computed over the MERGED set, not per member.' },
            sort: { type: 'string', description: 'Field to order by. Allowed values depend on the collection (entities: createdAt, name, type; edges: createdAt, label, from, to, type, weight; memories: createdAt, type; chrono: createdAt, title, startsAt, endsAt, status, type; files: createdAt, updatedAt, path). An unknown field is refused and names the allowed ones. Omit for newest-first.' },
            dir: { type: 'string', enum: ['asc', 'desc'], description: "Sort direction, default desc. Only meaningful with `sort`." },
            maxChars: { type: 'integer', minimum: 1000, description: 'Ceiling on the serialised response body, in CHARACTERS. **DEFAULT 25000 ON THIS DOOR, and 50000 on REST.** `limit` caps ROWS and says nothing about how big one is, so a page of file records or of long-described entities had no size bound at all before 3.7 — on the read tool you are most likely to page through. When the budget bites, `results` is a PREFIX of the page, `truncated` says so, and `nextSkip` is where to continue: send it back as `skip`. `count` is what you were actually given and still matches `results.length`; `total` is unchanged and still the whole match.' },
            maxBytes: { type: 'integer', minimum: 1000, description: 'Ceiling on the serialised response body, in real UTF-8 BYTES. **NO DEFAULT — opt-in.** Set it when your limit is genuinely a byte limit. Bytes are always >= characters, so a byte default equal to the character one would silently bind on every non-ASCII answer. When you set both, BOTH apply: the page stops at whichever ceiling it reaches first.' },
            maxTokens: { type: 'integer', minimum: 1, description: 'A convenience onto `maxChars`, converted with `charsPerToken` — the conversion produces characters. If both are sent the SMALLER resulting character figure applies. An approximation: the server does not know your tokeniser.' },
            charsPerToken: { type: 'number', exclusiveMinimum: 0, description: 'Per-call override of the characters-per-token ratio used by `maxTokens`. Default 3.5.' },
            maxTimeMS: { type: 'number', minimum: 1, maximum: 10000, default: 5000, description: 'Server-side query timeout in ms. Default 5000, hard-capped at 10000.' },
          },
          required: ['space', 'collection', 'filter'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const collName = String(a['collection'] ?? '');
    if (!(BRAIN_COLLECTIONS as readonly string[]).includes(collName)) {
      /*
       * The MESSAGE is built from the same list the CHECK uses, and it was written out by hand: five
       * names against an enum that admits six. So a caller who mistyped was handed a list excluding a
       * legal value — `links` — and the REST door, which builds this sentence from the real list, told
       * them something different for the same mistake.
       */
      throw new Error(`collection must be one of: ${BRAIN_COLLECTIONS.join(', ')}`);
    }
    const filter =
      a['filter'] != null && typeof a['filter'] === 'object'
        ? (a['filter'] as Record<string, unknown>)
        : {};
    const limit = Math.min(typeof a['limit'] === 'number' ? a['limit'] : 20, QUERY_PAGE_MAX);
    // Same refusal as the REST route: a non-integer or negative skip is an error, not a silent 0. Reading it as "start
    // from the beginning" returns a page that is not the page asked for, with no sign that anything went wrong.
    if (a['skip'] !== undefined && (typeof a['skip'] !== 'number' || !Number.isInteger(a['skip']) || a['skip'] < 0)) {
      throw new Error('skip must be a non-negative integer');
    }
    const skip = typeof a['skip'] === 'number' ? a['skip'] : 0;

    // The same parser, allowlist and error text the REST route and the list endpoints use.
    const sortParse = parseSortParam(a['sort'], a['dir'], SORTABLE_FIELDS[collName as keyof typeof SORTABLE_FIELDS]);
    if ('error' in sortParse) throw new Error(sortParse.error);
    const order = sortParse.sort ? toMongoSort(sortParse.sort) : DEFAULT_QUERY_SORT;
    const maxTimeMS = typeof a['maxTimeMS'] === 'number' ? a['maxTimeMS'] : 5000;
    const projection =
      a['projection'] != null && typeof a['projection'] === 'object'
        ? (a['projection'] as Record<string, unknown>)
        : undefined;

    // The SAME function the REST route pages with, not the same shape written twice.
    const members = memberSpacesWithin(callSpace, ctx.accessibleSpaces.map(sp => sp.id));
    const coll = collName as BrainCollection;
    const page = await pageAcrossMembers({
      members,
      limit,
      skip,
      ceiling: PROXY_PAGE_CEILING,
      compare: compareBySort(order),
      readMember: (mid, lim, sk) => queryBrain(mid, coll, filter, projection, lim, maxTimeMS, sk, order),
    });
    if (!page.ok) throw new Error(page.error);
    // Resolved before the read, so a bad `maxBytes` is an error rather than a query that ran first.
    const queryBudget = resolveBudget(a as BudgetRequest, MCP_DEFAULT_MAX_CHARS);
    if (!queryBudget.ok) throw new Error(queryBudget.error);
    const docs = page.rows;

    let total = 0;
    for (const mid of members) total += await countBrain(mid, coll, filter, maxTimeMS);

    // `content` stays the bare array it has always been, so a client parsing the text is unaffected. Without `total`
    // a caller sweeping with `skip` cannot tell a short last page from a truncated one, which is the number the fleet integrator
    // ended up fabricating.
    //
    // **`results` is in `structuredContent` too, and that is not redundancy.** This block used to carry the paging
    // facts ALONE, on the stated assumption that "a client that ignores structuredContent loses nothing because
    // `content` remains the whole answer". True — and the opposite client is the one that breaks: a client that
    // SURFACES structuredContent in preference to content showed the caller `{count: 25, total: 32, limit, skip}` and
    // not one row. Observed against Claude Code on 2026-08-15, four calls in a row, while `space_meta` — which
    // returns no structuredContent — rendered its whole body in the same session.
    //
    // That is the worst shape a result can have: the answer is absent and the metadata says how many rows were
    // returned, so it reads as a successful empty-ish page rather than as a client that dropped the payload. It is
    // The MCP spec's own framing is that structuredContent is the structured form of the SAME result, not a sidecar.
    //
    // **THIS COMMENT USED TO CLAIM IT WAS "the only tool with that shape — every other structuredContent in this
    // layer carries its own payload". THAT WAS FALSE, and the claim is why nobody checked.** `help` had the
    // identical shape: an index plus a capability map, with the entire guide in `content` alone. The canary operator
    // then reported the guide as unreachable and filed it as `help()` returning no bodies — which it never did.
    //
    // A universal claim cannot live in a comment. `mcp-structured-content-carries-its-payload.test.js` now sweeps
    // every tool and asserts it, so the next overlooked one fails a test instead of being described as impossible.
    /*
      * THE SIZE CEILING, the same one REST applies — `limit` caps ROWS and says nothing about how big one is.
      *
      * The offset goes in so `nextSkip` is ABSOLUTE. `query` has a real `skip`, so a continuation computed
      * from the page alone would send a caller back to the start of page two for ever.
      */
    const budgeted = applyBudget(docs, { chars: queryBudget.chars, bytes: queryBudget.bytes });
    const rows = budgeted.returned;

    /*
     * `count` MEANS DIFFERENT THINGS ON THESE TWO ROUTES, and that collision is worth naming.
     *
     * On the recall paths `count` is the TOTAL number of matches, so `budgetFields` reports it as such. On
     * `/query` it has always been the PAGE — documented that way, with `total` beside it for the whole match.
     * Spreading the accounting fields wholesale therefore overwrote a documented meaning with a different one:
     * a caller asking for `limit: 3` got `count: 12`, which is exactly the fabricated-number defect this route
     * was reported for.
     *
     * Stripped by NAME rather than fixed by spread order. Ordering works and is one careless reorder away from
     * silently coming back.
     */
    const { count: _queryBudgetTotal, ...queryAccounting } = budgetFields(budgeted, total, { chars: queryBudget.chars, bytes: queryBudget.bytes }, skip);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(rows),
        },
      ],
      structuredContent: {
        results: rows,
        // `count` is what you were GIVEN, so it still matches `results.length` when the budget bit; `total`
        // is unchanged and still the whole match.
        count: rows.length, total, limit, skip,
        ...queryAccounting,
        ...(sortParse.sort ? { sort: sortParse.sort.field, dir: sortParse.sort.dir === 1 ? 'asc' : 'desc' } : {}),
      },
    };
  },
};
