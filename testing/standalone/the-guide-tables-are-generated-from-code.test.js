/**
 * The integration guide's tool tables are RENDERED from the code, and the tool names in its headings and tool
 * tables are tools.
 *
 * ## Why this, and what was wrong when it was written
 *
 * `16-mcp.md` is the page an integrator designs against, and its two largest tables were typed. The capability
 * map named `query POST /api/filter` for a route that no longer exists, left out `space_reembed`, called `help`
 * MCP-only while `GET /api/tokens/me` was mapped to it, and gave `read_file` the bytes route when the code
 * answers the extracted-text one. The REST-only block said the list was empty while `parity.ts` held rows. The
 * tool table listed `query` and `traverse`, which are not tools, and no `filter` or `graph_traverse`. The
 * example sections were headed with `update_memory`, `delete_memory` and `get_stats`. Every one of these was
 * believed by a reader and found only by an audit (`Q-546`), because **a typed copy of a derived fact is right
 * on the day it is written and wrong from the next change**, and nothing contradicts it.
 *
 * ## What it holds, in two halves
 *
 * **Generated regions.** A region between `<!-- generated: NAME -->` and `<!-- /generated: NAME -->` must equal
 * the render in `_guide-tables.mjs`, which is also what `scripts/surface-matrix.mjs` writes. Line endings are
 * normalised on both sides (the working tree is CRLF, the commit is LF). **A missing marker fails FIRST and names
 * the page**, because a page that lost its markers would otherwise have no region and the comparison would be
 * over nothing, which is the vacuous pass this gate exists to refuse.
 *
 * **Tool names.** The name a heading is ABOUT and every identifier in the first column of a table headed `Tool`
 * must be a live tool, across every integration-guide page. A heading's subject is its leading backticked
 * identifier, or the identifier after `Example:`. An `Example:` heading is held strictly (whatever follows is
 * meant as a tool); any other heading is held only when the name is one the registry has or had, because a
 * heading that opens with an ordinary word is not naming a tool. Retired names are read from the previous
 * major's tag (`_previous-major-tools.mjs`), so the set is derived and not listed.
 *
 * ## Stated limits
 *
 * It reads headings and tool-table first columns, not prose. A sentence that names a dead tool in running text is
 * `no-live-text-names-a-retired-tool`'s question, and that gate must keep excluding names that are also
 * parameters; a heading and a table cell are positions where the ambiguity does not exist, which is why this one
 * can be exact. The parameter tables under each tool stay hand-written (they carry parameter documentation the
 * code does not); it is their tool NAMES that this holds. Code fences are skipped.
 *
 * ## The floors
 *
 * Both pages have to be read, at least one tool table and one heading have to be found, and the live and the
 * retired sets have to be real, before anything is concluded. A name scan that finds nothing passes.
 *
 * ## Seen red
 *
 * On the base this was written against: both marker pairs were absent, the example headings above named retired
 * tools, and the tool table's first column named tools that are not tools. The region comparison is seen red by
 * mutation after the markers land: a row of the map edited by hand inside them, restored by hand.
 *
 * Run: node --test testing/standalone/the-guide-tables-are-generated-from-code.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { previousMajorTag, toolNamesAt } from './_previous-major-tools.mjs';
import { renderCapabilityMap, renderRestOnlyBlock, capabilityMapModel, rungCell, isToolDoorPath } from './_guide-tables.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

/** Each generated region: where it lives, what it is called, and what renders it. */
const REGIONS = [
  { page: 'docs/integration-guide/16b-mcp-capability-map.md', name: 'capability-map', render: renderCapabilityMap },
  { page: 'docs/integration-guide/16-mcp.md', name: 'rest-only', render: renderRestOnlyBlock },
];

const eol = s => s.replace(/\r\n/g, '\n');

/** The text between a region's markers; throws, naming the page, when either marker is absent or repeated. */
function regionOf({ page, name }) {
  assert.ok(existsSync(join(REPO_ROOT, page)), `${page} does not exist; the generated region \`${name}\` has no page to live on`);
  const text = eol(readFileSync(join(REPO_ROOT, page), 'utf8'));
  const open = `<!-- generated: ${name} -->`;
  const close = `<!-- /generated: ${name} -->`;
  const opens = text.split(open).length - 1;
  const closes = text.split(close).length - 1;
  assert.ok(opens === 1 && closes === 1,
    `${page} must carry the marker pair \`${open}\` ... \`${close}\` exactly once; it has the opening marker ${opens} time(s) `
    + `and the closing marker ${closes} time(s). Without the pair there is no region to compare against the render, so `
    + 'this fails here instead of comparing nothing.');
  const from = text.indexOf(open) + open.length;
  const to = text.indexOf(close);
  assert.ok(from <= to, `${page}: the closing marker for \`${name}\` comes before its opening marker`);
  return text.slice(from, to);
}

describe('every generated region has its markers', () => {
  for (const region of REGIONS) {
    it(`${region.page} carries \`${region.name}\``, () => {
      regionOf(region);
    });
  }
});

describe('a generated region equals what the code renders', () => {
  for (const region of REGIONS) {
    it(`${region.page} \`${region.name}\``, () => {
      const written = regionOf(region).trim();
      const rendered = eol(region.render()).trim();
      assert.ok(rendered.length > 0, `the render for \`${region.name}\` is empty; an empty region would equal it and pass`);
      if (written === rendered) return;
      const a = written.split('\n');
      const b = rendered.split('\n');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      assert.fail(
        `${region.page}: the \`${region.name}\` region differs from the render at its line ${i + 1}.\n`
        + `  page:   ${a[i] ?? '(ends here)'}\n  render: ${b[i] ?? '(ends here)'}\n`
        + 'The region is generated: change the code it is rendered from and regenerate it with `scripts/surface-matrix.mjs` '
        + '(build the server first — it reads `server/dist`). An edit inside the markers is overwritten by the next regeneration.');
    });
  }
});

// ── what the rung cell is allowed to say ────────────────────────────────────────────────────────────────────────

const { TOOL_RIGHTS } = await import('../../server/dist/auth/space-rights.js');

describe('the rung cell states only what the code has', () => {
  const rows = capabilityMapModel().rows;

  it('the tool door is a tool\'s own route, not any POST /api/<word>', () => {
    // `POST /api/spaces`, `/api/networks` and `/api/views` are ordinary REST routes priced by `ROUTE_RIGHTS`; only
    // `POST /api/<the row's tool>` is served by the generic `/:tool` route that `TOOL_RIGHTS` prices.
    assert.equal(isToolDoorPath('POST /api/spaces', 'save_space'), false);
    assert.equal(isToolDoorPath('POST /api/networks', 'network_create'), false);
    assert.equal(isToolDoorPath('POST /api/views', 'view_create'), false);
    assert.equal(isToolDoorPath('POST /api/save_space', 'save_space'), true);
    assert.equal(isToolDoorPath('POST /api/save_space', 'save_fact'), false, 'another tool\'s door is not this tool\'s');
  });

  it('a row says "both doors" only when its REST route is the tool\'s own door', () => {
    const both = rows.filter(r => rungCell(r).includes('both doors'));
    const wrong = both.filter(r => r.route !== `POST /api/${r.tool}`).map(r => `${r.tool} -> ${r.route}`);
    assert.deepEqual(wrong, [], 'a row claims one rung on both doors for a REST route that is not the tool door');
    assert.ok(both.length >= 1, 'no row says "both doors", so none was held');
  });

  it('a row states a door difference only when the tool is priced by a row or a flag', () => {
    const priced = new Set(TOOL_RIGHTS.map(r => r.tool));
    const flagged = new Set(ALL_TOOLS.filter(t => t.admin || t.spaceAdmin).map(t => t.name));
    const differing = rows.filter(r => /· MCP \S+\*\*/.test(rungCell(r)));
    const unfounded = differing.filter(r => !priced.has(r.tool) && !flagged.has(r.tool)).map(r => r.tool);
    assert.deepEqual(unfounded, [],
      'a tool priced inside its handler has no MCP rung to put against the route\'s; the cell claims a difference the code does not have');
    assert.ok(rows.filter(r => r.route && r.restRung && r.restRung !== 'exempt').length >= 20, 'too few priced rows were read');
  });
});

// ── tool names in headings and tool tables ──────────────────────────────────────────────────────────────────────

const LIVE = new Set(ALL_TOOLS.map(t => t.name));
const TAG = previousMajorTag();
const RETIRED = new Set([...toolNamesAt(TAG)].filter(n => !LIVE.has(n)));
const KNOWN = new Set([...LIVE, ...RETIRED]);

/** An identifier written the way a tool name is. */
const IDENT = /^[a-z][a-z0-9_]*$/;

/**
 * The tool names a page names in a position that is ABOUT a tool: `{ line, name, where, strict }`.
 *
 * `strict` is true where whatever is named is meant as a tool (an `Example:` heading, a `Tool` table cell), so a
 * name the registry never had is wrong too; otherwise only a name the registry has or had is considered.
 */
function namedTools(text) {
  const out = [];
  let fenced = false;
  let inToolTable = false;
  text.split('\n').forEach((raw, i) => {
    // A table inside a blockquote is still a table.
    const line = raw.replace(/^(\s*>\s?)+/, '');
    if (/^\s*```/.test(line)) { fenced = !fenced; inToolTable = false; return; }
    if (fenced) return;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inToolTable = false;
      const example = /^Example:\s*`?([a-z][a-z0-9_]*)`?/.exec(heading[1]);
      const leading = /^`([a-z][a-z0-9_]*)`(?=\s|$|[—–:,-])/.exec(heading[1]);
      if (example) out.push({ line: i + 1, name: example[1], where: 'an example heading', strict: true });
      else if (leading) out.push({ line: i + 1, name: leading[1], where: 'a heading', strict: false });
      return;
    }
    if (!/^\s*\|/.test(line)) { inToolTable = false; return; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (/^\**tool\**$/i.test(cells[0].replace(/`/g, ''))) { inToolTable = true; return; }
    if (!inToolTable || /^:?-{2,}:?$/.test(cells[0])) return;
    for (const m of cells[0].matchAll(/`([^`]+)`/g)) {
      if (IDENT.test(m[1])) out.push({ line: i + 1, name: m[1], where: 'the Tool column of a table', strict: true });
    }
  });
  return out;
}

const GUIDE_PAGES = trackedSources('docs/integration-guide', { ext: ['.md'], floor: 30 });
const NAMED = GUIDE_PAGES.flatMap(page =>
  namedTools(eol(readFileSync(join(REPO_ROOT, page), 'utf8'))).map(n => ({ ...n, page })));

describe('the tool-name scan reads before it concludes', () => {
  it('the registry and the previous major are real', () => {
    assert.ok(LIVE.size >= 30, 'too few live tools; the built registry is not being read');
    assert.ok(RETIRED.size > 0, `nothing is retired between ${TAG} and now; check the registry parse before trusting an empty offender list`);
  });

  it('finds tool tables and headings to hold', () => {
    assert.ok(NAMED.filter(n => n.where === 'the Tool column of a table').length >= 20,
      'the guide\'s tool table was not found, so no cell was held');
    assert.ok(NAMED.filter(n => n.where !== 'the Tool column of a table').length >= 1,
      'no heading naming a tool was found, so no heading was held');
  });
});

describe('a heading or tool table names a tool that exists', () => {
  it('every name in them is a live tool', () => {
    const offenders = NAMED
      .filter(n => !LIVE.has(n.name) && (n.strict || KNOWN.has(n.name)))
      .map(n => `${n.page}:${n.line} ${n.where} names \`${n.name}\`, `
        + (RETIRED.has(n.name) ? `which was a tool at ${TAG} and is not one now` : 'which the registry has never had'));
    assert.deepEqual(offenders, [],
      'a guide heading or tool table names something that is not a tool:\n  ' + offenders.join('\n  ')
      + '\n\nAn integrator reads a heading as the name to call. Name the live tool (`filter` for `query`, `graph_traverse` for '
      + '`traverse`), or move the name out of the tool position.');
  });
});
