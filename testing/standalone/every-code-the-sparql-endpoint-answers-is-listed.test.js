/**
 * Every code the SPARQL endpoint can answer is in its list and in the guide's table (bundle-271, Q-757; design §2 "a gate checks that
 * every code the endpoint answers is listed", r2 R8).
 *
 * ## What it prevents
 *
 * The endpoint answers codes from four places: the SPARQL refusals (`rdf/sparql-refusal.ts`: the check, the bounds, the engine), its own
 * door refusals (`rdf/sparql-answer.ts`: parameters, media types), the member state of a space read alone (`rdf/rdf-space-state.ts`: RDF off,
 * an unsettled base, a term clash) and the export's format chooser and writer it shares for graph answers (`rdf_format_not_acceptable`,
 * `rdf_unwritable`). A code added in any of them and left out of the list (`SPARQL_ENDPOINT_CODES`, which the tool's description names)
 * or out of `docs/integration-guide/04j-sparql-api.md` is a refusal a client meets with no word on what it means.
 *
 * The codes are derived from the sources, never from the list under test: every code constant the refusal module declares, every one the
 * answer module declares or imports by name, and the space state's code union. A code the sources answer and the list lacks fails; so does a
 * listed code no source answers, and one the guide omits.
 *
 * ## Seen red
 *
 * On db66e206d `server/src/rdf/sparql-answer.ts` and the guide page do not exist. Mutation: a new `export const SPARQL_X = 'sparql_x'` in
 * the answer module, left out of the list.
 *
 * Run: node --test testing/standalone/every-code-the-sparql-endpoint-answers-is-listed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const exists = (rel) => fs.existsSync(`${root}/${rel}`);
const read = (rel) => (exists(rel) ? fs.readFileSync(`${root}/${rel}`, 'utf8').replaceAll('\r\n', '\n') : '');
const code = (rel) => stripComments(read(rel));

const REFUSAL = 'server/src/rdf/sparql-refusal.ts';
const ANSWER = 'server/src/rdf/sparql-answer.ts';
const STATE = 'server/src/rdf/rdf-space-state.ts';
const GUIDE = 'docs/integration-guide/04j-sparql-api.md';
const CODE_SHAPE = /^[a-z]+(?:_[a-z0-9]+)+$/;

/** `NAME -> 'value'` of every string constant in `src`. */
const consts = (src) => Object.fromEntries([...src.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
/** The modules `src` imports from, each with the names it takes, resolved against `from` (a repo path). */
function imports(src, from) {
  const out = [];
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    const names = m[1].split(',').map(n => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
    const target = `${from.slice(0, from.lastIndexOf('/'))}/${m[2]}`.replace(/\/\.\//g, '/').replace(/\.js$/, '.ts');
    const parts = [];
    for (const p of target.split('/')) { if (p === '..') parts.pop(); else parts.push(p); }
    out.push({ module: parts.join('/'), names });
  }
  return out;
}

/** The codes the endpoint's sources can answer. */
function derived() {
  const found = new Set(Object.values(consts(code(REFUSAL))).filter(v => CODE_SHAPE.test(v)));
  const answer = code(ANSWER);
  for (const v of Object.values(consts(answer))) if (CODE_SHAPE.test(v) && /^(sparql|rdf)_/.test(v)) found.add(v);
  for (const { module, names } of imports(answer, ANSWER)) {
    const table = consts(code(module));
    for (const n of names) if (table[n] && CODE_SHAPE.test(table[n]) && /^(sparql|rdf)_/.test(table[n])) found.add(table[n]);
  }
  const state = code(STATE);
  const union = state.match(/code: (typeof \w+(?: \| typeof \w+)+);/)?.[1] ?? '';
  const stateConsts = consts(state);
  for (const m of union.matchAll(/typeof ([A-Z_]+)/g)) if (stateConsts[m[1]]) found.add(stateConsts[m[1]]);
  return found;
}

/** The codes `SPARQL_ENDPOINT_CODES` lists, by literal or by the constant it names (resolved through every module the answer reads). */
function listed() {
  const answer = code(ANSWER);
  const table = { ...consts(code(REFUSAL)), ...consts(answer) };
  for (const { module } of imports(answer, ANSWER)) Object.assign(table, consts(code(module)));
  const body = answer.match(/SPARQL_ENDPOINT_CODES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  const out = new Set();
  for (const m of body.matchAll(/'([^']+)'|\.\.\.([A-Z][A-Z0-9_]*)|([A-Z][A-Z0-9_]*)/g)) {
    if (m[1]) out.add(m[1]);
    else if (m[2]) {
      const spread = (code(REFUSAL).match(new RegExp(`${m[2]}[^=]*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`))?.[1] ?? '');
      for (const n of spread.matchAll(/[A-Z][A-Z0-9_]*/g)) if (table[n[0]]) out.add(table[n[0]]);
    } else if (table[m[3]]) out.add(table[m[3]]);
  }
  return out;
}

describe('every code the SPARQL endpoint answers is listed', () => {
  it('the sources answer codes, and the derivation found them', () => {
    assert.ok(exists(ANSWER), `${ANSWER} does not exist`);
    const d = derived();
    for (const c of ['sparql_malformed', 'sparql_busy', 'sparql_too_many_results', 'rdf_not_enabled', 'rdf_format_not_acceptable', 'rdf_unwritable']) {
      assert.ok(d.has(c), `${c} is among the codes derived from the sources`);
    }
  });

  it('SPARQL_ENDPOINT_CODES lists exactly the codes the sources answer', () => {
    const d = derived();
    const l = listed();
    assert.ok(l.size > 0, 'SPARQL_ENDPOINT_CODES lists nothing');
    assert.deepEqual([...d].filter(c => !l.has(c)).sort(), [], 'codes the endpoint answers that its list omits');
    assert.deepEqual([...l].filter(c => !d.has(c)).sort(), [], 'listed codes no source answers');
  });

  it('the guide lists every code', () => {
    assert.ok(exists(GUIDE), `${GUIDE} does not exist`);
    const guide = read(GUIDE);
    const inGuide = new Set([...guide.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map(m => m[1]));
    assert.deepEqual([...listed()].filter(c => !inGuide.has(c)).sort(), [], `codes ${GUIDE} does not name`);
  });
});
