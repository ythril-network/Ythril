/**
 * Whatever a list route adds to its rows AFTER the query, `filter` adds too — on both doors.
 *
 * ## The gap, and why nothing had reported it
 *
 * `B-9` is "one capability, one shape", and the visible half was parameters: `filter` did not accept the
 * conveniences the nine per-collection list routes accept. That half shipped first.
 *
 * This is the half that hides behind it. Two of those routes do work on their rows once the query has
 * returned, and `filter` did neither:
 *
 *   - `GET .../edges` resolves both endpoints' display names, batched by endpoint KIND, and spreads
 *     `fromName`/`toName` onto every row. `filter` answered with bare UUIDs.
 *   - `GET .../files` joins the embedding job's step progress for rows still in flight. `filter` answered
 *     without it, so the Files tab reading through `filter` would show a spinner that never resolves.
 *
 * And `includeDiagnostics` was accepted nowhere on `filter` at all — not in the body allowlist, not in
 * the tool schema — while four list routes honour it.
 *
 * **A decoration is not a parameter.** It appears in no body allowlist, no `inputSchema` and no
 * capability map, so the two doors were never compared and nobody could report the difference. Step 3 of
 * `B-9` deletes those routes, which would have taken both decorations with them silently.
 *
 * ## What this asserts, and why it is the rule rather than the two sites
 *
 * The decorations live in `brain/list-decorations.ts`, which dispatches on the COLLECTION. So the rule
 * is: every door that pages a collection reaches that module, and nothing re-implements what it does.
 * A seventh collection with a decoration of its own is then one declaration, in one file.
 *
 * Run: node --test testing/standalone/a-list-decoration-reaches-both-doors.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { FILTER_DOORS } from '../_shared/search-doors.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { decorateMemberRows, decoratePage } = await import('../../server/dist/brain/list-decorations.js');
const { QUERY_BODY_FIELDS } = await import('../../server/dist/brain/query.js');

const src = (p) => stripComments(readFileSync(p, 'utf8'));
/** Both doors of `filter`: the generic tool and the route that answers the same body. */
const DOORS = FILTER_DOORS;

function filterSchema() {
  const tool = ALL_TOOLS.find(t => t.name === 'filter');
  assert.ok(tool, 'the `filter` tool is gone or renamed — re-anchor this gate');
  return tool.inputSchema({ requiredSpace: {}, optionalSpace: {} });
}

describe('both doors apply the decorations, through the one module', () => {
  for (const door of DOORS) {
    it(`${door} decorates the merged page`, () => {
      assert.match(src(door), /decoratePage\(/,
        `${door} returns its rows undecorated, so an edge comes back as two bare UUIDs`);
    });

    it(`${door} decorates each member's slice BEFORE the page is merged`, () => {
      /*
       * A file's progress is joined against the job collection of the member that OWNS the row. Applied
       * after the merge, the owner is already forgotten and the lookup finds nothing — which looks
       * exactly like a file with no job, so nothing would report it.
       */
      assert.match(src(door), /decorateMemberRows\(/,
        `${door} does not decorate per member, so a proxy page loses every file's progress`);
    });
  }
});

describe('nobody re-implements a decoration', () => {
  it('the endpoint-name resolution exists once', () => {
    /*
     * It was inline in the edges list route, which is why `filter` did not have it. The tell is the
     * per-kind name FIELD — an entity has `name`, a chrono `title`, a fact `fact` — so a second copy is
     * a file that reaches `endpointNameField` without being the module that owns it.
     */
    // `untracked: true`, because the file a change ADDS is not in `git ls-files` until it is committed —
    // so a pre-commit sweep without it cannot see the very copy the commit introduces. Found here: the
    // case below reported an EMPTY holder list for a module that was sitting on disk.
    const offenders = trackedSources(['server/src'], {
      untracked: true,
      exclude: ['server/src/brain/edge-endpoint-names.ts', 'server/src/brain/entity-refs.ts'],
    }).filter(f => src(f).includes('endpointNameField('));
    assert.deepEqual(offenders, [],
      `these resolve an endpoint's display name themselves instead of calling \`withEndpointNames\`, so `
      + `one door can show a name the other cannot: ${offenders.join(', ')}`);
  });

  it('the file-progress join exists once, and NOT in a route file', () => {
    // It lived in `api/brain/file-meta.ts`, which a `brain/` module may not import from — so `filter`
    // could not have reached it wherever it was declared. The module is the reason both doors can.
    const holders = trackedSources(['server/src'], { untracked: true })
      .filter(f => src(f).includes('export async function attachJobProgress'));
    assert.deepEqual(holders, ['server/src/files/file-job-progress.ts'],
      `the progress join should be declared once, outside \`api/\`: ${holders.join(', ')}`);
  });
});

describe('`includeDiagnostics` is accepted and honoured on both doors', () => {
  it('the REST body allowlist admits it', () => {
    // Absent from the allowlist it is a 400 for a parameter the tool takes — and admitting it WITHOUT
    // wiring the projection would be the worse half: a 200 with the flag doing nothing.
    assert.ok(QUERY_BODY_FIELDS.has('includeDiagnostics'),
      'the REST door 400s on a flag its twin accepts');
  });

  it('the tool declares it, with the same default', () => {
    const prop = filterSchema().properties?.includeDiagnostics;
    assert.ok(prop, 'the tool refuses a flag the route accepts — `additionalProperties` is false here');
    assert.equal(prop.default, false, 'the two doors must default the same way');
    assert.match(prop.description ?? '', /matchedText/,
      'the schema is what a caller reads while constructing arguments — say what it adds back');
  });

  it('and both doors actually apply the projection', () => {
    for (const door of DOORS) {
      assert.match(src(door), /withoutListDiagnostics\(/,
        `${door} accepts \`includeDiagnostics\` and strips nothing, which is a silent no-op`);
    }
  });
});

describe('a collection with no decoration is returned untouched', () => {
  it('the rows come back identical, not merely equal', async () => {
    // The common case. A module that rebuilt every row would be a per-page copy for nothing, and would
    // quietly drop any field it did not know about.
    const rows = [{ _id: 'a', fact: 'x' }];
    assert.equal(await decorateMemberRows('facts', 'space', rows), rows);
    assert.equal(await decoratePage('facts', 'space', rows, async () => []), rows);
  });

  it('and an empty edge page needs no lookup at all', async () => {
    let queried = false;
    const out = await decoratePage('edges', 'space', [], async () => { queried = true; return []; });
    assert.deepEqual(out, []);
    assert.equal(queried, false, 'an empty page must not issue a name lookup');
  });
});
