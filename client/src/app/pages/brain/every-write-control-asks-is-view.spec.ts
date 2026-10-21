/**
 * Every component that renders a write control on the Brain or Files page asks the one shared `isView` flag (Q-531, bundle-100, plan
 * rev 3.2 "Client": "One shared isView flag gates every write control: Brain tabs, record drawer, review tab, retype flow, file
 * toolbar").
 *
 * ## The rule, and why it is derived
 *
 * A personal view never writes; the server refuses a write to one with a 404 and a hint. A control that offers the write anyway
 * invites a user to fill a form that can only be refused. The set of components is DERIVED, never listed: every tracked component
 * under `pages/brain/` and `pages/files/` whose template binds an event to a write - a handler (or an `output` it emits) named for
 * one (save, create, delete, remove, update, retype, merge, upload, rename, move, wipe, import, dismiss, unlink, restore, convert,
 * reindex, newFolder/createFolder) - or that writes through `saveWithRetype(` (the retype flow's callers). Each of them must read
 * the flag by name (`isView`), comments stripped so a comment promising it does not count.
 *
 * A component reached ONLY through a parent that already hides it on a view may be listed in `GATED_BY_PARENT` with that parent;
 * the gate then holds the parent to the flag and checks the parent really renders it. The list is empty: nothing has been argued.
 *
 * ## Seen red at 18e8d598
 *
 * No component mentions `isView`: every derived component is listed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from '../../testing/tracked-sources';

/** Component file (relative to client/) -> the parent that hides it on a view, with why. Empty until one is argued. */
const GATED_BY_PARENT: Record<string, { parent: string; why: string }> = {};

const WRITE_NAME = String.raw`(?:save|create|delete|remove|update|retype|merge|upload|rename|move|wipe|import|dismiss|unlink|restore|convert|reindex|newFolder)\w*`;

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** The inline template of a component source, or '' when it has none. */
function templateOf(src: string): string {
  const m = /template\s*:\s*`([\s\S]*?)`\s*,?\s*\n\s*(?:\}|\w+\s*:)/.exec(src);
  return m ? m[1]! : '';
}

/** The write handlers a template binds, as written. */
function writeBindings(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\((?:click|ngSubmit|submit|change|keydown\.enter)\)="([^"]*)"/g)) {
    // `save()`, `state.save()`, `createFolder.emit()`: a write named directly, through a member, or as an output.
    if (new RegExp(String.raw`(?:^|[^\w.$])(?:[\w$]+\.)*${WRITE_NAME}(?:\.emit)?\s*\(`, 'i').test(m[1]!)) out.push(m[1]!.trim());
  }
  return out;
}

function derived(): { file: string; why: string; src: string }[] {
  const files = trackedAppSources().filter(f => /^src\/app\/pages\/(?:brain|files)\/[^/]+\.component\.ts$/.test(f));
  const out = [];
  for (const file of files) {
    const src = stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
    const bindings = writeBindings(templateOf(src));
    const retype = /\bsaveWithRetype\s*\(/.test(src);
    if (bindings.length || retype) out.push({ file, why: retype ? 'saveWithRetype(' : bindings[0]!, src });
  }
  return out;
}

describe('every write control asks isView (Q-531)', () => {
  it('the derivation finds the components the plan names, and more than a handful', () => {
    const found = derived().map(d => d.file);
    expect(found.length, `derived ${found.length} component(s) with a write control: ${found.join(', ')}`).toBeGreaterThanOrEqual(6);
    for (const named of ['entities-tab', 'facts-tab', 'edges-tab', 'chrono-tab', 'record-drawer', 'review-tab', 'file-toolbar']) {
      expect(found.some(f => f.includes(`/${named}.component.ts`)), `the derivation missed ${named}, which renders a write control`).toBe(true);
    }
  });

  it('each one reads the shared isView flag (or is hidden by a parent that does)', () => {
    const missing = derived()
      .filter(d => !/\bisView\b/.test(d.src))
      .filter(d => {
        const gated = GATED_BY_PARENT[d.file];
        if (!gated) return true;
        const parent = stripComments(readFileSync(resolve(CLIENT_ROOT, gated.parent), 'utf8'));
        const selector = /selector\s*:\s*'([^']+)'/.exec(d.src)?.[1] ?? '\u0000';
        return !(/\bisView\b/.test(parent) && parent.includes(`<${selector}`));
      })
      .map(d => `${d.file} (writes through ${d.why})`);
    expect(missing, 'components that render a write control without asking isView').toEqual([]);
  });
});
