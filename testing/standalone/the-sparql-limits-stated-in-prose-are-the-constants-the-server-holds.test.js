/**
 * Every SPARQL limit the docs, the example config and the tool texts state is the number the server holds (bundle-271, Q-756, Q-757; lens-3 D2).
 *
 * ## What it prevents
 *
 * The bounds of a query are written in prose in six places: the bounds table of `docs/integration-guide/04j-sparql-api.md`, the user guide's
 * SPARQL section, the MCP guide's `sparql_query` row, the CHANGELOG, `config/config.example.json` and the tool's description. Each was typed by
 * hand beside the constants (`SPARQL_LIMIT_DEFAULTS`, `SPARQL_QUERY_MAX_BYTES`, `SLOT_FAMILIES.sparql`), so a default changed in the code left
 * a doc that stated the old one. This reads the constants from the built server and holds each statement to them: the table's rows (every key
 * the bounds name, with its default), the example config's block (deep equal to the defaults), the slot counts in words, the text cap in KiB,
 * and the numbers in the tool's description (which the tool builds from the constants).
 *
 * ## Seen red
 *
 * Mutations: `maxResults` default changed in `sparql-limits.ts` (the 04j row, the example block and the user guide disagree); the example
 * block without `maxResultBytes` (a key the bounds name that the example does not state).
 *
 * Run: node --test testing/standalone/the-sparql-limits-stated-in-prose-are-the-constants-the-server-holds.test.js (a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { SPARQL_LIMIT_DEFAULTS, SPARQL_LIMIT_BOUNDS } = await import('../../server/dist/config/sparql-limits.js');
const { SPARQL_QUERY_MAX_BYTES } = await import('../../server/dist/rdf/sparql-engine.js');
const { SLOT_FAMILIES } = await import('../../server/dist/util/slots.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

const read = (path) => readFileSync(path, 'utf8').replace(/^\u{FEFF}/u, '').replace(/\r\n/g, '\n');
const sparqlGuide = read('docs/integration-guide/04j-sparql-api.md');
const mcpGuide = read('docs/integration-guide/16-mcp.md');
const userGuide = read('docs/userguide/02-brain.md');
const changelog = read('CHANGELOG.md');
const exampleConfig = JSON.parse(read('config/config.example.json'));

const WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
const word = (n) => WORDS[n] ?? assert.fail(`no word for ${n}: extend this test`);
/** `10000` as the docs group it: `10 000`. */
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const KEYS = Object.keys(SPARQL_LIMIT_BOUNDS);
const tool = ALL_TOOLS.find(t => t.name === 'sparql_query') ?? assert.fail('no sparql_query tool');

describe('the limits the docs state are the constants the server holds', () => {
  it('the keys are found (a floor, so an empty scan is not a clean one)', () => {
    assert.deepEqual([...KEYS].sort(), ['maxRecordsRead', 'maxResultBytes', 'maxResults', 'timeoutMs']);
    assert.equal(SLOT_FAMILIES.sparql.instance >= 1 && SLOT_FAMILIES.sparql.perCaller >= 1, true);
  });

  it('the bounds table of the SPARQL guide has a row per key with its default', () => {
    for (const key of KEYS) {
      const row = new RegExp(`^\\| \`sparql\\.${key}\` \\| ([^|]+) \\|`, 'm').exec(sparqlGuide);
      assert.ok(row, `04j-sparql-api.md has no bounds row for sparql.${key}`);
      assert.equal(Number(row[1].replace(/\s/g, '').match(/^\d+/)?.[0]), SPARQL_LIMIT_DEFAULTS[key], `04j states ${row[1].trim()} for sparql.${key}, the server holds ${SPARQL_LIMIT_DEFAULTS[key]}`);
    }
  });

  it('config.example.json states the defaults, every key', () => {
    assert.deepEqual(exampleConfig.sparql, { ...SPARQL_LIMIT_DEFAULTS });
  });

  it('the slot counts are the family\'s, in the SPARQL guide, the MCP guide and the CHANGELOG', () => {
    const { instance, perCaller } = SLOT_FAMILIES.sparql;
    assert.ok(sparqlGuide.includes(`At most ${word(instance)} queries run at once on an instance and ${word(perCaller)} per token`), '04j states other slot counts');
    assert.ok(mcpGuide.includes(`${word(perCaller)[0].toUpperCase()}${word(perCaller).slice(1)} query at a time per token, ${word(instance)} per instance`), '16-mcp.md states other slot counts');
    assert.ok(changelog.includes(`${word(instance)} queries at once per instance, ${word(perCaller)} per token`), 'the CHANGELOG states other slot counts');
  });

  it('the text cap is stated as the engine holds it', () => {
    const kib = SPARQL_QUERY_MAX_BYTES / 1024;
    assert.ok(sparqlGuide.includes(`The text is over ${kib} KiB`), `04j does not state the ${kib} KiB text cap`);
    assert.ok(String(tool.inputSchema({ requiredSpace: {}, optionalSpace: {} }).properties.query.description).includes(`at most ${kib} KiB`), 'the tool describes another text cap');
  });

  it('the user guide states the defaults of the three bounds it names', () => {
    for (const [key, unit] of [['maxResults', ''], ['timeoutMs', ' ms'], ['maxRecordsRead', '']]) {
      assert.ok(userGuide.includes(`\`sparql.${key}\``), `02-brain.md does not name sparql.${key}`);
      const stated = new RegExp(`sparql\\.${key}\`[^()]*\\(default ${grouped(SPARQL_LIMIT_DEFAULTS[key])}${unit}\\)`).test(userGuide)
        || new RegExp(`\\(default ${grouped(SPARQL_LIMIT_DEFAULTS[key])}${unit}\\)[^.]*\`sparql\\.${key}\``).test(userGuide)
        || userGuide.includes(`\`sparql.${key}\` (default ${grouped(SPARQL_LIMIT_DEFAULTS[key])}${unit})`);
      assert.ok(stated, `02-brain.md does not state ${grouped(SPARQL_LIMIT_DEFAULTS[key])}${unit} as the default of sparql.${key}`);
    }
  });

  it('the tool describes the row default it holds', () => {
    const limit = tool.inputSchema({ requiredSpace: {}, optionalSpace: {} }).properties.limit.description;
    assert.ok(String(limit).includes(`default ${SPARQL_LIMIT_DEFAULTS.maxResults}`), 'the limit parameter states another default');
  });
});
