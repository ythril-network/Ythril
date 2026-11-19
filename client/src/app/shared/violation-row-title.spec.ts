/**
 * Where a violation's row is shown as a sentence (a refused write's alert, a stored write's warnings), the sentence is worded in the reader's
 * language and the server's own sentence is the row's `title` (bundle-285, Q-943): one rule for every place, so a developer finds the raw
 * text in the same spot on each. A row the client words as the server did (no code) has no title: it would say the same thing twice.
 */
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { getTranslocoModule } from '../testing/transloco-testing';
import { dictionary } from '../testing/i18n-dictionary';
import { describeRefusal } from '../core/refusal-text';
import { RefusalAlertComponent } from './refusal-alert.component';
import { WriteWarningsComponent } from './write-warnings.component';

const EN = dictionary('en');
const words = Object.fromEntries(Object.entries(EN).filter(([k]) => k.startsWith('refusal.') || k.startsWith('violation.') || k.startsWith('writeWarnings.')));
const coded = { field: 'properties.age', value: 'x', reason: "expected type 'number', got 'string'", code: 'type', params: { type: 'number', got: 'string' } };
const plain = { field: 'properties.size', value: 'x', reason: 'must be a number' };

function translate(key: string, params: Record<string, unknown> = {}): string {
  const raw = EN[key];
  return raw === undefined ? key : raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n: string) => String(params[n] ?? ''));
}

describe('a violation row\'s server sentence is its title (Q-943)', () => {
  it('the refusal alert: worded text, the server\'s sentence as the title, none on a row without a code', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [RefusalAlertComponent, getTranslocoModule({ translation: { en: words } })] });
    const f = TestBed.createComponent(RefusalAlertComponent);
    f.componentRef.setInput('view', describeRefusal({ translate }, 'en', { status: 422, error: { error: 'schema_violation', introduced: [coded, plain] } }));
    f.detectChanges();
    const items = [...(f.nativeElement as HTMLElement).querySelectorAll('li')];
    expect(items.map(li => li.textContent?.trim())).toEqual(['age: must be a number, not text', 'size: must be a number']);
    expect(items.map(li => li.getAttribute('title'))).toEqual([coded.reason, null]);
  });

  it('the write warnings: worded text, the server\'s sentence as the title, none on a row without a code', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [WriteWarningsComponent, getTranslocoModule({ translation: { en: words } })] });
    const f = TestBed.createComponent(WriteWarningsComponent);
    f.componentRef.setInput('warnings', [coded, plain]);
    f.detectChanges();
    const items = [...(f.nativeElement as HTMLElement).querySelectorAll('li')];
    expect(items.map(li => li.textContent?.trim())).toEqual(['age: must be a number, not text', 'size: must be a number']);
    expect(items.map(li => li.getAttribute('title'))).toEqual([coded.reason, null]);
  });
});
