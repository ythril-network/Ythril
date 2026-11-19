/**
 * The list of unconverted records takes one reason or a list of reasons, on REST and on MCP through one parser (bundle-285 slice 1, Q-938,
 * plan section 6 "Review list" and section 9 "Server (S1)").
 *
 * ## The rule
 *
 * - `reason` is one reason (as it always was), or a list of them: `reason=not_conforming,fork` or `reason=not_conforming&reason=fork` on REST, an
 *   array (or the same comma text) on MCP. The list shows the items whose reason is ANY of those given, and `total` counts exactly those.
 * - One parser reads both doors, so a list in a place one door allows is a list on the other: an unknown reason ANYWHERE in the list is refused 400
 *   `unconverted_bad_reason` (the code the single form uses) with a sentence that names the value, and a list longer than the number of reasons
 *   that exist is refused with the same code. A blank piece (`reason=fork,`) is no piece, as a blank `reason=` was always no filter.
 * - A single reason answers exactly what it answered before: the same body, whether it is sent as text, as a list of one, or with a blank beside it.
 *
 * ## Why it matters
 *
 * The Review page groups the reasons into classes ("does not fit" covers eight of them) and shows one list per class. One reason per call cannot
 * list a class, and a client that asked once per reason and merged the pages would break the page's order, its `total` and its `nextSkip`.
 *
 * ## What was wrong
 *
 * The list took one reason, and a list was refused (`unconverted_bad_reason`).
 *
 * Run: node --test testing/standalone/an-unconverted-list-filters-by-several-reasons-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';
import { openMountedDoor } from './_mounted-door.mjs';
import { itemRow, plant, ADMIN } from './_unconverted-fixture.mjs';

const skip = await mongoSkipReason();
const S = 'unconv-reasons';
const S2 = 'unconv-reasons-b';

/** The page fields that state the door's own byte budget: the one thing the two transports answer differently. */
const BUDGET_KEYS = ['budgetChars', 'budgetBytes', 'charsReturned', 'bytesReturned'];
const withoutBudget = (body) => { const b = structuredClone(body); for (const k of BUDGET_KEYS) delete b[k]; return b; };

/** Six items of three reasons: newest first they are c6 a6... (the higher the number the newer). */
const ROWS = [
  itemRow(1, { recordId: 'p-nc', kind: 'entity', type: 'person', reason: 'not_conforming' }),
  itemRow(2, { recordId: 'o-nc', kind: 'entity', type: 'org', reason: 'not_conforming' }),
  itemRow(3, { recordId: 'p-fork', kind: 'entity', type: 'person', reason: 'fork' }),
  itemRow(4, { recordId: 'f-case', kind: 'fact', type: 'claim', reason: 'no_case_matched' }),
  itemRow(5, { recordId: 'f-fork-dismissed', kind: 'fact', type: 'claim', reason: 'fork', status: 'dismissed' }),
  itemRow(6, { recordId: 'c-nc', kind: 'chrono', type: 'event', reason: 'not_conforming' }),
];

describe('the unconverted list takes one reason or a list of reasons (real MongoDB)', { skip }, () => {
  let door, mounted, admin, acts;
  const base = `/api/spaces/${S}/schema-convert/items`;
  const ids = (body) => body.items.map(r => r.recordId);

  const rest = (query) => mounted.rest(admin.key, 'GET', `${base}${query}`);
  const tool = (args) => mounted.mcp(admin.key, 'list_unconverted', { space: S, ...args });
  const viaAct = async (params) => {
    const r = await acts.listUnconvertedAct(S, params, { rights: ADMIN, transport: 'rest' });
    return 'error' in r ? { status: r.status, body: { error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.detail ?? {}) } } : { status: r.status, body: r.body };
  };

  before(async () => {
    door = await openConvertDoor({ name: 'b285s1reasons', spaces: [S, S2] });
    acts = await import('../../server/dist/spaces/unconverted-acts.js');
    mounted = await openMountedDoor();
    admin = await mounted.mint('reasons-admin', 'admin');
    await plant(door, S, ROWS);
  });
  after(async () => { await mounted?.close(); await door?.close(); });

  it('lists exactly the items of two of the three reasons, newest first, and total counts them: on REST as text and repeated, and on MCP as an array and as text', async () => {
    const expected = ['c-nc', 'p-fork', 'o-nc', 'p-nc'];
    const answers = {
      'REST reason=a,b': await rest('?reason=not_conforming,fork'),
      'REST reason=a&reason=b': await rest('?reason=not_conforming&reason=fork'),
      'REST reason=b,a (the order given does not matter)': await rest('?reason=fork,not_conforming'),
    };
    for (const [name, a] of Object.entries(answers)) {
      assert.equal(a.status, 200, `${name}: ${JSON.stringify(a.body)}`);
      assert.deepEqual(ids(a.body), expected, name);
      assert.equal(a.body.total, 4, `${name}: total counts the items of both reasons and no others`);
      assert.equal(a.body.count, 4, name);
    }
    assert.deepEqual(answers['REST reason=a&reason=b'].body, answers['REST reason=a,b'].body, 'the repeated form and the text form answered differently');
    const mcpArray = await tool({ reason: ['not_conforming', 'fork'] });
    const mcpText = await tool({ reason: 'not_conforming,fork' });
    for (const [name, a] of [['MCP array', mcpArray], ['MCP text', mcpText]]) {
      assert.equal(a.isError, false, `${name}: ${a.text}`);
      assert.deepEqual(ids(a.body), expected, name);
      assert.equal(a.body.total, 4, name);
    }
    assert.deepEqual(withoutBudget(mcpArray.body), withoutBudget(answers['REST reason=a,b'].body), 'the two doors answered different bodies for one list');
    assert.deepEqual((await viaAct({ reason: ['not_conforming', 'fork'] })).body.items.map(r => r.recordId), expected, 'the act asked with an array');
    assert.match(mcpArray.text, /4 on this page of 4/, 'the tool says in words how many matched');
  });

  it('a list composes with the other filters and the status, and pages by the same rule', async () => {
    assert.deepEqual(ids((await rest('?reason=not_conforming,fork&kind=entity')).body), ['p-fork', 'o-nc', 'p-nc']);
    assert.deepEqual(ids((await rest('?reason=not_conforming,fork&type=person')).body), ['p-fork', 'p-nc']);
    assert.deepEqual(ids((await rest('?reason=not_conforming,fork&kind=fact')).body), [], 'the one fact item of those reasons is dismissed');
    assert.deepEqual(ids((await rest('?reason=not_conforming,fork&kind=fact&status=dismissed')).body), ['f-fork-dismissed']);
    assert.deepEqual(ids((await rest('?reason=fork,no_case_matched')).body), ['f-case', 'p-fork']);
    const first = (await rest('?reason=not_conforming,fork&limit=3')).body;
    assert.deepEqual([ids(first), first.total, first.truncated, first.nextSkip], [['c-nc', 'p-fork', 'o-nc'], 4, true, 3]);
    const second = (await rest('?reason=not_conforming,fork&limit=3&skip=3')).body;
    assert.deepEqual([ids(second), second.total, second.truncated], [['p-nc'], 4, false]);
    assert.deepEqual((await rest('?reason=not_conforming,fork,no_case_matched,step_refused&limit=500')).body.total, 5, 'a list that names a reason nobody has is not an error, only that reason lists nothing');
  });

  it('one reason answers exactly as before: as text, as a list of one, with a blank piece, or twice', async () => {
    const before = await rest('?reason=fork');
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(ids(before.body), ['p-fork']);
    assert.equal(before.body.total, 1);
    assert.deepEqual(Object.keys(before.body.items[0]).sort(),
      ['detectedAt', 'fromFp', 'itemId', 'kind', 'proposed', 'reason', 'recordId', 'seq', 'space', 'status', 'toFp', 'type', 'violations'],
      'a row is the row it was (the record part is absent: the planted record is not stored)');
    for (const [name, a] of [
      ['reason=fork,', await rest('?reason=fork,')], ['reason=,fork', await rest('?reason=,fork')], ['reason=fork&reason=fork', await rest('?reason=fork&reason=fork')],
      ['reason=fork,fork', await rest('?reason=fork,fork')], ['reason=%20fork%20', await rest('?reason=%20fork%20')],
    ]) assert.deepEqual(a, before, `${name} answered otherwise than reason=fork`);
    for (const [name, args] of [['MCP text', { reason: 'fork' }], ['MCP list of one', { reason: ['fork'] }], ['MCP list with a blank', { reason: ['fork', ''] }]]) {
      const a = await tool(args);
      assert.equal(a.isError, false, `${name}: ${a.text}`);
      assert.deepEqual(withoutBudget(a.body), withoutBudget(before.body), `${name} answered otherwise than reason=fork`);
    }
    // A blank reason, or nothing but blank pieces, is no filter at all, as it always was.
    const every = await rest('');
    for (const q of ['?reason=', '?reason=,', '?reason=,,']) assert.deepEqual(await rest(q), every, `${q} narrowed the list`);
    assert.equal(every.body.total, 5);
  });

  it('refuses an unknown reason anywhere in a list, 400 unconverted_bad_reason, naming the value, on REST and on MCP', async () => {
    const cases = [
      ['?reason=nopeNope', 'nopeNope'], ['?reason=fork,nopeNope', 'nopeNope'], ['?reason=nopeNope,fork', 'nopeNope'],
      ['?reason=fork&reason=nopeNope', 'nopeNope'], ['?reason=not_conforming,fork,nopeNope,no_case_matched', 'nopeNope'],
    ];
    for (const [query, value] of cases) {
      const a = await rest(query);
      assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_reason'], `${query}: ${JSON.stringify(a.body)}`);
      assert.ok(a.body.error.includes(value), `${query}: the refusal does not name the value: ${a.body.error}`);
    }
    for (const reason of [['fork', 'nopeNope'], ['nopeNope'], 'fork,nopeNope', [5], 5, { fork: true }]) {
      const a = await tool({ reason });
      assert.deepEqual([a.isError, a.body?.code], [true, 'unconverted_bad_reason'], `MCP ${JSON.stringify(reason)}: ${a.text}`);
      assert.match(a.text, /unconverted_bad_reason/);
    }
    const named = await tool({ reason: ['fork', 'nopeNope'] });
    assert.ok(named.text.includes('nopeNope'), `the tool's refusal does not name the value: ${named.text}`);
    // The refusals of the two doors are the one sentence: the parser is one.
    const viaRest = await rest('?reason=fork,nopeNope');
    const viaTool = await tool({ reason: ['fork', 'nopeNope'] });
    assert.equal(viaTool.body.error, viaRest.body.error, 'the two doors word one refusal twice');
  });

  it('a value in the list is named bounded: an oversized or line-breaking value neither floods the answer nor forges a line', async () => {
    const huge = 'x'.repeat(5_000);
    const a = await rest(`?reason=fork,${huge}`);
    assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_reason']);
    assert.ok(a.body.error.length < 1_000, `the refusal is ${a.body.error.length} characters long`);
    const broken = await tool({ reason: ['fork', 'a\nforged line'] });
    assert.equal(broken.isError, true);
    assert.ok(!broken.body.error.includes('\n'), 'a line break of the value reached the refusal');
  });

  it('refuses a list longer than the number of reasons there are, with the same code, and takes a list of exactly that many', async () => {
    const { UNCONVERTED_REASONS } = await import('../../server/dist/spaces/unconverted-terms.js');
    assert.ok(UNCONVERTED_REASONS.length >= 10, 'the reasons that exist');
    const all = [...UNCONVERTED_REASONS];
    const ok = await rest(`?reason=${all.join(',')}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.total, 5, 'every reason at once lists every open item');
    const okTool = await tool({ reason: all });
    assert.equal(okTool.isError, false, okTool.text);
    const tooMany = [...all, 'fork'];
    for (const [name, a] of [['REST text', await rest(`?reason=${tooMany.join(',')}`)], ['REST repeated', await rest(`?${tooMany.map(r => `reason=${r}`).join('&')}`)]]) {
      assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_reason'], `${name}: ${JSON.stringify(a.body)}`);
      assert.match(a.body.error, new RegExp(String(all.length)), `${name}: the refusal does not say the bound`);
    }
    const tooManyTool = await tool({ reason: tooMany });
    assert.deepEqual([tooManyTool.isError, tooManyTool.body?.code], [true, 'unconverted_bad_reason'], tooManyTool.text);
    const flood = await rest(`?reason=${'fork,'.repeat(1_000)}`);
    assert.deepEqual([flood.status, flood.body?.code], [400, 'unconverted_bad_reason'], 'a thousand pieces are no list');
  });

  // ---- status=all (bundle-285 S1, the Review page's Open / Dismissed / All) ----

  it('status=all lists the open and the dismissed items together, newest first, each row saying its status, total counting both, counts and openBy unchanged', async () => {
    const newestFirst = ['c-nc', 'f-fork-dismissed', 'f-case', 'p-fork', 'o-nc', 'p-nc'];
    const open = await rest('');
    for (const [name, a] of [['REST', await rest('?status=all')], ['MCP', await tool({ status: 'all' })], ['act', await viaAct({ status: 'all' })]]) {
      assert.equal(a.status ?? 200, 200, `${name}: ${JSON.stringify(a.body)}`);
      assert.equal(a.isError ?? false, false, `${name}: ${a.text}`);
      assert.deepEqual(ids(a.body), newestFirst, `${name}: one newest-first order across both statuses`);
      assert.deepEqual(a.body.items.map(r => r.status), ['open', 'dismissed', 'open', 'open', 'open', 'open'], `${name}: each row says its status`);
      assert.equal(a.body.total, 6, `${name}: total counts both statuses`);
      assert.deepEqual(a.body.counts, open.body.counts, `${name}: counts are those of the whole space, whatever the status asked for`);
    }
    assert.deepEqual(withoutBudget((await tool({ status: 'all' })).body), withoutBudget((await rest('?status=all')).body), 'the doors answered different bodies');
    assert.deepEqual(open.body.items.map(r => r.recordId), ['c-nc', 'f-case', 'p-fork', 'o-nc', 'p-nc'], 'an absent status stays open');
    assert.deepEqual(ids((await rest('?status=')).body), ids(open.body), 'a blank status is no status: open');
    assert.deepEqual(ids((await rest('?status=dismissed')).body), ['f-fork-dismissed']);
    assert.deepEqual(ids((await rest('?status=all&reason=fork,no_case_matched')).body), ['f-fork-dismissed', 'f-case', 'p-fork'], 'all composes with the reasons');
    assert.deepEqual(ids((await rest('?status=all&kind=fact')).body), ['f-fork-dismissed', 'f-case']);
  });

  it('pages across the boundary between an open and a dismissed item without skipping or repeating, by the one cursor paging', async () => {
    const whole = ids((await rest('?status=all')).body);
    assert.equal(whole.length, 6);
    for (const limit of [1, 2, 4, 5]) {
      const seen = [];
      let skip = 0;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = (await rest(`?status=all&limit=${limit}&skip=${skip}`)).body;
        assert.equal(page.total, 6, `limit ${limit}: total is the whole list's on every page`);
        seen.push(...ids(page));
        if (!page.truncated) { assert.equal('nextSkip' in page, false); break; }
        assert.equal(page.nextSkip, skip + page.count, `limit ${limit}: the cursor is where the page ended`);
        skip = page.nextSkip;
      }
      assert.deepEqual(seen, whole, `limit ${limit}: the pages together are the list, none twice, none missing`);
    }
    const edge = (await rest('?status=all&limit=2')).body;
    assert.deepEqual([ids(edge), edge.items.map(r => r.status)], [['c-nc', 'f-fork-dismissed'], ['open', 'dismissed']], 'the first page ends on the dismissed item');
    assert.deepEqual(ids((await rest(`?status=all&limit=2&skip=${edge.nextSkip}`)).body), ['f-case', 'p-fork'], 'the next page starts on the open item after it');
  });

  it('through a personal view status=all merges both statuses of every member newest first, total and counts summed as for the other statuses', async () => {
    await plant(door, S2, [
      itemRow(10, { recordId: 'b-open', type: 'org', reason: 'fork' }),
      itemRow(11, { recordId: 'b-dismissed', type: 'org', reason: 'fork', status: 'dismissed' }),
    ]);
    const view = async (params) => {
      const r = await acts.listUnconvertedAct(S, params, { rights: ADMIN, transport: 'rest' }, [S, S2]);
      assert.equal(r.status, 200, JSON.stringify(r));
      return r.body;
    };
    const all = await view({ status: 'all' });
    assert.deepEqual(ids(all), ['b-dismissed', 'b-open', 'c-nc', 'f-fork-dismissed', 'f-case', 'p-fork', 'o-nc', 'p-nc']);
    assert.equal(all.total, 8);
    assert.deepEqual(all.items.slice(0, 2).map(r => r.space), [S2, S2]);
    const open = await view({});
    assert.equal(open.total, 6);
    assert.deepEqual(all.counts, open.counts, 'counts are the members\' summed whatever the status');
    assert.deepEqual([open.counts.open, open.counts.dismissed], [6, 2]);
    assert.deepEqual(ids(await view({ status: 'dismissed' })), ['b-dismissed', 'f-fork-dismissed']);
    await plant(door, S2, []);
  });

  it('an unknown status is still refused by its own code, on both doors, naming the value', async () => {
    for (const status of ['everything', 'ALL', 'All', 'open,dismissed', 'none']) {
      const a = await rest(`?status=${encodeURIComponent(status)}`);
      assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_status'], `${status}: ${JSON.stringify(a.body)}`);
      assert.ok(a.body.error.includes(`'${status}'`), `${status}: the refusal does not name the value: ${a.body.error}`);
      const t = await tool({ status });
      assert.deepEqual([t.isError, t.body?.code], [true, 'unconverted_bad_status'], `MCP ${status}: ${t.text}`);
      assert.equal(t.body.error, a.body.error, 'the two doors word one refusal twice');
    }
  });

  it('the tool and the route state the list form in one schema: the tool takes a reason or an array of reasons, bounded, from the act\'s own reasons', async () => {
    const { UNCONVERTED_REASONS } = await import('../../server/dist/spaces/unconverted-terms.js');
    const { list_unconvertedTool, dismiss_unconverted_shownTool } = await import('../../server/dist/mcp/tools/unconverted.js');
    const schemas = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };
    const listStatus = list_unconvertedTool.inputSchema(schemas).properties.status;
    assert.deepEqual(listStatus.enum, ['open', 'dismissed', 'all'], 'the list declares the three statuses it takes');
    assert.match(listStatus.description, /all/, 'the status description says what all is');
    for (const t of [list_unconvertedTool, dismiss_unconverted_shownTool]) {
      const node = t.inputSchema(schemas).properties.reason;
      const branches = node.anyOf ?? node.oneOf;
      assert.ok(Array.isArray(branches) && branches.length === 2, `${t.name}: reason is not one reason or a list of them: ${JSON.stringify(node)}`);
      const single = branches.find(b => b.type === 'string');
      const list = branches.find(b => b.type === 'array');
      assert.deepEqual(single?.enum, [...UNCONVERTED_REASONS], `${t.name}: the single form does not declare the reasons`);
      assert.deepEqual(list?.items?.enum, [...UNCONVERTED_REASONS], `${t.name}: the list form does not declare the reasons`);
      assert.equal(list?.maxItems, UNCONVERTED_REASONS.length, `${t.name}: the list form is not bounded by the number of reasons`);
      assert.match(node.description, /list|array/i, `${t.name}: the description does not say the list form`);
      assert.match(node.description, new RegExp(`at most ${UNCONVERTED_REASONS.length}|${UNCONVERTED_REASONS.length} reasons`), `${t.name}: the description does not say the bound in words`);
    }
  });
});
