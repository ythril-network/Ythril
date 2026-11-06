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
const NOT_A_DRAFT: Readonly<Record<string, string>> = {
  // Filters, queries and controls that act at once.
  'src/app/pages/brain/query-tab.component.ts': 'a query builder: the recall form and the advanced query form only parameterise a read that a Run button sends, and nothing is written',
  'src/app/pages/brain/recall-form.component.ts': 'the recall (search) parameters: every field only shapes a read that Run sends, nothing is stored',
  'src/app/pages/brain/record-search-bar.component.ts': 'a record search box that emits its query at once to filter the list; it is a filter, not an edit',
  'src/app/pages/brain/review-tab.component.ts': 'review filters (type, search, status) that narrow the pair list; the merge and dismiss actions act at once',
  'src/app/pages/brain/review-contradictions-panel.component.ts': 'a search box and a status filter that narrow the contradiction list; its actions act at once',
  'src/app/pages/graph/graph-toolbar.component.ts': 'the graph depth slider acts at once on the drawn graph, and the entity finder is a search that reports a pick',
  'src/app/pages/graph/graph-linked-records.component.ts': 'a type filter and a description filter over the linked records of one node; they only narrow what is shown',
  'src/app/pages/settings/audit-log.component.ts': 'filters held until Search is pressed; they only query the log and a navigation loses nothing a user wrote',
  'src/app/pages/settings/preferences.component.ts': 'language buttons and date style/zone radios act at once (setLang, setStyle, setZone), so nothing waits for a save',
  'src/app/pages/files/conflicts.component.ts': 'per-row choices made again in one click (default keep-local) and selection checkboxes; nothing is typed, and each Resolve sends its own choice',
  // One-shot credentials and confirmations.
  'src/app/pages/login/login.component.ts': 'a one-shot credential on a public route outside the shell, left only by its own sign-in',
  'src/app/pages/setup/setup.component.ts': 'the first-run form on a public route outside the shell, left only by its own submit',
  'src/app/pages/settings/mfa.component.ts': 'the confirm code is a one-shot six-digit code from the authenticator, typed to prove possession and not a draft anyone keeps',
  'src/app/shared/mfa-prompt.component.ts': 'a one-shot six-digit code sent by Verify; it cannot be recovered or reused later, so nothing is lost by leaving',
  'src/app/shared/confirm-dialog.component.ts': 'the type-to-confirm text is a one-shot confirmation of a destructive act that the dialog itself sends or cancels',
  // Fields that edit a draft their host holds.
  'src/app/pages/brain/chrono-ref-field.component.ts': 'a record picker whose search box finds a chrono entry to add; the picked ids land in its host\'s draft, which src/app/pages/files/file-meta-editor.component.ts holds',
  'src/app/pages/brain/fact-ref-field.component.ts': 'a record picker whose search box finds a fact to add; the picked ids land in its host\'s draft, which chrono-tab.component.ts, record-drawer.component.ts and src/app/pages/files/file-meta-editor.component.ts hold',
  'src/app/shared/tag-input.component.ts': 'edits the tag list of its host\'s draft, which the Brain tabs (facts, entities, edges, chrono), record-drawer.component.ts and file-meta-editor.component.ts hold',
  'src/app/shared/properties-editor.component.ts': 'edits the properties map of its host\'s draft, which the Brain tabs and record-drawer.component.ts hold',
  'src/app/shared/prop-schema-table.component.ts': 'edits the property rows of its host\'s draft: schema-library.component.ts holds the library form, and the settings schema editor is held by SpaceSettingsState.isDirty()',
  'src/app/shared/rule-rows.component.ts': 'edits the rule list of its host\'s draft: schema-library.component.ts holds the library form, and the settings schema editor is held by SpaceSettingsState.isDirty()',
  'src/app/shared/entity-search.component.ts': 'a finder: it holds a typed query and reports a pick; a pick lands in its host\'s draft (edges-tab.component.ts holds the edge form) and a typed query alone is no edit',
  'src/app/pages/settings/space-settings-tab.component.ts': 'edits the SpaceSettingsState form, whose draft spaces.component.ts holds (and brain.component.ts holds when the pop-up is hosted there)',
  'src/app/pages/settings/space-duplicates-tab.component.ts': 'edits the SpaceSettingsState duplicate-rule draft, which spaces.component.ts holds (and brain.component.ts when the pop-up is hosted there)',
  'src/app/pages/settings/schema-type-editor.component.ts': 'edits a type draft in SpaceSettingsState, which spaces.component.ts holds (and brain.component.ts when hosted there)',
  'src/app/pages/settings/media-processing/models-tab.component.ts': 'edits the MediaProcessingStateService draft, which media-processing-page.component.ts holds through s.isDirty()',
  'src/app/pages/settings/media-processing/pipelines-tab.component.ts': 'edits the MediaProcessingStateService draft, which media-processing-page.component.ts holds through s.isDirty()',
  'src/app/pages/settings/media-processing/decision-model-card.component.ts': 'edits the MediaProcessingStateService draft, which media-processing-page.component.ts holds through s.isDirty()',
  'src/app/pages/settings/media-processing/slot-tuning.component.ts': 'edits the MediaProcessingStateService draft, which media-processing-page.component.ts holds through s.isDirty()',
  'src/app/pages/settings/media-processing/assist-extras.component.ts': 'edits the MediaProcessingStateService draft, which media-processing-page.component.ts holds through s.isDirty()',
};

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
