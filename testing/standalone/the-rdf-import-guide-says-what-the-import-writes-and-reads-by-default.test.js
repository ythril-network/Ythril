/**
 * The RDF import's guide says what the import now does (bundle-270, fix round 4, findings R1 to R4).
 *
 * ## What it prevents
 *
 * The guide said `sourceBase` defaults to the file's one data graph, which the code did not do (R2); it did not say a record that already says what the
 * file states is not written (R3), named neither the order the kinds are written in nor the reason a link the commit could not write is answered with (R1),
 * and said the base check is made at the door only (R4). A guide sentence that drifts from the code is a promise the next reader acts on.
 *
 * ## What it holds
 *
 * - Every reason code the import's report builder spells as its own constant (`export const <NAME> = '<code>'` in `rdf/import-report.ts`, derived from the
 *   source, never a list here) is named in the import section as a reason (`coded \`<code>\``), a hyphenated code too (Q-759: the planner refusals'
 *   `missing-required-field` and `end-refused` were read past by a pattern of underscores alone).
 * - The kinds are written in `IMPORT_OP_ORDER`'s order (read from the source), and the section says that order.
 * - The parameters table says TriG, N-Quads and JSON-LD default `sourceBase` to the file's one data graph and Turtle to none, and the section says when the
 *   default applies; the section says an unchanged record is not written and is counted in `unchanged`; the status table says the base check is also made
 *   before the first window.
 * - The section says the upload's idle bound and its rate, as the reader holds them, and that both are answered 408 (Q-953).
 *
 * Run: node --test testing/standalone/the-rdf-import-guide-says-what-the-import-writes-and-reads-by-default.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
/** A file of the repository, or '' where it does not exist (a module a case names and the tree lacks fails that case's assertion). */
const read = (p) => (fs.existsSync(root + p) ? fs.readFileSync(root + p, 'utf8').replaceAll('\r\n', '\n') : '');

function importSection() {
  const page = read('docs/integration-guide/06f-exports.md');
  const from = page.indexOf('\n## RDF import');
  assert.ok(from >= 0, 'the page has an RDF import section');
  const to = page.indexOf('\n## ', from + 1);
  return page.slice(from, to < 0 ? undefined : to);
}

describe('the RDF import section says what the import writes and reads by default', () => {
  it('names every reason code the report builder owns, as a coded reason', () => {
    const source = read('server/src/rdf/import-report.ts');
    // A code may be spelled with hyphens (Q-759: `missing-required-field`, `end-refused`); a pattern of underscores alone read past them, so a
    // planner refusal's code could reach callers with no line of the guide to say what it means.
    const codes = [...source.matchAll(/^export const [A-Z_]+ = '([a-z][a-z_-]*)';$/gm)].map(m => m[1]);
    for (const c of ['stored_record_gone', 'links_not_written', 'plan_refused', 'missing-required-field', 'end-refused', 'stored-link-dangling', 'address-gives-no-name']) {
      assert.ok(codes.includes(c), `${c} is among the constants found: ${codes.join(', ')}`);
    }
    const section = importSection();
    for (const code of codes) assert.ok(section.includes(`coded \`${code}\``), `the section names the reason \`${code}\``);
  });

  it('says in the `plan_refused` row that the reason carries the planner\'s sentence (Q-759 review F3)', () => {
    const row = importSection().split('\n').find(l => l.startsWith('| `plan_refused` |'));
    assert.ok(row, 'the table has a `plan_refused` row');
    assert.ok(row.includes('`message`: the planner\'s sentence'), `the row says where the sentence is: ${row}`);
  });

  it('says the order the kinds are written in, which is the source\'s', () => {
    const source = read('server/src/rdf/import-report.ts');
    const order = /IMPORT_OP_ORDER: readonly OpKind\[\] = \[([^\]]+)\]/.exec(source)?.[1]?.replaceAll("'", '').split(',').map(s => s.trim());
    assert.deepEqual(order, ['entity', 'fact', 'chrono', 'edge'], 'what a record points at is written first');
    assert.ok(importSection().includes('what a record points at first (entities, facts, chrono entries, edges)'), 'the section says it');
  });

  it('says when sourceBase defaults, and that an unchanged record is not written', () => {
    const section = importSection();
    assert.ok(section.includes('| TriG, N-Quads, JSON-LD: the file\'s one data graph; Turtle: none |'), 'the table says which formats default');
    assert.ok(section.includes('exactly one data graph, no statement outside it and no `graphBase`'), 'the section says when the default applies');
    assert.ok(section.includes('is **not written at all**'), 'the section says an unchanged record is not written');
    assert.ok(section.includes('in `converged` and in `unchanged`'), 'and where the report counts it');
    assert.ok(section.includes('after the import was registered and before its first window'), 'the status table says the base is checked before the first window too');
  });
});

/**
 * Lens findings L1 to L3 and L7 (bundle-270): what the other pages and the changelog say of the import and of the checks it brought, each read against the
 * source that decides it, never a list kept here.
 */
describe('the pages say what the import and its shared checks do to existing callers', () => {
  it('L2: the read-only list of the tool page holds no tool whose rung is above read, and import_rdf_status asks write', () => {
    const rights = [...read('server/src/auth/space-rights.ts').matchAll(/\{ tool: '([a-z_]+)', area: '[a-z]+', needs: '([a-z]+)' \}/g)].map(m => [m[1], m[2]]);
    const needs = Object.fromEntries(rights);
    assert.equal(needs['import_rdf_status'], 'write', 'the tool asks the write rung');
    assert.ok(Object.keys(needs).length > 30, `the tool rights were read (${Object.keys(needs).length})`);
    const page = read('docs/integration-guide/16-mcp.md');
    const list = /Read-only tools \(([^)]+)\) work normally/.exec(page)?.[1] ?? '';
    const named = [...list.matchAll(/`([a-z_]+)`/g)].map(m => m[1]);
    assert.ok(named.includes('recall'), 'the list was read');
    assert.deepEqual(named.filter(t => needs[t] !== undefined && needs[t] !== 'read'), [], 'a tool above the read rung is listed as read-only');
    assert.ok(page.includes('`import_rdf_status` is not among them: it asks `knowledge: write`'), 'the page says which rung it asks');
  });

  it('L3: the page of limits names the refusal code of every space act kind', () => {
    const codes = [...read('server/src/config/types-space-acts.ts').matchAll(/writeRefusalCode: '([a-z_]+)'/g)].map(m => m[1]);
    assert.ok(codes.includes('space_being_rdf_imported') && codes.length >= 7, `the codes read: ${codes.join(', ')}`);
    const page = read('docs/integration-guide/03-auth-and-limits.md');
    assert.deepEqual(codes.filter(c => !page.includes(`\`${c}\``)), [], 'a write refusal code of a space act is not on the page');
  });

  it('L1: the changelog and the pages say the shared checks reach existing callers', () => {
    const bulk = read('server/src/brain/bulk.ts');
    const status = /BULK_STORAGE_STATUS = (\d+);/.exec(bulk)?.[1];
    assert.equal(status, '507');
    const mib = /JSON_BODY_MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(read('server/src/config/body-limits.ts'))?.[1];
    const size = `${mib} MiB`;
    const changelog = read('CHANGELOG.md');
    const unreleased = changelog.slice(changelog.indexOf('## [Unreleased]'));
    const entry = unreleased.split('\n').find(l => l.startsWith('- **Brain:** a record over '));
    assert.ok(entry, 'the changelog has the Brain entry that names the new refusals');
    for (const word of [size, '`400`', '`507`', '`storage_exceeded`', '`save_bulk`']) assert.ok(entry.includes(word), `the changelog entry names ${word}`);
    assert.ok(!unreleased.includes('no user-facing effect: the checks a record must pass'), 'the changelog still calls the change invisible');
    const added = unreleased.split('\n').find(l => l.startsWith('- **RDF:** `POST /api/brain/spaces/:spaceId/import/rdf`'));
    assert.ok(added?.includes('peer tokens get `403`'), 'the Added entry says a peer-bound token is refused');
    const brain = read('docs/integration-guide/04-brain-api.md');
    assert.ok(brain.includes('`507` with `storageExceeded: true`') && brain.includes(`A record over ${size} as JSON`), 'the brain guide says the bulk limit and the size bound');
    const mcp = read('docs/integration-guide/16-mcp.md').split('\n').find(l => l.startsWith('| `save_bulk`')) ?? '';
    assert.ok(mcp.includes('(REST answers `507`)') && mcp.includes(`over ${size} as JSON`), 'the tool page says the bulk limit and the size bound on the save_bulk row');
  });

  it('L7, Q-953 and Q-983: the import section says the idle bound, the rate, and the share of memory one import is given, as the code holds them', () => {
    const reader = read('server/src/util/upload-reader.ts');
    assert.equal(/UPLOAD_IDLE_MS = 60_000;/.test(reader), true, 'the idle bound is a minute (the section says "a minute")');
    assert.equal(/UPLOAD_RATE_WINDOW_MS = 60_000;/.test(reader), true, 'the rate window is a minute (the section says "over a minute")');
    assert.equal(/MIN_TRANSFER_BYTES_PER_SECOND = 16_384;/.test(read('server/src/util/pace-window.ts')), true, 'the rate is 16 KiB/s (the section says so)');
    const room = read('server/src/rdf/import-memory.ts');
    assert.equal(/ROOM_DIVISOR = 4;/.test(room) && /CONTAINER_DIVISOR = 2;/.test(room), true, 'the room is a quarter of the smaller of the heap limit and half the container (the section says so)');
    const section = importSection();
    assert.ok(section.includes('an upload that sends nothing for a minute is answered `408 rdf_import_upload_stalled`'), 'the section says the stalled upload is refused 408');
    assert.ok(section.includes('one that sends less than 16 KiB/s over a minute of waiting is answered `408 rdf_import_upload_too_slow`'), 'the section says the slow upload is refused 408');
    assert.ok(section.includes('a quarter of the smaller of its heap limit and half its container\'s memory limit'), 'the section says the share the import gets');
    assert.ok(section.includes('`--max-old-space-size`') && section.includes('`NODE_OPTIONS`'), 'the section says how to raise the heap limit past the container');
    assert.ok(!/twice the record bound|RDF_IMPORT_MAX_(SUBJECTS|RECORDS)/.test(section), 'the section still names the retired record bound');
  });
});
