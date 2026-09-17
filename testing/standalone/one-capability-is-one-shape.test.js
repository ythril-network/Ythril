/**
 * A capability is ONE shape, and both doors reach it through ONE function.
 *
 * ## The instruction, repeated
 *
 * Owner, 2026-09-16: *"I SAID FOR THE 100000 TIME KEEP MCP, REST, TOKENS in FUCKING SYNC!!! filter mcp =>
 * GET /api/brain/filter — same parameters, same methods/procedures called"*, then *"or use post everywhere
 * and accept the same body, i dont care but i want the same fucking shape, same parameters and same thing
 * called"*, then *"the body can be EXACTLY the mcp tool (create modules that are used by both doors)"*, and
 * then *"this shared module concept for both doors should be applied to each and every tool"*.
 *
 * ## Why `mcp-rest-parity` and the capability map did not catch it
 *
 * They ask whether a capability EXISTS on both doors. `filter` exists on both; `delete_space_data` existed
 * on both. Neither asks whether the two are the same CALL — so a tool answering ten routes with ten
 * grammars passed, and `B-7`'s map recorded each pairing as *answered*. The file built to end the
 * divergence became the place it was written down.
 *
 * ## What this asserts now, and the first one is the structural half
 *
 * 1. **Both doors dispatch through `callTool` and neither decides anything.** Not "they agree today" —
 *    there is one implementation of the gates, the space parse, the rung check and the error
 *    classification, so a forty-sixth tool cannot arrive with one door governed and the other not.
 * 2. **The LEGACY per-collection routes only shrink.** They are the old second shapes, still mounted and
 *    still used by the client. The point of counting them is to make the remaining divergence countable,
 *    not to bless it.
 *
 * Run: node --test testing/standalone/one-capability-is-one-shape.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAPABILITIES } from './_capability-map.mjs';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

let ALL_TOOLS;
before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

/**
 * The decisions that belong to the shared module and to nothing else.
 *
 * Asserted as a RULE over both doors rather than as two named checks, so a third door — a CLI, a queue
 * consumer, whatever 5.x grows — is covered the day it is written rather than the day somebody remembers
 * to add a case here.
 */
const DOORS = ['server/src/api/tools.ts', 'server/src/mcp/router.ts'];
const DECIDING = [
  ['toolRightsRefusal', 'the per-space rung check'],
  ['spaceAdminRefusal', 'the space-admin grant check'],
  ['toolIsVisible', 'the visibility gate'],
  ['makeArgsValidator', 'inputSchema validation'],
  ['consumeHeavyToolCall', 'the destructive-call throttle'],
  ['classifyReadFailure', 'the store-failure classification'],
];

describe('both doors are adapters over one function', () => {
  it('each door calls callTool', () => {
    for (const door of DOORS) {
      assert.match(src(door), /callTool\(/,
        `${door} must dispatch through the shared function — a door with its own dispatch is the second `
        + 'implementation this whole mechanism exists to remove');
    }
  });

  it('and no door makes a decision of its own', () => {
    /*
     * The half that would rot. A door can call `callTool` AND keep a check of its own beside it, and that
     * check is the copy that gets forgotten — whichever door its author was not using that day. The five
     * REST wipe routes were exactly this: they called the collection wipe directly while the tool asked
     * the network for a vote first.
     *
     * `toolIsVisible` is the one exception and it is a listing, not a decision: `tools/list` filters what
     * it advertises. The enforcement is still inside `callTool`, which is what the parity gate relies on.
     */
    const offences = [];
    for (const door of DOORS) {
      const text = src(door);
      for (const [symbol, what] of DECIDING) {
        if (symbol === 'toolIsVisible' && door.endsWith('router.ts')) continue;  // advisory listing filter
        if (text.includes(symbol)) offences.push(`${door} performs ${what} (${symbol})`);
      }
    }
    assert.deepEqual(offences, [],
      'a door is deciding rather than translating:\n  ' + offences.join('\n  '));
  });

  it('the REST door adds nothing to the body it forwards', () => {
    // "The body is EXACTLY the tool's arguments" is a promise to a caller, and a door that injects,
    // renames or defaults one field makes it a promise with an exception nobody reads.
    const text = src('server/src/api/tools.ts');
    assert.match(text, /args: \(req\.body \?\? \{\}\) as Record<string, unknown>/,
      'the REST door must forward the body unchanged as the tool arguments');
  });

  it('every tool is reachable through it, by construction', () => {
    /*
     * There is no per-tool list to check against, and that is the point — the path IS the name. So what is
     * asserted is the thing that could break it: the route resolving its name from the registry, and a
     * floor under the registry so an empty one cannot make this vacuous.
     */
    assert.ok(ALL_TOOLS.length > 30, `expected the tool registry, got ${ALL_TOOLS.length}`);
    const text = src('server/src/api/tools.ts');
    assert.match(text, /TOOLS_BY_NAME\.has\(/,
      'the REST door must decide what is a tool from the registry, not from a list of its own');
    assert.match(text, /toolsRouter\.post\('\/:tool'/,
      'one generic route, so a new tool needs no REST code at all');
  });
});

/**
 * Tools still answering a SECOND, older route shape, with the reason and what closes it.
 *
 * **This list only ever shrinks.** Every entry is a caller whose request shape depends on which door they
 * picked. They are all still mounted because the Angular client calls them; closing one means moving the
 * client to `POST /api/<tool-name>` first.
 */
const NOT_YET_ONE_SHAPE = new Map(Object.entries({
  filter: 'B-9. Nine per-collection GETs take conveniences (`type`, `tag`, `search`, `entity`) as a query '
    + 'string; `POST /api/brain/filter` takes a predicate as a body. Closing it means the client\'s four '
    + 'list methods build predicates — the components do not change, the service is the seam.',
  list_tokens: 'B-9. `GET /api/tokens` lists tokens; `GET .../token-access` answers which tokens reach one '
    + 'space. Possibly two questions rather than one capability — decide that before merging them.',
  network_sync: 'B-9. By network id and by peer id. One route taking either is the likely answer, and it '
    + 'sits behind the network governance work rather than ahead of it.',
}));

const routesByTool = () => {
  const out = new Map();
  for (const [, tool, route] of CAPABILITIES) {
    if (!out.has(tool)) out.set(tool, []);
    out.get(tool).push(route);
  }
  return out;
};

describe('one capability, one shape', () => {
  it('no tool answers more than one legacy REST route', () => {
    const offenders = [];
    for (const [tool, routes] of routesByTool()) {
      if (routes.length <= 1 || NOT_YET_ONE_SHAPE.has(tool)) continue;
      offenders.push(`${tool} answers ${routes.length}:\n      ${routes.join('\n      ')}`);
    }
    assert.deepEqual(offenders, [],
      'a caller\'s request shape depends on which door they picked:\n  ' + offenders.join('\n  '));
  });

  it('and the exemption list only shrinks', () => {
    // Every entry is a divergence somebody decided to keep for now. A new one is a decision, not a diff.
    const known = [...NOT_YET_ONE_SHAPE.keys()].sort();
    assert.deepEqual(known, ['filter', 'list_tokens', 'network_sync'],
      'the exemption list changed. Removing an entry is the work; ADDING one needs the owner, because it '
      + 'is a capability whose shape depends on the door. `space_reindex` left on 2026-09-17: its second '
      + 'route was never a second shape, it was a second CAPABILITY, and it has its own tool now.');
  });

  it('every exemption names the row that closes it', () => {
    for (const [tool, why] of NOT_YET_ONE_SHAPE) {
      assert.ok(why.length > 60 && /B-9/.test(why),
        `${tool}'s exemption has no exit — an exemption with no row behind it is a decision to keep the `
        + 'divergence, and none of these are that');
    }
  });

  it('delete_space_data is the worked example and keeps no legacy route', () => {
    /*
     * The one the owner named. Five `DELETE .../<collection>` routes, each hard-coding one collection and
     * calling `bulkDelete<Collection>`, against one tool taking `types[]` and calling `wipeSpace`.
     * Different parameters, different procedure, different response — and different SAFETY, because the
     * routes required `confirm: true` and the tool required nothing at all. Worse, the routes skipped the
     * network vote the tool opened, so on a shared space the door decided whether the peers got a say.
     */
    assert.deepEqual(routesByTool().get('delete_space_data') ?? [], [],
      'delete_space_data still has a legacy route. Its only shape is POST /api/delete_space_data, served '
      + 'by the generic tool door.');
  });
});
