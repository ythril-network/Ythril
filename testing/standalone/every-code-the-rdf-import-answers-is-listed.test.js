/**
 * Every code the RDF import's doors can answer is in the import's refusal list and in the guide's table, and every status they answer with is one
 * the tool can carry (bundle-270, second review F11 and F6's tool status).
 *
 * ## What it prevents
 *
 * The list (`RDF_IMPORT_REFUSAL_CODES`, which the tool's description counts) and the guide's table were written by hand beside the answers, and
 * nine codes the doors answer were in neither, and one answer was a code with a space in it. The codes are derived here from the sources that
 * can answer them, never from the list under test: the act's own `refusal(...)` calls (a literal, or a constant it names), the reader's refusal
 * codes (`RdfRefusalCode`), the space state's codes (`RdfSpaceState`) and the existence rule's. A code the sources answer and the list lacks
 * fails; so does a code in the list that no source answers, one spelled with a space or capitals, and one the guide's import section omits.
 *
 * Run: node --test testing/standalone/every-code-the-rdf-import-answers-is-listed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const read = (rel) => fs.readFileSync(`${root}/${rel}`, 'utf8').replaceAll('\r\n', '\n');
/** Source with its comments removed (the suite's one stripper), so a code a comment mentions is not an answer. */
const code = (rel) => stripComments(read(rel));

const ACT = 'server/src/spaces/rdf-import-act.ts';
const act = code(ACT);
const consts = (src) => Object.fromEntries([...src.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
const all = { ...consts(act), ...consts(code('server/src/rdf/rdf-space-state.ts')), ...consts(code('server/src/spaces/rdf-settle.ts')) };

/** What a `refusal(HTTP.X, <code>, ...)` call or a `code: <code>` of a refusal names, in the act. */
function answeredByTheAct() {
  const found = new Set();
  for (const m of act.matchAll(/\brefusal\(\s*[^,()]+,\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*)(?=\s*,)|([a-z][\w.]*(?:\([^)]*\))?))/g)) {
    if (m[1]) found.add(m[1]);
    else if (m[2]) { assert.ok(all[m[2]], `the constant ${m[2]} a refusal names is a string constant`); found.add(all[m[2]]); }
  }
  // An act that ends for good (`gone(status, code, why)`) is answered by that status and code from its report.
  for (const m of act.matchAll(/\bgone\(\s*[^,()]+,\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*)(?=\s*,))/g)) {
    if (m[1]) found.add(m[1]);
    else if (m[2]) { assert.ok(all[m[2]], `the constant ${m[2]} an ended act names is a string constant`); found.add(all[m[2]]); }
  }
  return found;
}

function readerCodes() {
  const union = code('server/src/rdf/parse.ts').match(/export type RdfRefusalCode =([^;]+);/)?.[1] ?? '';
  return new Set([...union.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
}

function spaceStateCodes() {
  const src = code('server/src/rdf/rdf-space-state.ts');
  const union = src.match(/code: (typeof \w+(?: \| typeof \w+)+);/)?.[1] ?? '';
  return new Set([...union.matchAll(/typeof ([A-Z_]+)/g)].map(m => all[m[1]]).filter(Boolean));
}

function listed() {
  const body = act.match(/RDF_IMPORT_REFUSAL_CODES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  return new Set([...body.matchAll(/'([^']+)'|([A-Z][A-Z0-9_]*)/g)].map(m => m[1] ?? all[m[2]]).filter(Boolean));
}

function guideCodes() {
  const guide = read('docs/integration-guide/06f-exports.md');
  const section = guide.slice(guide.indexOf('## RDF import'), guide.indexOf('## RDF schema export'));
  return new Set([...section.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+)`/g)].map(m => m[1]));
}

describe('every code the RDF import answers is listed', () => {
  const answered = new Set([...answeredByTheAct(), ...readerCodes(), ...spaceStateCodes(), 'space_not_found']);

  it('the sources answer codes, and the derivation found them (a probe that cannot read answers nothing)', () => {
    for (const c of ['rdf_import_refused', 'rdf_malformed', 'rdf_not_enabled', 'rdf_base_conflict', 'rdf_gzip_invalid', 'space_not_found']) {
      assert.ok(answered.has(c), `${c} is among the codes derived from the sources`);
    }
    assert.ok(answered.size >= 14, `the derivation found ${answered.size} codes`);
  });

  it('every answered code is in RDF_IMPORT_REFUSAL_CODES, and the list names nothing nobody answers', () => {
    const list = listed();
    assert.deepEqual([...answered].filter(c => !list.has(c)).sort(), [], 'answered but not listed');
    assert.deepEqual([...list].filter(c => !answered.has(c)).sort(), [], 'listed but answered by no source');
  });

  it('every code is spelled as a code: lower case, digits and underscores', () => {
    assert.deepEqual([...answered].filter(c => !/^[a-z][a-z0-9_]*$/.test(c)), []);
  });

  it('every answered code is in the guide\'s import section', () => {
    const guide = guideCodes();
    assert.deepEqual([...answered].filter(c => !guide.has(c)).sort(), [], 'answered but not in the guide');
  });

  it('every status the act answers with is one the tool carries, or the storage limit\'s 507, which the tool answers as the fact tool does', () => {
    const table = Object.fromEntries([...act.matchAll(/\b([A-Z_]+): (\d{3})\b/g)].map(m => [m[1], Number(m[2])]));
    const used = new Set([...act.matchAll(/\brefusal\(\s*HTTP\.([A-Z_]+)/g)].map(m => table[m[1]]).filter(Boolean));
    const tool = new Set([...code('server/src/util/errors.ts').match(/TOOL_REFUSAL_STATUSES = Object\.freeze\(\[([^\]]+)\]/)?.[1].matchAll(/\d{3}/g) ?? []].map(m => Number(m[0])));
    assert.ok(tool.size > 5 && used.size > 3, 'both sets were read');
    assert.deepEqual([...used].filter(s => !tool.has(s) && s !== 507).sort(), [], 'a status the tool cannot carry');
  });
});
