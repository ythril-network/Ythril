/**
 * The "at the limit" notice of the Forks section names the cap the SERVER says (bundle-81 slice I4, decision 64).
 *
 * A record may hold only so many forks; the next differing copy of one at the limit is dropped, which is why a reviewer is told. The number is
 * the server's (`maxForksPerRecord` in the list's answer, from `MAX_FORKS_PER_RECORD`), so the client holds none: a second hand-written 10 is
 * a number that goes stale the day the server's changes. An answer that does not say it shows no notice rather than one with a guess.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { ReviewForksComponent } from './review-forks.component';
import { pageOf } from '../../core/forks-api.service';

const version = (id: string, fact: string) => ({ _id: id, type: 'note', fact, tags: [] as string[] });
const row = (forkId: string, siblings: number) => ({
  forkId, parentId: 'parent-aaaa-bbbb', fork: version(forkId, 'one text'), parent: version('parent-aaaa-bbbb', 'another text'),
  kind: 'fact' as const, orphaned: false, edgeCount: 0, linkCount: 0, siblings, resolvedElsewhere: [],
});

/** The answer's `kinds`: the fields a fact compares and its main field. The other kinds are not on screen in this spec. */
const KINDS = Object.fromEntries(['fact', 'entity', 'chrono', 'edge'].map(k => [k, { fields: k === 'fact' ? ['fact', 'type', 'tags'] : ['x'], mainField: k === 'fact' ? 'fact' : 'x' }]));

function make(cap: number | null, siblings: number) {
  const words: Record<string, any> = {};
  for (const [key, value] of Object.entries(dictionary('en'))) {
    if (!key.startsWith('brain.review.forks.')) continue;
    let node = words;
    const parts = key.split('.');
    parts.slice(0, -1).forEach(p => { node = node[p] ??= {}; });
    node[parts.at(-1)!] = value;
  }
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ReviewForksComponent, getTranslocoModule({ translation: { en: words } })] });
  const fixture = TestBed.createComponent(ReviewForksComponent);
  fixture.componentRef.setInput('rows', [row('fork-1111-2222', siblings), row('fork-3333-4444', siblings)]);
  fixture.componentRef.setInput('kinds', KINDS);
  fixture.componentRef.setInput('cap', cap);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('the forks cap is the server\'s', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('names the cap the list answered, once for the parent, when a record holds that many forks', () => {
    const el = make(7, 7);
    expect(el.querySelectorAll('.fk-cap').length).toBe(1);
    expect(el.querySelector('.fk-cap')!.textContent).toContain('7');
    expect(el.querySelector('.cap-note')!.textContent).toContain('7');
  });

  it('says nothing below the cap, and nothing when the answer names none', () => {
    expect(make(7, 6).querySelector('.fk-cap')).toBeNull();
    expect(make(null, 99).querySelector('.fk-cap')).toBeNull();
  });

  it('reads the cap off the list answer, and ignores one that is not a number', () => {
    expect(pageOf({ forks: [], total: 0, skip: 0, limit: 25, maxForksPerRecord: 10 }, 0, 25).maxForksPerRecord).toBe(10);
    expect(pageOf({ forks: [], maxForksPerRecord: 'ten' }, 0, 25).maxForksPerRecord).toBeUndefined();
    expect(pageOf({ forks: [] }, 0, 25).maxForksPerRecord).toBeUndefined();
  });

  it('keeps no number of its own: nothing in the client names the cap as a constant', () => {
    const forksTypes = readFileSync(resolve(process.cwd(), 'src/app/core/forks.types.ts'), 'utf8');
    expect(forksTypes).not.toMatch(/MAX_FORKS_PER_RECORD\s*=/);
    const component = readFileSync(resolve(process.cwd(), 'src/app/pages/brain/review-forks.component.ts'), 'utf8');
    expect(component).not.toMatch(/MAX_FORKS_PER_RECORD/);
  });
});
