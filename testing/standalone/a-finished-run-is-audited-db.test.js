/**
 * A schema conversion leaves an audit trail an operator can read: one entry for each run that finishes, one for each start through a door, one for each
 * dismissal, and a read entry for a list only when the instance logs reads (Q-746 and Q-919, bundle-284 design r5 sections 2.3 and 5.4 "Audit", slice 6).
 *
 * ## The rule
 *
 * - **A finished run is ONE internal entry**, `schema.convert.run`: no token (the server did the work, `ip: internal`), the space, how the run was
 *   started (`sources`, the kinds a save, a vote and an act started it by), the types it converted (a list) and its counts (`stamped`, `rewritten`,
 *   `unconverted`, `moved`, `edgesRestamped`). Never record content: a distinctive value planted in a record's name and property is in no entry
 *   of the whole log. A second run is a second entry, and a run of several pages is still one.
 * - **A start through a door is ONE entry under ONE operation on both doors**: `schema.convert.start` on the route and on the tool, carrying the types
 *   (a list) and the number of steps, never the steps' text. A refused start is an entry too, with its status and no changes.
 * - **A dismissal names what it dismissed**: `unconverted.dismiss` the item id (as the entry id on the route and as a change on both), and
 *   `unconverted.dismiss_shown` the filter it was given, the `expect` it was given and the number it dismissed.
 * - **A list is a read**: `unconverted.list` is written, on either door, only when `audit.logReads` is on; a status read the same way.
 *
 * ## What was wrong
 *
 * Nothing audited the new doors: no operation was named for them, the allowlist knew no field of them (an operation with no allowlist records NO
 * change), and the run wrote its entry through an allowlist that did not exist, so the entry said that a run ended and nothing of what it did.
 *
 * ## How it asks
 *
 * The run is driven by the run module (a run needs no door to be audited); the starts and the dismissals go through the MOUNTED application and the
 * REGISTERED tools (`_mounted-door.mjs`), because an operation is named by the route table and the tool table and an unmounted router has neither.
 *
 * Seen red on 8ca143bb: the run's entry has no `changes` (no allowlist row), and the routes are not mounted (404, no entry).
 *
 * Run: node --test testing/standalone/a-finished-run-is-audited-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { openMountedDoor } from './_mounted-door.mjs';
import { auditRowsOf, untilAuditWritesLanded } from './_audit-rows.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

/** The distinctive text a record carries (its name, an offending property, a renamed property's value): no audit entry may hold it. */
const SECRET = 'ZEBRA-AUDIT-9137';
/** A space whose run the test drives itself, one per thing asked, so no entry of one case is another's. */
const RUN = 'aud-run';
const START_ROUTE = 'aud-start-route';
const START_TOOL = 'aud-start-tool';
const DISMISS_ROUTE = 'aud-dismiss-route';
const DISMISS_TOOL = 'aud-dismiss-tool';
const SHOWN_ROUTE = 'aud-shown-route';
const SHOWN_TOOL = 'aud-shown-tool';
const READ = 'aud-read';
const SPACES = [RUN, START_ROUTE, START_TOOL, DISMISS_ROUTE, DISMISS_TOOL, SHOWN_ROUTE, SHOWN_TOOL, READ];

const RENAME = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
const PERSON = [{ kind: 'entity', type: 'person' }];
/** The schema the conversion leads to: `nick` is gone, `alias` is declared. */
const AFTER = structuredClone(CONVERT_META);
AFTER.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, alias: { type: 'string' } };

const AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'];
const knowledgeRung = (space, rung) => ({
  instanceAdmin: false, createSpaces: false, floor: null,
  perSpace: { [space]: Object.fromEntries(AREAS.map(a => [a, a === 'knowledge' ? rung : 'none'])) },
});

/** The change of one field of an entry, or undefined. */
const changeOf = (row, field) => (row.changes ?? []).find(c => c.field === field);

describe('a finished run, a start and a dismissal are audited, and no entry holds a record\'s content (real MongoDB)', { skip }, () => {
  let door, run, mounted, mongo, loader;
  const who = {};

  before(async () => {
    door = await openConvertDoor({ name: 'b284audit', spaces: SPACES, metaOf: () => AFTER });
    run = await door.runModule();
    mongo = door.mongo;
    loader = await import('../../server/dist/config/loader.js');
    mounted = await openMountedDoor();
    who.admin = await mounted.mint('aud-admin', 'admin');
    who.reader = await mounted.mint('aud-reader', knowledgeRung(READ, 'read'));
    who.writer = await mounted.mint('aud-writer', { instanceAdmin: false, createSpaces: false, floor: null, perSpace: Object.fromEntries(
      [DISMISS_ROUTE, DISMISS_TOOL, SHOWN_ROUTE, SHOWN_TOOL].map(s => [s, knowledgeRung(s, 'write').perSpace[s]])) });
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await mounted?.close(); await door?.close(); });
  beforeEach(async () => { await untilAuditWritesLanded(); });

  const seedRecords = (space) => door.seed(space, 'entities', [
    // Rewritten by the rename; its name and its value are the text no entry may hold.
    { _id: 'good', name: `Good ${SECRET}`, type: 'person', properties: { nick: `nick-${SECRET}` } },
    // Not conforming after the steps (age is a number): an unconverted item that names the field and never the value.
    { _id: 'bad', name: `Bad ${SECRET}`, type: 'person', properties: { age: `${SECRET}-age` } },
    // Conforming already: stamped, no new version.
    { _id: 'fine', name: 'Fine', type: 'person', properties: { alias: 'a' } },
  ]);
  const complete = (space, after = 0) => waitForValue(async () => { const d = await door.runDoc(space); return d?.state === 'complete' && Date.parse(d.finishedAt ?? 0) >= after ? d : null; },
    30_000, 100, undefined, { what: `the run of ${space} to complete` });
  /** Seed `space` and run the conversion of `person` with the rename through the run module, to its end. */
  async function converted(space) {
    await seedRecords(space);
    const started = await run.startSchemaConvertRun({ spaceId: space, types: PERSON.map(t => ({ ...t })), steps: [RENAME], source: { kind: 'act' } });
    assert.equal(started.ok, true, JSON.stringify(started));
    return await complete(space);
  }
  const rowsOf = async (filter) => await auditRowsOf(mongo, filter);
  const rowsAppearing = (filter, what) => waitForValue(async () => { const r = await rowsOf(filter); return r.length ? r : null; }, 15_000, 100, undefined, { what });
  const itemOf = async (space) => (await door.itemRows(space)).find(r => r.recordId === 'bad')._id;

  describe('a finished run', () => {
    it('writes one internal entry: no token, the space, how it started, its types and its counts', async () => {
      await converted(RUN);
      const rows = await rowsAppearing({ operation: 'schema.convert.run', spaceId: RUN }, 'the entry of the finished run');
      assert.equal(rows.length, 1, `a run wrote ${rows.length} entries: ${JSON.stringify(rows.map(r => r.changes))}`);
      const [row] = rows;
      assert.equal(row.tokenId, null, 'the entry of a run the server did names a token');
      assert.equal(row.tokenLabel, null);
      assert.equal(row.ip, 'internal');
      assert.equal(row.status, 200);
      for (const [field, to] of [['stamped', 1], ['rewritten', 1], ['unconverted', 1], ['moved', 0], ['edgesRestamped', 0]]) {
        assert.equal(changeOf(row, field)?.to, to, `the entry does not carry ${field}: ${JSON.stringify(row.changes)}`);
      }
      assert.deepEqual(changeOf(row, 'types')?.added, ['entity:person'], `the entry does not carry the types as a list: ${JSON.stringify(row.changes)}`);
      assert.equal(changeOf(row, 'sources')?.to, 'act', `the entry does not say how the run was started: ${JSON.stringify(row.changes)}`);
    });

    it('writes a second entry for a second run, and one for a run of several types and pages, never one per pass', async () => {
      const before = (await rowsOf({ operation: 'schema.convert.run', spaceId: RUN })).length;
      const started = await run.startSchemaConvertRun({ spaceId: RUN, types: [...PERSON, { kind: 'fact', type: 'claim' }], steps: [], source: { kind: 'act' } });
      assert.equal(started.ok, true, JSON.stringify(started));
      await waitForValue(async () => { const d = await door.runDoc(RUN); return d?.state === 'complete' && d.types.length === 2 ? d : null; }, 30_000, 100, undefined, { what: 'the second run' });
      await waitForValue(async () => ((await rowsOf({ operation: 'schema.convert.run', spaceId: RUN })).length > before ? true : null), 15_000, 100, undefined, { what: 'the second entry' });
      await untilAuditWritesLanded();
      const rows = await rowsOf({ operation: 'schema.convert.run', spaceId: RUN });
      assert.equal(rows.length, before + 1, `the second run wrote ${rows.length - before} entries`);
      assert.deepEqual(changeOf(rows.at(-1), 'types')?.added, ['entity:person', 'fact:claim']);
    });
  });

  describe('a start through a door', () => {
    it('is one `schema.convert.start` on the mounted route, with the types and the number of steps and never the steps\' text', async () => {
      await seedRecords(START_ROUTE);
      const answer = await mounted.rest(who.admin.key, 'POST', `/api/spaces/${START_ROUTE}/schema-convert`, { types: PERSON, steps: [RENAME] });
      assert.equal(answer.status, 202, `the start was not accepted: ${JSON.stringify(answer)}`);
      await complete(START_ROUTE);
      const rows = await rowsAppearing({ operation: 'schema.convert.start', spaceId: START_ROUTE }, 'the entry of the start');
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.deepEqual([row.method, row.path, row.status, row.tokenId], ['POST', `/api/spaces/${START_ROUTE}/schema-convert`, 202, who.admin.id]);
      assert.deepEqual(changeOf(row, 'types')?.added, ['entity:person'], JSON.stringify(row.changes));
      assert.equal(changeOf(row, 'steps')?.to, 1, JSON.stringify(row.changes));
      assert.ok(!JSON.stringify(row).includes('nick'), 'the entry holds a step\'s text');
      assert.equal((await rowsAppearing({ operation: 'schema.convert.run', spaceId: START_ROUTE }, 'the entry of the run it started')).length, 1, 'the run a start made did not write its one entry');
    });

    it('is one `schema.convert.start` through the registered tool too, the same operation and the same changes', async () => {
      await seedRecords(START_TOOL);
      const answer = await mounted.mcp(who.admin.key, 'space_schema_convert', { space: START_TOOL, types: PERSON, steps: [RENAME] });
      assert.equal(answer.isError, false, `the start was not accepted: ${answer.text}`);
      await complete(START_TOOL);
      const rows = await rowsAppearing({ operation: 'schema.convert.start', spaceId: START_TOOL }, 'the entry of the tool start');
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.deepEqual([row.method, row.path, row.status, row.tokenId], ['MCP', 'http:space_schema_convert', 200, who.admin.id]);
      const [routeRow] = await rowsOf({ operation: 'schema.convert.start', spaceId: START_ROUTE });
      assert.deepEqual(row.changes, routeRow.changes, 'the two doors record different changes for one start');
    });

    it('writes an entry for a refused start too, with its status and no changes', async () => {
      const refused = await mounted.rest(who.admin.key, 'POST', `/api/spaces/${START_ROUTE}/schema-convert`, { types: [] });
      assert.equal(refused.status, 400, JSON.stringify(refused));
      await untilAuditWritesLanded();
      const rows = (await rowsOf({ operation: 'schema.convert.start', spaceId: START_ROUTE })).filter(r => r.status === 400);
      assert.equal(rows.length, 1, `a refused start left ${rows.length} entries`);
      assert.equal(rows[0].changes, undefined, 'a refused start records what it would have done');
    });
  });

  describe('a dismissal', () => {
    it('`unconverted.dismiss` names the item: the entry id on the route, a change on both doors', async () => {
      await converted(DISMISS_ROUTE);
      await converted(DISMISS_TOOL);
      const routeItem = await itemOf(DISMISS_ROUTE);
      const toolItem = await itemOf(DISMISS_TOOL);
      const route = await mounted.rest(who.writer.key, 'POST', `/api/spaces/${DISMISS_ROUTE}/schema-convert/items/${routeItem}/dismiss`);
      assert.equal(route.status, 200, `the dismiss was not served: ${JSON.stringify(route)}`);
      const tool = await mounted.mcp(who.writer.key, 'dismiss_unconverted', { space: DISMISS_TOOL, itemId: toolItem });
      assert.equal(tool.isError, false, tool.text);
      const [rowOfRoute] = await rowsAppearing({ operation: 'unconverted.dismiss', spaceId: DISMISS_ROUTE }, 'the entry of the route dismiss');
      const [rowOfTool] = await rowsAppearing({ operation: 'unconverted.dismiss', spaceId: DISMISS_TOOL }, 'the entry of the tool dismiss');
      assert.equal(rowOfRoute.entryId, routeItem, 'the route entry does not name the item');
      for (const [row, item] of [[rowOfRoute, routeItem], [rowOfTool, toolItem]]) {
        assert.equal(changeOf(row, 'itemId')?.to, item, `the entry does not carry the item id: ${JSON.stringify(row.changes)}`);
      }
      assert.deepEqual([rowOfRoute.path, rowOfTool.path], [`/api/spaces/${DISMISS_ROUTE}/schema-convert/items/${routeItem}/dismiss`, 'http:dismiss_unconverted']);
    });

    it('`unconverted.dismiss_shown` names the filter it was given, the `expect` and the number it dismissed, on both doors', async () => {
      await converted(SHOWN_ROUTE);
      await converted(SHOWN_TOOL);
      const route = await mounted.rest(who.writer.key, 'POST', `/api/spaces/${SHOWN_ROUTE}/schema-convert/items/dismiss`, { kind: 'entity', reason: 'not_conforming', expect: 1 });
      assert.deepEqual([route.status, route.body], [200, { dismissed: 1 }], JSON.stringify(route));
      const tool = await mounted.mcp(who.writer.key, 'dismiss_unconverted_shown', { space: SHOWN_TOOL, kind: 'entity', reason: 'not_conforming', expect: 1 });
      assert.deepEqual([tool.isError, tool.body], [false, { dismissed: 1 }], tool.text);
      const [rowOfRoute] = await rowsAppearing({ operation: 'unconverted.dismiss_shown', spaceId: SHOWN_ROUTE }, 'the entry of the route bulk dismiss');
      const [rowOfTool] = await rowsAppearing({ operation: 'unconverted.dismiss_shown', spaceId: SHOWN_TOOL }, 'the entry of the tool bulk dismiss');
      for (const row of [rowOfRoute, rowOfTool]) {
        const changes = Object.fromEntries((row.changes ?? []).map(c => [c.field, c.to]));
        assert.deepEqual(changes, { kind: 'entity', reason: 'not_conforming', expect: 1, dismissed: 1 }, `the entry does not carry the filter, expect and count: ${JSON.stringify(row.changes)}`);
      }
      assert.deepEqual([rowOfRoute.method, rowOfTool.method], ['POST', 'MCP']);
    });
  });

  describe('a read', () => {
    const askAll = async () => {
      await mounted.rest(who.reader.key, 'GET', `/api/spaces/${READ}/schema-convert/items`);
      await mounted.mcp(who.reader.key, 'list_unconverted', { space: READ });
      await mounted.rest(who.reader.key, 'GET', `/api/spaces/${READ}/schema-convert`);
      await mounted.mcp(who.reader.key, 'space_schema_conversion', { space: READ });
      await untilAuditWritesLanded();
    };
    const readRows = async () => (await rowsOf({ spaceId: READ })).filter(r => r.method === 'GET' || r.method === 'MCP');

    it('writes no entry for a list or a status read while the instance does not log reads', async () => {
      loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: false }; });
      await askAll();
      assert.deepEqual((await readRows()).map(r => [r.method, r.operation]), [], 'a read was audited with read logging off');
    });

    it('writes one entry per read, under one operation per capability on both doors, when it does', async () => {
      loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: true } });
      try {
        await askAll();
        const rows = await readRows();
        const byOperation = Object.groupBy(rows, r => r.operation);
        assert.deepEqual(Object.keys(byOperation).sort(), ['space.list', 'unconverted.list'], `${JSON.stringify(rows.map(r => [r.method, r.path, r.operation]))}`);
        for (const [operation, group] of Object.entries(byOperation)) {
          assert.deepEqual(group.map(r => r.method).sort(), ['GET', 'MCP'], `${operation}: one entry per door`);
        }
        const list = byOperation['unconverted.list'];
        assert.deepEqual(list.map(r => r.path).sort(), [`/api/spaces/${READ}/schema-convert/items`, 'http:list_unconverted']);
        assert.ok(list.every(r => r.changes === undefined && r.status === 200), 'a read records a change or did not succeed');
      } finally {
        loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: false }; });
      }
    });
  });

  it('no audit entry of the whole log holds the text a record carried', async () => {
    const all = await rowsOf({});
    assert.ok(all.length >= 10, `the log holds ${all.length} entries: the cases above wrote none, so this asserts nothing`);
    assert.ok((await door.coll(RUN, 'entities').findOne({ _id: 'bad' })).properties.age.includes(SECRET), 'the fixture record does not hold the text');
    const holding = all.filter(r => JSON.stringify(r).includes(SECRET));
    assert.deepEqual(holding.map(r => [r.operation, r.path]), [], 'an audit entry holds record content');
  });
});
