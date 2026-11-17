/**
 * A public or protected member of a client component, service or directive is read by a template or by a product source, not by a spec alone.
 *
 * ## Why this gate exists
 *
 * bundle-231's Q-64 set the pipeline Validate step's warning in `MediaProcessingStateService.stageClass`, a member no template or source had read since
 * 6.4.0. Its spec passed, and the live page showed Validate green. The project's unused check (`noUnusedLocals`) sees only private and local names, never a
 * public member that specs alone read, so a state computed only for its spec passed for a page behaviour (Q-703). `a-component-declares-nothing-it-never-reads`
 * asks this of the graph page alone, by name; this asks it of every decorated class in `client/src`, by the TypeScript checker's symbols
 * (`_client-member-reads.mjs`).
 *
 * ## The rule
 *
 * Every public or protected member of an `@Component`, `@Directive` or `@Injectable` class is read by a template (its own, or a dotted name in any) or by a
 * non-spec source, unless it is a framework door (a decorated member, an input/output/query, a lifecycle hook, an override or an interface member). One
 * that is not goes in `a-client-member-is-read-by-a-template-or-source.allow.json` with its reason and a reviewBy date; the count of entries is part of the
 * run. Remove a member nothing reads, or wire it into the page.
 *
 * ## It cannot pass vacuously
 *
 * The sources come from `git ls-files` (floor included). The reader is run on a planted source whose every row of the truth table has a hand-written
 * outcome, and on a copy of a real member of `MediaProcessingStateService` taken from the repository and left unread: the reader must flag the copy and
 * nothing else of that file.
 *
 * Run: node --test testing/standalone/a-client-member-is-read-by-a-template-or-source.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { clientSourceFiles, unreadClientMembers } from './_client-member-reads.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./a-client-member-is-read-by-a-template-or-source.allow.json', import.meta.url), 'utf8'));
const ENTRIES = ALLOW.entries;
const FILE_FLOOR = 150;
const SERVICE = 'client/src/app/pages/settings/media-processing/media-processing-state.service.ts';
const PLANT = 'client/src/app/zz-planted-members.ts';

const label = (m) => `${m.cls}.${m.member}`;
const planted = (source) => unreadClientMembers({ overrides: { [PLANT]: source } }).filter(m => m.file === PLANT).map(label);

describe('the reader, row by row', () => {
  const SOURCE = [
    "import { Component, Directive, Injectable, effect, inject, input, output } from '@angular/core';",
    "@Injectable({ providedIn: 'root' })",
    'export class PlantedState {',
    '  unreadByAnything(): number { return 1; }',
    '  readByATemplateAfterADot = 1;',
    '  readByCode(): number { return 2; }',
    '  readByDestructuring = 3;',
    '  private hiddenFromTemplates = 5;',
    '  ngOnDestroy(): void { return; }',
    '}',
    "@Component({ selector: 'app-planted', template: `{{ state.readByATemplateAfterADot }} {{ own() }} <button (click)=\"go()\"></button>` })",
    'export class PlantedComponent {',
    '  state = inject(PlantedState);',
    '  own(): number { return 1; }',
    '  go(): void { this.state.readByCode(); const { readByDestructuring } = this.state; void readByDestructuring; }',
    '  protected unreadProtected(): number { return 6; }',
    '  unreadPlain = 7;',
    '  readonly size = input<string>();',
    '  readonly picked = output<string>();',
    '  protected readonly paint = effect(() => { this.own(); });',
    '}',
    "@Directive({ selector: '[plantedHost]', host: { '(click)': 'onHostClick()' } })",
    'export class PlantedDirective {',
    '  onHostClick(): void { return; }',
    '  unreadOnTheDirective(): void { return; }',
    '}',
    "@Component({ selector: 'app-planted-base', template: '' })",
    'export class PlantedBase {',
    '  readBySubclassTemplate = 1;',
    '  baseUnread = 2;',
    '}',
    "@Component({ selector: 'app-planted-sub', template: `{{ readBySubclassTemplate }}` })",
    'export class PlantedSub extends PlantedBase {}',
    '',
  ].join('\n');

  it('flags exactly the members nothing reads, whatever their access, and none of the framework doors', () => {
    assert.deepEqual(planted(SOURCE).sort(), [
      'PlantedBase.baseUnread', 'PlantedComponent.unreadPlain', 'PlantedComponent.unreadProtected', 'PlantedDirective.unreadOnTheDirective', 'PlantedState.unreadByAnything',
    ]);
  });
});

describe('a copy of a real member, left unread, is flagged', () => {
  it('flags the copy of a member of MediaProcessingStateService and nothing else of that file', () => {
    const text = readFileSync(join(REPO_ROOT, SERVICE), 'utf8');
    const line = text.split(/\r?\n/).find(l => /^ {2}[a-z]\w*\(\): boolean \{.*\}$/.test(l));
    assert.ok(line, 'the service has no one-line boolean member to copy: the plant needs a new real line');
    const name = line.trim().match(/^(\w+)\(/)[1];
    const copy = line.replace(name, `${name}OnlyItsSpecReads`);
    const plantedText = text.replace(line, `${line}\n${copy}`);
    const hits = unreadClientMembers({ overrides: { [SERVICE]: plantedText } }).filter(m => m.file === SERVICE).map(label);
    assert.deepEqual(hits, [`MediaProcessingStateService.${name}OnlyItsSpecReads`]);
  });
});

describe('the client', () => {
  it(`read at least ${FILE_FLOOR} sources (read ${clientSourceFiles().length}), so an empty listing cannot pass`, () => {
    assert.ok(clientSourceFiles().length >= FILE_FLOOR);
  });

  it('every public or protected member is read by a template or a product source, unless the allow list names it', () => {
    const open = unreadClientMembers().filter(m => !ENTRIES.some(e => e.file === m.file && e.cls === m.cls && e.member === m.member));
    assert.deepEqual(open.map(m => `${m.file}:${m.line} ${label(m)}`), [],
      'a member nothing reads is dead code, or state computed for its spec while the page shows something else (Q-64: stageClass). '
      + 'Remove it or wire it into the template; a framework door the reader cannot see goes in '
      + 'a-client-member-is-read-by-a-template-or-source.allow.json with a reason and a reviewBy date.');
  });
});

describe(`the allowlist (${ENTRIES.length} entries)`, () => {
  const today = new Date().toISOString().slice(0, 10);
  const name = (e) => `${e.file} ${e.cls}.${e.member}`;

  it('every entry has a file, a class, a member, a reason of three words or more and a reviewBy date', () => {
    const bad = ENTRIES.filter(e => !(typeof e.file === 'string' && e.file && typeof e.cls === 'string' && e.cls && typeof e.member === 'string' && e.member
      && typeof e.reason === 'string' && e.reason.trim().split(/\s+/).length >= 3
      && typeof e.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy) && new Date(e.reviewBy).toISOString().slice(0, 10) === e.reviewBy));
    assert.deepEqual(bad.map(name), [], 'each entry needs file, cls, member, reason (3+ words) and reviewBy (YYYY-MM-DD)');
  });

  it('no entry is past its reviewBy date', () => {
    assert.deepEqual(ENTRIES.filter(e => e.reviewBy < today).map(e => `${name(e)} (reviewBy ${e.reviewBy}, today ${today})`), [],
      'review the entry: remove the member, or renew the date with a reason');
  });

  it('every entry names a member the reader still flags, so a wired or removed member leaves the list', () => {
    const flagged = unreadClientMembers();
    assert.deepEqual(ENTRIES.filter(e => !flagged.some(m => m.file === e.file && m.cls === e.cls && m.member === e.member)).map(name), [],
      'the member is read now, or gone: remove the entry');
  });
});
