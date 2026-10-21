/**
 * bundle-157 (Q-561, findings 4 and 5): what the restore / migrate progress card SAYS for each state of a space, and for the end of a set.
 *
 * The verify drive of bundle-157 read every screenshot: every pending row said "Retry owed | Attempts so far: 0 | Next try: shortly", a row
 * that only an abandon ends said it would be retried shortly beside "It is not retried; abandon it", and after the end the stage label still
 * read "Working". An operator watching a restore reads this card, so these specs use the REAL en.json: the thing pinned is the sentence read.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ActSetProgressComponent } from './act-set-progress.component';
import { migrateReport, restoreReport, restoreSpace } from '../../testing/data-act-bodies';

const en: Record<string, string> = JSON.parse(readFileSync(resolve(__dirname, '../../../../public/assets/i18n/en.json'), 'utf8'));

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const AHEAD = '2026-10-18T12:05:00.000Z';

function card(kind: 'restore' | 'migrate', report: Record<string, unknown>): ComponentFixture<ActSetProgressComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ActSetProgressComponent, getTranslocoModule({ translation: { en } })] });
  const fixture = TestBed.createComponent(ActSetProgressComponent);
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('report', report);
  fixture.detectChanges();
  return fixture;
}

const rows = (f: ComponentFixture<ActSetProgressComponent>): HTMLElement[] =>
  Array.from((f.nativeElement as HTMLElement).querySelectorAll('li'));
const rowOf = (f: ComponentFixture<ActSetProgressComponent>, id: string): string =>
  rows(f).find(li => li.querySelector('span')?.textContent?.trim() === id)?.textContent?.replace(/\s+/g, ' ') ?? '';
const cardText = (f: ComponentFixture<ActSetProgressComponent>): string => ((f.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ');
const barLabel = (f: ComponentFixture<ActSetProgressComponent>): string =>
  (f.nativeElement as HTMLElement).querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? '';

describe('a row names its state truly (Q-561, finding 4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a space that has not started (owed, attempt 0) is Waiting: no "Retry owed", no next try', () => {
    const f = card('restore', restoreReport({ spaces: [restoreSpace('alpha', 'owed', { attempts: 0 }), restoreSpace('general', 'done')] }));
    const row = rowOf(f, 'alpha');
    expect(row).toContain(en['spaces.dangerZone.act.state.registered']);
    expect(en['spaces.dangerZone.act.state.registered']).toBe('Waiting');
    expect(row).not.toContain(en['spaces.dangerZone.act.state.owed']);
    expect(row).not.toContain('Next try');
  });

  it('the same for a migrate: a pending space is Waiting', () => {
    const f = card('migrate', migrateReport({ spaces: [restoreSpace('alpha', 'owed', { attempts: 0 }), restoreSpace('notes', 'running', { attempts: 0 })] }));
    expect(rowOf(f, 'alpha')).toContain('Waiting');
    expect(rowOf(f, 'alpha')).not.toContain('Retry owed');
    expect(rowOf(f, 'alpha')).not.toContain('Next try');
  });

  it('a running space with no failed try is Running, never Waiting', () => {
    const f = card('restore', restoreReport({ spaces: [restoreSpace('proj', 'running', { attempts: 0 })] }));
    expect(rowOf(f, 'proj')).toContain('Running');
    expect(rowOf(f, 'proj')).not.toContain('Waiting');
  });

  it('a space only an abandon ends has no next try and is not "retry owed"; it keeps its failure and its abandon sentence', () => {
    const f = card('restore', restoreReport({ spaces: [restoreSpace('notes', 'owed', {
      attempts: 2, lastError: 'the backup holds records that one of its unique indexes refuses.', retryAt: AHEAD, needsAbandon: true,
    })] }));
    const row = rowOf(f, 'notes');
    expect(row).not.toContain('Retry owed');
    expect(row).not.toContain('Next try');
    expect(row).toContain(en['data.progress.needsAbandon']);
    expect(row).toContain('unique indexes refuses');
  });

  it('a real retry (tried before, not abandon-only) keeps "Retry owed", its tries and its next try', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const f = card('restore', restoreReport({ spaces: [restoreSpace('notes', 'owed', { attempts: 3, retryAt: AHEAD, lastError: 'the store did not answer.' })] }));
      const row = rowOf(f, 'notes');
      expect(row).toContain('Retry owed');
      expect(row).toContain('Attempts so far: 3');
      expect(row).toContain('Next try:');
    } finally { vi.useRealTimers(); }
  });
});

describe('the end of a set is named, not left at "Working" (Q-561, finding 5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a completed restore: the stage label says Completed, not Working', () => {
    const f = card('restore', restoreReport({
      state: 'completed', endedAt: '2026-10-18T12:01:00.000Z', spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'done')],
    }));
    expect(barLabel(f)).toContain(en['data.progress.state.completed']);
    expect(barLabel(f)).not.toContain(en['files.progress.working']);
    expect(cardText(f)).not.toContain(en['files.progress.working']);
  });

  it('an abandoned restore: the stage label says Abandoned, not Working', () => {
    const f = card('restore', restoreReport({
      state: 'abandoned', endedAt: '2026-10-18T12:01:00.000Z', spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'restore_abandoned')],
    }));
    expect(barLabel(f)).toContain(en['data.progress.state.abandoned']);
    expect(cardText(f)).not.toContain(en['files.progress.working']);
  });

  it('a completed migrate is named the same way', () => {
    const f = card('migrate', migrateReport({ state: 'completed', endedAt: '2026-10-18T12:01:00.000Z', done: 2, spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'done')] }));
    expect(barLabel(f)).toContain('Completed');
    expect(cardText(f)).not.toContain('Working');
  });
});

describe('a standing migrate says what happens when it ends (Q-561, finding 5)', () => {
  it('while it runs, the card says the process exits when the copy completes and the next start connects to the new database', () => {
    const f = card('migrate', migrateReport());
    expect(cardText(f)).toContain('the process exits when the copy completes');
    expect(cardText(f)).toContain('the next start connects to the new database');
  });

  it('a restore card says nothing about the process exiting', () => {
    const f = card('restore', restoreReport());
    expect(cardText(f)).not.toContain('next start connects');
  });
});
