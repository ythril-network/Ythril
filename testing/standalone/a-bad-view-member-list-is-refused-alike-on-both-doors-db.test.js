/**
 * A bad `members` list is refused with the same coded refusal on every door that creates or changes a view (Q-531, bundle-100 row P).
 *
 * ## The rule
 *
 * CLAUDE.md, "MCP and REST are ONE API with two doors": same refusals, same error text. `POST /api/views` and `PATCH /api/views/:id` answer
 * a missing, empty, over-long or malformed `members` with the view act's coded refusal (`view_members_empty`, `view_members_limit`, ...),
 * while `view_create` / `view_update` - on MCP and on the REST tool door - were refused by the dispatcher's inputSchema check
 * (`minItems`, `maxItems`, `type`) in the validator's words, before the act ran, with no code: a client translating by code got nothing on
 * one door. The limit is still stated in the schema description, which is what a caller reads while building the call.
 *
 * Each case is sent to all three doors (REST route, MCP, REST tool door) and must answer the same status class, code and sentence.
 *
 * ## Seen red at 743562a5
 *
 * MCP and the tool door answered `Error: ... must NOT have fewer than 1 items` / `more than 1000 items` / `must be array` without a code.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-bad-view-member-list-is-refused-alike-on-both-doors-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vp-qa';
let d, caller;

/** What a door answered, reduced to what must agree: the refusal's code and its sentence (without a door's `Error: ` prefix). */
const restAnswer = (a) => ({ code: a.body?.code ?? null, error: a.error });
const toolAnswer = (a) => ({ code: a.structured?.code ?? a.body?.code ?? null, error: (a.structured?.error ?? a.error ?? a.text ?? '').replace(/^Error(?: \(\d+\))?: /, '') });

const BAD_LISTS = [
  ['empty', []],
  ['over the cap', Array.from({ length: 1001 }, (_, i) => `vp-m${i}`)],
  ['not a list', 'vp-qa'],
  ['a blank id', ['']],
  ['a non-string id', [7]],
];

describe('a bad view member list is refused alike on both doors (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'b100-view-member-parity', spaces: [QA] });
    caller = await d.mint('vp-caller', { [QA]: d.row({ knowledge: 'read' }) });
    const made = await d.rest(caller.key, 'POST', '/api/views', { name: 'vp-mine', members: [QA] });
    assert.equal(made.status, 201, `fixture: ${made.status} ${made.text}`);
  });
  after(async () => { await d?.close(); });

  for (const [what, members] of BAD_LISTS) {
    it(`create, ${what}: one coded refusal on every door`, async () => {
      const rest = await d.rest(caller.key, 'POST', '/api/views', { name: 'vp-new', members });
      assert.ok(rest.status === 400 && rest.body?.code, `fixture: REST refuses ${what} with a code: ${rest.status} ${rest.text.slice(0, 160)}`);
      const mcp = await d.mcp(caller.key, 'view_create', { name: 'vp-new', members });
      const door = await d.rest(caller.key, 'POST', '/api/view_create', { name: 'vp-new', members });
      assert.ok(mcp.isError, `MCP accepted ${what}`);
      assert.deepEqual(toolAnswer(mcp), restAnswer(rest), `MCP view_create answers ${what} unlike POST /api/views`);
      assert.equal(door.status, rest.status, `the tool door's status for ${what}`);
      assert.deepEqual(toolAnswer(door), restAnswer(rest), `POST /api/view_create answers ${what} unlike POST /api/views`);
    });

    it(`update, ${what}: one coded refusal on every door`, async () => {
      const rest = await d.rest(caller.key, 'PATCH', '/api/views/%40vp-mine', { members });
      assert.ok(rest.status === 400 && rest.body?.code, `fixture: REST refuses ${what} with a code: ${rest.status} ${rest.text.slice(0, 160)}`);
      const mcp = await d.mcp(caller.key, 'view_update', { view: '@vp-mine', members });
      assert.ok(mcp.isError, `MCP accepted ${what}`);
      assert.deepEqual(toolAnswer(mcp), restAnswer(rest), `MCP view_update answers ${what} unlike PATCH /api/views/:id`);
    });
  }

  it('the schema description still states the limit', async () => {
    const { rpc } = d;
    const listed = await rpc(caller.key, 'tools/list');
    const tool = listed.result?.result?.tools?.find(t => t.name === 'view_create');
    assert.ok(tool, 'view_create is not listed');
    assert.match(tool.inputSchema?.properties?.members?.description ?? '', /1[ ,.]?000/, 'the members description no longer states the cap');
  });
});
