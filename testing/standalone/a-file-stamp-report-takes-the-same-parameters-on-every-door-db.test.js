/**
 * `file_stamp_report` takes the same parameters on every door, accepts the same range of each, and refuses the same values
 * with the same status (`Q-433`, plan rev 4 items 25, 28; CLAUDE.md, "MCP and REST are ONE API with two doors").
 *
 * ## The contract
 *
 * `limit` — an integer 1 to 5000, default 1000. `after` — a string of at most 1024 characters, a cursor (the path of the
 * last row of the page before). Nothing else: the REST body is `.strict()` and the tool's schema is closed, so a misspelt
 * parameter is a 400 and not a silent default (`a 400 on one door and a silent default on the other is worse than either
 * alone, because it makes the behaviour depend on which client the caller picked`). A proxy space holds no rows: 400. A
 * space that does not exist: 404.
 *
 * ## What it asks
 *
 * Every value below goes through all three doors (`_file-stamp-doors.mjs`: the dedicated route, `POST /api/file_stamp_report`
 * and the tool through `callTool`) and each must answer what the other two answer. Every call is made by a fresh instance
 * admin, so the heavy-call rail never judges one value on the slots of another. The VALID values include the extremes
 * (1, 5000, a 1024-character cursor) and cursors that look like paths (`.`, `..`, `a%2Fb`), which are cursors and not
 * traversals; the INVALID ones are the edges just outside, and the wrong types.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-file-stamp-report-takes-the-same-parameters-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openStampDoor } from './_file-stamp-door.mjs';
import { openStampDoors } from './_file-stamp-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'stampargs';
const PROXY = 'stampargs-proxy';
const DOOR_NAMES = ['route', 'toolRest', 'mcp'];

let stamp, door, drivers;

before(async () => {
  stamp = await openStampDoor({ suite: 'stampargs', space: S });
  door = stamp.door;
  drivers = await openStampDoors(S);
});
after(async () => { await drivers?.close(); await stamp?.close(); });
beforeEach(async () => {
  await stamp.reset();
  await stamp.s1('docs/a.txt');
  await stamp.s1('docs/b.txt');
});

/** Ask every door with the same arguments, each by a fresh admin; the answers by door name. */
async function askAll(args, space) {
  const out = {};
  for (const name of DOOR_NAMES) out[name] = await drivers.doors[name](await drivers.token('admin'), args, space);
  return out;
}

describe('accepted: the same range on every door', { skip }, () => {
  const VALID = [
    ['no arguments (limit 1000, from the start)', {}],
    ['limit 1', { limit: 1 }],
    ['limit 5000', { limit: 5000 }],
    ['a cursor of exactly 1024 characters', { after: 'x'.repeat(1024) }],
    ['a cursor `.`', { after: '.' }],
    ['a cursor `..`', { after: '..' }],
    ['a cursor `a%2Fb`', { after: 'a%2Fb' }],
    ['an empty cursor', { after: '' }],
  ];
  for (const [what, args] of VALID) {
    it(`${what}: every door answers a report`, async () => {
      const answers = await askAll(args);
      for (const name of DOOR_NAMES) {
        assert.equal(answers[name].status, 200, `${name} refused ${JSON.stringify(args).slice(0, 80)}: ${answers[name].status} ${answers[name].error ?? ''}`);
        assert.ok(Array.isArray(answers[name].answer?.rows), `${name} answered no rows`);
      }
      assert.deepEqual(answers.route.answer.rows.map(r => r.path), answers.mcp.answer.rows.map(r => r.path), 'the doors read different rows');
      assert.deepEqual(answers.toolRest.answer.rows.map(r => r.path), answers.mcp.answer.rows.map(r => r.path));
    });
  }

  it('the default limit is the same on every door: more rows than one page of 1000 is not needed to see it, the answer says it', async () => {
    const answers = await askAll({});
    for (const name of DOOR_NAMES) assert.equal(answers[name].answer.truncated, false, `${name}: truncated at the default limit with two rows`);
    const one = await askAll({ limit: 1 });
    for (const name of DOOR_NAMES) {
      assert.equal(one[name].answer.rows.length, 1, `${name}: limit 1 gave ${one[name].answer.rows.length} rows`);
      assert.equal(one[name].answer.truncated, true, `${name}: limit 1 over two rows was not truncated`);
      assert.equal(one[name].answer.nextAfter, one[name].answer.rows[0].path);
    }
  });
});

describe('refused: the same values, with the same status, naming the parameter', { skip }, () => {
  const INVALID = [
    ['limit 0', { limit: 0 }, 'limit'],
    ['limit -1', { limit: -1 }, 'limit'],
    ['limit 5001', { limit: 5001 }, 'limit'],
    ['a fractional limit', { limit: 1.5 }, 'limit'],
    ['a limit that is a string', { limit: '10' }, 'limit'],
    ['a null limit', { limit: null }, 'limit'],
    ['a cursor of 1025 characters', { after: 'x'.repeat(1025) }, 'after'],
    ['a cursor that is a number', { after: 5 }, 'after'],
    ['a cursor that is an object', { after: { $gt: '' } }, 'after'],
    ['a parameter that does not exist', { skip: 1 }, 'skip'],
    ['a misspelt parameter', { limt: 10 }, 'limt'],
  ];
  for (const [what, args, named] of INVALID) {
    it(`${what}: a 400 on every door, and the sentence names ${named}`, async () => {
      const answers = await askAll(args);
      for (const name of DOOR_NAMES) {
        assert.equal(answers[name].status, 400, `${name} answered ${answers[name].status} to ${what} (${answers[name].error ?? 'served'})`);
        assert.ok(String(answers[name].error).includes(named), `${name}: the refusal does not name ${named}: ${answers[name].error}`);
      }
    });
  }

  /** A refusal is only evidence beside the same call served: a door that does not exist answers 404 too. */
  async function controlIsServed() {
    const served = await askAll({});
    for (const name of DOOR_NAMES) assert.equal(served[name].status, 200, `the control through ${name} was not served: ${served[name].status} ${served[name].error ?? ''}`);
  }

  it('a space that does not exist is a 404 on every door', async () => {
    await controlIsServed();
    const answers = await askAll({}, 'a-space-nobody-made');
    for (const name of DOOR_NAMES) assert.equal(answers[name].status, 404, `${name}: ${answers[name].status} ${answers[name].error ?? ''}`);
  });

  it('a proxy space holds no rows and is a 400 on every door', async () => {
    await controlIsServed();
    door.config().spaces.push({ id: PROXY, label: PROXY, folders: [], proxyFor: [S] });
    try {
      const answers = await askAll({}, PROXY);
      for (const name of DOOR_NAMES) assert.equal(answers[name].status, 400, `${name}: ${answers[name].status} ${answers[name].error ?? 'served'}`);
    } finally { door.config().spaces = door.config().spaces.filter(s => s.id !== PROXY); }
  });
});
