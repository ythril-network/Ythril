/**
 * The `filter` tool — a structured, read-only query over one brain collection.
 *
 * ## Why it is not in `search.ts` with `recall` and `find_similar`
 *
 * It was, and `no-new-god-files` is what moved it: that file reached its ceiling and the next change to
 * this tool could not be made without either splitting something out or writing an exemption. The split is
 * the honest one, because the three tools were never one responsibility. `recall` and `find_similar` RANK
 * — they embed, they score, they fuse two rankings. `filter` does not: it takes a predicate and returns
 * every row that satisfies it, which is the EXACT counterpart the tool description already calls it.
 *
 * ## What it shares, and where that shared thing lives
 *
 * Almost everything this tool does beyond dispatching is in a module both doors call — `resolvePredicate`
 * for the conveniences, the file path and the derived chrono status; `decorateMemberRows` and
 * `decoratePage` for the endpoint names and the job progress; `pageAcrossMembers` for a proxy space. That
 * is what makes the move a move rather than a fork: there is no per-door logic here to leave behind.
 */
import { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { BRAIN_COLLECTIONS, type BrainCollection } from '../../config/types.js';
import { QUERY_FILTER_OPERATORS } from './shared.js';
import { resolveBudget, applyBudget, budgetFields, type BudgetRequest, defaultBudgetChars } from '../../brain/result-budget.js';
import {
  queryBrain, countBrain, compareBySort, DEFAULT_QUERY_SORT, DEFAULT_QUERY_LIMIT, PROXY_PAGE_CEILING,
  parseQueryPaging,
} from '../../brain/query.js';
import { parseSortParam, toMongoSort, SORTABLE_FIELDS } from '../../brain/list-sort.js';
import { CONVENIENCE_SCHEMA } from '../../brain/list-conveniences.js';
import { FILE_PATH_SCHEMA } from '../../brain/file-path-arg.js';
import { decorateMemberRows, decoratePage, resolvePredicate, PAGE_DECORATION_SCHEMA } from '../../brain/list-decorations.js';
import { withoutListDiagnostics } from '../../brain/read-projection.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { pageAcrossMembers } from '../../spaces/page-across-members.js';
import { resolveEntityIdsByName } from '../../brain/entities.js';
import { attachedToEntityNamed } from '../../brain/entity-name-scope.js';

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
  // Optional since 5.0, matching `POST /api/brain/filter` and the rest of the search family. Omit it and
  // the read runs across every space this token holds `knowledge: read` in.
  //
  // It was left REQUIRED here when the ROUTE was changed — this repo's signature defect happening
  // inside the change that was fixing another instance of it: one rule, two doors, and the MCP one
  // quietly narrower. Caught by an integration test calling `filter` without a space.
  spaceRequired: false,
  // recall / similar / filter fan out per space already, so a list costs them nothing but
  // the parse. Every other tool acts on exactly one space and refuses a list.
  spaceList: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.optionalSpace,
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
            /*
             * `minimum` and NO `maximum`, and the asymmetry is deliberate — the same one `windowDays`
             * carries on `graph_link_preflight`, for the same reason. The MCP dispatcher enforces this
             * schema BEFORE the handler runs, so a `maximum` here would REFUSE a page the REST door
             * serves: a 400 on one door and an answer on the other, which `CLAUDE.md` names in those
             * words as worse than either alone.
             */
            limit: { type: 'number', minimum: 1, default: DEFAULT_QUERY_LIMIT, description: `Max documents in this page. Default ${DEFAULT_QUERY_LIMIT}, and NOT capped — it was silently clamped to 100 until 5.0, so a caller asking for 200 got 100 with \`truncated\` making it read as a correct short page. What bounds an answer instead: the byte budget (\`maxChars\`/\`maxBytes\`) trims it and hands you \`nextSkip\`, \`maxTimeMS\` bounds the query's duration, and on a PROXY space \`skip + limit\` past the merge ceiling is an explicit 400 naming the limit. Compare \`count\` against \`total\` to know whether more rows satisfy the filter — a full page is not evidence that it is the last one.` },
            skip: { type: 'number', minimum: 0, description: 'Rows to discard before the page, for paging. The result order is total (`_id` breaks every tie), so no row can be seen twice or missed between pages. On a proxy space the page is computed over the MERGED set, not per member.' },
            sort: { type: 'string', description: 'Field to order by. Allowed values depend on the collection (entities: createdAt, name, type; edges: createdAt, label, from, to, type, weight; facts: createdAt, type; chrono: createdAt, title, startsAt, endsAt, status, type; files: createdAt, updatedAt, path). An unknown field is refused and names the allowed ones. Omit for newest-first.' },
            dir: { type: 'string', enum: ['asc', 'desc'], description: "Sort direction, default desc. Only meaningful with `sort`." },
            entityName: {
              type: 'string',
              description: 'Only records attached to an entity whose name CONTAINS this, case-insensitively. '
                + 'For `facts` and `chrono` only — they carry entity ids, and this resolves the name to those '
                + 'ids first. It is a join rather than a predicate, which is why `filter` cannot express it: '
                + 'ids belong to the space that owns them, so on a proxy the resolution runs per member. A '
                + 'name that matches nothing returns NOTHING rather than everything.',
            },
            fromName: {
              type: 'string',
              description: 'Only edges whose FROM end is an entity whose name contains this. For `edges` '
                + 'only. Direction is data, not a guess — an edge from Alice to Bob matches `fromName: '
                + '"Alice"` and not `toName: "Alice"`.',
            },
            toName: {
              type: 'string',
              description: 'Only edges whose TO end is an entity whose name contains this. For `edges` only.',
            },
            maxChars: { type: 'integer', minimum: 1000, description: 'Ceiling on the serialised response body, in CHARACTERS. **DEFAULT 25000 ON THIS DOOR, and 50000 on REST.** `limit` caps ROWS and says nothing about how big one is, so a page of file records or of long-described entities had no size bound at all before 3.7 — on the read tool you are most likely to page through. When the budget bites, `results` is a PREFIX of the page, `truncated` says so, and `nextSkip` is where to continue: send it back as `skip`. `count` is what you were actually given and still matches `results.length`; `total` is unchanged and still the whole match.' },
            maxBytes: { type: 'integer', minimum: 1000, description: 'Ceiling on the serialised response body, in real UTF-8 BYTES. **NO DEFAULT — opt-in.** Set it when your limit is genuinely a byte limit. Bytes are always >= characters, so a byte default equal to the character one would silently bind on every non-ASCII answer. When you set both, BOTH apply: the page stops at whichever ceiling it reaches first.' },
            maxTokens: { type: 'integer', minimum: 1, description: 'A convenience onto `maxChars`, converted at a fixed 3.5 characters per token — the conversion produces characters. If both are sent the SMALLER resulting character figure applies. An approximation: the server does not know your tokeniser.' },
            maxTimeMS: { type: 'number', minimum: 1, maximum: 10000, default: 5000, description: 'Server-side query timeout in ms. Default 5000, hard-capped at 10000.' },
            // The five list conveniences, declared beside the module that assembles them — see
            // `CONVENIENCE_SCHEMA` in `brain/list-conveniences.ts`. Spread rather than spelled so the
            // names, their meanings and their assembly cannot drift into three descriptions.
            ...CONVENIENCE_SCHEMA,
            // The page-decoration asks, declared beside the module that applies them — see
            // `PAGE_DECORATION_SCHEMA` in `brain/list-decorations.ts`. A tool spelling its own
            // descriptions is a second account of that module's behaviour.
            ...PAGE_DECORATION_SCHEMA,
            // ONE file by its stored path, declared beside the module that normalises it — see
            // `FILE_PATH_SCHEMA` in `brain/file-path-arg.ts`. Same reason as the two above: the
            // transform and its description belong in one place or they stop agreeing.
            ...FILE_PATH_SCHEMA,
          },
          /*
           * `filter` is NOT required, since 5.0 and on both doors in the same change. A caller narrowing
           * by `tag` alone had to send `filter: {}` to say "and no predicate", which is a shape you have
           * to be told about. An omitted filter is the empty predicate, exactly as `{}` always was.
           */
          required: ['collection'],
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
    const rawFilter =
      a['filter'] != null && typeof a['filter'] === 'object'
        ? (a['filter'] as Record<string, unknown>)
        : {};
    /*
     * The conveniences are merged UNDER `$and`, by the module, never assigned over the caller's
     * predicate — `search` produces an `$or` and so may the caller. See `brain/list-conveniences.ts`;
     * the refusal branch is why it returns a result rather than a predicate.
     */
    const resolved = resolvePredicate(collName, a, rawFilter, ctx.callSpaces[0] ?? '');
    if ('error' in resolved) throw new Error(resolved.error);
    const filter = resolved.predicate;
    // The same parser the REST door calls, so the two cannot disagree about a value neither can use.
    const paging = parseQueryPaging({ limit: a['limit'], skip: a['skip'] });
    if ('error' in paging) throw new Error(paging.error);
    const { limit, skip } = paging;

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
    // A NAMED space resolves its proxy members; an OMITTED one is every space this connection can reach.
    // `memberSpacesWithin('')` would answer nothing, which is how an optional parameter turns into a read
    // that silently returns empty rather than the cross-space read it advertises.
    const reachable = ctx.accessibleSpaces.map(sp => sp.id);
    const members = ctx.callSpaces.length > 0
      ? [...new Set(ctx.callSpaces.flatMap(sp => memberSpacesWithin(sp, reachable)))]
      : reachable;
    const coll = collName as BrainCollection;

    /*
     * THE NAME CONVENIENCES, and they are a JOIN rather than part of the predicate.
     *
     * A record stores entity IDS. The nine per-collection list routes have always accepted a NAME and
     * resolved it server-side before filtering; `filter` took a Mongo predicate and could not, so an agent
     * could not ask for "facts about Alice" by name while a browser could — a capability REST had and MCP
     * did not, hidden by a capability-map pairing that called the two answered.
     *
     * RESOLVED PER MEMBER, which is the part a caller could not do for itself. An id belongs to the space
     * that owns it, so resolving `Alice` against one member and querying another matches nothing while
     * looking entirely correct. That is also why this cannot be pushed to the client when the routes go.
     */
    const nameArg = (k: string): string | undefined =>
      typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string) : undefined;
    const entityName = nameArg('entityName');
    const fromName = nameArg('fromName');
    const toName = nameArg('toName');

    /*
     * REFUSED on a collection it cannot mean, never ignored.
     *
     * `entityName` on `entities` has no meaning — the predicate for that is `filter: { name: ... }` — and
     * dropping it silently hands back every entity in the space to a caller who believes they narrowed the
     * search. The refusal names what to use instead, because "unsupported" without an alternative is how a
     * caller ends up paging the whole collection by hand.
     */
    // Refused on a collection it cannot mean, word for word what the route answers — a caller comparing
    // the two doors should not have to work out that two wordings mean the same thing.
    if (a['deriveStatus'] !== undefined && coll !== 'chrono') {
      throw new Error(`\`deriveStatus\` applies to chrono only, not '${coll}'. `
        + 'Only a chrono entry has a due moment for a status to be derived from.');
    }
    const ENTITY_LINKED: readonly string[] = ['facts', 'chrono'];
    if (entityName && !ENTITY_LINKED.includes(coll)) {
      throw new Error(`entityName applies to ${ENTITY_LINKED.join(' and ')} only, not '${coll}'. `
        + `For entities themselves use filter: { name: ... }; for edges use fromName or toName.`);
    }
    if ((fromName || toName) && coll !== 'edges') {
      throw new Error(`${fromName ? 'fromName' : 'toName'} applies to edges only, not '${coll}'. `
        + `For facts and chrono use entityName.`);
    }

    /** The predicate for ONE member: the caller's filter, plus whatever the names resolve to there. */
    const filterFor = async (mid: string): Promise<Record<string, unknown>> => {
      if (!entityName && !fromName && !toName) return filter;
      const per: Record<string, unknown> = { ...filter };
      // `$in: []` when a name matches nothing, and that is the answer rather than a reason to widen: a
      // typo must not become a full-collection read that looks like a successful search.
      // Through the shared predicate, which covers BOTH the legacy array and link records — reading
      // only the array misses every record written with `linkEntities`, which is the form the guide
      // leads with. See `entity-name-scope.ts` for the measurement.
      if (entityName) Object.assign(per, await attachedToEntityNamed(mid, coll === 'chrono' ? 'chrono' : 'fact', entityName));
      if (fromName) per['from'] = { $in: await resolveEntityIdsByName(mid, fromName) };
      if (toName) per['to'] = { $in: await resolveEntityIdsByName(mid, toName) };
      return per;
    };

    const page = await pageAcrossMembers({
      members,
      limit,
      skip,
      ceiling: PROXY_PAGE_CEILING,
      compare: compareBySort(order),
      readMember: async (mid, lim, sk) => decorateMemberRows(coll, mid,
        (await queryBrain(mid, coll, await filterFor(mid), projection, lim, maxTimeMS, sk, order)) as Array<Record<string, unknown>>),
    });
    if (!page.ok) throw new Error(page.error);
    // Resolved before the read, so a bad `maxBytes` is an error rather than a query that ran first.
    const queryBudget = resolveBudget(a as BudgetRequest, defaultBudgetChars(ctx.transport));
    if (!queryBudget.ok) throw new Error(queryBudget.error);
    /*
     * The same two DECORATIONS the REST door applies, through the same module: an edge's endpoint names,
     * and a file's job step progress (joined per member above, before the page is merged). They were on
     * the per-collection list routes and on neither door of `filter`, which is a capability the browser
     * had and an agent did not — and a decoration is not a parameter, so nothing compared them.
     *
     * A NAMED space resolves its proxy members; an omitted one is every space this connection can reach,
     * which is the same list the page was read from.
     */
    const decorated = await decoratePage(coll, ctx.callSpaces[0] ?? members[0] ?? '', page.rows,
      async read => (await Promise.all(members.map(read))).flat(),
      { deriveStatus: a['deriveStatus'] === true });
    // And the diagnostics projection, read from the tool argument rather than a query string.
    const docs = withoutListDiagnostics(decorated, a['includeDiagnostics'] === true);

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
        /*
         * ECHOED, and it came from the route this tool replaced. `POST /api/brain/filter` sent the
         * collection back with every answer and this tool did not, which is a field a caller loses when
         * the twin is deleted — the one thing a deletion must not do quietly.
         *
         * It earns its place beyond compatibility: `limit` and `skip` are echoed for a pager, and a
         * client holding several in-flight reads needs the same thing for WHICH read this is.
         */
        collection: coll,
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
