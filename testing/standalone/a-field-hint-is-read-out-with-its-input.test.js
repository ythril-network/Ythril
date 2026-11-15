/**
 * A field hint is read out with the input it explains.
 *
 * ## The rule
 *
 * Every element of class `field-hint` in a client template carries an id that some control in the same template names
 * in its `aria-describedby` (or `aria-errormessage`). A screen reader announces a control's label and its described-by
 * text when the control takes focus; a hint that is only placed beside the input is never announced, so a user who
 * cannot see the page never hears what the field expects ("paste the token you were given") or what went wrong.
 *
 * ## What bought it
 *
 * Q-792's accessibility probe (tools/flow-checks/check-i-a11y-form-label-association.mjs), on its first real run against
 * the test stack, found the login page's token hint beside `<input id="token">` with no id and no `aria-describedby`.
 * The same shape sat in the setup page twice. A lint finds it without a running app.
 *
 * ## Scope
 *
 * Derived, never listed: every tracked `.ts` and `.html` file under client/src (git ls-files, with a floor), comments
 * stripped, so a commented-out hint neither counts nor hides one. A template that holds no `field-hint` is not read
 * further.
 *
 * Run: node --test testing/standalone/a-field-hint-is-read-out-with-its-input.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** Opening tags whose class list holds `field-hint`, with their attribute text. */
function hintTags(code) {
  const out = [];
  for (const m of code.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*\bclass\s*=\s*"[^"]*\bfield-hint\b[^"]*"[^>]*)>/g)) out.push({ tag: m[1], attrs: m[2], at: m.index });
  return out;
}

/** Every id named by an aria-describedby or aria-errormessage in the code, static or bound. */
function describedIds(code) {
  const ids = new Set();
  for (const m of code.matchAll(/\[?(?:attr\.)?aria-(?:describedby|errormessage)\]?\s*=\s*"([^"]*)"/g)) {
    for (const id of m[1].replace(/['`]/g, ' ').split(/\s+/)) if (/^[A-Za-z][\w-]*$/.test(id)) ids.add(id);
  }
  return ids;
}

/** The hints of one source that no control names, as `file: <tag attrs>` lines. */
export function unannouncedHints(file, text) {
  // stripComments removes the JS comments; a template's own HTML comments are removed here.
  const code = stripComments(text).replace(/<!--[\s\S]*?-->/g, '');
  const tags = hintTags(code);
  if (tags.length === 0) return [];
  const named = describedIds(code);
  return tags
    .filter(({ attrs }) => {
      const id = /\bid\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
      return !(id && named.has(id));
    })
    .map(({ tag, attrs }) => `${file}: <${tag}${attrs.replace(/\s+/g, ' ')}>`);
}

function templates() {
  return readTrackedSources('client/src', { ext: ['.ts', '.html'], floor: 100 })
    .filter(({ file }) => !/\.spec\.ts$/.test(file));
}

describe('a field hint is read out with its input', () => {
  it('the sweep reads the client templates and finds hints to judge, so an empty scan cannot pass', () => {
    const withHints = templates().filter(({ text }) => hintTags(stripComments(text)).length > 0);
    assert.ok(withHints.length >= 2, `only ${withHints.length} template(s) hold a field-hint: the sweep is broken, not the client`);
  });

  it('every field-hint carries an id a control names in aria-describedby', () => {
    const bad = templates().flatMap(({ file, text }) => unannouncedHints(file.replace(/\\/g, '/'), text));
    assert.deepEqual(bad, [],
      'these hints are placed beside an input but never read out with it:\n  ' + bad.join('\n  ')
      + '\n\n      Give the hint an id and name it in the input\'s aria-describedby (an error hint may use aria-errormessage),'
      + '\n      so a screen reader announces it when the input takes focus.');
  });

  it('a planted copy of the login hint as it was fails, and the same hint described by its input passes', () => {
    const before = '<input id="token" type="password" />\n<span class="field-hint">\n  {{ \'login.tokenHint\' | transloco }}\n</span>';
    assert.equal(unannouncedHints('planted.ts', before).length, 1);
    const after = '<input id="token" aria-describedby="token-hint" />\n<span id="token-hint" class="field-hint">x</span>';
    assert.deepEqual(unannouncedHints('planted.ts', after), []);
    const commented = '<!-- <span class="field-hint">x</span> -->';
    assert.deepEqual(unannouncedHints('planted.ts', commented), [], 'a commented-out hint is not a hint');
  });
});
