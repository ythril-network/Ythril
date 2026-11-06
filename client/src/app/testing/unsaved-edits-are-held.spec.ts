/**
 * A page never loses an edit on navigation without asking first (Q-701).
 *
 * ## The defect it prevents
 *
 * `docs/ui-primitives.md` asks for "an unsaved-changes guard on every editable form", and nothing checked it. At 139c6938 only the
 * spaces route registered a leave guard: media processing asked on its own tab switch and nowhere else, the networks page's sync
 * schedule, the data page's backup settings, the embedding page's origins and every brain create form and inline edit were lost
 * silently by one sidebar click, and the space Danger tab's retention and embeddings tick were outside even the spaces guard. Each
 * page that had a guard had written its own (two copies of the discard question, two key sets).
 *
 * ## The rule, derived from the repository
 *
 * 1. Every route that loads a page component carries `unsavedEditsGuard` (`core/unsaved-edits.ts`), so leaving any page asks the one
 *    registry whether a live component holds an unsaved draft. `app.routes.ts` adds it with `guardEveryPage`, so no route can forget it.
 * 2. Every component whose template holds an editable control (`<input>`, `<textarea>`, `<select>`, `contenteditable`) registers its
 *    draft with `holdUnsavedEdits(...)`, or is listed in `NOT_A_DRAFT` below with the reason its controls hold nothing a user would call
 *    an edit (a filter, a control that acts at once, a one-shot credential, a field whose draft its host holds). Each entry is asserted
 *    to still hold a control and still not hold a draft, so the list is a ceiling: an entry that starts holding, or loses its controls,
 *    fails until it is removed.
 *
 * Sources come from `git ls-files` (`componentTemplates`, `trackedAppSources`), comments stripped. The guard is matched by its function's
 * NAME on the route table, not by an import, so this file reads the table the app runs on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Route } from '@angular/router';
import { routes } from '../app.routes';
import { CLIENT_ROOT } from './tracked-sources';
import { componentTemplates, formElements } from './component-templates';
import { stripComments } from './strip-comments';

/** Far below the real counts (19 page routes; dozens of components with controls); they tell "none found" from "found". */
const ROUTE_FLOOR = 15;
const HOLDER_FLOOR = 20;

/**
 * Components whose controls hold no draft. Keyed by the file, relative to `client/`. Each reason says why leaving loses nothing a user
 * would call an edit, or which host holds the draft its fields edit.
 */
const NOT_A_DRAFT: Readonly<Record<string, string>> = {};

/** Depth-first walk of the route table, every route with its full path. */
function walk(rs: Route[], prefix = ''): Array<{ path: string; route: Route }> {
  const out: Array<{ path: string; route: Route }> = [];
  for (const r of rs) {
    const here = [prefix, r.path ?? ''].filter(Boolean).join('/');
    out.push({ path: here, route: r });
    if (r.children) out.push(...walk(r.children, here));
  }
  return out;
}

/** True when the template text holds an element a user types or picks into. */
function holdsAControl(file: string, text: string): boolean {
  return formElements({ file, text, startLine: 1, declaresRequiredInput: false })
    .some(e => e.name === 'input' || e.name === 'textarea' || e.name === 'select')
    || /\bcontenteditable\b/.test(text);
}

const holdsADraft = (file: string): boolean =>
  /\bholdUnsavedEdits\s*\(/.test(stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8')));

describe('a page never loses an edit on navigation without asking (Q-701)', () => {
  it('every route that loads a page carries unsavedEditsGuard', () => {
    const pages = walk(routes).filter(x => x.route.loadComponent || x.route.component);
    expect(pages.length, 'the route table yielded too few pages to judge').toBeGreaterThanOrEqual(ROUTE_FLOOR);
    const bare = pages
      .filter(x => !(x.route.canDeactivate ?? []).some(g => typeof g === 'function' && g.name === 'unsavedEditsGuard'))
      .map(x => `/${x.path}`);
    expect(bare, 'these pages can be left without asking whether a draft would be lost: build the table with guardEveryPage (core/unsaved-edits.ts)').toEqual([]);
  });

  const withControls = [...new Set(componentTemplates().filter(t => holdsAControl(t.file, t.text)).map(t => t.file))]
    .filter(f => f.endsWith('.component.ts'));

  it('every component with an editable control holds its draft, or says why it has none', () => {
    const silent = withControls.filter(f => !holdsADraft(f) && !(f in NOT_A_DRAFT));
    expect(silent, 'these components hold editable controls and register no draft: call holdUnsavedEdits(() => <the draft differs from what it was opened with>) in the component, or add the file to NOT_A_DRAFT with the reason it holds no edit').toEqual([]);
    expect(withControls.filter(holdsADraft).length, 'too few components hold a draft for the scan to be reading the app').toBeGreaterThanOrEqual(HOLDER_FLOOR);
  });

  it('every NOT_A_DRAFT entry still has controls, still holds nothing, and says why', () => {
    for (const [file, why] of Object.entries(NOT_A_DRAFT)) {
      expect(withControls, `${file} is listed as holding no draft but has no editable control any more: remove the entry`).toContain(file);
      expect(holdsADraft(file), `${file} now holds a draft: remove it from NOT_A_DRAFT`).toBe(false);
      expect(why.trim().length, `${file} needs its reason`).toBeGreaterThan(20);
    }
  });
});
