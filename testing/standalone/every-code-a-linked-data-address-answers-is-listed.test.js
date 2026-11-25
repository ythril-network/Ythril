/**
 * Every code a Linked Data address can answer is in `LD_CODES` and in the guide's table (bundle-271, Q-758; design r2 R8 "a gate checks
 * that every code the endpoint and /ld/ answer is listed").
 *
 * ## What it prevents
 *
 * The door (`server/src/api/linked-data.ts`) answers codes it declares and codes it imports by name: the export chooser's, the space
 * state's and the read bounds'. A code it answers and the list or `docs/integration-guide/06f-exports.md` leaves out is a refusal a client
 * meets with no word on what it means. The codes are derived from the door's source, never from the list under test: every code constant
 * it declares, and every name it imports whose value has the code shape. A listed code the door does not answer fails too.
 *
 * ## Seen red
 *
 * Written with the door (the list it reads is the door's own). Mutation: `SPARQL_BUSY` dropped from `LD_CODES` while the door still answers it.
 *
 * Run: node --test testing/standalone/every-code-a-linked-data-address-answers-is-listed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const read = (rel) => fs.readFileSync(`${root}/${rel}`, 'utf8').replaceAll('\r\n', '\n');
const DOOR = 'server/src/api/linked-data.ts';
const GUIDE = 'docs/integration-guide/06f-exports.md';
const CODE_SHAPE = /^[a-z]+(?:_[a-z0-9]+)+$/;

/** `NAME -> 'value'` of every string constant in `src`. */
const consts = (src) => Object.fromEntries([...src.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));

/** Every name the door imports from a module of its own, resolved to its value where that module declares one (re-exports followed once). */
function importedValues(src) {
  const out = {};
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'(\.\.?\/[^']+)'/g)) {
    const file = `server/src/api/${m[2]}`.replace(/\.js$/, '.ts').split('/').reduce((parts, p) => (p === '..' ? parts.slice(0, -1) : p === '.' ? parts : [...parts, p]), []).join('/');
    if (!fs.existsSync(`${root}/${file}`)) continue;
    const target = stripComments(read(file));
    const table = consts(target);
    for (const r of target.matchAll(/export\s*\{([^}]+)\}\s*from\s*'(\.\.?\/[^']+)'/g)) {
      const from = `${file.slice(0, file.lastIndexOf('/'))}/${r[2]}`.replace(/\.js$/, '.ts').split('/').reduce((parts, p) => (p === '..' ? parts.slice(0, -1) : p === '.' ? parts : [...parts, p]), []).join('/');
      if (fs.existsSync(`${root}/${from}`)) Object.assign(table, consts(stripComments(read(from))));
    }
    for (const n of m[1].split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean)) if (table[n]) out[n] = table[n];
  }
  return out;
}

function door() {
  const src = stripComments(read(DOOR));
  const table = { ...importedValues(src), ...consts(src) };
  const answered = new Set(Object.values(table).filter(v => CODE_SHAPE.test(v)));
  const body = src.match(/LD_CODES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  const listed = new Set([...body.matchAll(/'([^']+)'|([A-Z][A-Z0-9_]*)/g)].map(m => m[1] ?? table[m[2]]).filter(Boolean));
  return { answered, listed };
}

describe('every code a linked data address answers is listed', () => {
  it('LD_CODES lists exactly the codes the door can answer', () => {
    const { answered, listed } = door();
    assert.ok(answered.has('ld_not_found') && answered.has('sparql_busy') && answered.has('rdf_format_not_acceptable'), `derivation: ${[...answered].join(', ')}`);
    assert.deepEqual([...answered].filter(c => !listed.has(c)).sort(), [], 'codes the door answers that LD_CODES omits');
    assert.deepEqual([...listed].filter(c => !answered.has(c)).sort(), [], 'listed codes the door does not answer');
  });

  it('the guide\'s record-address section names every code', () => {
    const guide = read(GUIDE);
    const section = guide.slice(guide.indexOf('## Record addresses'));
    const named = new Set([...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map(m => m[1]));
    assert.deepEqual([...door().listed].filter(c => !named.has(c)).sort(), [], `codes ${GUIDE} does not name under "Record addresses"`);
  });
});
