/**
 * A translation that carries markup is RENDERED as markup, not printed as tags.
 *
 * ## What was wrong
 *
 * `mediaProcessing.embedding.prefixSchemeHint` marks the mode name with `<b>` in all three languages, and
 * the template interpolated it. So the Models card read, in full:
 *
 *     …are marked differently. <b>Auto</b> reproduces what this instance did before this setting existed…
 *
 * Nothing failed. No test could see it either: specs echo translation KEYS rather than English, so the
 * tags do not exist in a unit render — the first attempt at a gate here passed against the broken code.
 * It was found by **looking at a screenshot** of the card, and a sweep for other instances immediately
 * turned up a second one on the reranker card.
 *
 * ## What this gate does
 *
 * Enumerates the keys whose value contains real markup out of `en.json`, finds every use of each in the
 * client, and requires the binding to be `[innerHTML]`. Enumerated rather than listed: this is the second
 * instance of one defect, and the way to stop finding a third by eye is to derive the set from the
 * translations themselves.
 *
 * Run: node --test testing/standalone/i18n-markup-rendering.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Real HTML elements only — a whitelist, deliberately, not "anything in angle brackets".
 *
 * Two translations use angle brackets as PLACEHOLDER notation and must stay interpolated:
 * `schemaLib.description` explains `$ref: "library:<name>"`, and `schemaLib.exportSpace.namePrefixHint`
 * shows `<prefix>-<knowledgeType>-<typeName>`. Rendering those as HTML would not merely be wrong, it would
 * delete the part the sentence is about — the browser would drop them as unknown elements. The exemption is
 * a claim about what the text IS, which is why the discrimination lives in this list rather than in a
 * per-key allowlist someone would have to maintain.
 */
const MARKUP = /<\/?(b|strong|i|em|code|br|a|span|ul|ol|li|p|div|h[1-6])(\s[^>]*)?>/i;

const LOCALES = ['en', 'de', 'pl'];

/** Every client source that could reference a key. Specs excluded: they render keys, never values. */
function clientSources(dir = 'client/src', out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) clientSources(p, out);
    else if (/\.(ts|html)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const translations = Object.fromEntries(
  LOCALES.map(l => [l, JSON.parse(readFileSync(`client/public/assets/i18n/${l}.json`, 'utf8'))]),
);
const markupKeys = Object.entries(translations['en'])
  .filter(([, v]) => typeof v === 'string' && MARKUP.test(v))
  .map(([k]) => k);

const files = clientSources();

describe('translations that contain markup', () => {
  it('the enumeration found something — an empty set would pass every assertion below', () => {
    assert.ok(markupKeys.length >= 5,
      `expected several markup-bearing keys, enumerated ${markupKeys.length}: ${markupKeys}`);
  });

  it('is rendered with [innerHTML] at every use, never interpolated', () => {
    const offenders = [];
    for (const key of markupKeys) {
      for (const file of files) {
        const rel = file.split(path.sep).join('/');
        readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (!line.includes(key)) return;
          if (line.includes('innerHTML')) return;
          offenders.push(`${rel}:${i + 1} interpolates ${key}`);
        });
      }
    }
    assert.deepEqual(offenders, [],
      'these print their tags as text — bind with [innerHTML]:\n' + offenders.join('\n'));
  });

  it('every locale agrees about carrying markup, so no language shows tags the others hide', () => {
    // The defect is per-string, and a translator who dropped the `<b>` (or added one) makes it appear in
    // one language only — the hardest version of this to notice, since nobody reviews all three.
    const disagreements = [];
    for (const key of markupKeys) {
      for (const l of LOCALES.slice(1)) {
        const v = translations[l][key];
        if (v === undefined) continue;  // a missing key is the i18n coverage gate's job, not this one
        if (!MARKUP.test(v)) disagreements.push(`${l}: ${key} lost its markup`);
      }
    }
    assert.deepEqual(disagreements, [], disagreements.join('\n'));
  });

  it('does not mistake placeholder notation for markup', () => {
    // Guards the discrimination itself: these two are prose ABOUT angle brackets and must keep being
    // interpolated. If the pattern ever widens to catch them, the gate would demand a change that deletes
    // the text it is describing.
    for (const key of ['schemaLib.description', 'schemaLib.exportSpace.namePrefixHint']) {
      const v = translations['en'][key];
      if (v === undefined) continue;   // renamed or removed — not this test's business
      assert.ok(/<[a-z]/i.test(v), `${key} should still be the angle-bracket case this pins`);
      assert.ok(!markupKeys.includes(key), `${key} is placeholder notation, not markup`);
    }
  });
});

/**
 * ## The tags an innerHTML-bound value carries are en's, exactly, in every locale (Q-573, security lens S1)
 *
 * A value bound with `[innerHTML]` is markup, so what a translator writes in it is code the page renders. The three-way agreement above
 * is only "does it still carry SOME tag"; a German or Polish rewrite of `mediaProcessing.embedding.reindexWarning` that adds an `<a>`, an
 * `<img>` or one more `<b>`, or drops a closing tag, passes it and changes what the page renders. Angular's sanitizer strips what is
 * dangerous, not what is unintended. The rule is the plain one: the multiset of tags in the de and pl value equals en's.
 *
 * Derived, never listed: the keys are those a source line binds next to `innerHTML`, read out of the sources, and the tag set is read
 * out of the values. A floor on both, so a changed binding spelling cannot pass by finding none.
 */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;

/** The tags of a value as a sorted, lower-cased list: `<b>` and `</b>` are two entries, and attributes are kept (an added `href` is an added behaviour). */
const tagSet = value => (String(value).match(TAG) ?? []).map(t => t.replace(/\s+/g, ' ').toLowerCase()).sort();

/** Every key a client source line binds next to `innerHTML` that en defines. */
function innerHtmlBoundKeys() {
  const found = new Set();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.includes('innerHTML')) continue;
      for (const m of line.matchAll(/'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) if (m[1] in translations['en']) found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe('an innerHTML-bound value carries the tags en has, exactly, in every locale', () => {
  const keys = innerHtmlBoundKeys();

  it('finds the innerHTML-bound keys, and most of them carry markup (a floor)', () => {
    assert.ok(keys.length >= 5, `expected several innerHTML-bound keys, found ${keys.length}: ${keys}`);
    assert.ok(keys.filter(k => tagSet(translations['en'][k]).length > 0).length >= 5, 'expected the bound keys to carry en markup');
  });

  it('reads tags the way the rule means: attributes and closing tags count', () => {
    assert.deepEqual(tagSet('a <b>x</b> y'), ['</b>', '<b>']);
    assert.notDeepEqual(tagSet('a <b>x</b>'), tagSet('a <b>x</b> <i>y</i>'));
    assert.notDeepEqual(tagSet('<b>x</b>'), tagSet('<b>x'));
    assert.notDeepEqual(tagSet('<a href="https://a.example">x</a>'), tagSet('<a>x</a>'));
    assert.deepEqual(tagSet('1 < 2 and 3 > 2'), []);
  });

  it('de and pl carry exactly the tags en does in each of them', () => {
    const wrong = [];
    for (const key of keys) {
      const want = tagSet(translations['en'][key]);
      for (const l of LOCALES.slice(1)) {
        const v = translations[l][key];
        if (v === undefined) continue;  // a missing key is the i18n coverage gate's job
        const got = tagSet(v);
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${l}: ${key} has [${got.join(' ')}], en has [${want.join(' ')}]`);
      }
    }
    assert.deepEqual(wrong, [], 'an innerHTML-bound value renders tags en does not have (or lacks ones it has):\n' + wrong.join('\n'));
  });
});
