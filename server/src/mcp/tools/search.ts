/**
 * MCP retrieval tools — cross-type semantic search over the brain.
 *
 * `recall` (vector search across all knowledge types, with optional graph traversal),
 * `find_similar` (nearest-neighbour to an existing record), and `query` (structured MongoDB
 * read) were split out of the fact-tools bundle: they search facts, entities, edges, chrono
 * entries, and files alike, so they belong with the read/search surface rather than fact CRUD.
 */

import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { RECORD_TYPES } from '../../config/types.js';
import { UUID_V4_RE, formatRecallSummary, toRecallRecord, uuidSchema, unitScoreSchema } from './shared.js';
import { MAX_RECALL_TRAVERSE } from '../../brain/recall-seed-traversal.js';
import { mapGraphNodes, graphNodeRecord } from '../../brain/recall-graph.js';
import { stripRecordMeta, stripGraphRecordMeta } from '../../brain/recall-record-meta.js';
import { applyProjection, normaliseProjection } from '../../brain/projection.js';
import {
  resolveBudget,
  resolvePaging,
  budgetedEnvelope,
  type BudgetRequest,
  defaultBudgetChars,
  carriagesFor,
} from '../../brain/result-budget.js';
import { spillResultSet } from '../../brain/graph-spill.js';
import { traversedAnswer } from '../../brain/traversed-answer.js';
import { deadlineFrom } from '../../brain/search-bounds.js';
import { parseTraverseOption, traverseOptionSchema, echoTraverse } from '../../brain/traverse-option.js';
import { type FilterExpression } from '../../brain/filter.js';
import { resolveRecallFilter, type RawMongoFilter } from '../../brain/recall-filter.js';
import { observeRecallPath } from '../../brain/recall.js';
import { type RecallKnowledgeType, type RecallResult, findSimilar, recallGlobal, effectiveBudgetFor, RECALL_BUDGET_MS } from '../../brain/recall.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { NotFoundError } from '../../util/errors.js';
// The SAME resolver the nine per-collection list routes use — not a second name lookup with its own cap
// and its own idea of what 'contains' means. Two spellings of one join is how the doors start
// disagreeing about which records a name matches.
import { rankingFields } from '../../brain/recall-shape.js';
import { pageBudgetSchema } from './_page-budget-schema.js';
import { MAX_TAGS } from '../../util/request-bounds.js';

/**
 * Space scope for find_similar — mirrors recall's omit-space idiom (F1 consistency).
 *
 * - **ONE space, without `crossSpace`**: locate the source in that proxy-resolved space and search only
 *   there (searchIds `undefined` → findSimilar searches just the base space).
 * - **SEVERAL spaces** (a list, since 5.0): search exactly those, proxies expanded, and probe each for the
 *   source — the first base holding the entry wins, as in the omitted case. Deliberately NOT the same as
 *   omitting the space: that searches everything reachable, and the difference is paid in the answer's
 *   byte budget, which is the whole reason a caller names three of their twelve.
 * - **No space, or `crossSpace: true`**: locate the source across ALL accessible spaces and search them all.
 *
 * Takes a LIST rather than a string so the three shapes a caller can send — one name, several, none —
 * arrive as one type. A `string | string[]` parameter here would put the normalising step at each door,
 * and the doors are exactly where one of them gets it wrong.
 *
 * **`crossSpace` is NOT deprecated.** It looks like a duplicate of omitting `space`, and is not: `space` says where
 * the SOURCE entry lives, so naming it and setting `crossSpace` searches every other space from a source in one — a
 * request omitting `space` cannot express, because omitting it also looks for the source everywhere. (Its earlier
 * reason, a REST route with the space in its path, stopped being true at 5.0; REST answers through this tool now.)
 *
 * Pure (proxy resolver injected) so the scope logic is unit-testable without a database.
 */
export function resolveFindSimilarScope(
  callSpaces: readonly string[] | undefined,
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
  if (callSpaces && callSpaces.length > 0 && !crossSpace) {
    // Each named space expanded and DEDUPLICATED: a caller may name a proxy and one of its members, and
    // searching a space twice doubles every match it contributes.
    const seen = new Set<string>();
    for (const sp of callSpaces) for (const m of resolveMembers(sp)) seen.add(m);
    const members = [...seen];

    // ONE named space keeps the narrow form exactly as before — `searchIds: undefined` tells findSimilar to
    // search only the base. Widening it to a one-element list here would look equivalent and is not: the
    // cross-space path probes every base for the source, so a caller who named one space and mistyped the
    // id would get "not found" from a different space than the one they asked about.
    if (callSpaces.length === 1) return { candidateBases: [members[0] ?? callSpaces[0] as string], searchIds: undefined };

    return { candidateBases: members, searchIds: members };
  }
  return { candidateBases: accessibleSpaceIds, searchIds: accessibleSpaceIds };
}

/**
 * `includeRecordMeta`, declared ONCE for `recall` and `similar` (`Q-90`) — the two tools shape a hit with the same
 * builder, so they take the flag with the same words and the same default.
 */
const INCLUDE_RECORD_META_SCHEMA = {
  type: 'boolean',
  default: false,
  description: 'Add back the two fields that describe where a record SITS rather than what it says: `createdAt` and `updatedAt` (default false, and false is what you want almost always). It applies at every depth: to each match and to every node of its `_graph`. It no longer covers link ids: connections are link records since 5.0, so reach them with `traverse` or a `filter` over the `links` collection. Measured on a real corpus, only 30% of a recall answer was content and most of the rest was this. `createdAt` is the one to be careful of: it is when the RECORD was written, not when the remembered thing happened - that lives in the record\'s own properties, put there by whoever stored it. Turn this on when you need to act on the record\'s place in the store, not to read what it says. REST takes the same parameter with the same default.',
} as const;

/** How a caller asked hits to be shaped — the four flags every search row honours. */
interface HitShape {
  includeFileContent: boolean;
  includeDiagnostics: boolean;
  includeRecordMeta: boolean;
  projection: ReturnType<typeof normaliseProjection>;
}

/**
 * One search hit as `recall` and `similar` answer it, plain or traversed — ONE builder for all four branches (`Q-90`).
 *
 * The row was written out four times, and the record-meta rule was in one of them: the untraversed recall. So a
 * traversed recall, and every `similar` answer, carried each record's `createdAt`/`updatedAt` and empty collections
 * whatever `includeRecordMeta` said, on the match and on every neighbour.
 */
function hitRow(r: RecallResult, shape: HitShape, nodes?: Parameters<typeof mapGraphNodes>[0]): Record<string, unknown> {
  const meta = { includeRecordMeta: shape.includeRecordMeta };
  const nested = nodes ? mapGraphNodes(nodes, graphNodeRecord, shape.includeDiagnostics, shape.projection) : undefined;
  return {
    score: r.score,
    ...rankingFields(r as unknown as Record<string, unknown>),
    spaceId: r.spaceId,
    type: r.type,
    record: stripRecordMeta(applyProjection(toRecallRecord(r, {
      includeFileContent: shape.includeFileContent, includeDiagnostics: shape.includeDiagnostics,
    }), shape.projection), meta),
    ...(nested ? { _graph: stripGraphRecordMeta(nested, meta) } : {}),
  };
}

export const recallTool: ToolHandler = {
  name: 'recall',
  // recall / similar / filter fan out per space already, so a list costs them nothing but the parse.
  // Every other tool acts on exactly one space and refuses a list.
  spaceList: true,
  description: 'Search all knowledge types (facts, entities, edges, chrono entries, files) by MEANING and by exact tokens: a semantic vector ranking is fused with a lexical (BM25) ranking, so identifiers such as article numbers or form ids rank even though their embeddings carry little meaning. A cross-encoder refines the top candidates when the operator has configured one. Searches the specified space if provided, otherwise across all accessible spaces.\n\n'
    + 'THE RESPONSE, because knowing the parameters is only half of it:\n'
    + '• `results` — the ranked matches. Each carries `_id`, its name/fact/title, type, tags, properties, `spaceId`, timestamps and `score` (vector similarity).\n'
    + '• WHAT THIS DOOR DOES NOT SEND YOU, so you do not go looking for a flag to switch it off: the embedding VECTOR (never returned by anything here, and no parameter can ask for it), `matchedText` (the pre-embedding source string — for a file chunk it is the passage a SECOND time), `embeddingModel` (identical for every record in a space), and `seq` (a sync counter that is not an input to any tool). Withheld on REST too, with the same default, since 3.1.0 — `includeDiagnostics: true` restores them on either door and applies recursively, so a `graph_traverse` answer\'s `_graph` follows it at every depth. Leave it off: each of these is multiplied by `topK` and paid for in your context, and you want them only to answer WHY something ranked where it did. The other size lever is `includeFileContent: false`, which drops file-passage bodies and keeps their locations.\n'
    + '• `count` — the number of MATCHES. Traversed nodes are NOT counted in it.\n'
    + '• `graphNodes` — an integer COUNT of what a traversal reached, not the content. The content is nested per-result under `_graph`, and a result with no edges simply has no `_graph` at all: reading `results[0]` and concluding the feature is absent is the mistake to avoid.\n'
    + '• THE SIZE ANSWER, and it is a slope now rather than a cliff. `returned`, `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned` and `bytesReturned` are on EVERY response, so you never have to interpret an absence (`budgetBytes` is null unless you asked for a byte ceiling). `results` is a PREFIX of the ranked matches that fits BOTH ceilings you set, and every record in it is WHOLE — full body, full properties, its complete `_graph`, byte-identical to that record from an unbudgeted call. A match is counted together with its whole `_graph` subtree, so a deeper or wider traversal means fewer matches fit — they are absent, not shortened. When `truncated` is true, `nextSkip` says where to continue from — send it back as `skip` for the next prefix. The matches that did not fit are also kept as a SPILL and reported as `remainder` (`spillId`, `download`, `expiresAt`), but ONLY if you ask with `remainderDump: true`: readable with `read_spill` by your token alone, for up to one day (your own newer spills may evict it sooner), and never written into any space. A spill that cannot be kept says why in `spillRefused`, and `nextSkip` still reaches every record.\n'
    + '  Until 3.2.0 this was a record CAP that collapsed a large answer to three inline records plus a download of the whole set — including the three you already had. That roughly doubled what a caller had to read, so most abandoned the remainder. If you have logic keyed on `complete` or on a hard 25, it is `remainder` and a byte budget now.\n'
    + '• `incompleteRows`, `incompleteCount` and `graphTruncated` — the same rule for a neighbourhood: a match comes with its WHOLE `_graph` or not at all. One that cannot be walked whole is left out and named (`_id`, `spaceId`, `type`, `name`, `reason`), and `graphTruncated: true` means at least one was. `truncatedBy` says which bound stopped a truncated answer: `budget` (bytes), `walk_budget` or `deadline`.',
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
             * instead — see `MAX_PER_TYPE_CANDIDATES` and `brain/search-bounds.ts`.
             */
            topK: { type: 'number', minimum: 1, default: 10, description: 'Max results to return. Default 10, and NO ceiling — the same on both doors since 4.0, where REST used to clamp to 100 silently. With a `filter`, `topK` is filled from records that SATISFY it — every record that satisfies the filter, whatever its vector rank — so a filtered recall cannot silently miss a matching record; an answer that could not be completed says so in `degraded` (`filter_window`). What comes back is bounded by the answer budget instead: every record whole, `truncated` on every response, and `nextSkip` when it bit. That cap is a size, not a count — the answer is a prefix that fits `maxChars` (default 25000 on this door) — so asking for 80 does not return 80 inline; how many it does return depends on how big they are. Large values are slower, and every field of every result is paid for in tokens.' },
            tags: { type: 'array', maxItems: MAX_TAGS, items: { type: 'string' }, description: 'Optional tag filter — only results bearing ALL of these tags are returned (applies to facts, entities, chrono entries, and files).' },
            types: {
              type: 'array',
              maxItems: RECORD_TYPES.length,
              items: { type: 'string', enum: [...RECORD_TYPES] },
              description: 'Optional knowledge-type filter — restrict results to one or more types. Omit to search all five. EDGES ARE SEARCHABLE RECORDS and compete for your topK: a topK 20 on a persona space came back with 2 of them, so structural relationships displace knowledge unless you exclude them here.',
            },
            minPerType: {
              type: 'object',
              description: 'Optional minimum result count per type — a FLOOR. Guarantees at least that many results of each type if available (e.g. {"entity": 2, "edge": 1}). Omit to use pure score ranking. This is the cheap fix for one type crowding out another: facts are numerous and score well, so principles and entities lose slots to them without a floor.',
              // `minimum: 0` and integers only, matching the `maxPerType` beside it and the REST door,
              // which answers `400 minPerType.<key> must be a non-negative integer`. This declared a
              // bare number, so MCP admitted a negative and a fraction where REST refused both — an
              // omission rather than a policy, one line from the neighbour that got it right.
              additionalProperties: { type: 'integer', minimum: 0 },
            },
            maxPerType: {
              type: 'object',
              description: 'Optional MAXIMUM result count per type — the ceiling to minPerType\'s floor (e.g. {"file": 2, "fact": 4}). A slot freed by the cap goes to another type, so this is how you stop one long file chunk from crowding out several one-line records that would answer the query more cheaply. At least 1 per type; use `types` to exclude a type entirely. Must not be below minPerType for the same type — a contradictory pair is refused rather than silently resolved.',
              additionalProperties: { type: 'number', minimum: 1 },
            },
            maxTimeMS: {
              type: 'number',
              minimum: 1,
              description: 'Optional deadline for this recall, in milliseconds. It can only LOWER the instance budget, never raise it, and is clamped to a small floor so a tiny value is not a guaranteed empty answer. On expiry you get a PARTIAL answer rather than an error or a hang: whichever collections finished are returned, and the response says it degraded. Use it when a slow recall would cost more than a thin one — a fact that can only ever delay you by a known amount is one you can put in a workflow.',
            },
            minScore: unitScoreSchema('Minimum COSINE SIMILARITY (0.0–1.0). It filters on `score` ONLY — never on the fused or the reranked ordering — so it is a vector-side gate rather than a relevance gate, and a result the reranker would have promoted can be cut by it before the reranker sees it.'),
            rerank: {
              type: 'boolean',
              default: true,
              description: 'Whether the configured cross-encoder re-orders the answer (default true — the reranked answer '
                + 'is the default and the better ranking). Send false when you are waiting on the answer as a user '
                + 'types: the rerank can take seconds on a shared model, and the fused order is returned at once. A '
                + 'skip you asked for is not reported in `degraded`. No effect on an instance with no reranker.',
            },
            includeFileContent: {
              type: 'boolean',
              default: true,
              description: 'Whether to return each file chunk’s `content` — the passage body (default true). '
                + 'Set false to get locations and metadata only: path, heading, chunk index, tags, properties. '
                + 'Use it for a two-phase flow — recall to find WHERE something is, then read only the chunk '
                + 'you decided you need.\n\n'
                + 'WHAT IT DOES NOT COVER, because the general argument below invites the wrong conclusion: '
                + 'this is FILE CHUNKS ONLY. On a search returning entities, facts, edges or chrono '
                + 'entries it changes nothing at all — their bodies are `description` and `properties`, and '
                + 'this flag does not touch them. An integrator lost a call finding that out. The lever for '
                + 'those is `projection`, which names fields on any type.\n\n'
                + 'The general argument is still true and is why both exist: every field a result carries is '
                + 'multiplied by topK and paid for in tokens, and passage bodies are by far the largest.',
            },
            includeRecordMeta: INCLUDE_RECORD_META_SCHEMA,
            includeDiagnostics: {
              type: 'boolean',
              default: false,
              description: 'Add back the three RECORD fields a result carries for the SYSTEM rather than for you (default false, and false is what you want almost always): `matchedText` — the exact pre-embedding source string, which for a file chunk is the heading plus the passage, so the passage a SECOND time; `embeddingModel`, identical for every record in a space; and `seq`, a sync counter that is not an input to any tool. Turn it on to see WHICH TEXT was embedded, then turn it off — `matchedText` especially is multiplied by `topK` and paid for in your context. REST takes the same parameter with the same default. **THIS NO LONGER GOVERNS THE PER-STAGE SCORES.** `lexicalScore`, `fusedScore` (with `vectorRank` and `lexicalRank`, the two ranks it is `1/(60 + vectorRank) + 1/(60 + lexicalRank)` of) and `rerankScore` come back on EVERY recall, on both doors, each present only if that stage ran — because they are the ORDERING, not payload. `score` is vector similarity, and precedence in a fused recall is `rerankScore > fusedScore > score`, and a result carrying a `rerankScore` ranks above every result without one (the cross-encoder scores the top 100 candidates), so on an instance with a reranker the number that decided a result’s position was previously the one you could not see. A handful of numbers is not a cost, so they do not belong behind a flag whose purpose is removing cost.',
            },
            projection: {
              type: 'object',
              description: 'Fields to include (1) or exclude (0), the same grammar `filter` takes and applied to each result\'s `record` — dotted paths work, so `{"name": 1, "properties.status": 1}` is valid. REACH FOR THIS RATHER THAN SKIPPING IT: it is the difference between an answer you can read inline and one that overruns your context. Measured by an integrator before this existed — a search for fifteen names, a `from`, a `kind` and a `status` returned 100,547 characters where the wanted data was about 1.5 KB, and their client refused the response outright. IT APPLIES RECURSIVELY: a `traverse` answer\'s `_graph` nodes and edges are projected at every depth, which is where a large answer actually comes from. Inclusion and exclusion cannot be mixed (the non-`_id` fields decide which you meant), `_id` survives an inclusion projection unless you send `_id: 0`, and the embedding VECTOR can never be projected back in — an explicit `embedding: 1` is dropped rather than honoured. The ranking envelope (`score`, `spaceId`, `type`) sits outside `record` here and is never projected away, so you cannot lose the score you searched for.',
            },
            // The size ceilings and the paging pair, from the one schema every budgeted tool takes (Q-161).
            ...pageBudgetSchema('match'),
            traverse: {
              // A depth, or a whole traversal minus its start node. Built from `TRAVERSE_OPTION_FIELDS` rather
              // than spelled out here — see `traverseOptionSchema`, which exists because these two tools each
              // held their own copy and both were left behind when the parser gained three flags.
              ...traverseOptionSchema(MAX_RECALL_TRAVERSE),
              description: 'Optional graph expansion depth (integer 0–5, default 0). When > 0, each semantic match is expanded along knowledge-graph edges up to this many hops, and what the walk reached is NESTED under the match that reached it in a `_graph` array: {edges, node, paths} per node, where `edges` holds EVERY edge joining that node to the one it is nested under as whole documents (description and tags included) — one for an ordinary hop, more when two records are joined by more than one relationship and on a node that loops back to itself — `node` is the reached entity, and `paths` is every route to it as record ids, match first — so paths[0] is the nesting route and paths[0].length-1 is the hop count. A nested node carries its own `_graph`, so depth is a tree. `count` stays the number of MATCHES (traversed nodes are not in the ranked list and carry no score); `graphNodes` reports how many were reached. LINKS, since 3.6: a walk follows stored edges always, and the LINKS a fact, chrono entry or file carries naming what it is about only when you ask — `{depth: 2, includeChrono: true, includeMemories: true, includeFiles: true}`, one flag per kind. CHRONO AND FILES DEFAULT FALSE, and facts are the exception: with `includeMemories` unsaid a walk brings the ATTRIBUTED claims of what it reached and no other fact. An attributed claim is one an AI assistant originated rather than a person — it is stored with no vector so nothing can rank it, and this is how it reaches you at all. Say `includeMemories: true` for every linked fact, or `false` for none, attributed included. The rest are off by default because you asked for matches and the answer is budgeted: a match is counted with its whole `_graph` subtree, so every record admitted by default is paid for in matches that no longer fit — which is why the fact default is a narrowing and not the whole class. Turn one on and two things change. A linked node arrives carrying `kind` (chrono|fact|file) and the fields that say what it is — the title and type of a chrono, the fact of a fact, the path/description/tags of a file, NEVER file chunk text. And a NON-ENTITY SEED stops being a dead end: a matched fact has no edges of its own, so the walk starts from the entities its links name, at hop 1. The reaching edge is SYNTHETIC and is the single entry in `edges` — id `<label>:<from>:<to>`, label `chrono.entityIds`/`fact.entityIds`/`file.entityIds` — a frozen token naming the 4.x field these links replaced, and part of the link id — and no author/createdAt/seq because a derived edge has none; do not look one up by that id. `edgeLabels` filters them like any other label. AN EDGE HERE CARRIES NO `from`/`to`: every edge in one entry joins the same pair — this node and the one it is nested under — so repeating two UUIDs per edge restated what `node._id` and `paths[0]` already say. Each edge has `direction` instead: outbound (it runs from the parent to this node), inbound (the other way) or self (a record joined to itself). The far end is paths[0][paths[0].length-2]. With every flag off the behaviour is exactly what it was: a non-entity seed comes back with an empty `_graph` at any depth. A MATCH IS RETURNED WITH ITS WHOLE GRAPH OR NOT AT ALL: its `_graph` holds every node the walk you asked for reaches and every route to each, and a graph is never shortened. A match whose neighbourhood cannot be walked whole — past the per-match node ceiling, a link scan past its bound, too many routes to one node, or out of time — is left out, named in `incompleteRows` ({_id, spaceId, type, name, reason}; reason walk_ceiling|link_scan|paths|deadline) and counted in `incompleteCount`, and `graphTruncated: true` says at least one was; the other matches are unaffected. When the whole call runs out of walk budget or time, the answer stops at the last whole match with `truncated: true`, `truncatedBy` (walk_budget|deadline) and `nextSkip`, exactly as the byte budget does. Nothing is written anywhere unless you send `remainderDump: true`, and then only the matches the byte budget cut. Narrow `edgeLabels` or ask for fewer hops to bring a left-out match back. Use with filter/tags to narrow the seed set — traverse > 2 on dense graphs can be slow. Example: recall "auth token scoping" with traverse: 1 returns the matching records, each carrying everything one edge away. NARROWING, since 3.5: pass an OBJECT instead of a number to walk the graph the way the standalone `graph_traverse` tool does — `{depth, edgeLabels, direction}`, which is a traverse call without its start node because the matches ARE the start nodes. `edgeLabels` follows only those labels; `direction` is one of outbound, inbound or both (default both, which is what a bare number does) and it narrows STORED EDGES ONLY. A link is a record with a from and a to since 4.0, but which way it runs is fixed by the KINDS at its ends rather than by the data — a fact names entities and entities name nothing — so there is nothing for direction to select between, and both traversals reach the entity it names whatever direction says. `{direction: inbound, includeMemories: true}` on a matched fact still returns the entities that fact NAMES. Before this the expansion followed EVERY edge in BOTH directions with no way to say otherwise, so one hop off a well-connected node returned whichever neighbours the cap happened to keep — narrow it and you get the neighbourhood you asked for instead. `limit` is deliberately not accepted here: in a recall the walk is bounded per match by the instance and the answer by the byte budget, and a traverse that could raise either would overrule the budget governing the rest of the answer. Example: recall "the dog" with `traverse: {depth: 2, edgeLabels: [owns, lives_in], direction: outbound}`.',
            },
            filter: {
              type: 'object',
              description: 'Optional property filter, in EITHER of two grammars. RAW MONGODB is accepted — the same operators `filter` takes (`$or`, `$and`, `$not`, `$nor`, `$in`, `$regex`, `$elemMatch`, comparisons) nested to depth 8 — and so is the older one-operator-object-per-key form (`{"properties.status": {"eq": "x"}}`), which is ANDed across keys; its operators are eq, ne, in (array), exists (boolean), gt, gte, lt, lte. A filter MIXING both is refused rather than resolved. Any key is accepted. **`topK` is filled from every record that satisfies the filter, whatever its vector rank** — a filtered recall cannot silently miss a matching record, and an answer that could not be completed says so in `degraded` (`filter_window`). What differs is the cost. `tags`, `type`, `name`, `status`, `label` and schema-DECLARED `properties.<key>` (a flat conjunction, in either grammar) are applied by the vector index itself and cost what an unfiltered recall costs. Any other filter costs a pass over the matching records in the space, so declare a heavily filtered property in the space schema to keep it fast. `filterPath` in the response says which one this answer took. Combined with `tags`, both apply. Example: { "properties.status": { "eq": "accepted" }, "properties.count": { "gt": 10 } }. Records not matching ALL filter conditions are excluded.',
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
    // The ONE deadline this call runs under starts here: the search spends it first, the graph walk what is left.
    const startedAt = Date.now();
    const { args: a, accessibleSpaceIds } = ctx;
    const query = String(a['query'] ?? '');
    if (!query.trim()) throw new Error('query must not be empty');
    const topK = typeof a['topK'] === 'number' ? a['topK'] : 10;
    const tags = Array.isArray(a['tags']) ? (a['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    const types = Array.isArray(a['types']) ? (a['types'] as unknown[]).filter((t): t is RecallKnowledgeType => typeof t === 'string') : undefined;
    const minPerType = (a['minPerType'] != null && typeof a['minPerType'] === 'object' && !Array.isArray(a['minPerType']))
      ? (a['minPerType'] as Partial<Record<RecallKnowledgeType, number>>)
      : undefined;
    const minScore = typeof a['minScore'] === 'number' ? a['minScore'] : undefined;
    const includeFileContent = a['includeFileContent'] !== false;
    const includeDiagnostics = a['includeDiagnostics'] === true;
    const includeRecordMeta = a['includeRecordMeta'] === true;
    // Only an explicit `false` skips the reranker (Q-88): absent keeps the configured, reranked answer.
    const rerank = a['rerank'] === false ? false : undefined;
    const recallProjection = normaliseProjection(a['projection'] as Record<string, unknown> | undefined);
    const shape: HitShape = { includeFileContent, includeDiagnostics, includeRecordMeta, projection: recallProjection };
    const budget = resolveBudget(a as BudgetRequest, defaultBudgetChars(ctx.transport), carriagesFor(ctx.transport));
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
    /** Which path the filter took — observed, not predicted. Same field the REST door reports. */
    const observePath = observeRecallPath();

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
      // capability. Either grammar reaches the index when it is a flat conjunction of fields the index declares;
      // anything else is completed from the collection (brain/predicate-recall.ts). Both answers are complete.
      const resolved = resolveRecallFilter(a['filter']);
      if (!resolved.ok) throw new Error(resolved.error);
      if (resolved.kind === 'expression') filter = resolved.expression;
      else if (resolved.kind === 'mongo') filter = resolved.filter;
    }

    // Resolve the seed set and the authorized space set (same guard for both).
    let seeds: RecallResult[];
    let traverseSpaces: string[];
    if (ctx.callSpaces.length > 0) {
      // Narrowed to what this connection may see, not every member of the proxy. `accessibleSpaceIds` is built
      // once per connection from the rights matrix (#786), so intersecting with it is the same answer the HTTP side
      // gets from `memberSpacesForRequest` — without threading rights down into every tool.
      //
      // EVERY named space, deduplicated: a caller may name a proxy and one of its members, and reading a
      // space twice doubles every match it contributes to the merged ranking.
      const memberIds = [...new Set(ctx.callSpaces.flatMap(sp => memberSpacesWithin(sp, accessibleSpaceIds)))];
      /*
       * THE SAME MERGE as the no-space branch, not a copy of it (`Q-81`). This was a hand-written fan-out —
       * `recall` per member, then a sort and a slice here — which skipped the ONE query embedding and the ONE
       * rerank pass `recallGlobal` makes: after P-35 fixed the no-space branch, a recall on a proxy of thirteen
       * members still sent thirteen rerank requests. `recallGlobal` also re-applies `maxPerType` to the merged
       * set, which this branch did by hand.
       */
      seeds = await recallGlobal(memberIds, query, topK, tags, types, minPerType, minScore, filter,
        { maxPerType, maxTimeMS: recallMaxTimeMS, degraded, observePath, rerank });
      traverseSpaces = memberIds;
    } else {
      /*
       * EVERY option has to be forwarded here, and the fresh-write flag once was not — so the one
       * parameter whose entire purpose was *"find the record I just wrote"* did nothing on this branch,
       * with a 200. It is no longer a parameter (`recall` always scans), but the shape of the mistake is
       * why this comment stays: this is the branch a caller takes by OMITTING `space`, which is the form
       * this tool's own first paragraph promotes, and the test that should have caught it drove REST,
       * where the space was in the path and this branch could not be reached.
       */
      seeds = await recallGlobal(accessibleSpaceIds, query, topK, tags, types, minPerType, minScore, filter,
        { maxPerType, maxTimeMS: recallMaxTimeMS, degraded, observePath, rerank });
      traverseSpaces = accessibleSpaceIds;
    }

    if (traverse === 0) {
      // A large answer spills with NO traversal too: `topK: 100` is a hundred records, and for a tool result
      // that is a model's context window rather than a page of JSON. The spill used to live in the graph branch
      // alone, which meant the plainest large call was the one that returned everything.
      const plain = seeds.map(r => hitRow(r, shape));
      const plainBudgeted = await budgetedEnvelope({
        results: plain,
        budget,
        skip: paging.skip,
        remainderDump: paging.remainderDump,
        spillRemainder: remainder => spillResultSet({
          issuedTo: ctx.actor?.tokenId,
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
        // Present ONLY when the recall scanned, like `degraded` above — see `api/brain/search.ts`
        // for why the fast path says nothing: an agent pays for every byte out of its own context.
        ...(observePath.path() === 'exhaustive' ? { filterPath: 'exhaustive' } : {}),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
    }

    // Graph-augmented recall: every row with its WHOLE graph, nested under the seed that reached it, or left out
    // and named (Q-126) — see `traversed-answer.ts`. The envelope is the non-traverse one plus `_graph`, so
    // `count` keeps meaning matches. Budgeted because a tool result is a model's context window.
    const budgeted = await traversedAnswer({
      seeds,
      memberIds: traverseSpaces,
      maxDepth: traverse,
      narrowing: traverseOpt,
      deadline: deadlineFrom(startedAt, effectiveBudgetFor(recallMaxTimeMS)),
      budget,
      skip: paging.skip,
      remainderDump: paging.remainderDump,
      shapeRow: (r, nodes) => hitRow(r, shape, nodes),
      spillRemainder: (remainder, about) => spillResultSet({
        issuedTo: ctx.actor?.tokenId,
        results: remainder,
        request: { query, topK, traverse, types: types ?? null, ...about },
      }),
    });
    const output = {
      results: budgeted.results,
      ...budgeted.fields,
      traverseDepth: traverse,
      /*
       * The NARROWING echoed back, beside the depth — a number when nothing was narrowed, an object when
       * anything was, so an existing caller's assertion on `traverse` does not change shape for free.
       *
       * This lived on `POST /api/brain/recall` and nowhere else, and collapsing that route onto this
       * module would have dropped it — a response field silently disappearing is the exact half of a
       * collapse that nothing else notices. A narrowing the response does not mention is one the caller
       * cannot verify was applied, which is the whole reason the parameter exists.
       */
      traverse: echoTraverse(traverseOpt),
      // `graphNodes`, `graphTruncated`, `incompleteRows` and the one `spillRefused` come from `traversedAnswer`.
      ...(degraded.length > 0 ? { degraded } : {}),
      // The TRAVERSED branch reports it too. A graph-augmented recall runs the same search first,
      // so it pays the same scan — and a caller who only ever uses `traverse` would otherwise never
      // be told, which is the half of a two-branch response that gets forgotten.
      ...(observePath.path() === 'exhaustive' ? { filterPath: 'exhaustive' } : {}),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
  },
};

export const find_similarTool: ToolHandler = {
  name: 'similar',
  description: 'Find entries with high vector similarity to an EXISTING entry — deduplication, "more like this", merge detection. It uses that entry\'s STORED embedding rather than re-embedding anything, which is what separates it from `recall`: no query string, no BM25 half, no reranker. Pure cosine distance from one record to the rest.\n\n'
    + 'Two consequences of using the stored vector, and both are silent if you do not know them:\n'
    + '• A source entry retired from semantic ranking has NO vector, so there is nothing to be similar to and the answer is empty — not an error, and not evidence that nothing resembles it.\n'
    + '• A record written seconds ago may not be indexed yet, and unlike `recall` this tool cannot see past that. `recall` also reads the newest records straight from the collection, so it finds what you just wrote; here the SOURCE entry\'s own embedding has to exist before there is anything to be similar TO. Wait for the embed queue, or search by text with `recall`.\n\n'
    + 'THE RESPONSE, and it is the same JSON at every depth — matching `recall`, which is the point:\n'
    + '• `source` — the entry you asked about, as {type, id, summary}. This tool has one and `recall` does not.\n'
    + '• `results` — the matches, each {score, spaceId, type, record}, the SAME per-result shape `recall` returns. With `traverse > 0` each carries its own `_graph`.\n'
    + '• `count` — how many matches, and `traverseDepth` — the depth echoed back, present at every depth including 0.\n'
    + '• `graphNodes` — a COUNT of what a traversal reached, not its content, and only when one ran.\n'
    + '• THE SIZE ANSWER, and it is the same envelope `recall` returns. `returned`, `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned` and `bytesReturned` are on EVERY response, so you never have to interpret an absence (`budgetBytes` is null unless you asked for a byte ceiling). `results` is a PREFIX of the ranked matches that fits both ceilings you set, and every record in it is WHOLE — a match is counted together with its whole `_graph` subtree, so a deeper or wider traversal means FEWER MATCHES fit: they are absent, not shortened. When `truncated` is true, `nextSkip` says where to continue from — send it back as `skip` for the next prefix. The matches that did not fit are also kept as a SPILL and reported as `remainder` (`spillId`, `download`, `expiresAt`), but ONLY if you ask with `remainderDump: true`: readable with `read_spill` by your token alone, for up to one day (your own newer spills may evict it sooner), and never written into any space. A spill that cannot be kept says why in `spillRefused`, and `nextSkip` still reaches every record. THIS PARAGRAPH USED TO NAME A `complete` FIELD — there is no such field, and has not been since the record cap became a byte budget, so a caller waiting for it waited for something nothing sends while `nextSkip` and `remainder` went unmentioned.\n'
    + '• `incompleteRows`, `incompleteCount` and `graphTruncated` — the same rule for a neighbourhood as on `recall`: a match comes with its WHOLE `_graph` or is left out and named, and `truncatedBy` says which bound stopped a truncated answer.\n\n'
    + 'IT ANSWERED PLAIN TEXT AT `traverse: 0` UNTIL 3.1.0, and JSON only above it. If you built against that, this is the break: parse JSON at every depth now. Two things arrive with it — the default depth gains the size cap it never had, and `includeFileContent`/`includeDiagnostics` start doing something there, having been accepted and unobservable on a summary line.\n\n'
    + 'Provide `space` to scope to one space, or omit it to search every space the token can reach. `score` is raw cosine similarity — the same number `recall` reports, but here it is the ONLY ranking, so `minScore` is a genuine relevance gate rather than the vector-side gate it is on `recall`.\n\n'
    + 'REST `POST /api/brain/similar` answers through this tool, so it returns exactly this JSON — the same hits and the same `source`.',
  spaceRequired: false,
  // recall / similar / filter fan out per space already, so a list costs them nothing but
  // the parse. Every other tool acts on exactly one space and refuses a list.
  spaceList: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.optionalSpace,
            entryId: uuidSchema('UUID v4 of the source entry — the record everything else is compared AGAINST. It is never itself in the results.'),
            entryType: { type: 'string', enum: [...RECORD_TYPES], description: 'Knowledge type of the SOURCE entry, which is how the id is resolved — a wrong type is a not-found rather than a wrong answer. It does not constrain what comes back: use `targetTypes` for that, and note a fact can legitimately be most similar to an entity.' },
            includeFileContent: { type: 'boolean', default: true, description: 'Whether to return each file chunk’s `content` (default true). Same meaning as on `recall`, including the limit: it is FILE CHUNKS ONLY and does nothing on a search returning entities, facts, edges or chrono entries. Use `projection` to trim those.' },
            targetTypes: {
              type: 'array',
              maxItems: RECORD_TYPES.length,
              items: { type: 'string', enum: [...RECORD_TYPES] },
              description: 'Which knowledge types to search in. Omit to search all types.',
            },
            includeRecordMeta: INCLUDE_RECORD_META_SCHEMA,
            includeDiagnostics: {
              type: 'boolean',
              default: false,
              description: 'Add back the three RECORD fields a result carries for the SYSTEM rather than for you (default false, and false is what you want almost always): `matchedText` — the exact pre-embedding source string, which for a file chunk is the heading plus the passage, so the passage a SECOND time; `embeddingModel`, identical for every record in a space; and `seq`, a sync counter that is not an input to any tool. Turn it on to see WHICH TEXT was embedded, then turn it off — `matchedText` especially is multiplied by `topK` and paid for in your context. REST takes the same parameter with the same default. **THIS NO LONGER GOVERNS THE PER-STAGE SCORES.** `lexicalScore`, `fusedScore` (with `vectorRank` and `lexicalRank`, the two ranks it is `1/(60 + vectorRank) + 1/(60 + lexicalRank)` of) and `rerankScore` come back on EVERY recall, on both doors, each present only if that stage ran — because they are the ORDERING, not payload. `score` is vector similarity, and precedence in a fused recall is `rerankScore > fusedScore > score`, and a result carrying a `rerankScore` ranks above every result without one (the cross-encoder scores the top 100 candidates), so on an instance with a reranker the number that decided a result’s position was previously the one you could not see. A handful of numbers is not a cost, so they do not belong behind a flag whose purpose is removing cost.',
            },
            projection: {
              type: 'object',
              description: 'Fields to include (1) or exclude (0), the same grammar `filter` takes and applied to each result\'s `record` — dotted paths work, so `{"name": 1, "properties.status": 1}` is valid. REACH FOR THIS RATHER THAN SKIPPING IT: it is the difference between an answer you can read inline and one that overruns your context. Measured by an integrator before this existed — a search for fifteen names, a `from`, a `kind` and a `status` returned 100,547 characters where the wanted data was about 1.5 KB, and their client refused the response outright. IT APPLIES RECURSIVELY: a `traverse` answer\'s `_graph` nodes and edges are projected at every depth, which is where a large answer actually comes from. Inclusion and exclusion cannot be mixed (the non-`_id` fields decide which you meant), `_id` survives an inclusion projection unless you send `_id: 0`, and the embedding VECTOR can never be projected back in — an explicit `embedding: 1` is dropped rather than honoured. The ranking envelope (`score`, `spaceId`, `type`) sits outside `record` here and is never projected away, so you cannot lose the score you searched for.',
            },
            // The size ceilings and the paging pair, from the one schema every budgeted tool takes (Q-161).
            ...pageBudgetSchema('match'),
            // Refused above 100, not clamped: the validator's range IS the contract (`mcp-args-validation`), so the
            // description says so. It said "clamped", which REST did until it answered through this tool (Q-89).
            topK: { type: 'number', minimum: 1, maximum: 100, default: 10, description: 'Max results to return, 1–100; a value outside that is refused, never clamped. Default 10.' },
            minScore: unitScoreSchema('Minimum cosine similarity (0.0–1.0). Results below it are excluded. Unlike on `recall`, this IS the relevance gate — cosine distance is the only ranking here, so raising it narrows the answer honestly rather than cutting candidates a reranker would have rescued. For deduplication, start high: near-duplicates sit well above 0.9 and everything below that is a topic match rather than a repeat.'),
            traverse: {
              // Literally `recall`'s, not merely the same shape: one builder, so a parameter cannot mean one
              // thing on one search and something else on the next.
              ...traverseOptionSchema(MAX_RECALL_TRAVERSE),
              default: 0,
              description: `Optional graph-expansion depth (integer 0–${MAX_RECALL_TRAVERSE}, default 0). When > 0, each similar match is expanded along knowledge-graph edges up to this many hops and what the walk reached is NESTED under the match that reached it in a \`_graph\` array — {edges, node, paths} per node, identical to \`recall\`'s shape: \`edges\` holds every edge joining that node to the one it is nested under as whole documents (more than one when a pair is joined twice, or when a node loops back to itself) and carries \`direction\` (outbound|inbound|self) in place of \`from\`/\`to\`, which the entry already states, \`node\` the reached record, \`paths\` every route to it as record ids with the match first. LINKS, since 3.6, and identical to \`recall\` here too: a walk follows stored edges always, and the \`entityIds\` field a fact, chrono entry or file carries naming what it is about only when you ask — \`{depth: 2, includeChrono: true, includeMemories: true, includeFiles: true}\`, one flag per kind. CHRONO AND FILES DEFAULT FALSE; with \`includeMemories\` unsaid a walk brings the ATTRIBUTED claims of what it reached — those an AI assistant originated, stored with no vector so nothing can rank them — and no other fact. \`true\` admits every linked fact, \`false\` none. Turn one on and two things change. A linked node arrives carrying \`kind\` (chrono|fact|file) and the fields that say what it is — a chrono's title and type, a fact's fact, a file's path/description/tags, NEVER file chunk text — so \`node\` is not always an entity. And its reaching edge is SYNTHETIC: id \`<label>:<from>:<to>\`, label \`chrono.entityIds\`/\`fact.entityIds\`/\`file.entityIds\` — a frozen token naming the 4.x field these links replaced, and part of the link id — and no author/createdAt/seq, because a derived edge has none — do not look one up by that id. \`direction\` narrows STORED EDGES ONLY, so an inbound walk still reaches the records that name an entity. \`count\` is the number of matches and \`graphNodes\` how many nodes were reached. A match is returned with its WHOLE graph or not at all, exactly as on \`recall\`: one whose neighbourhood cannot be walked whole is left out and named in \`incompleteRows\` and \`incompleteCount\`, with \`graphTruncated: true\`, and a call that runs out of walk budget or time stops at the last whole match with \`truncatedBy\` and \`nextSkip\`. Nothing is written unless you send \`remainderDump: true\`.`,
            },
            crossSpace: { type: 'boolean', default: false, description: 'Search every space you can read even when `space` is given. `space` says where the SOURCE entry lives, so naming it and setting this finds records like it in every other space — a request omitting `space` cannot express, because omitting it also looks for the source everywhere. Not slated for removal.' },
          },
          required: ['entryId', 'entryType'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { args: a, accessibleSpaceIds } = ctx;
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
      ctx.callSpaces.length > 0 ? ctx.callSpaces : undefined, crossSpace, accessibleSpaceIds,
      sp => memberSpacesWithin(sp, accessibleSpaceIds));
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

    const includeFileContent = a['includeFileContent'] !== false;
    const includeDiagnostics = a['includeDiagnostics'] === true;
    const includeRecordMeta = a['includeRecordMeta'] === true;
    const recallProjection = normaliseProjection(a['projection'] as Record<string, unknown> | undefined);
    const shape: HitShape = { includeFileContent, includeDiagnostics, includeRecordMeta, projection: recallProjection };
    const budget = resolveBudget(a as BudgetRequest, defaultBudgetChars(ctx.transport), carriagesFor(ctx.transport));
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
      //  - **`includeFileContent` and `includeDiagnostics` that DO something.** A summary line carried neither
      //    passage bodies nor system fields, so both flags were accepted here and unobservable.
      //
      // The shape is `recall`'s plain branch plus `source`, which is this tool's own — you asked about a
      // specific entry and the answer names it back.
      const plain = result.results.map(r => hitRow(r, shape));
      const plainBudgeted = await budgetedEnvelope({
        results: plain,
        budget,
        skip: paging.skip,
        remainderDump: paging.remainderDump,
        spillRemainder: remainder => spillResultSet({
          issuedTo: ctx.actor?.tokenId,
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
    }

    // Graph-augmented: every similar match with its WHOLE graph, or left out and named — the same answer
    // recall's traverse gives, through the same module (`traversed-answer.ts`).
    const traverseSpaces = searchIds ?? [usedBase];
    const itemsBudgeted = await traversedAnswer({
      seeds: result.results,
      memberIds: traverseSpaces,
      maxDepth: traverse,
      narrowing: fsTraverseOpt,
      // similar has no `maxTimeMS` of its own; its walk runs under the instance's recall budget.
      deadline: deadlineFrom(startedAt, RECALL_BUDGET_MS),
      budget,
      skip: paging.skip,
      remainderDump: paging.remainderDump,
      shapeRow: (r, nodes) => hitRow(r, shape, nodes),
      spillRemainder: (remainder, about) => spillResultSet({
        issuedTo: ctx.actor?.tokenId,
        results: remainder,
        request: { entryId, entryType, topK, traverse, ...about },
      }),
    });
    const output = {
      source: { type: result.source.type, id: result.source._id, summary: formatRecallSummary(result.source) },
      results: itemsBudgeted.results,
      ...itemsBudgeted.fields,
      traverseDepth: traverse,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
  },
};

