/**
 * Every code the schema-from-RDF door can answer is in its refusal list and in the guide's table (06f, "RDF schema import"; bundle-270, Q-754, design revision 2
 * "Refusals", the lens sweep's integration gap), derived from the sources as `every-code-the-rdf-import-answers-is-listed.test.js` derives the
 * data import's.
 *
 * ## What it prevents
 *
 * A list written by hand beside the answers drifts from them: the data import's list lacked nine codes its doors answered. The codes are derived
 * here from what can answer them, never from the list under test: the `refusal(...)` calls of the door's act (`spaces/schema-rdf-import-act.ts`,
 * a literal or a constant it names) and of the RDF document front half it shares (`rdf/rdf-document.ts`), the reader's refusal codes
 * (`RdfRefusalCode`), the space state's codes (`RdfSpaceState`) and the space write gate's code for an RDF import's hold. A code answered and not
 * listed fails; so does a listed code nobody answers, one not spelled as a code, one missing from the guide's section, and a status the tool
 * cannot carry other than 412, which the tool answers as an error result naming its code.
 *
 * Run: node --test testing/standalone/every-code-the-schema-rdf-import-answers-is-listed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const read = (rel) => (fs.existsSync(`${root}/${rel}`) ? fs.readFileSync(`${root}/${rel}`, 'utf8').replaceAll('\r\n', '\n') : '');
const code = (rel) => stripComments(read(rel));

const ACT = 'server/src/spaces/schema-rdf-import-act.ts';
const DOCUMENT = 'server/src/rdf/rdf-document.ts';
/** The guide's section of the door (beside the schema export; 06a is at its line ceiling), read up to the next section. */
const GUIDE = 'docs/integration-guide/06f-exports.md';
const GUIDE_SECTION = '## RDF schema import';
const actSrc = code(ACT);
const act = `${actSrc}\n${code(DOCUMENT)}`;
const consts = (src) => Object.fromEntries([...src.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
const all = { ...consts(act), ...consts(code('server/src/rdf/rdf-space-state.ts')), ...consts(code('server/src/spaces/rdf-settle.ts')) };

/** What a `refusal(HTTP.X, <code>, ...)` call names in `src`. */
function answeredBy(src) {
  const found = new Set();
  for (const m of src.matchAll(/\brefusal\(\s*[^,()]+,\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*)(?=\s*,))/g)) {
    if (m[1]) found.add(m[1]);
    else { assert.ok(all[m[2]], `the constant ${m[2]} a refusal names is a string constant`); found.add(all[m[2]]); }
  }
  return found;
}

const readerCodes = () => new Set([...(code('server/src/rdf/parse.ts').match(/export type RdfRefusalCode =([^;]+);/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
function spaceStateCodes() {
  const union = code('server/src/rdf/rdf-space-state.ts').match(/code: (typeof \w+(?: \| typeof \w+)+);/)?.[1] ?? '';
  return new Set([...union.matchAll(/typeof ([A-Z_]+)/g)].map(m => all[m[1]]).filter(Boolean));
}
/** The code an RDF import's hold is answered with, read from the act kinds' table (`writeRefusalCode`). */
function holdCode() {
  return code('server/src/config/types-space-acts.ts').match(/'rdf-import':[\s\S]*?writeRefusalCode:\s*'([a-z_]+)'/)?.[1];
}
function listed() {
  const body = actSrc.match(/SCHEMA_RDF_IMPORT_REFUSAL_CODES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  return new Set([...body.matchAll(/'([^']+)'|([A-Z][A-Z0-9_]*)/g)].map(m => m[1] ?? all[m[2]]).filter(Boolean));
}
function guideCodes() {
  const guide = read(GUIDE);
  const start = guide.indexOf(`${GUIDE_SECTION}\n`);
  if (start < 0) return new Set();
  const next = guide.indexOf('\n## ', start + 1);
  const section = guide.slice(start, next < 0 ? undefined : next);
  return new Set([...section.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+)`/g)].map(m => m[1]));
}

describe('every code the schema-from-RDF door answers is listed', () => {
  const answered = new Set([...answeredBy(act), ...readerCodes(), ...spaceStateCodes(), 'space_not_found', holdCode()].filter(Boolean));

  it('the act exists and answers its own codes (a source not read answers nothing)', () => {
    assert.ok(actSrc.length > 0, `${ACT} does not exist`);
    const own = answeredBy(actSrc);
    for (const c of ['schema_rdf_bad_param', 'schema_rdf_rung', 'schema_rdf_networked', 'schema_rdf_not_empty', 'schema_rdf_busy', 'schema_rdf_changed', 'schema_rdf_refused']) {
      assert.ok(own.has(c), `${c} is answered by ${ACT}`);
    }
    assert.equal(holdCode(), 'space_being_rdf_imported', 'the hold\'s code is read from the act kinds\' table');
    for (const c of ['rdf_import_upload_stalled', 'rdf_import_upload_too_slow', 'rdf_import_upload_cooldown']) {
      assert.ok(answered.has(c), `${c} (the upload's pace, Q-953) is among the codes derived from the sources`);
    }
  });

  it('every answered code is in SCHEMA_RDF_IMPORT_REFUSAL_CODES, and the list names nothing nobody answers', () => {
    const list = listed();
    assert.ok(list.size > 0, 'SCHEMA_RDF_IMPORT_REFUSAL_CODES is not in the act');
    assert.deepEqual([...answered].filter(c => !list.has(c)).sort(), [], 'answered but not listed');
    assert.deepEqual([...list].filter(c => !answered.has(c)).sort(), [], 'listed but answered by no source');
  });

  it('every code is spelled as a code: lower case, digits and underscores', () => {
    assert.ok(answeredBy(actSrc).size > 0, `${ACT} answers no code: nothing was read to judge`);
    assert.deepEqual([...answered].filter(c => !/^[a-z][a-z0-9_]*$/.test(c)), []);
  });

  it('every answered code is in the guide\'s "RDF schema import" section', () => {
    const guide = guideCodes();
    assert.ok(guide.size > 0, `${GUIDE} has no "${GUIDE_SECTION}" section with codes`);
    assert.deepEqual([...answered].filter(c => !guide.has(c)).sort(), [], 'answered but not in the guide');
  });

  it('every status the act answers with is one the tool carries as a structured refusal (412 included: Q-754 R4)', () => {
    const table = Object.fromEntries([...act.matchAll(/\b([A-Z_]+): (\d{3})\b/g)].map(m => [m[1], Number(m[2])]));
    const used = new Set([...act.matchAll(/\brefusal\(\s*HTTP\.([A-Z_]+)/g)].map(m => table[m[1]]).filter(Boolean));
    // The statuses of an upload's pace (408, 429) are the one builder's (`util/upload-pace-refusal.ts`, lens finding D1), not a `refusal(HTTP.X` call's.
    for (const m of code('server/src/util/upload-pace-refusal.ts').matchAll(/\b[A-Z_]+: (\d{3})\b/g)) used.add(Number(m[1]));
    const tool = new Set([...code('server/src/util/errors.ts').match(/TOOL_REFUSAL_STATUSES = Object\.freeze\(\[([^\]]+)\]/)?.[1].matchAll(/\d{3}/g) ?? []].map(m => Number(m[0])));
    assert.ok(tool.size > 5 && used.size > 3, `both sets were read (${tool.size}, ${used.size})`);
    // 408 is an upload's pace (Q-953): the tool takes its document inline, as one chunk already in hand, so no pace refusal reaches it.
    assert.ok(used.has(408), 'the pace refusals are answered 408 (the owner\'s choice, RFC 9110 section 15.5.9)');
    assert.deepEqual([...used].filter(s => !tool.has(s) && s !== 408).sort(), [], 'a status the tool cannot carry');
  });
});
