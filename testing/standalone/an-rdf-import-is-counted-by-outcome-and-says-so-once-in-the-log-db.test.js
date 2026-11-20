/**
 * An RDF import is counted by outcome, and its end leaves one log line with the space, the import and counts, never a record (bundle-270, lens
 * finding L6).
 *
 * ## What it holds
 *
 * - **The counter.** The space acts are counted by the runner in `ythril_space_acts_total{kind,via,outcome}`, and the RDF import is a kind of it
 *   (`rdf-import`): an import that wrote counts `completed`, one that was refused or cannot go on counts `failed` (the runner's own word for an act
 *   that ended without its effect), and the metrics page names the kind. There is no counter of the import's own: a second one would count the same
 *   ends twice. The page's row lists every kind the runner knows (`SPACE_ACT_KIND_NAMES`), so a kind added later fails here until the page says it.
 *   (The counter existed before this finding: its two assertions pin it and are green on the unchanged tree; the line and the page are the red ones.)
 * - **The line.** Both the end that wrote and the end that refused leave exactly one line saying `RDF import <id> ...`, naming the space and
 *   carrying counts; the file's records (a name, a value, a subject address) never reach the log.
 *
 * Run: node --test testing/standalone/an-rdf-import-is-counted-by-outcome-and-says-so-once-in-the-log-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const WROTE = 'rdfimpmetw';
const REFUSED = 'rdfimpmetr';
const NAME_MARKER = 'NameMarker-5c1e90';
const ADDRESS_MARKER = 'address-marker-5c1e90';
const VALUE_MARKER = 'ValueMarker-5c1e90';

/** A person whose name and address are markers; `bad` adds a value the strict mode refuses. */
function fileOf(space, bad) {
  const v = `${baseOf(space)}vocab/`;
  const label = '<http://www.w3.org/2000/01/rdf-schema#label>';
  return [
    `<http://people.example/${ADDRESS_MARKER}> a <${v}entity/person> ; ${label} "${NAME_MARKER}" .`,
    ...(bad ? [`<http://people.example/${ADDRESS_MARKER}> <http://unknown.example/says> "${VALUE_MARKER}" .`] : []),
    '',
  ].join('\n');
}

describe('an RDF import is counted by outcome and says so once in the log (real routes, real MongoDB)', { skip, timeout: 240_000 }, () => {
  let d, writer, registry, log, acts;

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_metric', spaces: [{ id: WROTE, meta: personMeta(WROTE, 'warn') }, { id: REFUSED, meta: personMeta(REFUSED, 'strict') }] });
    writer = await d.mint('rdf-import-metric-writer', Object.fromEntries([WROTE, REFUSED].map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    registry = await import('../../server/dist/metrics/registry.js');
    log = await import('../../server/dist/util/log.js');
    acts = await import('../../server/dist/config/types-space-acts.js');
  });
  after(async () => { await d?.close(); });

  const sample = async (outcome) => {
    const metric = (await registry.register.getMetricsAsJSON()).find(m => m.name === 'ythril_space_acts_total');
    return (metric?.values ?? []).filter(v => v.labels.kind === 'rdf-import' && v.labels.outcome === outcome).reduce((n, v) => n + v.value, 0);
  };
  async function linesWhile(work) {
    const lines = [];
    const off = log.subscribeLogLines(l => lines.push(l));
    try { await work(); } finally { off(); }
    return lines;
  }

  it('an import that wrote counts completed and leaves one line with the space, the import id and counts', async () => {
    const before = await sample('completed');
    let answer;
    const lines = await linesWhile(async () => { answer = await d.importRest(writer.key, WROTE, fileOf(WROTE, false)); });
    assert.equal(answer.status, 200, answer.text.slice(0, 300));
    assert.equal(await sample('completed'), before + 1, 'the completed import was not counted under kind rdf-import');
    const own = lines.filter(l => l.includes(`RDF import ${answer.body.importId} `));
    assert.equal(own.length, 1, `the end left ${own.length} lines: ${JSON.stringify(lines.slice(-6))}`);
    assert.ok(own[0].includes(WROTE), `the line does not name the space: ${own[0]}`);
    assert.match(own[0], /completed/);
    assert.match(own[0], /\b1\b/, 'the line carries no count');
    for (const marker of [NAME_MARKER, ADDRESS_MARKER, VALUE_MARKER]) assert.ok(!lines.join('\n').includes(marker), `a record's ${marker} reached the log`);
  });

  it('an import that was refused counts failed and leaves one line, with no record in it', async () => {
    const before = await sample('failed');
    let answer;
    const lines = await linesWhile(async () => { answer = await d.importRest(writer.key, REFUSED, fileOf(REFUSED, true)); });
    assert.equal(answer.status, 409, answer.text.slice(0, 300));
    assert.equal(await sample('failed'), before + 1, 'the refused import was not counted');
    const report = answer.body.report;
    assert.ok(report?.importId, `the refusal carries no report: ${answer.text.slice(0, 200)}`);
    const own = lines.filter(l => l.includes(`RDF import ${report.importId} `));
    assert.equal(own.length, 1, `the end left ${own.length} lines: ${JSON.stringify(lines.slice(-6))}`);
    assert.ok(own[0].includes(REFUSED));
    assert.match(own[0], /refused/);
    for (const marker of [NAME_MARKER, ADDRESS_MARKER, VALUE_MARKER]) assert.ok(!lines.join('\n').includes(marker), `a record's ${marker} reached the log`);
  });

  it('the metrics page names the rdf-import kind among the space acts it counts', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const page = fs.readFileSync(`${root}/docs/integration-guide/11-setup-api.md`, 'utf8').replaceAll('\r\n', '\n');
    const row = page.split('\n').find(l => l.startsWith('| `ythril_space_acts_total`')) ?? '';
    assert.ok(row, 'the page has no row for ythril_space_acts_total');
    const names = [...acts.SPACE_ACT_KIND_NAMES];
    assert.ok(names.includes('rdf-import') && names.length >= 6, `the kinds were not read from the runner: ${JSON.stringify(names)}`);
    assert.deepEqual(names.filter(k => !row.includes(`\`${k}\``)), [], 'a kind the runner counts is not named in the page\'s row');
    assert.match(row, /refused/i, 'the row does not say where a refused import is counted');
  });
});
