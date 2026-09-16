/**
 * The `help` document, as SECTIONS — one source for both the full read and the searched read.
 *
 * ## Why this file exists
 *
 * Owner, 2026-08-12: *"help needs a searchfunction"*. `help` took no arguments and returned the entire instance
 * explanation — every visible tool, the knowledge model, retrieval guidance, schema authoring and the REST map — which is
 * a large payload to read in full when the caller wanted one thing.
 *
 * The hazard in adding search is specific and named in the item: **a searched `help` that assembles its own copy of the
 * text is the two-surfaces defect inside the one tool whose job is to describe the others.** So the sections live here,
 * both paths consume this list, and `help-search.test.js` asserts the searched output is a literal subset of the full
 * output rather than trusting that it is.
 *
 * ## Line-granular sections
 *
 * The most likely search is a tool name, and the tools section is 40 lines long. Returning all of it for
 * `query: "chrono"` would technically be "the matching section" and would defeat the purpose. So a section may declare
 * `lines`, and a search over it returns only the matching lines — the tool list and the space list are both like that.
 *
 * ## Lexical, deliberately
 *
 * No embedder. `help` is the one tool that must work when everything else is misconfigured, and semantic matching would
 * put it on the embedding path — so a broken embedder would take the tool that explains the instance down with it.
 */
import type { ToolContext } from './types.js';
import { isSpaceAdminFor } from '../../auth/editor-scope.js';

/** Strip control chars (incl. newlines) and backticks, clamp length. */
export function sanitizeDynamic(s: string, max = 200): string {
  return s.replace(/[\x00-\x1f\x7f`]/g, '').slice(0, max);
}

export interface HelpSection {
  /** Stable short id, used by the index and by tests. Never rendered as prose. */
  id: string;
  /** The `## ` heading, without the marker. */
  title: string;
  /** Prose body for a whole-section match. Empty when the section is entirely `lines`. */
  body: string;
  /**
   * Individually searchable lines. When present, a search returns only the matching ones — the tools section is 40
   * lines and a search for one tool must not return the other 39.
   */
  lines?: string[];
  /** Prose that must accompany the lines whenever any of them is returned (a header sentence, a caveat). */
  preamble?: string;
}

const KNOWLEDGE_MODEL = `An instance holds one or more **spaces** — isolated knowledge graphs with their own
storage quota, optional type schemas, and sync membership. Every record lives in
exactly one space. There are five knowledge types:

- **facts** — free-text facts with semantic embeddings; may reference entities via entityIds.
- **entities** — named things (people, projects, concepts) with a type, tags, and properties.
- **edges** — directed, labelled relationships between two entities (from → label → to); the graph part of the knowledge graph.
- **chrono** — time-anchored entries (event/deadline/plan/milestone) with a status lifecycle.
- **files** — file metadata and embedded content chunks, linked to the space's file tree.

All five types are embedded for semantic search. A **proxy space** aggregates reads
across (and routes writes to) its member spaces. Instances connect to each other in
**networks**; records sync between peers with per-space scoping.`;

const RETRIEVAL_GUIDE = `Three retrieval modes exist and they are easy to confuse:

1. **query** — structured, exact retrieval by field predicates (a MongoDB filter).
   No semantic ranking. Use when you know WHAT you are filtering for — a tag, a
   type, a property value, a date range — and want all matches.
   Example: query(space, collection: "entities", filter: { "type": "person" }).

2. **recall** — HYBRID search: semantic nearest-neighbour ranking fused with a
   lexical (BM25) ranking. Use for "find things ABOUT X" where wording varies,
   AND for exact tokens — an article number, form id, part code or clause name
   ranks on the lexical side even though its embedding is near-arbitrary.
   IMPORTANT: the free-text query only RANKS results — it does NOT hard-filter.
   "confidential files about the merger" as free text returns things ranked near
   that phrase, not things tagged "confidential"; to restrict, pass tags/filter
   (mode 3). Ranking may be refined further by a cross-encoder when the operator
   has configured one; results carry score (vector), and lexicalScore /
   fusedScore / rerankScore when those stages ran. minScore always filters on
   the VECTOR score, never on the fused or rerank score.

3. **recall with tags/types/filter** — semantic ranking WITHIN a structured
   subset. tags requires ALL listed tags; types restricts knowledge types; filter
   is an operator object per key (eq, ne, in, exists, gt, gte, lt, lte).
   Filter keys must start with: properties., tags, type, name, status, or label.
   Performance: tags, type, name, status, label — and, on spaces whose schema
   declares them, properties.<key> — take a fast pre-filtered vector-search path.
   Other filters (undeclared properties.*, exists) are still correct but scan
   exhaustively, so prefer declared fields on large spaces.

KEEPING A READ CHEAP -- the answer to "how do I avoid fetching the internal
fields":

THE EMBEDDING VECTOR IS NEVER RETURNED. By anything, on either door. There is no
parameter for it because there is nothing to switch off: query strips it and
refuses to let a projection put it back, and every list path projects it out
before the documents leave the database. If you have been looking for that flag,
this is why you could not find it.

What you CAN control, and where:

- projection, on query AND recall AND find_similar. The field-selection lever,
  and it works on all three: naming the four fields you actually branch on
  turns a page of full record bodies into something you can read, and on the
  two search tools it applies through the graph expansion as well. A bare query
  over a dozen records with descriptions and properties is the cheapest way to
  overrun a context budget. Reach for this on an entity search rather than
  includeContent, which only drops file-passage bodies.
- recall -> includeContent: false. Drops file-passage BODIES and keeps their
  locations, so you can find WHICH document holds something and then read only
  the part you decided you need. Passage bodies are by far the largest thing a
  result carries.
- recall -> includeDiagnostics, and you almost never want it. Off by default on
  BOTH doors, it adds back the three RECORD fields a result carries for the
  system: matchedText (the pre-embedding source string -- for a file chunk, the
  passage a second time), embeddingModel (identical for every record in a
  space), and seq (a sync counter that is not an input to any tool). It is
  RECURSIVE: a traverse answer's _graph nodes and edges follow it at every
  depth. Turn it on to see WHICH TEXT was embedded, then turn it off.

THE PER-STAGE SCORES ARE NOT BEHIND THAT FLAG, and this is worth knowing before
you try to switch them on. lexicalScore, fusedScore and rerankScore come back on
EVERY recall, on both doors, each present only when that stage ran. They are the
ORDERING: score is vector similarity, precedence in a fused recall is
rerankScore > fusedScore > score, and minScore filters on score ALONE -- so on an
instance with a reranker configured, the number that decided a result's position
is rerankScore and the number you can threshold on is a different one. Read the
highest of the three that is present to know why something placed where it did.
- The other read tools return a formatted summary line per record rather than a
  document. list_chrono and find_entities_by_name cost you an id, a name and a
  type whatever the record holds, so there is nothing to trim.

Rule of thumb: exact criteria you can name as a FIELD → query; meaning, or an
exact TOKEN you can only find inside the text → recall; both → recall +
tags/filter. (Before hybrid ranking, recall was a poor choice for exact tokens
and this guide said so; it no longer holds.) find_similar finds records semantically near an EXISTING record;
traverse walks the entity graph structurally (no semantics).`;

const SCHEMA_GUIDE = `Call get_space_meta(space) to see a space's purpose, typeSchemas, validation mode,
and entry counts — do this before writing into an unfamiliar space. A schema
declares entity/record types and their expected properties. Validation modes:
**off** (anything goes), **warn** (violations logged, write succeeds), **strict**
(violations rejected). With **strict linkage**, edges must reference existing
entities. Schema-declared property paths also unlock the fast filtered-recall path
(see retrieval guide above).`;

const REST_SUMMARY = `EVERY TOOL ON THIS LIST IS ALSO "POST /api/<tool-name>", with the token you are
using now as a Bearer header. The body is the tool's arguments exactly — the same
JSON you would send here, "space" included, nothing renamed or wrapped. One
envelope comes back for every tool: {"ok":true,"text":...,"data":...} on success
and {"ok":false,"error":...,"data":...} on a refusal, where "error" is the same
sentence you would read here. It is the same code: one function gates, resolves
and runs the call, and the two doors only translate their own envelope into it.

Older route families are still there and still work — /api/brain (facts,
entities, edges, chrono, recall), /api/spaces, /api/files, /api/tokens,
/api/networks, /api/sync, /api/conflicts, /api/duplicates, /api/schema-library,
/api/mfa, /api/about, and admin-only /api/admin/* (audit-log, webhooks, data,
local-agent, media-config). Full reference: docs/integration-guide.md in the
Ythril repository.`;

/**
 * Build the document for THIS token.
 *
 * The tool list uses the exact predicate `tools/list` uses, so the text can never advertise a tool the dispatcher would
 * deny. That predicate is passed in rather than recomputed here for the same reason the sections are shared.
 */
export function helpSections(
  ctx: ToolContext,
  visibleTools: { name: string; description: string; spaceRequired?: boolean }[],
  hiddenCount: number,
): HelpSection[] {
  const sections: HelpSection[] = [];

  sections.push({
    id: 'spaces',
    title: 'Spaces accessible to this token',
    body: '',
    preamble: 'Most tools take a "space" parameter; recall, find_similar and list_chrono search across all your spaces when it is '
      /*
       * This used to read "Call list_spaces for storage/quota details" while `list_spaces` returned counts and
       * nothing else. A caller who read the authoritative reference and believed it found no storage anywhere
       * on this door — the capability was REST-only, and the drift was invisible because nobody reports a
       * capability they were told they did not have. `list_spaces` reports it now, and this names the fields.
       */
      + 'omitted. Call list_spaces for each space\'s quota (`maxGiB`) and what its files occupy (`usageGiB`) — '
      + 'and read `usageIncomplete` beside them, because a directory the instance could not read makes that '
      + 'figure a floor rather than a total.\n\n'
      /*
       * NAMING THE SPACE-ADMIN RUNG, and marking the spaces where this token holds it.
       *
       * The capability has been enforced since #937 as `isSpaceAdminFor` — every one of the four areas at
       * `admin`, for ONE space. It had no name on any surface: the rights matrix shows four independent rungs
       * and nothing said that all four at admin IS administering that space. The canary operator asked twice
       * (2026-08-17T1910Z, narrowed 1916Z) and their complaint was about the surface rather than the
       * capability — an operator could not find it, grant it in one action, or verify they held it.
       *
       * MARKED per space rather than described in prose, because "verify they held it" is the third part of
       * that complaint and a sentence cannot answer it. The mark comes from the same predicate the server
       * enforces with, so it cannot claim a rung the caller does not have.
       */
      /*
       * REWRITTEN AT 5.0, and the old wording is the reason this paragraph is worth reading twice.
       *
       * It said a token with all four areas at `admin` for one space IS that space's administrator. That was
       * true while the capability was DERIVED, and it stopped being true when space admin became its own
       * grant — owner, 2026-09-16: *"Space admin is more than the four area admin rungs. It must be its own"*
       * and *"It includes the four but the four do not equal space admin"*.
       *
       * A sentence telling a caller to set four rungs, when four rungs no longer grant it, is worse than no
       * sentence: they follow it, are refused, and have been told to do the wrong thing by the authoritative
       * reference.
       */
      + 'ADMINISTERING A SPACE is its own grant and this list shows where you hold it. It INCLUDES the admin '
      + 'rung on all four areas (knowledge, files, schema, dataQuality) — but holding those four does not '
      + 'give it to you, so setting them will not make this appear. A space administrator manages that '
      + 'space’s own tokens and settings. It is never instance-wide — it cannot grant `instanceAdmin` or '
      + '`createSpaces`, cannot set a floor, and cannot see or edit tokens for a space it does not '
      + 'administer. `GET /api/tokens/rights-catalog` publishes the definition.',
    lines: ctx.accessibleSpaces.length > 0
      ? ctx.accessibleSpaces.map(s =>
        `- ${sanitizeDynamic(s.id)}${s.label ? ` ("${sanitizeDynamic(s.label)}")` : ''}`
        + `${isSpaceAdminFor(ctx.rights, s.id) ? '  [you administer this space]' : ''}`)
      : ['(none accessible to this token)'],
  });

  sections.push({ id: 'knowledge-model', title: 'The knowledge model', body: KNOWLEDGE_MODEL });
  sections.push({ id: 'retrieval', title: 'Choosing a retrieval mode (read this before querying)', body: RETRIEVAL_GUIDE });
  sections.push({ id: 'schemas', title: 'Schemas', body: SCHEMA_GUIDE });

  sections.push({
    id: 'tools',
    title: 'Tools available to this token',
    body: '',
    preamble: 'Each tool\'s COMPLETE input contract — every parameter, allowed values, numeric bounds, filter '
      + 'operators, and defaults — is published in its `inputSchema` via MCP `tools/list`, the authoritative '
      + 'machine-readable reference. The list below is a one-line summary per tool; call `tools/list` and read the '
      + 'schema before constructing arguments.'
      // Wording preserved verbatim from before the section refactor. `mcp-help.test.js` asserts the phrase "some tools
      // are hidden", and paraphrasing it to add a count broke that gate — a search feature has no business editing
      // reviewed prose, and the count is not worth spending the assertion on.
      //
      // Moved from the document header into this preamble, though, so it travels WITH the tool list on a searched read:
      // a caller who searches one tool and sees a short list should know the list was filtered by their scope.
      + (hiddenCount > 0
        ? '\n\nNote: some tools are hidden from this token by its scope (read-only and/or non-admin); calls to them '
          + 'would be denied.'
        : ''),
    lines: visibleTools.map(t =>
      `- **${t.name}**${t.spaceRequired ? ' (requires space)' : ''} — ${t.description}`),
  });

  sections.push({ id: 'rest', title: 'REST API (for non-MCP integrations)', body: REST_SUMMARY });

  return sections;
}

/** Render one section exactly as the full document renders it — the shared unit both paths go through. */
export function renderSection(s: HelpSection, lines?: string[]): string {
  const parts = [`## ${s.title}`];
  if (s.preamble) parts.push(s.preamble);
  if (s.body) parts.push(s.body);
  const shown = lines ?? s.lines;
  if (shown && shown.length > 0) parts.push(shown.join('\n'));
  return parts.join('\n\n');
}

/** The whole document. */
export function renderHelp(sections: HelpSection[]): string {
  return sections.map(s => renderSection(s)).join('\n\n');
}

export interface HelpMatch {
  section: HelpSection;
  /** For a line-granular section, only the lines that matched. Undefined for a whole-section match. */
  lines?: string[];
}

/**
 * Split a query into terms. All terms must be present for a match (AND), which is what a caller typing
 * `"recall filter"` means — OR would return most of the document for any two-word query and read as a broken search.
 */
export function helpTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map(t => t.trim()).filter(Boolean);
}

const hasAll = (haystack: string, terms: string[]): boolean => {
  const lower = haystack.toLowerCase();
  return terms.every(t => lower.includes(t));
};

/**
 * Search the sections lexically.
 *
 * A line-granular section matches when a LINE matches, and returns only those lines — a search for one tool must not
 * return the other thirty-nine. Its preamble still comes with it, because a tool line read without the "call tools/list
 * for the real schema" sentence invites a caller to construct arguments from a one-line summary.
 *
 * The section title counts as searchable text: `query: "schemas"` should find the schema section even though the body
 * may never repeat the word.
 */
export function searchHelp(sections: HelpSection[], query: string): HelpMatch[] {
  const terms = helpTerms(query);
  if (terms.length === 0) return [];
  const out: HelpMatch[] = [];

  for (const s of sections) {
    if (s.lines && s.lines.length > 0) {
      const hit = s.lines.filter(l => hasAll(`${s.title} ${l}`, terms));
      if (hit.length > 0) { out.push({ section: s, lines: hit }); continue; }
    }
    if (hasAll(`${s.title}\n${s.preamble ?? ''}\n${s.body}`, terms)) out.push({ section: s });
  }
  return out;
}

/**
 * What to return when nothing matched.
 *
 * NOT an empty answer. The caller asked what exists; "nothing" is the least useful true answer available, and an agent
 * that receives it typically retries with the same word. The index says what there is to ask for.
 */
export function renderHelpIndex(sections: HelpSection[], query?: string): string {
  const head = query
    ? `No section of this guide matches "${sanitizeDynamic(query, 80)}". Here is what the guide contains — `
      + 'call help with no query for the whole document, or with one of these words.'
    : 'Sections of this guide:';
  return [head, '', ...sections.map(s => `- **${s.id}** — ${s.title}`)].join('\n');
}
