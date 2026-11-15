/**
 * The stacking levels are ordered, and a dialog a drawer or popup hosts paints above the layer that hosts it (Q-744).
 *
 * ## Why
 *
 * The history dialog opened from the record drawer's Compare (and from the space settings popup's Schema tab) painted UNDER the
 * drawer: its backdrop was `z-index: 100`, the drawer overlay and the popup 200. The host covered the dialog's Close button and
 * its Open records link, so only Escape worked. Nothing failed: each level was a number in a stylesheet of its own.
 *
 * ## The rules
 *
 * - `STACK` orders the levels: a page dialog below a drawer or popup, a hosted dialog above both;
 * - the drawer's and the popup's stylesheets take their level from `STACK`;
 * - walking every component a host renders (the `<app-…>` tags of its template, then theirs), each full-screen layer such a
 *   component paints, as `.dialog-backdrop` or as a `position: fixed` block with a z-index, is above the host's level.
 *   A new dialog hosted in the drawer or popup that keeps the page-level 100 fails here, naming the file.
 *
 * ## Seen red
 *
 * Red on 15ac8af8: `STACK` did not exist; with it in place and the history dialog unchanged, the walk reported
 * `schema-type-history.component.ts` at 100 under the drawer's 200.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STACK } from './stacking';
import { BRAIN_DRAWER_STYLES } from '../pages/brain/brain-form.styles';
import { SPACE_DIALOG_STYLES } from '../pages/settings/space-dialog.styles';
import { stripComments } from '../testing/strip-comments';

const APP = resolve(__dirname, '..');

function componentFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) componentFiles(p, out);
    else if (e.name.endsWith('.component.ts')) out.push(p);
  }
  return out;
}

const SOURCES = new Map(componentFiles(APP).map(f => [f, stripComments(readFileSync(f, 'utf8'))]));
const BY_SELECTOR = new Map<string, string>();
for (const [f, src] of SOURCES) { const m = /selector:\s*'(app-[\w-]+)'/.exec(src); if (m) BY_SELECTOR.set(m[1]!, f); }

/** Every component file a host renders, the host first: its template's `<app-…>` tags, then theirs. */
function rendered(host: string): string[] {
  const seen = new Set([host]);
  const queue = [host];
  while (queue.length) {
    for (const m of SOURCES.get(queue.shift()!)!.matchAll(/<(app-[\w-]+)/g)) {
      const f = BY_SELECTOR.get(m[1]!);
      if (f && !seen.has(f)) { seen.add(f); queue.push(f); }
    }
  }
  return [...seen];
}

const level = (v: string): number => {
  const ref = /^\$\{STACK\.(\w+)\}$/.exec(v.trim());
  return ref ? (STACK as Record<string, number>)[ref[1]!]! : Number(v);
};
const Z = String.raw`(\$\{STACK\.\w+\}|\d+)`;

/** The levels of the full-screen layers one component file paints: its backdrop (its own rule, else the shared 100) and every fixed block. */
function layersOf(src: string): number[] {
  const out: number[] = [];
  const own = [...src.matchAll(new RegExp(String.raw`\.dialog-backdrop\s*\{[^}]*?z-index:\s*${Z}`, 'g'))];
  if (own.length) out.push(level(own[own.length - 1]![1]!));
  else if (src.includes('dialog-backdrop')) out.push(STACK.dialog);
  for (const m of src.matchAll(new RegExp(String.raw`position:\s*fixed[^}"'\x60]*?z-index:\s*${Z}`, 'g'))) out.push(level(m[1]!));
  return out;
}

describe('the stacking levels', () => {
  it('a hosted dialog is above the drawer and the popup, a page dialog below them', () => {
    expect(STACK.hostedDialog).toBeGreaterThan(STACK.drawer);
    expect(STACK.hostedDialog).toBeGreaterThan(STACK.popup);
    expect(STACK.dialog).toBeLessThan(STACK.drawer);
    expect(STACK.dialog).toBeLessThan(STACK.popup);
  });

  it('the drawer and the popup take their level from the shared place', () => {
    expect(BRAIN_DRAWER_STYLES).toMatch(new RegExp(String.raw`\.drawer-overlay\s*\{[^}]*z-index:\s*${STACK.drawer};`));
    expect(SPACE_DIALOG_STYLES).toMatch(new RegExp(String.raw`\.sp-backdrop\s*\{[^}]*z-index:\s*${STACK.popup};`));
  });

  const HOSTS: [string, string, number][] = [
    ['the record drawer', 'pages/brain/record-drawer.component.ts', STACK.drawer],
    ['the space settings popup', 'pages/settings/space-settings-popup.component.ts', STACK.popup],
  ];

  for (const [name, file, hostLevel] of HOSTS) {
    it(`every layer a component hosted in ${name} paints is above it`, () => {
      const hosted = rendered(join(APP, file)).slice(1);
      expect(hosted.length, 'the walk found no hosted component').toBeGreaterThan(5);
      const under = hosted.flatMap(f => layersOf(SOURCES.get(f)!).filter(z => z <= hostLevel).map(z => `${f.slice(APP.length + 1)}: ${z}`));
      expect(under, `layers at or below the host's ${hostLevel}`).toEqual([]);
      // A floor: the history dialog is hosted in both, so a walk that no longer reaches it checks nothing.
      expect(hosted.some(f => f.endsWith('schema-type-history.component.ts'))).toBe(true);
    });
  }
});
