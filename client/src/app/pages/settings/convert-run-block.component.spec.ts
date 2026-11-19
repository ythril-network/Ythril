/**
 * The run block: a conversion running and finished (bundle-285 slice S5, Q-747; plan sections 3.1 item 8, 5 rows R1 to R12, 9; drawing moments 3a, 3b).
 *
 * Every state of the drawn block, and the rules the drawing cannot show:
 *
 * - **checked and total come from the run's counts and `left`**: checked is stamped + rewritten + unconverted + moved, total is checked +
 *   `left`. With `left: null` ("not counted in time") there is NO total and no percentage: the block says it is counting the records left, and
 *   the bar has no value, rather than a total made of the records read so far (which would read 100% at every step);
 * - **a part of the line that is zero is not said** ("599 rewritten, 41 only stamped" and, only when there are some, "N could not be converted"
 *   in bold, and "N left" while it runs);
 * - **a finished run says what it refused**: how many of its steps were refused here (each as the step's sentence with its reason in words, a
 *   code this client has no words for as the generic sentence), how many records are listed in Review for it (read from the list, and left out
 *   when it could not be read), and what to do; a refusal of the whole vote has its own sentence;
 * - **the states with no run**: nothing to convert (an empty type, a space that never ran, a save that started nothing), a save that did not
 *   start a run (with its error), a run that stopped (with its error and the numbers it reached);
 * - **names are text and in the code face**, never markup: a peer-authored name in a refused step is a `.cv-tn` span of text.
 *
 * The footer of the finished dialog (Open Review with its count, or the hint) is one pure function, `runFooterOf`, held here too.
 * The words are markers (`RUN-CHECKED`), so no assertion depends on the English and a key the block forgot shows as a raw key.
 *
 * ## Seen red
 *
 * Red at 28b6b64d8: `pages/settings/convert-run-block.component.ts` does not exist.
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { ConversionApi } from '../../core/conversion-api.service';
import type { ConversionStep, ConvertRunNotice, ConvertStatus, ConvertStatusAnswer } from '../../core/conversion.types';
import { declaredNearest } from '../../testing/declared-style';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ConvertRunBlockComponent, runFooterOf, stepPieces } from './convert-run-block.component';

const REFUSED = 'REF-HEAD k={{k}} n={{count}}';
const WORDS: Record<string, string> = {
  'common.loading': 'RUN-LOADING',
  'spaces.schema.convert.run.converting': 'RUN-CONVERTING',
  'spaces.schema.convert.run.doneSome': 'RUN-DONE-SOME',
  'spaces.schema.convert.run.done': 'RUN-DONE',
  'spaces.schema.convert.run.nothing': 'RUN-NOTHING',
  'spaces.schema.convert.run.checked.one': 'RUN-CHECKED done={{done}} total={{count}}',
  'spaces.schema.convert.run.checked.other': 'RUN-CHECKED done={{done}} total={{count}}',
  'spaces.schema.convert.run.checkedAria': 'RUN-ARIA {{pct}}',
  'spaces.schema.convert.run.counting': 'RUN-COUNTING',
  'spaces.schema.convert.run.line.rewritten': 'RW={{rewritten}}',
  'spaces.schema.convert.run.line.stamped': 'ST={{stamped}}',
  'spaces.schema.convert.run.line.unconverted': 'UN={{unconverted}}',
  'spaces.schema.convert.run.line.left': 'LEFT={{left}}',
  'spaces.schema.convert.run.retrying': 'RUN-RETRY',
  'spaces.schema.convert.run.noneHere': 'RUN-NONE-HERE',
  'spaces.schema.convert.run.noneCurrent': 'RUN-NONE-CURRENT',
  'spaces.schema.convert.run.noneEmpty': 'RUN-NONE-EMPTY',
  'spaces.schema.convert.run.notStarted': 'RUN-NOT-STARTED {{error}}',
  'spaces.schema.convert.run.failed': 'RUN-FAILED {{error}}',
  'spaces.schema.convert.run.types.one': 'RUN-TYPES {{count}}',
  'spaces.schema.convert.run.types.other': 'RUN-TYPES {{count}}',
  'spaces.schema.convert.defineShort': 'RUN-DEFINE',
  'spaces.schema.convert.refused.head.one': REFUSED,
  'spaces.schema.convert.refused.head.other': REFUSED,
  'spaces.schema.convert.refused.listed.one': 'REF-LISTED {{count}}',
  'spaces.schema.convert.refused.listed.other': 'REF-LISTED {{count}}',
  'spaces.schema.convert.refused.item': 'REF-ITEM {{step}} :: {{reason}}',
  'spaces.schema.convert.refused.fix': 'REF-FIX',
  'spaces.schema.convert.refused.fixUnlisted': 'REF-FIX-UNLISTED',
  'spaces.schema.convert.refused.all': 'REF-ALL {{reason}}',
  'conversion.step.renameType': 'RENAME-TYPE {{from}} => {{to}}',
  'conversion.step.renameProperty': 'RENAME-PROP {{from}} => {{to}}',
  'conversion.step.mapEnum': 'MAP {{property}}: {{pairs}}',
  'conversion.step.mapPair': '{{from}}>{{to}}',
  'conversion.step.splitType': 'SPLIT {{type}} {{cases}} ELSE {{otherwise}}',
  'conversion.step.splitTypeOpen': 'SPLIT {{type}} {{cases}}',
  'conversion.step.splitCase': 'WHEN {{when}} TO {{to}}',
  'conversion.step.unknown': 'UNKNOWN-STEP {{op}}',
  'conversion.stepRefusal.property_still_declared': 'WHY-STILL-DECLARED',
  'conversion.stepRefusal.enum_not_declared_after': 'WHY-NO-ENUM',
  'conversion.stepRefusal.steps_not_signed': 'WHY-UNSIGNED',
  'conversion.stepRefusal.unknown': 'WHY-UNKNOWN {{code}}',
};

const renameProp: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'ticketRef', to: 'ticket' };
const mapEnum: ConversionStep = { op: 'mapEnum', kind: 'entity', type: 'person', property: 'sentiment', values: { pos: 'positive' } };

const status = (over: Partial<ConvertStatus> = {}): ConvertStatus => ({
  state: 'running',
  types: [{ kind: 'entity', type: 'person', done: false }],
  steps: [],
  stepsRefused: [],
  sources: [],
  startedAt: '2026-11-19T10:00:00.000Z',
  counts: { stamped: 41, rewritten: 599, unconverted: 0, moved: 0, edgesRestamped: 0 },
  left: 100,
  failures: 0,
  ...over,
});

describe('the run block', () => {
  let refusedCount: ReturnType<typeof vi.fn>;
  let countsFor: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ConvertRunBlockComponent>;

  beforeEach(() => {
    refusedCount = vi.fn(() => of(23));
    countsFor = vi.fn(() => of({ ok: false }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ConvertRunBlockComponent, getTranslocoModule({ translation: { en: WORDS } })],
      providers: [{ provide: ConversionApi, useValue: { refusedCount, countsFor } }],
    });
  });

  function mount(run: ConvertStatusAnswer | null, notice: ConvertRunNotice | null = null): HTMLElement {
    fixture = TestBed.createComponent(ConvertRunBlockComponent);
    fixture.componentRef.setInput('spaceId', 'customers');
    fixture.componentRef.setInput('status', run);
    fixture.componentRef.setInput('notice', notice);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  /** The block as the dialog shows it for a run reached from the type's button (`act`), its note (`note`) or a Save (`save`). */
  function mountFrom(run: ConvertStatusAnswer | null, from: 'save' | 'act' | 'note'): HTMLElement {
    fixture = TestBed.createComponent(ConvertRunBlockComponent);
    fixture.componentRef.setInput('spaceId', 'customers');
    fixture.componentRef.setInput('status', run);
    fixture.componentRef.setInput('from', from);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const text = (host: HTMLElement, id: string): string => host.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const bar =(host: HTMLElement): HTMLElement | null => host.querySelector('[role="progressbar"]');

  describe('running (R3, R4, R5)', () => {
    it('names the type in the code face, says Converting, and shows checked of total with the percentage as the bar\'s value', () => {
      const host = mount(status({ counts: { stamped: 41, rewritten: 599, unconverted: 0, moved: 0, edgesRestamped: 0 }, left: 160 }));
      expect(host.querySelector('.cv-run-h .cv-tn')?.textContent).toBe('person');
      expect(text(host, 'run-badge')).toBe('RUN-CONVERTING');
      // checked 640, total 800
      expect(bar(host)!.getAttribute('aria-valuenow')).toBe('80');
      expect(bar(host)!.getAttribute('aria-valuemin')).toBe('0');
      expect(bar(host)!.getAttribute('aria-valuemax')).toBe('100');
      expect(bar(host)!.getAttribute('aria-label')).toBe('RUN-ARIA 80');
      expect(text(host, 'run-label')).toBe('RUN-CHECKED done=640 total=800');
    });

    it('counts a record that moved while the run read it as checked: it is not read again', () => {
      const host = mount(status({ counts: { stamped: 10, rewritten: 10, unconverted: 5, moved: 5, edgesRestamped: 0 }, left: 30 }));
      expect(text(host, 'run-label')).toBe('RUN-CHECKED done=30 total=60');
      expect(bar(host)!.getAttribute('aria-valuenow')).toBe('50');
    });

    it('says what it did as one line of the parts that are not zero, in the order rewritten, stamped, could not, left, ending in a full stop', () => {
      const host = mount(status({ counts: { stamped: 41, rewritten: 599, unconverted: 3, moved: 0, edgesRestamped: 0 }, left: 7 }));
      expect(text(host, 'run-line')).toBe('RW=599, ST=41, UN=3, LEFT=7.');
    });

    it('leaves out each part that is zero', () => {
      const host = mount(status({ counts: { stamped: 41, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 }, left: 0 }));
      expect(text(host, 'run-line')).toBe('ST=41.');
    });

    it('sets the records that could not be converted in bold, and nothing else', () => {
      const host = mount(status({ counts: { stamped: 1, rewritten: 1, unconverted: 3, moved: 0, edgesRestamped: 0 }, left: 1 }));
      expect(Array.from(host.querySelectorAll('[data-testid="run-line"] strong')).map(e => e.textContent)).toEqual(['UN=3']);
    });

    it('groups digits for the language: 47,990 and not 47990', () => {
      const host = mount(status({ counts: { stamped: 223, rewritten: 47990, unconverted: 0, moved: 0, edgesRestamped: 0 }, left: 1000 }));
      expect(text(host, 'run-line')).toContain('RW=47,990');
      expect(text(host, 'run-label')).toBe('RUN-CHECKED done=48,213 total=49,213');
    });

    it('says the records left were not counted, and shows NO total and no percentage, when `left` is null', () => {
      const host = mount(status({ left: null }));
      expect(bar(host)!.hasAttribute('aria-valuenow')).toBe(false);
      expect(text(host, 'run-label')).toBe('RUN-COUNTING');
      expect(host.textContent).not.toContain('RUN-CHECKED');
      expect(host.textContent).not.toContain('LEFT=');
      expect(host.textContent).not.toMatch(/total=/);
    });

    it('never reads 100% of what it has read so far: with nothing counted yet the total is unknown, not the checked count', () => {
      const host = mount(status({ left: null, counts: { stamped: 5, rewritten: 5, unconverted: 0, moved: 0, edgesRestamped: 0 } }));
      expect(bar(host)!.getAttribute('aria-valuenow')).toBeNull();
      expect(bar(host)!.getAttribute('aria-label')).not.toBe('RUN-ARIA 100');
    });

    it('says the writes it could not make will be tried again, only while it runs', () => {
      expect(text(mount(status({ failures: 3 })), 'run-retry')).toBe('RUN-RETRY');
      expect(mount(status({ failures: 0 })).querySelector('[data-testid="run-retry"]')).toBeNull();
      expect(mount(status({ state: 'complete', left: 0, failures: 3 })).querySelector('[data-testid="run-retry"]')).toBeNull();
    });

    it('carries the definition of stamped and rewritten', () => {
      expect(mount(status()).textContent).toContain('RUN-DEFINE');
    });
  });

  describe('finished (R3)', () => {
    it('is Done with a full bar and no left part when nothing was left unconverted', () => {
      const host = mount(status({ state: 'complete', left: 0, finishedAt: '2026-11-19T10:05:00.000Z' }));
      expect(text(host, 'run-badge')).toBe('RUN-DONE');
      expect(bar(host)!.getAttribute('aria-valuenow')).toBe('100');
      expect(text(host, 'run-line')).toBe('RW=599, ST=41.');
    });

    it('is Done, some left when records could not be converted, and says how many in bold', () => {
      const host = mount(status({ state: 'complete', left: 0, counts: { stamped: 4111, rewritten: 44102, unconverted: 23, moved: 0, edgesRestamped: 0 } }));
      expect(text(host, 'run-badge')).toBe('RUN-DONE-SOME');
      expect(text(host, 'run-line')).toContain('UN=23');
      expect(bar(host)!.getAttribute('aria-valuenow')).toBe('100');
    });
  });

  describe('several types', () => {
    it('says how many types and shows each with a Done mark for those the run is done with', () => {
      const host = mount(status({ types: [{ kind: 'entity', type: 'client', done: true }, { kind: 'entity', type: 'customer', done: false }] }));
      expect(text(host, 'run-types')).toContain('RUN-TYPES 2');
      const rows = Array.from(host.querySelectorAll('[data-testid="run-type"]'));
      expect(rows.map(r => r.querySelector('.cv-tn')?.textContent)).toEqual(['client', 'customer']);
      expect(rows.map(r => r.textContent!.includes('RUN-DONE'))).toEqual([true, false]);
    });

    it('lists a name once however many records name it (a kind and a type is one type)', () => {
      const host = mount(status({ types: [{ kind: 'entity', type: 'a', done: false }, { kind: 'entity', type: 'a', done: false }] }));
      expect(host.querySelector('[data-testid="run-types"]')).toBeNull();
      expect(host.querySelector('.cv-run-h .cv-tn')?.textContent).toBe('a');
    });
  });

  describe('nothing to convert (R9)', () => {
    it('a run that checked and will check no record says there were none, with no bar', () => {
      const host = mount(status({ state: 'complete', left: 0, counts: { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 } }));
      expect(text(host, 'run-badge')).toBe('RUN-NOTHING');
      expect(text(host, 'run-line')).toBe('RUN-NONE-HERE');
      expect(bar(host)).toBeNull();
    });

    it('from the type\'s button or note, a run with nothing to do says the records are current, or that the type has none, never a saved schema (drive round 5)', () => {
      const nothing = status({ state: 'complete', left: 0, counts: { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 } });
      for (const from of ['act', 'note'] as const) {
        countsFor.mockReturnValue(of({ ok: true, counts: { total: 150, rewritten: 0, stamped: 150, casesCountedAsItRuns: false, wholeType: true } }));
        expect(text(mountFrom(nothing, from), 'run-line'), from).toBe('RUN-NONE-CURRENT');
        countsFor.mockReturnValue(of({ ok: true, counts: { total: 0, rewritten: 0, stamped: 0, casesCountedAsItRuns: false, wholeType: true } }));
        expect(text(mountFrom(nothing, from), 'run-line'), from).toBe('RUN-NONE-EMPTY');
      }
      expect(countsFor).toHaveBeenCalledWith('customers', { kind: 'entity', type: 'person', steps: [] });
      expect(text(mountFrom(nothing, 'save'), 'run-line'), 'a Save keeps its sentence').toBe('RUN-NONE-HERE');
    });

    it('a space that never had a run, a view that holds several, and a save that started nothing say the same', () => {
      for (const run of [{ state: 'none' } as ConvertStatusAnswer, { state: 'per_member', runs: [] } as ConvertStatusAnswer]) {
        expect(text(mount(run), 'run-line'), JSON.stringify(run)).toBe('RUN-NONE-HERE');
      }
      const host = mount(null, { state: 'nothing', types: [{ kind: 'entity', type: 'person' }] });
      expect(text(host, 'run-badge')).toBe('RUN-NOTHING');
      expect(host.querySelector('.cv-run-h .cv-tn')?.textContent).toBe('person');
      expect(bar(host)).toBeNull();
    });
  });

  describe('a run that did not start or did not finish (R11, R12)', () => {
    it('a save that could not start the run says so with the error, as an alert', () => {
      const host = mount(null, { state: 'not_started', types: [], error: 'the engine is busy' });
      expect(host.querySelector('[role="alert"]')?.textContent?.trim()).toBe('RUN-NOT-STARTED the engine is busy');
    });

    it('wins over a run of an earlier conversion that is still the last the status door knows', () => {
      const host = mount(status({ state: 'complete', left: 0 }), { state: 'not_started', types: [], error: 'x' });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('RUN-NOT-STARTED');
      expect(bar(host)).toBeNull();
    });

    it('a run that stopped says so with the error and still shows what it reached', () => {
      const host = mount(status({ state: 'failed', error: 'the store stopped answering', left: 50 }));
      expect(host.querySelector('[role="alert"]')?.textContent?.trim()).toBe('RUN-FAILED the store stopped answering');
      expect(text(host, 'run-line')).toContain('RW=599');
    });

    it('is a spinner and the loading word while neither a run nor a notice is known yet', () => {
      const host = mount(null);
      expect(host.textContent).toContain('RUN-LOADING');
      expect(bar(host)).toBeNull();
    });
  });

  describe('refused steps (R8)', () => {
    const refusedRun = (over: Partial<ConvertStatus> = {}): ConvertStatus => status({
      state: 'complete', left: 0, steps: Array.from({ length: 12 }, () => renameProp),
      stepsRefused: [{ step: renameProp, reason: 'property_still_declared' }, { step: mapEnum, reason: 'enum_not_declared_after' }],
      counts: { stamped: 4111, rewritten: 44102, unconverted: 23, moved: 0, edgesRestamped: 0 },
      ...over,
    });

    it('says how many of the steps were refused here, each as the step\'s sentence with its reason in words, the number of records listed, and what to do', () => {
      const host = mount(refusedRun());
      expect(text(host, 'run-refused-head')).toBe('REF-HEAD k=2 n=12');
      const items = Array.from(host.querySelectorAll('[data-testid="run-refused-item"]')).map(e => e.textContent!.replace(/\s+/g, ' ').trim());
      expect(items).toEqual([
        'REF-ITEM RENAME-PROP ticketRef => ticket :: WHY-STILL-DECLARED',
        'REF-ITEM MAP sentiment: pos>positive :: WHY-NO-ENUM',
      ]);
      expect(text(host, 'run-refused-listed')).toBe('REF-LISTED 23');
      expect(text(host, 'run-refused-fix')).toBe('REF-FIX');
      expect(refusedCount).toHaveBeenCalledWith('customers');
    });

    it('sets the names of a step in the code face', () => {
      const host = mount(refusedRun());
      const names = Array.from(host.querySelectorAll('[data-testid="run-refused-item"] .cv-tn')).map(e => e.textContent);
      expect(names).toEqual(['ticketRef', 'ticket', 'sentiment', 'pos', 'positive']);
    });

    it('words a reason this client does not know as the generic sentence with the code, never as a key it would build from the code', () => {
      const host = mount(refusedRun({ stepsRefused: [{ step: renameProp, reason: 'constructor' }] }));
      expect(text(host, 'run-refused-item')).toContain('WHY-UNKNOWN constructor');
      expect(host.textContent).not.toContain('conversion.stepRefusal.constructor');
    });

    it('says a vote\'s steps were all refused (no step named) in its own sentence, with no head of K of N', () => {
      const host = mount(refusedRun({ stepsRefused: [{ step: null, reason: 'steps_not_signed' }] }));
      expect(host.querySelector('[data-testid="run-refused-head"]')).toBeNull();
      expect(text(host, 'run-refused-all')).toBe('REF-ALL WHY-UNSIGNED');
    });

    it('shows a name a peer wrote as text: markup in it makes no element', () => {
      const evil = '<img src=x onerror=alert(1)>';
      const host = mount(refusedRun({ stepsRefused: [{ step: { ...renameProp, from: evil, to: evil }, reason: 'property_still_declared' }] }));
      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('[data-testid="run-refused-item"] .cv-tn')?.textContent).toBe(evil);
    });

    it('is not shown while the run is going, and asks for no count then', () => {
      const host = mount(refusedRun({ state: 'running', left: 5 }));
      expect(host.querySelector('[data-testid="run-refused-head"]')).toBeNull();
      expect(refusedCount).not.toHaveBeenCalled();
    });

    it('asks for no count when no step was refused', () => {
      mount(status({ state: 'complete', left: 0 }));
      expect(refusedCount).not.toHaveBeenCalled();
    });

    it('leaves the number of listed records out when it could not be read, and when none are listed', () => {
      refusedCount.mockReturnValue(of(null));
      expect(mount(refusedRun()).querySelector('[data-testid="run-refused-listed"]')).toBeNull();
      refusedCount.mockReturnValue(of(0));
      expect(mount(refusedRun()).querySelector('[data-testid="run-refused-listed"]')).toBeNull();
    });

    it('says the records stay listed only when Review lists some; with none listed it says only what to do, and the footer never says "Nothing left to review." (drive round 5)', () => {
      expect(text(mount(refusedRun()), 'run-refused-fix'), 'records listed').toBe('REF-FIX');
      refusedCount.mockReturnValue(of(0));
      const none = mount(refusedRun({ counts: { stamped: 640, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 } }));
      expect(text(none, 'run-refused-fix')).toBe('REF-FIX-UNLISTED');
      refusedCount.mockReturnValue(of(null));
      expect(text(mount(refusedRun()), 'run-refused-fix'), 'not known: no claim that records are listed').toBe('REF-FIX-UNLISTED');
      const done = refusedRun({ counts: { stamped: 640, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 } });
      expect(runFooterOf(done, null), 'the refusal is the thing to act on').toEqual({ kind: 'none' });
    });
  });

  describe('the footer of the finished dialog', () => {
    it('Open Review with the count is the primary when a finished run left records unconverted', () => {
      expect(runFooterOf(status({ state: 'complete', left: 0, counts: { stamped: 1, rewritten: 1, unconverted: 4, moved: 0, edgesRestamped: 0 } }), null))
        .toEqual({ kind: 'review', n: 4 });
    });

    it('Open Review (N so far) is a secondary while a running one has some', () => {
      expect(runFooterOf(status({ counts: { stamped: 1, rewritten: 1, unconverted: 2, moved: 0, edgesRestamped: 0 } }), null)).toEqual({ kind: 'reviewSoFar', n: 2 });
    });

    it('says nothing about Review while a run goes and has listed nothing yet: it may still list some (bundle-285 S10)', () => {
      expect(runFooterOf(status(), null)).toEqual({ kind: 'none' });
      expect(runFooterOf(status({ counts: { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 } }), { state: 'started', types: [] })).toEqual({ kind: 'none' });
      expect(runFooterOf(null, { state: 'started', types: [] }), 'begun, not read yet').toEqual({ kind: 'none' });
    });

    it('says "Nothing left to review." after a run that left nothing, and "Nothing to do here." when nothing is known', () => {
      expect(runFooterOf(status({ state: 'complete', left: 0 }), null)).toEqual({ kind: 'hint', key: 'spaces.schema.convert.run.nothingLeft' });
      expect(runFooterOf(null, { state: 'nothing', types: [] })).toEqual({ kind: 'hint', key: 'spaces.schema.convert.run.nothingLeft' });
      expect(runFooterOf(null, null)).toEqual({ kind: 'hint', key: 'spaces.schema.convert.run.nothingToDo' });
    });
  });

  describe('names in sentences', () => {
    it('cuts a step\'s sentence at its names so each is set in the code face, and a name cannot forge the cut', () => {
      const say = (key: string, params?: Record<string, unknown>): string => WORDS[key]!.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params?.[k] ?? ''));
      const pieces = stepPieces(say, { op: 'renameProperty', kind: 'entity', type: 'person', from: 'a\u0002b', to: 'c' });
      expect(pieces.filter(p => p.name).map(p => p.text)).toEqual(['ab', 'c']);
      expect(pieces.map(p => p.text).join('')).toBe('RENAME-PROP ab => c');
    });
  });

  describe('look', () => {
    it('lets a long name and a long sentence wrap, and cuts nothing off with an ellipsis', () => {
      const host = mount(refusedRunLong());
      const name = host.querySelector('.cv-tn') as HTMLElement;
      expect(declaredNearest(name, 'overflow-wrap', host) ?? declaredNearest(name, 'word-break', host)).toMatch(/anywhere|break-word|break-all/);
      const line = host.querySelector('[data-testid="run-line"]') as HTMLElement;
      expect(declaredNearest(line, 'text-overflow', host)).toBeNull();
    });
  });
});

function refusedRunLong(): ConvertStatus {
  return status({ types: [{ kind: 'entity', type: 'customer-support-conversation-transcript-segment', done: false }] });
}
