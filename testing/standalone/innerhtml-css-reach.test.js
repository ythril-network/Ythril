/**
 * CSS written for `[innerHTML]` content must actually be able to reach it.
 *
 * ## The defect this exists for
 *
 * Angular's emulated encapsulation stamps `_ngcontent-*` on elements the TEMPLATE creates, and compiles
 * `.doc p` into `.doc p[_ngcontent-xyz]`. Nodes inserted through `[innerHTML]` never carry that attribute
 * — so **every descendant rule silently matches nothing**. No error, no warning, no console message. The
 * styles sit right there in the file, they look applied, and they are dead.
 *
 * Two surfaces had been that way since each shipped:
 *
 *   - `help.component.ts` — the in-product guides, 19 rules
 *   - `file-manager.component.ts` — the Markdown file preview, 13 rules
 *
 * Nobody had ever seen the shipped documentation rendered with its own styling. Measured on a booted
 * instance, before → after: `pre` background `transparent` → `rgb(28,33,40)`, `blockquote` border-left
 * `0px` → `3px`, paragraph `max-width` `none` → `689px`.
 *
 * ## Why a declared map rather than a heuristic
 *
 * The first version guessed: it flagged any descendant rule ending in a markdown-ish tag inside a
 * component that renders `[innerHTML]`. That reported `.xlsx-grid th` and `.detail-desc h4` — both
 * template-built, properly encapsulated, entirely fine. A gate whose findings need triage is a gate
 * people learn to skip.
 *
 * So the container class of each rendered surface is **declared** here, and a separate check asserts the
 * map names every component that uses `[innerHTML]`. Adding a third surface fails the build until it is
 * classified, which is the opposite of how the original defect survived — there, the absence of any
 * declaration was the default.
 *
 * Run: node --test testing/standalone/innerhtml-css-reach.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const ROOT = 'client/src/app';

/**
 * Where `[innerHTML]` output lands, per component: the CSS class its rules are rooted at, or `null` when
 * the component renders innerHTML but styles none of its content.
 */
const RENDERED_SURFACES = new Map([
  ['client/src/app/pages/settings/help.component.ts', '.doc'],
  // Moved out of `file-manager.component.ts` when the preview became its own component (G-3). The page no
  // longer renders innerHTML at all, so listing it here would make the map claim a surface that is gone.
  ['client/src/app/pages/files/file-preview.component.ts', '.md-rendered'],
  // Inline SVG built from a path string; the component styles the host, never the injected markup.
  ['client/src/app/shared/ph-icon.component.ts', null],
  // Short highlighted fragments injected into a label; no descendant rules target them.
  ['client/src/app/pages/settings/media-processing/media-processing-page.component.ts', null],
  ['client/src/app/pages/settings/media-processing/models-tab.component.ts', null],
  ['client/src/app/pages/settings/space-schema-tab.component.ts', null],
  // A change note's markdown body, sanitised; only its first and last child margins are styled.
  ['client/src/app/pages/settings/network-change-notes.component.ts', '.md'],
]);

function sources(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

/**
 * A component's CSS, comments stripped — prose about a selector is not a rule.
 *
 * **It resolves an imported const, not just an inline block**, and that gap was found by the extraction that
 * needed it: this file read `styles: [\`…\`]` only, so a component whose styles live in a `.styles.ts` module
 * returned the empty string and every rule below passed by examining nothing. The repo's own convention is to
 * move styles out as a file grows, so the gate was set to go quiet on exactly the components most likely to
 * have been recently touched.
 */
function stylesBlock(src, file) {
  const inline = src.indexOf('styles: [`');
  if (inline >= 0) {
    const j = src.indexOf('`],', inline);
    const raw = j < 0 ? '' : src.slice(inline + 'styles: [`'.length, j);
    return raw.replace(/\/\*[\s\S]*?\*\//g, '');
  }

  // `styles: [SOME_CONST]` — follow the import to the module that declares it and read the template literal.
  const named = src.match(/styles:\s*\[\s*([A-Z][A-Z0-9_]*)\s*\]/);
  if (!named) return '';
  /*
   * Found by string search rather than a built regex. The first version interpolated the const name into a
   * `new RegExp(\`import\s*\{…\`)`, and inside a template literal `\s` and `\b` are not escapes — they collapse
   * to `s` and `b`, so the pattern matched nothing and this returned the empty string. Which the gate cannot
   * tell from "this component styles none of its content", so it passed. A mutation run caught it.
   */
  const line = src.split('\n').find(l => l.startsWith('import') && l.includes(named[1]) && l.includes('from'));
  const from = line?.match(/from\s+'([^']+)'/);
  if (!from) return '';
  const dir = file.slice(0, file.lastIndexOf('/'));
  const path = `${dir}/${from[1].replace(/^\.\//, '')}.ts`;
  let mod;
  try { mod = readFileSync(path, 'utf8'); } catch { return ''; }
  const at = mod.indexOf(`${named[1]} = \``);
  if (at < 0) return '';
  const end = mod.indexOf('`;', at);
  const raw = end < 0 ? '' : mod.slice(at + `${named[1]} = \``.length, end);
  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Detect the BINDING, not a mention of it.
 *
 * This used to test the raw file, so any file whose comments discussed `[innerHTML]` was classified as
 * rendering it — and the map then had to list a directive that renders nothing, which would have made the map
 * a lie about the very thing it exists to enumerate. `md-scrollers.directive.ts` tripped it by explaining *why*
 * Angular directives cannot reach `[innerHTML]` content.
 *
 * Comments are stripped first, which is what `stylesBlock` above already does for the same reason: prose about
 * a thing is not the thing. Six gates in this repo have now fired on the comment explaining their own subject.
 */
function rendersInnerHtml(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .includes('[innerHTML]');
}

describe('CSS for [innerHTML] content can reach it', () => {
  const usesInnerHtml = sources().filter(f => rendersInnerHtml(readFileSync(f, 'utf8')));

  it('finds the components that render innerHTML (the check itself works)', () => {
    // A refactor that reduced this to zero would make every assertion below pass by examining nothing.
    assert.ok(usesInnerHtml.length >= 2, `expected components rendering [innerHTML], found ${usesInnerHtml.length}`);
  });

  it('classifies every component that renders innerHTML — no more, no fewer', () => {
    assert.deepEqual([...RENDERED_SURFACES.keys()].sort(), usesInnerHtml.sort(),
      'Every component using [innerHTML] must be declared here — with the CSS class its rules are rooted\n' +
      'at, or `null` when it styles none of the injected content. A component missing from the map is a\n' +
      'surface nobody checked, which is exactly how the guides came to render unstyled.');
  });

  it('every rule rooted at a rendered surface is ::ng-deep', () => {
    const dead = [];
    for (const [file, root] of RENDERED_SURFACES) {
      if (!root) continue;
      const css = stylesBlock(readFileSync(file, 'utf8'), file);
      for (const line of css.split('\n')) {
        const selector = line.split('{')[0];
        if (!selector.includes(root) || selector.includes('::ng-deep')) continue;
        // `.doc { … }` styles the container itself and is correctly encapsulated; only DESCENDANTS break.
        if (new RegExp(`\\${root}\\s+\\S`).test(selector)) dead.push(`  ${file}\n    ${selector.trim()}`);
      }
    }

    assert.deepEqual(dead, [],
      'These rules target content inserted through [innerHTML] from a component using emulated\n' +
      'encapsulation — they compile to `sel[_ngcontent-x]` and match NOTHING. The styles look present\n' +
      'and are dead, with no error anywhere:\n' + dead.join('\n') +
      '\nAdd `::ng-deep` after the container (`.doc ::ng-deep blockquote`), which keeps the rule scoped to\n' +
      'this component\'s subtree while letting it reach content the template did not create.');
  });
});
