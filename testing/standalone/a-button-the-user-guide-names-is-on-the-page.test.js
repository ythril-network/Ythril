/**
 * A button the user guide names by its words is a button the app shows with those words.
 *
 * ## What it prevents
 *
 * The guide told readers to press **Backfill embeddings** on the Danger tab while the button said **Backfill missing
 * embeddings**, and to toggle a **Maintenance mode** button that is labelled **Activate** / **Deactivate** under a
 * **Maintenance Mode** heading (found by the 6.2.0 release's documentation accuracy pass, 2026-10-31). A reader
 * searching the page for the words in the guide finds nothing, and nothing failed.
 *
 * ## The rule
 *
 * Every `**X** button` in `docs/userguide/` names a string the English client shows: a value of
 * `client/public/assets/i18n/en.json`. An icon button has no words to match; it is written as its symbol or a
 * description and listed in ICON_BUTTONS with what it is, so a new icon button is a decision, not a silent pass.
 * The English file is the one read because the guide is written in English; the other languages are held to
 * English's keys by the client's own key-parity checks.
 *
 * Run: node --test testing/standalone/a-button-the-user-guide-names-is-on-the-page.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';

/** Buttons the guide names by symbol or description because they carry an icon, not words. */
const ICON_BUTTONS = new Map([
  ['✕', 'the close icon of a panel'],
  ['⊙ view-details', 'the details icon on a record row'],
  ['full-screen', 'the full-screen icon of the file viewer'],
]);

/** Every string the English client shows: the leaf values of en.json, trimmed. */
function uiStrings() {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') out.add(v.trim());
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(readFileSync(join(REPO_ROOT, 'client/public/assets/i18n/en.json'), 'utf8')));
  return out;
}

/** Every `**X** button` of a page, with its line. Built per call, so a shared global regex cannot skip a match. */
function namedButtons(file, text) {
  const out = [];
  for (const m of text.matchAll(/\*\*([^*\n]{1,80})\*\*\s+button/g)) {
    out.push({ file, line: text.slice(0, m.index).split('\n').length, label: m[1].trim() });
  }
  return out;
}

describe('a button the user guide names is on the page', () => {
  const pages = readTrackedSources('docs/userguide', { ext: ['.md'], floor: 5 });
  const strings = uiStrings();
  const named = pages.flatMap(p => namedButtons(p.file, p.text));

  it('reads buttons at all (a broken pattern would pass every page)', () => {
    assert.ok(named.length >= 10, `only ${named.length} named button(s) found in docs/userguide`);
  });

  it('every named button is a string the English client shows, or a listed icon button', () => {
    const missing = named.filter(b => !strings.has(b.label) && !ICON_BUTTONS.has(b.label));
    assert.deepEqual(missing.map(b => `${b.file}:${b.line} **${b.label}** button`), [],
      'the guide names a button the app does not show with these words: write the label as en.json has it, '
      + 'or, for an icon button, add it to ICON_BUTTONS with what it is');
  });

  it('every listed icon button is still named by the guide (a stale entry exempts nothing and hides a removal)', () => {
    const used = new Set(named.map(b => b.label));
    assert.deepEqual([...ICON_BUTTONS.keys()].filter(k => !used.has(k)), []);
  });

  it('the check fails on a planted label the app does not show', () => {
    const planted = namedButtons('planted.md', 'Press the **Backfill embeddings** button.');
    assert.equal(planted.filter(b => !strings.has(b.label) && !ICON_BUTTONS.has(b.label)).length, 1);
  });
});
