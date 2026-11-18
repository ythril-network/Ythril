/**
 * A space's record counts are read from ONE module, and no door keeps a count of its own (bundle-38, Q-169).
 *
 * ## The defect it prevents
 *
 * Four doors answered "how many facts, entities, edges and chrono entries does this space hold": REST stats, MCP `space_stats`,
 * `GET /api/spaces?counts=true` and MCP `list_spaces`. Each wrote the four counts out by hand. REST stats counted facts through
 * `countFacts` and the other three doors through `countDocuments()`, so a change to what a fact count means (a retired
 * record, a fork row) would have reached one door and not the next. MCP `space_stats` also left out `embedQueue`, which REST
 * stats answers, so an agent asking "is this space ready to search" got an answer on one door only.
 *
 * ## The rule
 *
 * `spaces/space-counts.ts` is the one place that counts the four knowledge collections of a space. A file under `server/src`
 * that counts three or more of them by hand is a copy. The files are read from git, never listed here, so a fifth door
 * written next month is judged the day it is added. A door that answers the counts imports the module (or the stats answer built on
 * it, `spaceStatsAnswer` in `spaces/space-meta-answer.ts`) and calls it, and `embedQueue` is built by that one answer for both stats
 * doors, never by a door. The stats answer lives in a module that already sits in the server's import cycle: a new module the MCP tools
 * import and that imports the embed queue would grow the cycle, whose ceiling only goes down.
 *
 * ## What it reads
 *
 * A COUNT is a call: `<collection>.countDocuments(...)` whose collection is named `spaceCollection(x, '<family>')` or
 * `` `${x}_<family>` ``, or a call of `countFacts` (the facts count). A mention, an import or a comment is not one. The scan
 * parses each file, so the text of a comment that explains a fix is never read as code. The families are written in this
 * file as the rule's own words and checked against the module, so a module that stopped counting one fails here.
 *
 * Planted copies at the foot take the module's own count lines and put them into a door, in each spelling a door has used,
 * and the detector must flag them; a detector that stopped seeing a spelling fails there instead of passing every file.
 *
 * Run: node --test testing/standalone/a-spaces-record-counts-are-read-from-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readTrackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { parseSource, walkEveryNode, lineOf, ts } from '../_shared/syntax-tree.mjs';

const MODULE = 'server/src/spaces/space-counts.ts';
/** Where the stats body is built: a module that already sits in the server's import cycle, because a new one the MCP tools import would grow it (its ceiling only goes down). */
const STATS_HOME = 'server/src/spaces/space-meta-answer.ts';
const COUNT_MODULES = [MODULE, STATS_HOME];
/** The four knowledge collections a space's `counts` carry. The rule's own words, not read from the module it judges. */
const FAMILIES = ['facts', 'entities', 'edges', 'chrono'];
/** How many of them a file may count by hand before it is a copy of the four-collection count. */
const COPY_AT = 3;
/** The doors that answer a space's counts: each must read the module. Written here as a floor for the derivation, which finds them itself. */
const DOORS = [
  'server/src/api/spaces.ts', 'server/src/api/brain/search.ts', 'server/src/mcp/tools/spaces.ts',
];

const SOURCES = readTrackedSources(SERVER_CODE_ROOTS, { floor: 500 });

/** The family a collection expression names, or null: `spaceCollection(x, 'facts')` and `${x}_facts`. */
function familyOfCollection(expr, sf) {
  let found = null;
  walkEveryNode(expr, (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'spaceCollection') {
      const part = n.arguments[1];
      if (part && ts.isStringLiteralLike(part) && FAMILIES.includes(part.text)) found = part.text;
    } else if (ts.isTemplateExpression(n)) {
      for (const span of n.templateSpans) {
        const m = /^_(\w+)$/.exec(span.literal.text);
        if (m && FAMILIES.includes(m[1])) found = m[1];
      }
    }
  });
  return found;
}

/** The counts one file makes by hand: `{ family, line }` for each, in the file's order. */
export function handCounts(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    if (ts.isIdentifier(callee) && callee.text === 'countFacts') { out.push({ family: 'facts', line: lineOf(sf, n) }); return; }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'countDocuments') {
      const family = familyOfCollection(callee.expression, sf);
      if (family) out.push({ family, line: lineOf(sf, n) });
    }
  });
  return out;
}

/** Whether a file's hand counts are a copy of the four-collection count. */
export const isCopy = (counts) => new Set(counts.map(c => c.family)).size >= COPY_AT;

/** The names a source imports from one of `modules` (repo-relative `.ts` paths), or an empty list when it imports none. */
export function importedFromModule(file, text, modules = [MODULE]) {
  const sf = parseSource(file, text);
  const wanted = modules.map(m => m.split('/').pop().replace(/\.ts$/, '.js'));
  const names = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    if (!wanted.some(w => st.moduleSpecifier.text.endsWith(`/${w}`))) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map(e => (e.propertyName ?? e.name).text));
  }
  return names;
}

/** Whether `text` calls one of `names` (an identifier call, not a mention). */
export function callsAny(file, text, names) {
  const sf = parseSource(file, text);
  let hit = false;
  walkEveryNode(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.includes(n.expression.text)) hit = true;
  });
  return hit;
}

/** The properties named `embedQueue` an object literal of this source defines: a door that builds the queue's counts itself. */
export function embedQueueBuilds(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name.getText(sf) === 'embedQueue') out.push(lineOf(sf, n));
  });
  return out;
}

const moduleSource = () => SOURCES.find(s => s.file === MODULE);

describe('a space\'s record counts are read from one module', () => {
  it('the module exists and counts each of the four collections itself', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)),
      `${MODULE} does not exist: four doors each count a space's records by hand, and a change to what a count means reaches one of them`);
    const own = handCounts(MODULE, moduleSource().text);
    assert.deepEqual([...new Set(own.map(c => c.family))].sort(), [...FAMILIES].sort(),
      `${MODULE} does not count every one of ${FAMILIES.join(', ')}: a door that reads it would be answered without one`);
  });

  it('no file outside the module counts three or more of the four collections by hand', () => {
    const copies = [];
    for (const { file, text } of SOURCES) {
      if (file === MODULE) continue;
      const counts = handCounts(file, text);
      if (isCopy(counts)) copies.push(`${file}: ${[...new Set(counts.map(c => c.family))].join(', ')} counted at lines ${counts.map(c => c.line).join(', ')}`);
    }
    assert.deepEqual(copies, [],
      'these keep a count of the four collections of their own: read the module, so the four doors answer one number for one space');
  });

  it('every door that answers a space\'s counts imports the one count and calls it', () => {
    for (const door of DOORS) {
      const { text } = SOURCES.find(s => s.file === door);
      const imported = importedFromModule(door, text, COUNT_MODULES);
      assert.ok(imported.length > 0, `${door} answers a space's counts and imports none of ${COUNT_MODULES.join(', ')}`);
      assert.ok(callsAny(door, text, imported), `${door} imports a count and calls none of ${imported.join(', ')}`);
    }
  });

  it('the stats answer, embedQueue included, is built in one module and by no door', () => {
    const builders = SOURCES.filter(s => embedQueueBuilds(s.file, s.text).length > 0).map(s => s.file);
    assert.deepEqual(builders, [STATS_HOME],
      `embedQueue is built in ${builders.join(', ') || 'no file'}: REST stats and MCP space_stats answer it from one function, or one door answers a space's queue and the other leaves it out`);
  });
});

describe('the detector sees every spelling a door has used', () => {
  /** The module's own count lines, taken from its source, never typed again here. */
  const OWN = () => moduleSource().text;
  const wrap = (body) => `import { col } from '../db/mongo.js';\nimport { spaceCollection } from '../db/space-collection.js';\nexport async function door(mid) {\n${body}\n}\n`;

  it('a door that counts with countDocuments on spaceCollection is a copy', () => {
    const planted = wrap(FAMILIES.map(f => `  const ${f} = await col(spaceCollection(mid, '${f}')).countDocuments();`).join('\n'));
    assert.ok(isCopy(handCounts('server/src/planted.ts', planted)));
  });

  it('a door that counts facts with countFacts and the rest with countDocuments is a copy', () => {
    const planted = wrap([
      '  const facts = await countFacts(mid);',
      ...FAMILIES.slice(1).map(f => `  const ${f} = await col(spaceCollection(mid, '${f}')).countDocuments();`),
    ].join('\n'));
    assert.ok(isCopy(handCounts('server/src/planted.ts', planted)));
  });

  it('a door that counts through a template collection name is a copy', () => {
    const planted = wrap(FAMILIES.map(f => `  const ${f} = await col(\`\${mid}_${f}\`).countDocuments();`).join('\n'));
    assert.ok(isCopy(handCounts('server/src/planted.ts', planted)));
  });

  it('the module\'s own count lines, put into a door, are a copy (and in the module they are the one home)', () => {
    const lines = OWN().split('\n').filter(l => /countDocuments|countFacts/.test(l) && !/^\s*(\*|\/\/|\/\*|import\b)/.test(l));
    assert.ok(lines.length >= FAMILIES.length, `the module has ${lines.length} count line(s): the plant has nothing to copy`);
    const planted = wrap(`  return {\n${lines.join('\n')}\n  };`);
    assert.ok(isCopy(handCounts('server/src/planted.ts', planted)), 'the module\'s own count lines are not seen as a copy when they sit in a door');
  });

  it('a mention in a comment, a string or an import is not a count, and two collections are not a copy', () => {
    const planted = wrap([
      "  // col(spaceCollection(mid, 'facts')).countDocuments()",
      "  const note = \"spaceCollection(mid, 'entities')).countDocuments()\";",
      "  const a = await col(spaceCollection(mid, 'facts')).countDocuments();",
      "  const b = await col(spaceCollection(mid, 'edges')).countDocuments();",
    ].join('\n'));
    const counts = handCounts('server/src/planted.ts', planted);
    assert.deepEqual(counts.map(c => c.family), ['facts', 'edges']);
    assert.equal(isCopy(counts), false);
  });

  it('an embedQueue property built in a door is found, shorthand and assigned', () => {
    assert.equal(embedQueueBuilds('server/src/planted.ts', wrap('  const embedQueue = {}; return { spaceId: 1, embedQueue };')).length, 1);
    assert.equal(embedQueueBuilds('server/src/planted.ts', wrap('  return { embedQueue: { pending: 1 } };')).length, 1);
  });
});
