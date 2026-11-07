/**
 * A dialog that holds a draft never closes on its dismiss without asking (Q-713, bundle-247).
 *
 * ## The defect it prevents
 *
 * `docs/ui-primitives.md` asks for "an unsaved-changes guard on every editable form". Q-701 made every draft-holding component register its
 * draft (`holdUnsavedEdits`), which makes leaving a PAGE ask. At 45f888b0 thirteen dialogs still closed on Escape, the X and Cancel with
 * `(dismiss)="closed.emit()"` and nothing between the key and the loss: only the space settings pop-up asked, by a hand-written copy.
 *
 * ## The rule, derived from the repository
 *
 * Every component file under `src/app` whose template carries `[appModal]` and whose source calls `holdUnsavedEdits(` is read dialog by
 * dialog (a dialog is the stretch of template from one `[appModal]` to the next). For each dialog:
 *
 * 1. its `(dismiss)` handler is a call of a method of the component whose body calls `closeIfConfirmed(` (`HeldDraft`, `core/unsaved-edits.ts`),
 *    so the question is asked by the module and not restated; and
 * 2. no `(click)` or `(dismiss)` in it closes the dialog directly (`closed.emit()`, `state.close()`, `closeX()`, `flag.set(false)`,
 *    `signal.set(null)`): the X and Cancel go through the same guarded method as Escape.
 *
 * A dialog that holds nothing a user would call an edit (a read-only log, a one-time reveal, a confirmation) is listed in `HOLDS_NOTHING`
 * with the reason. Each entry is asserted to still be a dialog of its file and to still not be guarded, so the list is a ceiling.
 *
 * The rule is held on planted samples: a plain-emit dismiss fails, a guarded one passes, an X that bypasses the guard fails.
 * A close after a SUCCESSFUL save stays a direct call in the class (the draft is saved, nothing to ask); only the template is read.
 *
 * Sources come from `git ls-files` (`componentTemplates`), comments stripped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT } from './tracked-sources';
import { componentTemplates } from './component-templates';
import { stripComments } from './strip-comments';

/** Far below the real counts (13 files, 18 guarded dialogs); they tell "none found" from "found". */
const FILE_FLOOR = 10;
const DIALOG_FLOOR = 14;

/**
 * Dialogs of draft-holding components that hold no draft. Keyed `<file relative to client/>::<the (dismiss) handler text>`.
 */
const HOLDS_NOTHING: Readonly<Record<string, string>> = {
  'src/app/pages/schema-library/schema-library.component.ts::browsing.set(null)': 'the catalog browser lists entries to read and import one at a time; nothing is typed',
  'src/app/pages/schema-library/schema-library.component.ts::libTokenRevealed.set(null)': 'the one-time reveal of a created token: the secret is shown, nothing is typed, and the token exists already',
  'src/app/pages/schema-library/schema-library.component.ts::closeDeleteDialog()': 'a usage-aware delete confirmation: it lists where an entry is used and offers the act; nothing is typed',
  'src/app/pages/settings/webhooks.component.ts::deliveriesFor.set(null)': 'the delivery log of one webhook, read-only',
  'src/app/pages/settings/space-schema-tab.component.ts::closeLibPicker()': 'the library picker lists entries to link or import at once; nothing is typed',
};

/** A close that skips the guard: a close output emitted, a `close*` method called, or a flag or signal cleared. */
const DIRECT_CLOSE = /\.set\(\s*(?:false|null)\s*\)|\bclose\w*\s*\(|\b(?:close|closed)\.emit\s*\(/;

/** The body of method `name` in `classSrc` (brace-matched), or null when it has none. */
function methodBody(classSrc: string, name: string): string | null {
  const head = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?::[^{;]+)?\\{`).exec(classSrc);
  if (!head) return null;
  let depth = 1;
  let i = head.index + head[0].length;
  const from = i;
  while (i < classSrc.length && depth > 0) {
    if (classSrc[i] === '{') depth++;
    else if (classSrc[i] === '}') depth--;
    i++;
  }
  return classSrc.slice(from, i - 1);
}

interface Dialog { handler: string | null; events: string[] }

/** The dialogs of a template: from each `[appModal]` to the next, with the `(dismiss)` handler and every `(click)` and `(dismiss)` text. */
function dialogsOf(template: string): Dialog[] {
  const starts = [...template.matchAll(/\[appModal\]/g)].map(m => m.index!);
  return starts.map((from, i) => {
    const region = template.slice(from, starts[i + 1] ?? template.length);
    const handler = /\(dismiss\)\s*=\s*"([^"]*)"/.exec(region)?.[1]?.trim() ?? null;
    const events = [...region.matchAll(/\((?:click|dismiss)\)\s*=\s*"([^"]*)"/g)].map(m => m[1]!.trim());
    return { handler, events };
  });
}

/** What is wrong with the dialogs of one component, as sentences; empty when every draft-holding dialog asks. `holdsNothing` is the handlers exempted. */
function problemsOf(file: string, template: string, classSrc: string, holdsNothing: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const d of dialogsOf(template)) {
    if (d.handler === null) { out.push(`${file}: a dialog has no (dismiss) handler`); continue; }
    if (holdsNothing.has(d.handler)) continue;
    const call = /^(\w+)\(\)$/.exec(d.handler);
    const body = call ? methodBody(classSrc, call[1]!) : null;
    if (!call || body === null || !/\bcloseIfConfirmed\s*\(/.test(body)) {
      out.push(`${file}: (dismiss)="${d.handler}" closes without asking: bind a method that calls closeIfConfirmed(...) on the held draft`);
    }
    for (const e of d.events) {
      if (e === d.handler) continue;
      if (DIRECT_CLOSE.test(e)) out.push(`${file}: "${e}" closes the dialog of (dismiss)="${d.handler}" without asking: call ${d.handler} from it`);
    }
  }
  return out;
}

const holdsADraft = (src: string): boolean => /\bholdUnsavedEdits\s*\(/.test(src);

/** Every draft-holding dialog component: its file, its template and its stripped source. */
function dialogComponents(): Array<{ file: string; template: string; src: string }> {
  const out: Array<{ file: string; template: string; src: string }> = [];
  for (const t of componentTemplates()) {
    if (!/\[appModal\]/.test(t.text)) continue;
    const src = stripComments(readFileSync(resolve(CLIENT_ROOT, t.file), 'utf8'));
    if (holdsADraft(src)) out.push({ file: t.file, template: t.text, src });
  }
  return out;
}

const none = new Set<string>();

describe('a dialog that holds a draft asks before its dismiss discards it (Q-713)', () => {
  it('flags a dismiss that emits the close output at once', () => {
    const template = `<div class="b"><div [appModal]="'t' | transloco" (dismiss)="closed.emit()"><button (click)="closed.emit()">x</button></div></div>`;
    const found = problemsOf('plain.ts', template, 'class A { readonly closed = output<void>(); }', none);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.join('\n')).toContain('(dismiss)="closed.emit()" closes without asking');
  });

  it('passes a dismiss, an X and a Cancel that all go through one guarded method', () => {
    const template = `<div [appModal]="'t'" (dismiss)="requestClose()"><button (click)="requestClose()">x</button><button (click)="save()">s</button><div (click)="$event.stopPropagation()"></div></div>`;
    const cls = 'class A { private readonly draft = holdUnsavedEdits(() => true); requestClose(): void { void this.draft.closeIfConfirmed(() => this.closed.emit()); } }';
    expect(problemsOf('guarded.ts', template, cls, none)).toEqual([]);
  });

  it('flags a guarded dismiss whose X still closes at once', () => {
    const template = `<div [appModal]="'t'" (dismiss)="requestClose()"><button (click)="close.emit()">x</button><button (click)="open.set(false)">c</button></div>`;
    const cls = 'class A { requestClose() { this.draft.closeIfConfirmed(() => this.close.emit()); } }';
    const found = problemsOf('bypass.ts', template, cls, none);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('"close.emit()" closes the dialog');
  });

  it('flags a method named for the guard that does not call it, and a multi-line method body is read whole', () => {
    const template = `<div [appModal]="'t'" (dismiss)="requestClose()"></div>`;
    expect(problemsOf('hollow.ts', template, 'class A { requestClose(): void { this.closed.emit(); } }', none)).toHaveLength(1);
    const multi = 'class A { async requestClose(): Promise<void> {\n if (x) { y(); }\n await this.draft.closeIfConfirmed(() => { this.closed.emit(); });\n } other() {} }';
    expect(problemsOf('multi.ts', template, multi, none)).toEqual([]);
  });

  it('reads each dialog of a component on its own, and skips the one that holds nothing', () => {
    const template = `<div [appModal]="'a'" (dismiss)="requestCloseA()"><button (click)="requestCloseA()"></button></div>
      <div [appModal]="'b'" (dismiss)="log.set(null)"><button (click)="log.set(null)"></button></div>
      <div [appModal]="'c'" (dismiss)="things.set(false)"></div>`;
    const cls = 'class A { requestCloseA() { this.a.closeIfConfirmed(() => this.show.set(false)); } }';
    const found = problemsOf('two.ts', template, cls, new Set(['log.set(null)']));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('(dismiss)="things.set(false)"');
  });

  const components = dialogComponents();

  it('every draft-holding dialog of the app asks', () => {
    expect(components.length, 'too few draft-holding dialog components for the scan to be reading the app').toBeGreaterThanOrEqual(FILE_FLOOR);
    const dialogs = components.reduce((n, c) => n + dialogsOf(c.template).length, 0);
    expect(dialogs, 'too few dialogs found').toBeGreaterThanOrEqual(DIALOG_FLOOR);
    const problems = components.flatMap(c => {
      const exempt = new Set(Object.keys(HOLDS_NOTHING).filter(k => k.startsWith(`${c.file}::`)).map(k => k.slice(c.file.length + 2)));
      return problemsOf(c.file, c.template, c.src, exempt);
    });
    expect(problems, 'these dialogs hold a draft and close without asking: keep the handle holdUnsavedEdits returns and close through draft.closeIfConfirmed(...)').toEqual([]);
  });

  it('every HOLDS_NOTHING entry is still a dialog of its file, is not guarded, and says why', () => {
    for (const [key, why] of Object.entries(HOLDS_NOTHING)) {
      const [file, handler] = key.split('::') as [string, string];
      const c = components.find(x => x.file === file);
      expect(c, `${file} no longer holds a draft in a dialog: remove ${key}`).toBeTruthy();
      const found = dialogsOf(c!.template).find(d => d.handler === handler);
      expect(found, `${file} has no dialog dismissed by ${handler}: remove the entry`).toBeTruthy();
      const body = /^(\w+)\(\)$/.test(handler) ? methodBody(c!.src, handler.slice(0, -2)) : null;
      expect(body === null || !/\bcloseIfConfirmed\s*\(/.test(body), `${file}: ${handler} now asks: remove it from HOLDS_NOTHING`).toBe(true);
      expect(why.trim().length, `${key} needs its reason`).toBeGreaterThan(20);
    }
  });
});
