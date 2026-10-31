/**
 * Every caller of `derivedFieldsForWrite` applies BOTH halves of what it returns: the `set` and the `unset` (Q-656, bundle-211).
 *
 * ## What it prevents
 *
 * `derivedFieldsForWrite` answers one question with two halves: the fields to write beside the content and the fields to REMOVE
 * (a suppressed record's old vector). A caller that destructures only `set` writes the text and leaves the vector standing beside
 * it, which is the pair the repair sweep then cannot see (text current, vector present) and the embed job calls `unchanged`:
 * `sync/embed-arrived-files.ts` wrote a suppressed file's new `matchedText` and dropped the `unset`, so a vector that arrived
 * after `dropFileVectors` ran stayed in meaning-ranked search for good. Reading `.set` alone is the shape every such slip takes.
 *
 * ## What is asked, with the comments stripped
 *
 * - the detector flags each planted call that uses only the `set` half (a destructure without `unset`, a result variable whose
 *   `.unset` is never read, an inline `(await derivedFieldsForWrite(...)).set`) and passes a call that applies both, or an insert;
 * - every call in `server/src` outside the module itself either reads the result's `unset` in the same top-level declaration, or
 *   passes `onto: 'insert'` as a literal (a new record holds nothing to remove), or is the ONE named exemption below;
 * - the exemption's reason holds: the arrival writer's replace carries no vector field from the stored copy.
 *
 * Run: node --test testing/standalone/a-derived-write-applies-both-halves.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const HOME = 'server/src/brain/derived-text-on-write.ts';

/**
 * The one call that may read `.set` alone: `sync/arrivals.ts`'s replace (`suppressedTexts`). Its `$replaceWith` keeps only the
 * fields it names (`carriedFields`) and a suppressed arrival keeps no vector field, so there is nothing for an `unset` to remove.
 */
const EXEMPT = { file: 'server/src/sync/arrivals.ts', declaration: 'suppressedTexts', reason: 'a $replaceWith keeps only the fields it names, and none is a vector field' };

/** The calls of `src` (comments already stripped) that apply only one half, as `{ at, why }`. */
function callsMissingTheirUnset(src) {
  const flagged = [];
  const starts = [...src.matchAll(/^(?:export |async |function |const |let |class |type |interface )/gm)].map(m => m.index);
  for (const m of src.matchAll(/derivedFieldsForWrite\s*\(/g)) {
    const before = src.slice(0, m.index);
    if (/function\s+$/.test(before) || /import\s*\{[^}]*$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const call = balancedFrom(src, open, 'derivedFieldsForWrite call');
    if (/\bonto\s*:\s*'insert'/.test(call)) continue;
    const from = Math.max(0, ...starts.filter(s => s <= m.index));
    const to = starts.find(s => s > m.index) ?? src.length;
    const declaration = src.slice(from, to);
    const bound = before.match(/(?:const|let)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s*)?$/);
    const after = src.slice(open + call.length);
    let applied;
    if (bound && bound[1].startsWith('{')) applied = /\bunset\b/.test(bound[1]);
    else if (bound) applied = new RegExp(`\\b${bound[1].replace(/\$/g, '\\$')}\\.unset\\b`).test(declaration);
    else applied = /^\s*\)\s*\.unset\b/.test(after);
    if (!applied) flagged.push({ at: m.index, declaration: declaration.match(/(?:function\s+|const\s+)([\w$]+)/)?.[1] ?? '?' });
  }
  return flagged;
}

describe('a derived write is applied in both halves', () => {
  it('the detector flags each planted set-only call and passes the ones that apply both', () => {
    const plant = (body) => `async function f() {\n${body}\n}\n`;
    assert.equal(callsMissingTheirUnset(plant("const { set } = await derivedFieldsForWrite({ text: () => t, vector: null, suppressed: true, onto: 'stored' });")).length, 1);
    assert.equal(callsMissingTheirUnset(plant("const d = await derivedFieldsForWrite({ text, vector, suppressed, onto: 'stored' });\nuse(d.set);")).length, 1);
    assert.equal(callsMissingTheirUnset(plant("out.set(id, (await derivedFieldsForWrite({ text, vector: null, suppressed: true, onto: 'stored' })).set);")).length, 1);
    assert.equal(callsMissingTheirUnset(plant("const { set, unset } = await derivedFieldsForWrite({ text, vector: null, suppressed: true, onto: 'stored' });")).length, 0);
    assert.equal(callsMissingTheirUnset(plant("const d = await derivedFieldsForWrite({ text, vector, suppressed, onto: 'stored' });\nuse(d.set, d.unset);")).length, 0);
    assert.equal(callsMissingTheirUnset(plant("const d = (await derivedFieldsForWrite({ text, vector, suppressed, onto: 'insert' })).set;")).length, 0);
    assert.equal(callsMissingTheirUnset(plant("return (await derivedFieldsForWrite({ text, vector, suppressed, onto: 'stored' })).unset;")).length, 0);
    // An import and the definition are not calls.
    assert.equal(callsMissingTheirUnset("import { derivedFieldsForWrite } from './x.js';\nexport async function derivedFieldsForWrite(input) {}\n").length, 0);
  });

  it('every caller in server/src reads the unset half, inserts, or is the one named exemption', () => {
    const offenders = [];
    let calls = 0;
    for (const f of trackedSources('server/src', { floor: 200 })) {
      if (f === HOME) continue;
      const src = stripComments(readFileSync(f, 'utf8'));
      if (!src.includes('derivedFieldsForWrite')) continue;
      calls += [...src.matchAll(/derivedFieldsForWrite\s*\(/g)].length;
      for (const { declaration } of callsMissingTheirUnset(src)) {
        if (f === EXEMPT.file && declaration === EXEMPT.declaration) continue;
        offenders.push(`${f}: ${declaration}`);
      }
    }
    assert.ok(calls >= 7, `only ${calls} derivedFieldsForWrite call(s) found: the scan is broken, re-derive`);
    assert.deepEqual(offenders, [], 'a caller writes the `set` of derivedFieldsForWrite and drops its `unset`: the old vector stays beside the new text');
  });

  it(`the named exemption still holds: ${EXEMPT.reason}`, async () => {
    const src = stripComments(readFileSync(EXEMPT.file, 'utf8'));
    const at = src.indexOf(`function ${EXEMPT.declaration}(`);
    assert.ok(at >= 0, `${EXEMPT.file} no longer declares ${EXEMPT.declaration}: drop the exemption or re-point it`);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.match(body, /derivedFieldsForWrite\s*\(/, `${EXEMPT.declaration} no longer calls derivedFieldsForWrite: drop the exemption`);
    const { carriedFields, UNSET_VECTOR } = await import('../../server/dist/sync/local-only-fields.js');
    const carried = carriedFields({ restore: false, suppressed: true });
    const overlap = Object.keys(UNSET_VECTOR).filter(k => carried.has(k));
    assert.deepEqual(overlap, [], 'a suppressed arrival now carries a vector field from the stored copy: the replace needs the unset half');
  });
});
