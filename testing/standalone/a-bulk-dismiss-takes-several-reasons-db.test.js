/**
 * The bulk dismiss of unconverted records takes one reason or a list of reasons, and its `expect` counts over all of them (bundle-285 slice 1,
 * Q-938, plan section 6 "Dismiss all shown" and section 9 "Server (S1)").
 *
 * ## The rule
 *
 * - `reason` is one reason or a list of them, on REST (the body's `reason`: text, comma text or an array) and on MCP, read by the one parser the list
 *   reads with. The call dismisses every OPEN item whose reason is any of those given (and that the other filters keep) when the caller was shown
 *   exactly `expect` of them: the number the list answers as `total` for the same filter.
 * - A wrong `expect` is 409 `unconverted_changed` with `current`, and `current` counts over the same set (every reason given, open items only);
 *   nothing is dismissed.
 * - An unknown reason anywhere in the list, or a list longer than the reasons that exist, is 400 `unconverted_bad_reason` and nothing is dismissed.
 * - The bound of one call (`UNCONVERTED_DISMISS_MAX`) counts over the same set: a list of reasons that matches more is 400 `unconverted_too_many`.
 * - A call that dismissed a list of reasons is audited with the reasons it named: the entry's `reason` change is the list as one text, never dropped
 *   for not being a scalar.
 *
 * ## Why it matters
 *
 * The Review page offers "Dismiss all N shown" under a class of reasons. N is the list's `total` for that class; if `expect` counted one reason
 * only, or `current` another set, the confirmation would be of one number and the dismissal of another.
 *
 * ## What was wrong
 *
 * The bulk dismiss took one reason, and a list was refused (`unconverted_bad_reason`).
 *
 * Run: node --test testing/standalone/a-bulk-dismiss-takes-several-reasons-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';
import { openMountedDoor } from './_mounted-door.mjs';
import { itemRow, itemsOf, plant, ADMIN } from './_unconverted-fixture.mjs';

const skip = await mongoSkipReason();
const S = 'unconv-bulk';
const BIG = 'unconv-bulk-big';

/** Seven items: not_conforming x3 (one dismissed), fork x2, no_case_matched x1, step_refused x1. */
const ROWS = () => [
  itemRow(1, { recordId: 'nc1', kind: 'entity', type: 'person', reason: 'not_conforming' }),
  itemRow(2, { recordId: 'nc2', kind: 'entity', type: 'org', reason: 'not_conforming' }),
  itemRow(3, { recordId: 'nc-dismissed', kind: 'entity', type: 'person', reason: 'not_conforming', status: 'dismissed' }),
  itemRow(4, { recordId: 'fork1', kind: 'entity', type: 'person', reason: 'fork' }),
  itemRow(5, { recordId: 'fork2', kind: 'fact', type: 'claim', reason: 'fork' }),
  itemRow(6, { recordId: 'case1', kind: 'fact', type: 'claim', reason: 'no_case_matched' }),
  itemRow(7, { recordId: 'refused1', kind: 'fact', type: 'claim', reason: 'step_refused' }),
];

describe('the bulk dismiss takes one reason or a list of reasons (real MongoDB)', { skip }, () => {
  let door, mounted, writer, acts;
  const base = `/api/spaces/${S}/schema-convert/items`;
  const statuses = async (space = S) => Object.fromEntries((await itemsOf(door, space).find({}).toArray()).map(r => [r.recordId, r.status]));
  const dismissedOf = (all) => Object.entries(all).filter(([, s]) => s === 'dismissed').map(([id]) => id).sort();
  const bulkRest = (body, space = S) => mounted.rest(writer.key, 'POST', `/api/spaces/${space}/schema-convert/items/dismiss`, body);
  const bulkTool = (args, space = S) => mounted.mcp(writer.key, 'dismiss_unconverted_shown', { space, ...args });
  const listTotal = async (reason) => {
    const r = await acts.listUnconvertedAct(S, { reason }, { rights: ADMIN, transport: 'rest' });
    assert.equal(r.status, 200, `the list refused reason ${JSON.stringify(reason)}: ${JSON.stringify(r)}`);
    return r.body.total;
  };

  before(async () => {
    door = await openConvertDoor({ name: 'b285s1bulk', spaces: [S, BIG] });
    acts = await import('../../server/dist/spaces/unconverted-acts.js');
    mounted = await openMountedDoor();
    writer = await mounted.mint('bulk-admin', 'admin');
  });
  beforeEach(async () => { await plant(door, S, ROWS()); });
  after(async () => { await mounted?.close(); await door?.close(); });

  it('dismisses the open items of every reason given when expect counts over all of them: through the act, REST and MCP, one list form each', async () => {
    const shown = await listTotal(['not_conforming', 'fork']);
    assert.equal(shown, 4, 'the list shows four open items of the two reasons (the dismissed one is not shown)');

    const viaAct = await acts.dismissShownUnconvertedAct(S, { reason: ['not_conforming', 'fork'], expect: shown }, { rights: ADMIN, transport: 'rest' });
    assert.deepEqual([viaAct.status, viaAct.body], [200, { dismissed: 4 }], JSON.stringify(viaAct));
    assert.deepEqual(dismissedOf(await statuses()), ['fork1', 'fork2', 'nc-dismissed', 'nc1', 'nc2'], 'exactly the items of the two reasons are dismissed');
    assert.equal((await statuses())['case1'], 'open');
    assert.equal((await statuses())['refused1'], 'open');

    await plant(door, S, ROWS());
    const viaRest = await bulkRest({ reason: ['not_conforming', 'fork'], expect: 4 });
    assert.deepEqual([viaRest.status, viaRest.body], [200, { dismissed: 4 }], JSON.stringify(viaRest));
    assert.deepEqual(dismissedOf(await statuses()), ['fork1', 'fork2', 'nc-dismissed', 'nc1', 'nc2']);

    await plant(door, S, ROWS());
    const viaText = await bulkRest({ reason: 'not_conforming,fork', expect: 4 });
    assert.deepEqual([viaText.status, viaText.body], [200, { dismissed: 4 }], 'the comma text form is the same list');
    assert.deepEqual(dismissedOf(await statuses()), ['fork1', 'fork2', 'nc-dismissed', 'nc1', 'nc2']);

    await plant(door, S, ROWS());
    const viaTool = await bulkTool({ reason: ['not_conforming', 'fork'], expect: 4 });
    assert.deepEqual([viaTool.isError, viaTool.body], [false, { dismissed: 4 }], viaTool.text);
    assert.deepEqual(dismissedOf(await statuses()), ['fork1', 'fork2', 'nc-dismissed', 'nc1', 'nc2']);
  });

  it('narrows a list of reasons by kind and type like the list does, and the list\'s total is the expect the call takes', async () => {
    const listed = await acts.listUnconvertedAct(S, { reason: ['fork', 'no_case_matched', 'step_refused'], kind: 'fact', type: 'claim' }, { rights: ADMIN, transport: 'rest' });
    assert.equal(listed.body.total, 3);
    const done = await bulkRest({ reason: ['fork', 'no_case_matched', 'step_refused'], kind: 'fact', type: 'claim', expect: listed.body.total });
    assert.deepEqual([done.status, done.body], [200, { dismissed: 3 }], JSON.stringify(done));
    assert.deepEqual(dismissedOf(await statuses()), ['case1', 'fork2', 'nc-dismissed', 'refused1'], 'fork1 is an entity: the kind narrows a list of reasons');
  });

  it('a wrong expect is 409 with current over the same set (every reason given, open items only) and nothing is dismissed', async () => {
    const before = await statuses();
    for (const expect of [0, 1, 2, 3, 5, 7]) {
      const a = await bulkRest({ reason: ['not_conforming', 'fork'], expect });
      assert.deepEqual([a.status, a.body.code, a.body.current], [409, 'unconverted_changed', 4], `expect ${expect}: ${JSON.stringify(a.body)}`);
      assert.match(a.body.error, /4/);
    }
    const tool = await bulkTool({ reason: ['not_conforming', 'fork'], expect: 3 });
    assert.deepEqual([tool.isError, tool.body?.code, tool.body?.current], [true, 'unconverted_changed', 4], tool.text);
    const viaText = await bulkRest({ reason: 'fork,no_case_matched', expect: 9 });
    assert.deepEqual([viaText.status, viaText.body.current], [409, 3], 'current counts the items of both reasons given');
    const one = await bulkRest({ reason: 'fork', expect: 9 });
    assert.deepEqual([one.status, one.body.current], [409, 2], 'a single reason counts as it did');
    assert.deepEqual(await statuses(), before, 'a refused call dismissed an item');
  });

  it('a single reason dismisses exactly as before, whether it is sent as text or as a list of one', async () => {
    for (const reason of ['fork', ['fork'], 'fork,', ['fork', 'fork']]) {
      await plant(door, S, ROWS());
      const a = await bulkRest({ reason, expect: 2 });
      assert.deepEqual([a.status, a.body], [200, { dismissed: 2 }], `${JSON.stringify(reason)}: ${JSON.stringify(a.body)}`);
      assert.deepEqual(dismissedOf(await statuses()), ['fork1', 'fork2', 'nc-dismissed']);
    }
  });

  it('refuses an unknown reason anywhere in the list, or a list longer than the reasons that exist, 400 unconverted_bad_reason, and dismisses nothing', async () => {
    const before = await statuses();
    for (const reason of [['fork', 'nopeNope'], ['nopeNope', 'fork'], 'fork,nopeNope', 'nopeNope', [5], 5]) {
      const a = await bulkRest({ reason, expect: 2 });
      assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_reason'], `${JSON.stringify(reason)}: ${JSON.stringify(a.body)}`);
      if (typeof reason === 'string' || Array.isArray(reason) && typeof reason[0] === 'string') assert.ok(a.body.error.includes('nopeNope'), `the refusal does not name the value: ${a.body.error}`);
      const t = await bulkTool({ reason, expect: 2 });
      assert.deepEqual([t.isError, t.body?.code], [true, 'unconverted_bad_reason'], `MCP ${JSON.stringify(reason)}: ${t.text}`);
      assert.equal(t.body.error, a.body.error, 'the two doors word one refusal twice');
    }
    const { UNCONVERTED_REASONS } = await import('../../server/dist/spaces/unconverted-terms.js');
    const tooMany = [...UNCONVERTED_REASONS, 'fork'];
    const a = await bulkRest({ reason: tooMany, expect: 0 });
    assert.deepEqual([a.status, a.body.code], [400, 'unconverted_bad_reason']);
    assert.match(a.body.error, new RegExp(String(UNCONVERTED_REASONS.length)), 'the refusal does not say the bound');
    const ok = await bulkRest({ reason: [...UNCONVERTED_REASONS], expect: 6 });
    assert.deepEqual([ok.status, ok.body], [200, { dismissed: 6 }], 'every reason at once dismisses every open item');
    await plant(door, S, ROWS());
    assert.deepEqual(await statuses(), before, 'the plant is the fixture of the refusals above');
  });

  it('a reason that is blank, or only blank pieces, is no filter: it dismisses every open item as it always did', async () => {
    for (const reason of ['', ',', [''], undefined]) {
      await plant(door, S, ROWS());
      const a = await bulkRest({ ...(reason === undefined ? {} : { reason }), expect: 6 });
      assert.deepEqual([a.status, a.body], [200, { dismissed: 6 }], `${JSON.stringify(reason)}: ${JSON.stringify(a.body)}`);
    }
  });

  it('counts the bound of one call over the same set: a list of reasons that matches more than the bound is 400 unconverted_too_many, a narrower one passes', async () => {
    const { UNCONVERTED_DISMISS_MAX: MAX } = await import('../../server/dist/spaces/unconverted-terms.js');
    const docs = Array.from({ length: MAX + 1 }, (_, i) => itemRow(i + 1, { recordId: `big${i}`, reason: i % 2 === 0 ? 'not_conforming' : 'fork', type: i < 4 ? 'small' : 'bulk' }));
    await plant(door, BIG, docs);
    // Each reason alone is under the bound; both together are over it.
    const half = Math.ceil((MAX + 1) / 2);
    assert.ok(half < MAX);
    const over = await bulkRest({ reason: ['not_conforming', 'fork'], expect: MAX + 1 }, BIG);
    assert.deepEqual([over.status, over.body.code, over.body.max], [400, 'unconverted_too_many', MAX], JSON.stringify(over.body));
    assert.equal(await itemsOf(door, BIG).countDocuments({ status: 'open' }), MAX + 1, 'a refused call dismissed an item');
    const narrowed = await bulkRest({ reason: ['not_conforming', 'fork'], type: 'small', expect: 4 }, BIG);
    assert.deepEqual([narrowed.status, narrowed.body], [200, { dismissed: 4 }], JSON.stringify(narrowed.body));
    await plant(door, BIG, []);
  });

  it('asks the rung inside the act before it reads the list: a reader is refused, a list or not', async () => {
    const READER = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: { knowledge: 'read', files: 'none', schema: 'none', dataQuality: 'none', networks: 'none' } } };
    const a = await acts.dismissShownUnconvertedAct(S, { reason: ['fork', 'nopeNope'], expect: 2 }, { rights: READER, transport: 'rest' });
    assert.deepEqual([a.status, a.code], [403, 'unconverted_rung'], 'the rung is asked before the parameters');
    assert.deepEqual(dismissedOf(await statuses()), ['nc-dismissed']);
  });

  it('is audited with the reasons it named: the entry\'s reason is the list as one text, and one reason is recorded as it was', async () => {
    const terms = await import('../../server/dist/spaces/unconverted-terms.js');
    assert.equal(typeof terms.dismissAuditGiven, 'function', 'spaces/unconverted-terms.ts does not export dismissAuditGiven');
    const { dismissShownChanges } = await import('../../server/dist/audit/audit-changes.js');
    const changesOf = (given) => Object.fromEntries(dismissShownChanges(terms.dismissAuditGiven(given), 4).map(c => [c.field, c.to]));
    assert.deepEqual(changesOf({ kind: 'entity', reason: ['not_conforming', 'fork'], expect: 4 }), { kind: 'entity', reason: 'not_conforming,fork', expect: 4, dismissed: 4 });
    assert.deepEqual(changesOf({ reason: 'not_conforming,fork', expect: 4 }), { reason: 'not_conforming,fork', expect: 4, dismissed: 4 });
    assert.deepEqual(changesOf({ reason: ['fork', 'fork', ''], expect: 2 }), { reason: 'fork', expect: 2, dismissed: 4 }, 'what is recorded is what was parsed: duplicates and blanks are gone');
    assert.deepEqual(changesOf({ reason: 'fork', expect: 2 }), { reason: 'fork', expect: 2, dismissed: 4 });
    assert.deepEqual(changesOf({ expect: 2 }), { expect: 2, dismissed: 4 }, 'no reason is no change');
    assert.deepEqual(changesOf({ reason: '', expect: 2 }), { expect: 2, dismissed: 4 });
  });
});
