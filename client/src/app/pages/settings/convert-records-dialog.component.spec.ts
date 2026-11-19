/**
 * The dialog that offers converting records at Save, and its other faces (bundle-285 slice S5, Q-747; plan sections 3.1 item 4, 4, 5 rows D, N,
 * R and A, 6, 7, 9, 11; drawing moments 1a to 2b, 3a, 3b, 4a, 4b and 6, with their 390 px frames).
 *
 * One dialog, four modes: `offer` (Save with a changed type, and its networked variant), `act` (the Convert records button on a type),
 * `progress` (a run, running and finished) and `submitted` (after a vote was opened). What it makes true, and the owner's answers of
 * 2026-11-19 (plan section 11) it holds:
 *
 * - **The counts are S2's and only S2's**, per type, asked of the space: "N records of <old name>: S will only be stamped, R will be rewritten."
 *   A split says "counted as it runs" at every size, never a number before the run; under the counts sits the hint that records that do not
 *   fit are listed in Review instead; where the count cannot be read the block says so and BOTH outcomes are still offered.
 * - **One value out.** `choice` says convert, later or cancel, and for convert the complete steps (S2's `ConversionStep[]`, one list over all
 *   blocks in the order they are sent), the blocks with those steps, the types, and the types "Add a new type" made. "Save only" and Cancel
 *   carry no steps and no new type, so a host that sends `convertRecords` only for `convert` can never send it for Save only. The dialog makes
 *   no request for the save itself.
 * - **The right to convert is shown, not guessed.** Without it the convert choice is disabled with its reason, "Save only" is picked and the
 *   primary says Save; a refusal `no_right` locks the choice the same way.
 * - **Refusals are words.** A rate limit with its retry time, a conversion already running, a stale schema, a bad step on ITS row (by the index
 *   the server names among the steps sent), each through S2's typed outcome.
 * - **An offered map is not a step.** A removed enum value is a row with no target; the primary waits for a person to choose.
 * - **Layers.** Escape closes the innermost layer only: a new-type name, then the step editor, then the dialog; focus stays inside the dialog.
 * - **Names are text** (a type, a property, a rule named by a peer or a schema), in the code face.
 *
 * The words are markers (`DLG-TITLE`), so no assertion depends on the English and a key the dialog forgot shows as a raw key.
 *
 * ## Seen red
 *
 * Red at 17b7cc432 (the run block's implementation): `pages/settings/convert-records-dialog.component.ts` does not exist.
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NEVER, of, type Observable } from 'rxjs';
import { blockCounts, type ConvertBlock } from '../../core/conversion-counts';
import { ConversionApi } from '../../core/conversion-api.service';
import type { ConversionRefusal, ConversionStep, ConvertRunNotice, ConvertStatus, ConvertStatusAnswer } from '../../core/conversion.types';
import { CONVERSION_LIMITS } from '../../shared/conversion-limits';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ConvertRecordsDialogComponent, type ConvertDialogChoice } from './convert-records-dialog.component';
import type { ConvertBlockPlan, ConvertSchemas } from './convert-steps';

const COUNTS = 'DLG-COUNTS n={{count}} type={{type}} stamped={{stamped}} rewritten={{rewritten}}';
const COUNTS_HERE = 'DLG-COUNTS-HERE n={{count}} type={{type}} stamped={{stamped}} rewritten={{rewritten}}';
const SPLIT = 'DLG-SPLIT type={{type}} all={{count}}';
const SPLIT_HERE = 'DLG-SPLIT-HERE type={{type}} all={{count}}';
const BAR = 'DLG-BAR {{count}}';
const WORDS: Record<string, string> = {
  'common.cancel': 'DLG-CANCEL',
  'common.close': 'DLG-CLOSE',
  'spaces.schema.was': 'DLG-WAS {{name}}',
  'spaces.schema.convert.title': 'DLG-TITLE',
  'spaces.schema.convert.titleNet': 'DLG-TITLE-NET',
  'spaces.schema.convert.lead': 'DLG-LEAD',
  'spaces.schema.convert.twoTypes': 'DLG-TWO-TYPES',
  'spaces.schema.convert.leadNet': 'DLG-LEAD-NET {{network}}',
  'spaces.schema.convert.stepsBar.one': BAR,
  'spaces.schema.convert.stepsBar.other': BAR,
  'spaces.schema.convert.editSteps': 'DLG-EDIT-STEPS',
  'spaces.schema.convert.hideSteps': 'DLG-HIDE-STEPS',
  'spaces.schema.convert.stepCount.one': 'DLG-STEPCOUNT {{count}}',
  'spaces.schema.convert.stepCount.other': 'DLG-STEPCOUNT {{count}}',
  'spaces.schema.convert.noSteps': 'DLG-NO-STEPS',
  'spaces.schema.convert.counts.one': COUNTS,
  'spaces.schema.convert.counts.other': COUNTS,
  'spaces.schema.convert.countsHere.one': COUNTS_HERE,
  'spaces.schema.convert.countsHere.other': COUNTS_HERE,
  'spaces.schema.convert.wholeType': 'DLG-WHOLE-TYPE',
  'spaces.schema.convert.noRecords': 'DLG-NO-RECORDS {{type}}',
  'spaces.schema.convert.noRecordsShort': 'DLG-NO-RECORDS-SHORT {{type}}',
  'spaces.schema.convert.noRecordsTwo': 'DLG-NO-RECORDS-TWO',
  'spaces.schema.convert.noRecordsNet': 'DLG-NO-RECORDS-NET {{network}} {{type}}',
  'spaces.schema.convert.split.one': SPLIT,
  'spaces.schema.convert.split.other': SPLIT,
  'spaces.schema.convert.splitHere.one': SPLIT_HERE,
  'spaces.schema.convert.splitHere.other': SPLIT_HERE,
  'spaces.schema.convert.counting': 'DLG-COUNTING',
  'spaces.schema.convert.countFailed': 'DLG-COUNT-FAILED',
  'spaces.schema.convert.dialog.unfitHint': 'DLG-UNFIT-HINT',
  'spaces.schema.convert.define': 'DLG-DEFINE',
  'spaces.schema.convert.outcomesLegend': 'DLG-OUTCOMES',
  'spaces.schema.convert.now': 'DLG-NOW',
  'spaces.schema.convert.nowHint': 'DLG-NOW-HINT',
  'spaces.schema.convert.afterVote': 'DLG-AFTER-VOTE',
  'spaces.schema.convert.afterVoteHint': 'DLG-AFTER-VOTE-HINT',
  'spaces.schema.convert.later': 'DLG-LATER',
  'spaces.schema.convert.laterHint': 'DLG-LATER-HINT',
  'spaces.schema.convert.saveAndConvert': 'DLG-SAVE-AND-CONVERT',
  'spaces.schema.convert.save': 'DLG-SAVE',
  'spaces.schema.convert.submitWith': 'DLG-SUBMIT-WITH',
  'spaces.schema.convert.submitForVote': 'DLG-SUBMIT-FOR-VOTE',
  'spaces.schema.convert.lockedChoice': 'DLG-LOCKED-CHOICE',
  'spaces.schema.convert.locked': 'DLG-LOCKED',
  'spaces.schema.convert.rateLimited': 'DLG-RATE',
  'spaces.schema.convert.retryIn': 'DLG-RETRY {{seconds}}',
  'spaces.schema.convert.running409': 'DLG-RUNNING',
  'spaces.schema.convert.incomplete': 'DLG-INCOMPLETE',
  'spaces.schema.convert.warn.rule': 'DLG-WARN-RULE rule={{rule}} type={{type}} old={{property}} new={{to}}',
  'spaces.schema.convert.submitted.title': 'DLG-SUBMITTED',
  'spaces.schema.convert.submitted.lead': 'DLG-SUBMITTED-LEAD {{network}}',
  'spaces.schema.convert.submitted.after': 'DLG-SUBMITTED-AFTER',
  'spaces.schema.convert.submitted.openNetworks': 'DLG-OPEN-NETWORKS',
  'spaces.schema.convert.act.title': 'DLG-ACT-TITLE {{type}}',
  'spaces.schema.convert.act.titleShort': 'DLG-ACT-TITLE-SHORT',
  'spaces.schema.convert.act.lead': 'DLG-ACT-LEAD',
  'spaces.schema.convert.act.checked.one': 'DLG-ACT-CHECKED {{count}}',
  'spaces.schema.convert.act.checked.other': 'DLG-ACT-CHECKED {{count}}',
  'spaces.schema.convert.act.noneToCheck': 'DLG-ACT-NONE',
  'spaces.schema.convert.act.run': 'DLG-ACT-RUN',
  'spaces.schema.convert.run.titleRunning': 'DLG-RUN-TITLE-RUNNING',
  'spaces.schema.convert.run.titleRunningAct': 'DLG-RUN-TITLE-RUNNING-ACT',
  'spaces.schema.convert.run.titleDone': 'DLG-RUN-TITLE-DONE',
  'spaces.schema.convert.run.keepsRunning': 'DLG-RUN-KEEPS-RUNNING',
  'spaces.schema.convert.run.openReview': 'DLG-OPEN-REVIEW {{n}}',
  'spaces.schema.convert.run.openReviewSoFar': 'DLG-OPEN-REVIEW-SO-FAR {{n}}',
  'spaces.schema.convert.run.nothingToDo': 'DLG-NOTHING-TO-DO',
  'spaces.schema.convert.run.nothingLeft': 'DLG-NOTHING-LEFT',
  'spaces.schema.convert.run.converting': 'DLG-CONVERTING',
  'spaces.schema.convert.run.done': 'DLG-DONE',
  'spaces.schema.convert.run.doneSome': 'DLG-DONE-SOME',
  'spaces.schema.convert.run.checked.one': 'DLG-RUN-CHECKED {{done}} {{count}}',
  'spaces.schema.convert.run.checked.other': 'DLG-RUN-CHECKED {{done}} {{count}}',
  'spaces.schema.convert.run.checkedAria': 'DLG-RUN-ARIA {{pct}}',
  'spaces.schema.convert.run.line.rewritten': 'DLG-RW {{rewritten}}',
  'spaces.schema.convert.run.line.stamped': 'DLG-ST {{stamped}}',
  'spaces.schema.convert.defineShort': 'DLG-DEFINE-SHORT',
  'refusal.schemaChanged': 'DLG-STALE',
  'spaces.error.saveFailed': 'DLG-SAVE-FAILED',
  'conversion.step.renameType': 'RENAME-TYPE {{from}} => {{to}}',
  'conversion.step.renameProperty': 'RENAME-PROP {{from}} => {{to}}',
  'conversion.step.mapEnum': 'MAP {{property}}: {{pairs}}',
  'conversion.step.mapPair': '{{from}}>{{to}}',
  'conversion.step.splitType': 'SPLIT {{type}} {{cases}} ELSE {{otherwise}}',
  'conversion.step.splitTypeOpen': 'SPLIT {{type}} {{cases}}',
  'conversion.step.splitCase': 'WHEN {{when}} TO {{to}}',
  'conversion.step.unknown': 'UNKNOWN-STEP {{op}}',
  'conversion.editor.renameProperty': 'ED-RENAME-PROP',
  'conversion.editor.mapEnum': 'ED-MAP',
  'conversion.editor.renameType': 'ED-RENAME-TYPE',
  'conversion.editor.splitType': 'ED-SPLIT',
  'conversion.editor.on': 'ED-ON',
  'conversion.editor.to': 'ED-TO',
  'conversion.editor.in': 'ED-IN',
  'conversion.editor.becomes': 'ED-BECOMES',
  'conversion.editor.recordsOf': 'ED-RECORDS-OF',
  'conversion.editor.if': 'ED-IF',
  'conversion.editor.otherwise': 'ED-OTHERWISE',
  'conversion.editor.addCondition': 'ED-ADD-CONDITION',
  'conversion.editor.countedAsItRuns': 'ED-COUNTED-AS-IT-RUNS',
  'conversion.editor.help': 'ED-HELP',
  'conversion.editor.addStep': 'ED-ADD-STEP',
  'conversion.editor.remove': 'ED-REMOVE',
  'conversion.editor.removeAria': 'ED-REMOVE-ARIA {{what}}',
  'conversion.editor.addNewType': 'ED-ADD-NEW-TYPE',
  'conversion.editor.newTypeName': 'ED-NEW-TYPE-NAME',
  'conversion.editor.oldName': 'ED-OLD-NAME',
  'conversion.editor.newName': 'ED-NEW-NAME',
  'conversion.editor.oldTypeName': 'ED-OLD-TYPE-NAME',
  'conversion.editor.newTypeNameField': 'ED-NEW-TYPE-NAME-FIELD',
  'conversion.editor.property': 'ED-PROPERTY',
  'conversion.editor.oldValue': 'ED-OLD-VALUE',
  'conversion.editor.newValue': 'ED-NEW-VALUE',
  'conversion.editor.condition': 'ED-CONDITION',
  'conversion.editor.becomesType': 'ED-BECOMES-TYPE',
  'conversion.editor.typeToSplit': 'ED-TYPE-TO-SPLIT',
  'conversion.editor.addValue': 'ED-ADD-VALUE',
  'conversion.editor.removeValue': 'ED-REMOVE-VALUE',
  'spaces.schema.renameError.empty': 'ED-ERR-EMPTY',
  'spaces.schema.renameError.exists': 'ED-ERR-EXISTS',
};

const ADMIN = { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} };
const KNOWLEDGE_ONLY = { instanceAdmin: false, createSpaces: false, floor: { knowledge: 'write' }, perSpace: {} };

const renameProp: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' };
const renameType: ConversionStep = { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' };
const split: ConversionStep = { op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'properties.kind == "org"', to: 'organization' }], otherwise: 'person' };

const person: ConvertBlockPlan = { kind: 'entity', type: 'person', steps: [renameProp], offers: [], warnings: [] };
const customer: ConvertBlockPlan = { kind: 'entity', type: 'customer', was: 'client', steps: [renameType], offers: [], warnings: [] };
const contact: ConvertBlockPlan = { kind: 'entity', type: 'contact', steps: [split], offers: [], warnings: [] };

const STAGED: ConvertSchemas = {
  entity: {
    person: { propertySchemas: { employer: { type: 'string' }, status: { type: 'string', enum: ['current', 'prospect'] } } },
    customer: {}, contact: {}, organization: {},
  },
};

/** What the counts of each type are (total, rewritten); a type not listed has no records. */
const RECORDS: Record<string, { total: number; rewritten: number }> = {
  person: { total: 640, rewritten: 599 },
  client: { total: 212, rewritten: 212 },
  contact: { total: 318, rewritten: 318 },
};

describe('the convert records dialog', () => {
  let fixture: ComponentFixture<ConvertRecordsDialogComponent>;
  let choices: ConvertDialogChoice[];
  let closed: number;
  let reviews: number;
  let networks: number;
  let countsFor: ReturnType<typeof vi.fn>;

  const answerOf = (block: ConvertBlock): Observable<{ ok: true; counts: ReturnType<typeof blockCounts> } | { ok: false }> => {
    const r = RECORDS[block.was ?? block.type] ?? { total: 0, rewritten: 0 };
    return of({ ok: true as const, counts: blockCounts(block, { total: r.total, rewritten: r.rewritten }) });
  };

  beforeEach(() => {
    countsFor = vi.fn((_space: string, block: ConvertBlock) => answerOf(block));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ConvertRecordsDialogComponent, getTranslocoModule({ translation: { en: WORDS } })],
      providers: [
        { provide: ConversionApi, useValue: { countsFor, refusedCount: () => of(0) } },
      ],
    });
  });

  interface Over {
    blocks?: ConvertBlockPlan[]; network?: string | null; rights?: unknown; refusal?: ConversionRefusal | null; busy?: boolean;
    staged?: ConvertSchemas; status?: ConvertStatusAnswer | null; notice?: ConvertRunNotice | null;
  }

  function mount(mode: 'offer' | 'act' | 'progress' | 'submitted', over: Over = {}): HTMLElement {
    fixture = TestBed.createComponent(ConvertRecordsDialogComponent);
    choices = [];
    closed = 0;
    reviews = 0;
    networks = 0;
    fixture.componentInstance.choice.subscribe(c => choices.push(c));
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.componentInstance.openReview.subscribe(() => reviews++);
    fixture.componentInstance.openNetworks.subscribe(() => networks++);
    fixture.componentRef.setInput('mode', mode);
    fixture.componentRef.setInput('spaceId', 'customers');
    fixture.componentRef.setInput('blocks', over.blocks ?? []);
    fixture.componentRef.setInput('staged', over.staged ?? STAGED);
    if (over.network !== undefined) fixture.componentRef.setInput('network', over.network);
    if (over.rights !== undefined) fixture.componentRef.setInput('rights', over.rights);
    if (over.refusal !== undefined) fixture.componentRef.setInput('refusal', over.refusal);
    if (over.busy !== undefined) fixture.componentRef.setInput('busy', over.busy);
    if (over.status !== undefined) fixture.componentRef.setInput('status', over.status);
    if (over.notice !== undefined) fixture.componentRef.setInput('notice', over.notice);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const set = (name: string, value: unknown): void => { fixture.componentRef.setInput(name, value); fixture.detectChanges(); fixture.detectChanges(); };
  const q = <T extends HTMLElement>(host: ParentNode, id: string): T | null => host.querySelector<T>(`[data-testid="${id}"]`);
  const qa = <T extends HTMLElement>(host: ParentNode, id: string): T[] => Array.from(host.querySelectorAll<T>(`[data-testid="${id}"]`));
  const text = (host: ParentNode, id: string): string => q(host, id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const click = (el: HTMLElement | null): void => { expect(el, 'an element to click').not.toBeNull(); el!.click(); fixture.detectChanges(); };
  const panel = (host: HTMLElement): HTMLElement => host.querySelector('[role="dialog"]') as HTMLElement;
  const escape = (el: Element): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges();
  };
  const primary = (host: HTMLElement): HTMLButtonElement => q<HTMLButtonElement>(host, 'cv-primary')!;
  const radios = (host: HTMLElement): HTMLInputElement[] => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const lastChoice = (): ConvertDialogChoice => choices[choices.length - 1]!;

  describe('the shell', () => {
    it('is a modal dialog named by its title, with a close button that has a name, and every control named', () => {
      const host = mount('offer', { blocks: [person] });
      const p = panel(host);
      expect(p.getAttribute('aria-modal')).toBe('true');
      expect(p.getAttribute('aria-label')).toBe('DLG-TITLE');
      expect(q(host, 'cv-close')!.getAttribute('aria-label')).toBe('DLG-CLOSE');
      click(q(host, 'cv-edit-toggle'));
      const unnamed = Array.from(host.querySelectorAll<HTMLElement>('input, select, button'))
        .filter(el => !(el.getAttribute('aria-label') || (el.textContent ?? '').trim() || el.getAttribute('title') || el.closest('label')?.textContent?.trim()));
      expect(unnamed.map(e => e.outerHTML)).toEqual([]);
    });

    it('draws only in the theme\'s tokens: no colour of its own in the rules it declares', () => {
      mount('offer', { blocks: [person] });
      const rules: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) if ((rule as CSSStyleRule).selectorText?.includes('.cv-')) rules.push(rule.cssText);
      }
      expect(rules.length, 'the rules were read').toBeGreaterThan(5);
      expect(rules.filter(r => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(r))).toEqual([]);
    });

    it('holds the phone layout of the drawing: the footer wraps and the body is the only thing that scrolls', () => {
      mount('offer', { blocks: [person] });
      const css = Array.from(document.styleSheets).flatMap(s => Array.from(s.cssRules)).map(r => r.cssText).join('\n');
      expect(css).toMatch(/max-width:\s*760px/);
      expect(css).toMatch(/\.cv-dbody[^{]*\{[^}]*overflow-y:\s*auto/);
      expect(css).toMatch(/\.cv-dfoot[^{]*\{[^}]*flex-wrap:\s*wrap/);
    });
  });

  describe('offer: the head, the lead and the steps bar (D1 to D4)', () => {
    it('says the title and the lead, with the two-types prefix only when two or more types were edited', () => {
      const one = mount('offer', { blocks: [person] });
      expect(text(one, 'cv-title')).toBe('DLG-TITLE');
      expect(text(one, 'cv-lead')).toBe('DLG-LEAD');
      const two = mount('offer', { blocks: [person, customer] });
      expect(text(two, 'cv-lead')).toBe('DLG-TWO-TYPES DLG-LEAD');
    });

    it('says how many steps will be applied over all the blocks, in the order the plural family gives', () => {
      const host = mount('offer', { blocks: [person, customer] });
      expect(text(host, 'cv-steps-bar')).toBe('DLG-BAR 2');
    });

    it('says there are no steps yet, and keeps Edit steps reachable, when the blocks hold none', () => {
      const host = mount('offer', { blocks: [{ ...person, steps: [] }] });
      expect(text(host, 'cv-steps-bar')).toBe('DLG-NO-STEPS');
      expect(q(host, 'cv-edit-toggle')).not.toBeNull();
    });

    it('Edit steps opens the step editor and says Hide step editor; the button states which with aria-expanded', () => {
      const host = mount('offer', { blocks: [person] });
      const toggle = q<HTMLButtonElement>(host, 'cv-edit-toggle')!;
      expect(toggle.textContent!.trim()).toBe('DLG-EDIT-STEPS');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('app-convert-step-editor')).toBeNull();
      click(toggle);
      expect(toggle.textContent!.trim()).toBe('DLG-HIDE-STEPS');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(host.querySelector('app-convert-step-editor')).not.toBeNull();
      click(toggle);
      expect(host.querySelector('app-convert-step-editor')).toBeNull();
    });

    it('each block names its type in the code face, its old name when renamed, and how many steps it holds', () => {
      const host = mount('offer', { blocks: [person, customer] });
      const blocks = qa(host, 'cv-block');
      expect(blocks.map(b => b.querySelector('.cv-type-h .cv-tn')?.textContent)).toEqual(['person', 'customer']);
      expect(q(blocks[0]!, 'cv-was')).toBeNull();
      expect(text(blocks[1]!, 'cv-was')).toBe('DLG-WAS client');
      expect(blocks.map(b => text(b, 'cv-stepcount'))).toEqual(['DLG-STEPCOUNT 1', 'DLG-STEPCOUNT 1']);
    });

    it('shows each step as a sentence with its names in the code face, in the order the server applies them', () => {
      const both: ConvertBlockPlan = { ...customer, steps: [renameType, { op: 'renameProperty', kind: 'entity', type: 'customer', from: 'tel', to: 'phone' }] };
      const host = mount('offer', { blocks: [both] });
      const sentences = qa(host, 'cv-sentence');
      expect(sentences.map(s => s.textContent)).toEqual(['RENAME-TYPE client => customer', 'RENAME-PROP tel => phone']);
      expect(Array.from(sentences[0]!.querySelectorAll('.cv-tn')).map(e => e.textContent)).toEqual(['client', 'customer']);
    });

    it('shows a name a peer or a schema wrote as text, never as markup', () => {
      const evil = '<img src=x onerror=alert(1)>';
      const host = mount('offer', { blocks: [{ ...person, type: evil, steps: [{ ...renameProp, type: evil, from: evil, to: `${evil}2` }] }] });
      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('.cv-type-h .cv-tn')?.textContent).toBe(evil);
      expect(host.querySelector('[data-testid="cv-sentence"] .cv-tn')?.textContent).toBe(evil);
    });
  });

  describe('offer: the counts (D5 to D7, D14, the owner\'s hint)', () => {
    it('says how many records of the type, and how many will only be stamped and how many rewritten, counted for the old name of a renamed type', () => {
      const host = mount('offer', { blocks: [person, customer] });
      const lines = qa(host, 'cv-counts').map(e => e.textContent!.replace(/\s+/g, ' ').trim());
      expect(lines).toEqual([
        'DLG-COUNTS n=640 type=person stamped=41 rewritten=599',
        'DLG-COUNTS n=212 type=client stamped=0 rewritten=212',
      ]);
      expect(countsFor).toHaveBeenCalledWith('customers', expect.objectContaining({ kind: 'entity', type: 'person', steps: [renameProp] }));
      expect(countsFor).toHaveBeenCalledWith('customers', expect.objectContaining({ type: 'customer', was: 'client' }));
    });

    it('under the counts sits the hint that records which do not fit are listed in Review instead', () => {
      const host = mount('offer', { blocks: [person] });
      expect(text(qa(host, 'cv-block')[0]!, 'cv-unfit')).toBe('DLG-UNFIT-HINT');
      const after = host.querySelector('[data-testid="cv-counts"]')!.compareDocumentPosition(q(host, 'cv-unfit')!);
      expect(after & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('says the counts are for the type as a whole when a block holds two or more steps, and not for one', () => {
      const many: ConvertBlockPlan = { ...person, steps: [renameProp, { ...renameProp, from: 'a', to: 'b' }] };
      expect(text(mount('offer', { blocks: [many] }), 'cv-whole')).toBe('DLG-WHOLE-TYPE');
      expect(q(mount('offer', { blocks: [person] }), 'cv-whole')).toBeNull();
    });

    it('says there are no records of the type, with no hint about records that do not fit', () => {
      const host = mount('offer', { blocks: [{ ...person, type: 'nobody', steps: [] }, person] });
      const first = qa(host, 'cv-block')[0]!;
      expect(text(first, 'cv-counts')).toBe('DLG-NO-RECORDS nobody');
      expect(q(first, 'cv-unfit')).toBeNull();
    });

    it('a split says every record changes its type and that how many go where is counted as the conversion runs: no number per case, at any size', () => {
      for (const total of [318, 48213, 1]) {
        RECORDS['contact'] = { total, rewritten: total };
        const host = mount('offer', { blocks: [contact] });
        expect(text(host, 'cv-counts'), `${total} records`).toBe(`DLG-SPLIT type=contact all=${total.toLocaleString('en')}`);
        expect(host.textContent).not.toMatch(/match(es)? \d|121|197/);
      }
      RECORDS['contact'] = { total: 318, rewritten: 318 };
    });

    it('says the records are being counted while the answer is awaited, and offers Save meanwhile', () => {
      countsFor.mockReturnValue(NEVER);
      const host = mount('offer', { blocks: [person] });
      expect(text(host, 'cv-counts')).toBe('DLG-COUNTING');
      expect(primary(host).disabled).toBe(false);
    });

    it('says the count failed, never a zero, and still offers both outcomes', () => {
      countsFor.mockReturnValue(of({ ok: false }));
      const host = mount('offer', { blocks: [person] });
      expect(text(host, 'cv-counts')).toBe('DLG-COUNT-FAILED');
      expect(radios(host).every(r => !r.disabled)).toBe(true);
      expect(primary(host).disabled).toBe(false);
      click(primary(host));
      expect(lastChoice().outcome).toBe('convert');
    });

    it('counts again when a step that decides the counts changes', () => {
      const host = mount('offer', { blocks: [person] });
      click(q(host, 'cv-edit-toggle'));
      const calls = countsFor.mock.calls.length;
      const from = host.querySelector<HTMLInputElement>('li[data-op="renameProperty"] input[aria-label="ED-OLD-NAME"]')!;
      from.value = 'firm';
      from.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      expect(countsFor.mock.calls.length).toBeGreaterThan(calls);
      const last = countsFor.mock.calls[countsFor.mock.calls.length - 1]![1] as ConvertBlock;
      expect(last.steps).toEqual([{ ...renameProp, from: 'firm' }]);
    });

    it('does not count again when only a condition\'s text changes: nothing the counts depend on moved', () => {
      const host = mount('offer', { blocks: [contact] });
      click(q(host, 'cv-edit-toggle'));
      const calls = countsFor.mock.calls.length;
      const cond = host.querySelector<HTMLInputElement>('input[aria-label="ED-CONDITION"]')!;
      cond.value = 'properties.kind == "company"';
      cond.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      expect(countsFor.mock.calls.length).toBe(calls);
    });
  });

  describe('offer: a rule that still names the old name (warning)', () => {
    it('is a line on the type\'s block that names the rule, the old and the new name, the names in the code face', () => {
      const warned: ConvertBlockPlan = { ...person, warnings: [
        { kind: 'rule', type: 'person', rule: 'has-company', property: 'company', to: 'employer' },
      ] };
      const host = mount('offer', { blocks: [warned, customer] });
      const [first, second] = qa(host, 'cv-block');
      const lines = qa(first!, 'cv-warning');
      expect(lines.map(l => l.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
        'DLG-WARN-RULE rule=has-company type=person old=company new=employer',
      ]);
      expect(Array.from(lines[0]!.querySelectorAll('.cv-tn')).map(e => e.textContent)).toEqual(['has-company', 'person', 'company', 'employer']);
      expect(qa(second!, 'cv-warning')).toEqual([]);
    });
  });

  describe('offer: the choice (D9 to D13)', () => {
    it('carries the definition of stamped and rewritten', () => {
      expect(text(mount('offer', { blocks: [person] }), 'cv-define')).toBe('DLG-DEFINE');
    });

    it('offers Convert the records now and Save only, convert later as one group of radios, the first picked, each with its hint', () => {
      const host = mount('offer', { blocks: [person] });
      const [now, later] = radios(host);
      expect(radios(host)).toHaveLength(2);
      expect(now!.checked).toBe(true);
      expect(later!.checked).toBe(false);
      expect(now!.name).toBe(later!.name);
      expect(text(host, 'cv-outcome-now')).toContain('DLG-NOW');
      expect(text(host, 'cv-outcome-now')).toContain('DLG-NOW-HINT');
      expect(text(host, 'cv-outcome-later')).toContain('DLG-LATER-HINT');
      expect(host.querySelector('fieldset legend')?.textContent?.trim()).toBe('DLG-OUTCOMES');
    });

    it('two dialogs never share a radio group: the name is one per dialog', () => {
      const a = radios(mount('offer', { blocks: [person] }))[0]!.name;
      const b = radios(mount('offer', { blocks: [person] }))[0]!.name;
      expect(a).not.toBe(b);
    });

    it('the primary follows the radio: Save and convert, then Save', () => {
      const host = mount('offer', { blocks: [person] });
      expect(primary(host).textContent!.trim()).toBe('DLG-SAVE-AND-CONVERT');
      click(radios(host)[1]!);
      expect(primary(host).textContent!.trim()).toBe('DLG-SAVE');
    });

    it('Save and convert answers convert with the steps, the blocks, the types and no new type', () => {
      const host = mount('offer', { blocks: [person, customer] });
      click(primary(host));
      expect(lastChoice()).toEqual({
        outcome: 'convert',
        steps: [renameProp, renameType],
        blocks: [{ kind: 'entity', type: 'person', steps: [renameProp] }, { kind: 'entity', type: 'customer', was: 'client', steps: [renameType] }],
        types: [{ kind: 'entity', type: 'person' }, { kind: 'entity', type: 'customer' }],
        addedTypes: [],
      });
    });

    it('Save only answers later with NO steps, no blocks and no new type: a host that sends convertRecords only for convert never sends it here', () => {
      const host = mount('offer', { blocks: [person] });
      click(radios(host)[1]!);
      click(primary(host));
      expect(lastChoice()).toEqual({ outcome: 'later', steps: [], blocks: [], types: [], addedTypes: [] });
    });

    it('Cancel and the close button answer cancel with nothing', () => {
      const host = mount('offer', { blocks: [person] });
      click(q(host, 'cv-cancel'));
      click(q(host, 'cv-close'));
      expect(choices).toEqual([
        { outcome: 'cancel', steps: [], blocks: [], types: [], addedTypes: [] },
        { outcome: 'cancel', steps: [], blocks: [], types: [], addedTypes: [] },
      ]);
    });

    it('sends the steps in the order the server applies them, the type first, whatever order the blocks were given them in', () => {
      const shuffled: ConvertBlockPlan = { ...customer, steps: [{ op: 'renameProperty', kind: 'entity', type: 'customer', from: 'tel', to: 'phone' }, renameType] };
      click(primary(mount('offer', { blocks: [shuffled] })));
      expect(lastChoice().steps.map(s => s.op)).toEqual(['renameType', 'renameProperty']);
    });

    it('makes no request for the save itself: the counts are the only calls it makes of the server', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [ConvertRecordsDialogComponent, getTranslocoModule({ translation: { en: WORDS } })],
        providers: [provideHttpClient(), provideHttpClientTesting()],
      });
      const http = TestBed.inject(HttpTestingController);
      fixture = TestBed.createComponent(ConvertRecordsDialogComponent);
      fixture.componentRef.setInput('mode', 'offer');
      fixture.componentRef.setInput('spaceId', 'customers');
      fixture.componentRef.setInput('blocks', [person]);
      fixture.componentRef.setInput('staged', STAGED);
      fixture.detectChanges();
      const counts = http.match(r => r.url === '/api/filter');
      expect(counts.length).toBeGreaterThan(0);
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-testid="cv-primary"]')!.click();
      fixture.detectChanges();
      http.expectNone(r => r.url !== '/api/filter');
    });
  });

  describe('offer: with no records (the footer says so, and the only act is Save)', () => {
    it('hides the choice, says there is nothing to convert in the footer, and the primary Save answers later', () => {
      const host = mount('offer', { blocks: [{ ...person, type: 'nobody' }] });
      expect(radios(host)).toEqual([]);
      expect(text(host, 'cv-foot-info')).toBe('DLG-NO-RECORDS-SHORT nobody');
      expect(primary(host).textContent!.trim()).toBe('DLG-SAVE');
      click(primary(host));
      expect(lastChoice()).toEqual({ outcome: 'later', steps: [], blocks: [], types: [], addedTypes: [] });
    });

    it('says it once for two types', () => {
      const host = mount('offer', { blocks: [{ ...person, type: 'nobody' }, { ...customer, was: 'nobody-either' }] });
      expect(text(host, 'cv-foot-info')).toBe('DLG-NO-RECORDS-TWO');
    });

    it('keeps the choice when only some of the types are empty', () => {
      const host = mount('offer', { blocks: [{ ...person, type: 'nobody' }, person] });
      expect(radios(host)).toHaveLength(2);
      expect(q(host, 'cv-foot-info')).toBeNull();
    });
  });

  describe('offer: without the right to convert (D13)', () => {
    it('disables Convert the records now with its reason, picks Save only, and the primary says Save', () => {
      const host = mount('offer', { blocks: [person], rights: KNOWLEDGE_ONLY });
      const [now, later] = radios(host);
      expect(now!.disabled).toBe(true);
      expect(later!.checked).toBe(true);
      expect(text(host, 'cv-locked')).toBe('DLG-LOCKED-CHOICE');
      expect(now!.getAttribute('aria-describedby')).toBe(q(host, 'cv-locked')!.id);
      expect(primary(host).textContent!.trim()).toBe('DLG-SAVE');
      click(primary(host));
      expect(lastChoice().outcome).toBe('later');
    });

    it('offers the choice with rights it cannot read: the server decides', () => {
      const host = mount('offer', { blocks: [person], rights: null });
      expect(radios(host)[0]!.disabled).toBe(false);
      expect(q(host, 'cv-locked')).toBeNull();
    });

    it('an instance administrator may', () => {
      expect(radios(mount('offer', { blocks: [person], rights: ADMIN }))[0]!.disabled).toBe(false);
    });
  });

  describe('offer: the networked variant (N1 to N5)', () => {
    it('says it is a vote: its title, its lead naming the network, "here" in the counts, Convert after the vote and Submit with conversion', () => {
      const host = mount('offer', { blocks: [person], network: 'Acme team' });
      expect(text(host, 'cv-title')).toBe('DLG-TITLE-NET');
      expect(text(host, 'cv-lead')).toBe('DLG-LEAD-NET Acme team');
      expect(text(host, 'cv-counts')).toBe('DLG-COUNTS-HERE n=640 type=person stamped=41 rewritten=599');
      expect(text(host, 'cv-outcome-now')).toContain('DLG-AFTER-VOTE-HINT');
      expect(text(host, 'cv-outcome-now')).not.toContain('DLG-NOW-HINT');
      expect(primary(host).textContent!.trim()).toBe('DLG-SUBMIT-WITH');
      click(radios(host)[1]!);
      expect(primary(host).textContent!.trim()).toBe('DLG-SUBMIT-FOR-VOTE');
    });

    it('a split says "here" too', () => {
      expect(text(mount('offer', { blocks: [contact], network: 'Acme team' }), 'cv-counts')).toBe('DLG-SPLIT-HERE type=contact all=318');
    });

    it('with no records says the vote is opened and there is nothing to convert, and the primary is Submit for vote', () => {
      const host = mount('offer', { blocks: [{ ...person, type: 'nobody' }], network: 'Acme team' });
      expect(text(host, 'cv-foot-info')).toBe('DLG-NO-RECORDS-NET Acme team nobody');
      expect(primary(host).textContent!.trim()).toBe('DLG-SUBMIT-FOR-VOTE');
    });
  });

  describe('offer: refusals in words (D15)', () => {
    const refusalLine = (host: HTMLElement): string => text(host, 'cv-refusal');

    it('a rate limit says so, and when to try again when the server said', () => {
      expect(refusalLine(mount('offer', { blocks: [person], refusal: { kind: 'rate_limited', retryAfterSeconds: null } }))).toBe('DLG-RATE');
      expect(refusalLine(mount('offer', { blocks: [person], refusal: { kind: 'rate_limited', retryAfterSeconds: 30 } }))).toBe('DLG-RATE DLG-RETRY 30');
    });

    it('a conversion already running, a stale schema and any other refusal say so in words, never a code', () => {
      expect(refusalLine(mount('offer', { blocks: [person], refusal: { kind: 'running' } }))).toBe('DLG-RUNNING');
      expect(refusalLine(mount('offer', { blocks: [person], refusal: { kind: 'stale' } }))).toBe('DLG-STALE');
      expect(refusalLine(mount('offer', { blocks: [person], refusal: { kind: 'other', status: 500, code: 'boom', error: 'the server\'s sentence' } }))).toBe('the server\'s sentence');
      expect(refusalLine(mount('offer', { blocks: [person], refusal: { kind: 'other', status: 0, error: '' } }))).toBe('DLG-SAVE-FAILED');
      expect(refusalLine(mount('offer', { blocks: [person], refusal: { kind: 'needs_meta' } }))).toBe('DLG-SAVE-FAILED');
    });

    it('a refusal for want of the right locks the choice, as if the rights had said so', () => {
      const host = mount('offer', { blocks: [person], rights: ADMIN, refusal: { kind: 'no_right', code: 'space_admin_required', error: 'x' } });
      expect(radios(host)[0]!.disabled).toBe(true);
      expect(radios(host)[1]!.checked).toBe(true);
      expect(text(host, 'cv-locked')).toBe('DLG-LOCKED-CHOICE');
    });

    it('a bad step is shown under its own row, by the index the server names among the steps SENT, with the editor open on it and focus on its sentence', () => {
      const host = mount('offer', { blocks: [person, { ...customer, steps: [renameType, { op: 'renameProperty', kind: 'entity', type: 'customer', from: 'tel', to: 'phone' }] }] });
      set('refusal', { kind: 'bad_step', step: 2, error: 'the schema before does not declare tel' });
      const alerts = Array.from(host.querySelectorAll('li.cv-step [role="alert"]'));
      expect(alerts.map(a => a.textContent?.trim())).toEqual(['the schema before does not declare tel']);
      expect(alerts[0]!.closest('li')!.getAttribute('data-op')).toBe('renameProperty');
      expect(alerts[0]!.closest('[data-testid="cv-block"]')!.querySelector('.cv-type-h .cv-tn')?.textContent).toBe('customer');
      expect(q(host, 'cv-edit-toggle')!.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(alerts[0]);
    });

    it('a bad step whose index names no row is shown in the footer instead of being lost', () => {
      const host = mount('offer', { blocks: [person], refusal: { kind: 'bad_step', step: 9, error: 'the server says no' } });
      expect(refusalLine(host)).toBe('the server says no');
    });

    it('shows no refusal when there is none, and disables the buttons while the save is in flight', () => {
      const host = mount('offer', { blocks: [person], busy: true });
      expect(q(host, 'cv-refusal')).toBeNull();
      expect(primary(host).disabled).toBe(true);
      expect(q<HTMLButtonElement>(host, 'cv-cancel')!.disabled).toBe(true);
      expect(host.querySelector('[data-testid="cv-primary"] .spinner')).not.toBeNull();
    });
  });

  describe('offer: the steps the owner can edit, and the maps it offers', () => {
    const withOffer: ConvertBlockPlan = { ...person, steps: [], offers: [{ kind: 'entity', type: 'person', property: 'status', removed: ['active', 'lead'] }] };

    it('an offered map opens the editor on a row with no target, which is not a step: Convert waits, Save only does not, and the hint says why', () => {
      const host = mount('offer', { blocks: [withOffer] });
      expect(q(host, 'cv-edit-toggle')!.getAttribute('aria-expanded')).toBe('true');
      expect(host.querySelectorAll('li[data-op="mapEnum"]')).toHaveLength(1);
      expect(primary(host).disabled).toBe(true);
      expect(text(host, 'cv-incomplete')).toBe('DLG-INCOMPLETE');
      click(radios(host)[1]!);
      expect(primary(host).disabled).toBe(false);
      expect(q(host, 'cv-incomplete')).toBeNull();
    });

    it('choosing a target for each value makes it a step, which Save and convert then sends', () => {
      const host = mount('offer', { blocks: [withOffer] });
      const pickers = Array.from(host.querySelectorAll<HTMLSelectElement>('select[aria-label="ED-NEW-VALUE"]'));
      expect(pickers).toHaveLength(2);
      for (const picker of pickers) {
        picker.selectedIndex = Array.from(picker.options).findIndex(o => o.textContent?.trim() === 'current');
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        fixture.detectChanges();
      }
      expect(primary(host).disabled).toBe(false);
      click(primary(host));
      expect(lastChoice().steps).toEqual([{ op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { active: 'current', lead: 'current' } }]);
    });

    it('a row a person removes is not sent and no longer holds the primary', () => {
      const host = mount('offer', { blocks: [withOffer] });
      click(host.querySelector<HTMLButtonElement>('li[data-op="mapEnum"] button[title="ED-REMOVE"]'));
      expect(primary(host).disabled).toBe(false);
      click(primary(host));
      expect(lastChoice().steps).toEqual([]);
    });

    it('a step added in the editor is a step once it is complete, and the step bar and the block count it', () => {
      const host = mount('offer', { blocks: [{ ...person, steps: [] }] });
      click(q(host, 'cv-edit-toggle'));
      Array.from(host.querySelectorAll<HTMLButtonElement>('.cv-add button')).find(b => b.textContent?.includes('ED-RENAME-PROP'))!.click();
      fixture.detectChanges();
      expect(primary(host).disabled).toBe(true);
      const inputs = Array.from(host.querySelectorAll<HTMLInputElement>('li[data-op="renameProperty"] input'));
      inputs[0]!.value = 'nick';
      inputs[0]!.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      inputs[1]!.value = 'alias';
      inputs[1]!.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      expect(primary(host).disabled).toBe(false);
      expect(text(host, 'cv-steps-bar')).toBe('DLG-BAR 1');
      click(primary(host));
      expect(lastChoice().steps).toEqual([{ op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' }]);
    });

    it('holds the whole conversion to the most steps the server takes: past it no step is offered', () => {
      const many: ConvertBlockPlan = { ...person, steps: Array.from({ length: CONVERSION_LIMITS.stepsMax }, (_, i) => ({ ...renameProp, from: `a${i}`, to: `b${i}` })) };
      const host = mount('offer', { blocks: [many] });
      click(q(host, 'cv-edit-toggle'));
      expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.cv-add button')).every(b => b.disabled)).toBe(true);
    });

    it('Add a new type is reported with the steps: the type, as a copy of its source, and the split that targets it', () => {
      const host = mount('offer', { blocks: [contact] });
      click(q(host, 'cv-edit-toggle'));
      const picker = host.querySelector<HTMLSelectElement>('select[aria-label="ED-BECOMES-TYPE"]')!;
      picker.selectedIndex = Array.from(picker.options).findIndex(o => o.hasAttribute('data-add'));
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      const field = host.querySelector<HTMLInputElement>('input[aria-label="ED-NEW-TYPE-NAME"]')!;
      field.value = 'partner';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      fixture.detectChanges();
      click(primary(host));
      expect(lastChoice().addedTypes).toEqual([{ kind: 'entity', name: 'partner', copyOf: 'contact' }]);
      expect((lastChoice().steps[0] as Extract<ConversionStep, { op: 'splitType' }>).cases[0]!.to).toBe('partner');
    });

    it('a new type made and then not converted (Save only) is not reported: its split is not sent', () => {
      const host = mount('offer', { blocks: [contact] });
      click(q(host, 'cv-edit-toggle'));
      const picker = host.querySelector<HTMLSelectElement>('select[aria-label="ED-BECOMES-TYPE"]')!;
      picker.selectedIndex = Array.from(picker.options).findIndex(o => o.hasAttribute('data-add'));
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      const field = host.querySelector<HTMLInputElement>('input[aria-label="ED-NEW-TYPE-NAME"]')!;
      field.value = 'partner';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      fixture.detectChanges();
      click(radios(host)[1]!);
      click(primary(host));
      expect(lastChoice()).toEqual({ outcome: 'later', steps: [], blocks: [], types: [], addedTypes: [] });
    });
  });

  describe('layers: Escape closes the innermost one (the editor before the dialog), focus stays inside', () => {
    it('Escape with the editor open closes the editor and leaves the dialog; the next Escape cancels', () => {
      const host = mount('offer', { blocks: [person] });
      const toggle = q<HTMLButtonElement>(host, 'cv-edit-toggle')!;
      click(toggle);
      escape(panel(host));
      expect(host.querySelector('app-convert-step-editor')).toBeNull();
      expect(choices).toEqual([]);
      expect(document.activeElement).toBe(toggle);
      escape(panel(host));
      expect(lastChoice().outcome).toBe('cancel');
    });

    it('Escape in the new type\'s name closes that field only: the editor stays open and the dialog too', () => {
      const host = mount('offer', { blocks: [contact] });
      click(q(host, 'cv-edit-toggle'));
      const picker = host.querySelector<HTMLSelectElement>('select[aria-label="ED-BECOMES-TYPE"]')!;
      picker.selectedIndex = Array.from(picker.options).findIndex(o => o.hasAttribute('data-add'));
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      const field = host.querySelector<HTMLInputElement>('input[aria-label="ED-NEW-TYPE-NAME"]')!;
      escape(field);
      expect(host.querySelector('input[aria-label="ED-NEW-TYPE-NAME"]')).toBeNull();
      expect(host.querySelector('app-convert-step-editor')).not.toBeNull();
      expect(choices).toEqual([]);
    });

    it('Escape in the progress and submitted faces closes the dialog; in the act it cancels', () => {
      const progress = mount('progress', { status: null });
      escape(panel(progress));
      expect(closed).toBe(1);
      const submitted = mount('submitted', { blocks: [person], network: 'Acme team' });
      escape(panel(submitted));
      expect(closed).toBe(1);
      const act = mount('act', { blocks: [{ kind: 'entity', type: 'invoice', steps: [], offers: [], warnings: [] }] });
      escape(panel(act));
      expect(lastChoice().outcome).toBe('cancel');
    });
  });

  describe('act: Convert records from the type (A1 to A6)', () => {
    const invoice: ConvertBlockPlan = { kind: 'entity', type: 'invoice', steps: [], offers: [], warnings: [] };
    beforeEach(() => { RECORDS['invoice'] = { total: 412, rewritten: 0 }; });

    it('says Convert records of the type, the lead, the type with no steps yet, how many records are checked, the editor\'s add row and the definition', () => {
      const host = mount('act', { blocks: [invoice] });
      expect(text(host, 'cv-title')).toBe('DLG-ACT-TITLE invoice');
      expect(text(host, 'cv-lead')).toBe('DLG-ACT-LEAD');
      expect(text(host, 'cv-stepcount')).toBe('DLG-NO-STEPS');
      expect(text(host, 'cv-counts')).toBe('DLG-ACT-CHECKED 412');
      expect(host.querySelector('.cv-add')).not.toBeNull();
      expect(host.querySelector('li.cv-step')).toBeNull();
      expect(text(host, 'cv-define')).toBe('DLG-DEFINE');
      expect(q(host, 'cv-edit-toggle')).toBeNull();
      expect(radios(host)).toEqual([]);
    });

    it('names a long type "this type" instead of the name', () => {
      const long = 'customer-support-conversation-transcript-segment';
      expect(text(mount('act', { blocks: [{ ...invoice, type: long }] }), 'cv-title')).toBe('DLG-ACT-TITLE-SHORT');
    });

    it('converts with the steps the person added, as one convert answer', () => {
      const host = mount('act', { blocks: [invoice] });
      Array.from(host.querySelectorAll<HTMLButtonElement>('.cv-add button')).find(b => b.textContent?.includes('ED-RENAME-PROP'))!.click();
      fixture.detectChanges();
      const inputs = Array.from(host.querySelectorAll<HTMLInputElement>('li[data-op="renameProperty"] input'));
      inputs[0]!.value = 'a';
      inputs[0]!.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      inputs[1]!.value = 'b';
      inputs[1]!.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      expect(text(host, 'cv-primary')).toBe('DLG-ACT-RUN');
      click(primary(host));
      expect(lastChoice()).toEqual({
        outcome: 'convert', steps: [{ op: 'renameProperty', kind: 'entity', type: 'invoice', from: 'a', to: 'b' }],
        blocks: [{ kind: 'entity', type: 'invoice', steps: [{ op: 'renameProperty', kind: 'entity', type: 'invoice', from: 'a', to: 'b' }] }],
        types: [{ kind: 'entity', type: 'invoice' }], addedTypes: [],
      });
    });

    it('converts with no steps too: stamping what fits is the act', () => {
      click(primary(mount('act', { blocks: [invoice] })));
      expect(lastChoice()).toMatchObject({ outcome: 'convert', steps: [] });
    });

    it('with no records to check, says so, and Convert records is disabled', () => {
      const host = mount('act', { blocks: [{ ...invoice, type: 'empty' }] });
      expect(text(host, 'cv-counts')).toBe('DLG-ACT-NONE');
      expect(primary(host).disabled).toBe(true);
    });

    it('without the right to convert, Convert records is disabled and the reason is shown', () => {
      const host = mount('act', { blocks: [invoice], rights: KNOWLEDGE_ONLY });
      expect(primary(host).disabled).toBe(true);
      expect(text(host, 'cv-locked')).toBe('DLG-LOCKED');
    });

    it('a conversion already running is said in words', () => {
      expect(text(mount('act', { blocks: [invoice], refusal: { kind: 'running' } }), 'cv-refusal')).toBe('DLG-RUNNING');
    });
  });

  describe('submitted: after a vote was opened (N6)', () => {
    it('says the change was submitted, names the network, shows the block with the counts "here" and when the conversion happens, and leads to Networks', () => {
      const host = mount('submitted', { blocks: [person], network: 'Acme team' });
      expect(text(host, 'cv-title')).toBe('DLG-SUBMITTED');
      expect(text(host, 'cv-lead')).toBe('DLG-SUBMITTED-LEAD Acme team');
      expect(text(host, 'cv-counts')).toBe('DLG-COUNTS-HERE n=640 type=person stamped=41 rewritten=599');
      expect(qa(host, 'cv-sentence').map(s => s.textContent)).toEqual(['RENAME-PROP company => employer']);
      expect(text(host, 'cv-after')).toBe('DLG-SUBMITTED-AFTER');
      expect(radios(host)).toEqual([]);
      expect(q(host, 'cv-edit-toggle')).toBeNull();
      expect(text(host, 'cv-primary')).toBe('DLG-OPEN-NETWORKS');
      click(primary(host));
      expect(networks).toBe(1);
    });

    it('with no records leaves the block out, as drawn', () => {
      const host = mount('submitted', { blocks: [{ ...person, type: 'nobody' }], network: 'Acme team' });
      expect(qa(host, 'cv-block')).toEqual([]);
    });
  });

  describe('progress: a run, running and finished (R1 to R12)', () => {
    const run = (over: Partial<ConvertStatus> = {}): ConvertStatus => ({
      state: 'running', types: [{ kind: 'entity', type: 'person', done: false }], steps: [], stepsRefused: [], sources: [], startedAt: '2026-11-19T10:00:00.000Z',
      counts: { stamped: 41, rewritten: 599, unconverted: 0, moved: 0, edgesRestamped: 0 }, left: 100, failures: 0, ...over,
    });

    it('running: says Schema saved, converting records, that closing keeps it running, and shows the run block; the footer says nothing about Review yet', () => {
      const host = mount('progress', { status: run() });
      expect(text(host, 'cv-title')).toBe('DLG-RUN-TITLE-RUNNING');
      expect(text(host, 'cv-lead')).toBe('DLG-RUN-KEEPS-RUNNING');
      expect(host.querySelector('app-convert-run-block [role="progressbar"]')).not.toBeNull();
      expect(q(host, 'cv-foot-hint'), 'no "Nothing to do here." while the run may still list records (bundle-285 S10)').toBeNull();
      expect(q(host, 'cv-open-review')).toBeNull();
      expect(text(host, 'cv-foot')).toBe('');
    });

    it('a run just begun (the save or start said started, no status read yet) is running, never finished (bundle-285 S10)', () => {
      const host = mount('progress', { status: null, notice: { state: 'started', types: [{ kind: 'entity', type: 'person' }] } });
      expect(text(host, 'cv-title')).toBe('DLG-RUN-TITLE-RUNNING');
      expect(text(host, 'cv-lead')).toBe('DLG-RUN-KEEPS-RUNNING');
    });

    it('a run the Convert act started says only that records are converted: the act saved no schema (bundle-285 S10, drive D3)', () => {
      const host = mount('progress', { status: run() });
      set('byAct', true);
      expect(text(host, 'cv-title')).toBe('DLG-RUN-TITLE-RUNNING-ACT');
    });

    it('running with some unconverted: Open Review (N so far) is a secondary button', () => {
      const host = mount('progress', { status: run({ counts: { stamped: 1, rewritten: 1, unconverted: 4, moved: 0, edgesRestamped: 0 } }) });
      const button = q<HTMLButtonElement>(host, 'cv-open-review')!;
      expect(button.textContent!.trim()).toBe('DLG-OPEN-REVIEW-SO-FAR 4');
      expect(button.classList.contains('btn-secondary')).toBe(true);
      click(button);
      expect(reviews).toBe(1);
    });

    it('finished: says Conversion finished, no lead, and Open Review (N) is the one primary when records are left', () => {
      const host = mount('progress', { status: run({ state: 'complete', left: 0, counts: { stamped: 4111, rewritten: 44102, unconverted: 4, moved: 0, edgesRestamped: 0 } }) });
      expect(text(host, 'cv-title')).toBe('DLG-RUN-TITLE-DONE');
      expect(q(host, 'cv-lead')).toBeNull();
      const button = q<HTMLButtonElement>(host, 'cv-open-review')!;
      expect(button.textContent!.trim()).toBe('DLG-OPEN-REVIEW 4');
      expect(button.classList.contains('btn-primary')).toBe(true);
    });

    it('finished with nothing left: the footer says nothing is left to review', () => {
      expect(text(mount('progress', { status: run({ state: 'complete', left: 0 }) }), 'cv-foot-hint')).toBe('DLG-NOTHING-LEFT');
    });

    it('a save that started nothing, and one that could not start the run, are shown by the run block', () => {
      const nothing = mount('progress', { notice: { state: 'nothing', types: [{ kind: 'entity', type: 'person' }] } });
      expect(text(nothing, 'cv-title')).toBe('DLG-RUN-TITLE-DONE');
      expect(nothing.querySelector('app-convert-run-block')!.textContent).toContain('person');
    });

    it('the close button and Escape say the dialog was closed; they are not a cancel of anything', () => {
      const host = mount('progress', { status: run() });
      click(q(host, 'cv-close'));
      expect(closed).toBe(1);
      expect(choices).toEqual([]);
    });
  });
});
