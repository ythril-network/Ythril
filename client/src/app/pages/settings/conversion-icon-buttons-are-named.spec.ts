/**
 * Every icon-only button of the record-conversion pages has an accessible name of its own (bundle-285 slice S10, Q-747; the browser drive's D6).
 *
 * ## What it prevents
 *
 * A button whose only content is an icon is announced as "button" unless it carries `aria-label` (or `[attr.aria-label]`, or `aria-labelledby`).
 * A `title` alone is not enough: it is a tooltip, which a screen reader may not read and a touch screen never shows. The drive found the enum
 * chips' remove buttons nameless, the control a map step starts from. This reads the templates of the components bundle-285 built or changed
 * and refuses such a button, so the next one fails here instead of in a drive.
 *
 * The rest of the client holds more (the reference fields' chip removers, the graph's and the library's icon buttons with a title only); they are
 * outside this bundle and listed for their own ticket, not allowed here.
 *
 * ## Seen red
 *
 * Red at c65fa1f51: `schema-type-editor.component.ts` holds two (the enum chip's remove button, the property's remove button with a title only).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_ROOT } from '../../testing/tracked-sources';

const APP = resolve(CLIENT_ROOT, 'src/app');

/** The components of the conversion pages: the settings dialog, its editor and run, the type's bar and head, the vote row, Review's section. */
const FILES = [
  'pages/settings/convert-records-dialog.component.ts',
  'pages/settings/convert-step-editor.component.ts',
  'pages/settings/convert-run-block.component.ts',
  'pages/settings/type-convert-bar.component.ts',
  'pages/settings/space-settings-popup.component.ts',
  'pages/settings/space-schema-tab.component.ts',
  'pages/settings/schema-type-editor.component.ts',
  'pages/settings/schema-type-name.component.ts',
  'pages/settings/network-vote-row.component.ts',
  'pages/settings/vote-conversion-block.component.ts',
  'pages/brain/review-unconverted-panel.component.ts',
];

/**
 * The buttons of a template text whose content is icons only (an icon, an svg or a spinner, and no text or interpolation) and that carry no name of
 * their own, each as `<file>:<line> <attributes>`.
 */
function unnamedIconButtons(file: string, src: string): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, attrs = '', body = ''] = m;
    if (/\baria-label\b|\baria-labelledby\b/.test(attrs)) continue;
    const text = body.replace(/<[^>]*>/g, '').replace(/@(if|else)[^{]*\{|\}|\{/g, '').trim();
    if (text !== '' || !/<ph-icon|<svg|class="spinner/.test(body)) continue;
    found.push(`${file}:${src.slice(0, m.index).split('\n').length} ${attrs.trim()}`);
  }
  return found;
}

describe('the record-conversion pages name every icon-only button', () => {
  it('reads a button by its content: an icon alone is refused without a name, text or an aria-label passes (the reader works)', () => {
    expect(unnamedIconButtons('x', '<button class="b" (click)="go()"><ph-icon name="x"/></button>')).toHaveLength(1);
    expect(unnamedIconButtons('x', '<button [attr.title]="t"><ph-icon name="x"/></button>'), 'a title alone is not a name').toHaveLength(1);
    expect(unnamedIconButtons('x', '<button [attr.aria-label]="n"><ph-icon name="x"/></button>')).toEqual([]);
    expect(unnamedIconButtons('x', '<button><ph-icon name="x"/>{{ label }}</button>')).toEqual([]);
    expect(unnamedIconButtons('x', '<button>Save</button>')).toEqual([]);
  });

  it('finds none in the components of the conversion pages', () => {
    const found = FILES.flatMap(file => unnamedIconButtons(file, readFileSync(resolve(APP, file), 'utf8')));
    expect(found, `icon-only buttons with no aria-label:\n${found.join('\n')}`).toEqual([]);
  });
});
