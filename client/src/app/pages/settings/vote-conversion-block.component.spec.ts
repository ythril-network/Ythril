/**
 * The conversion block of a vote row (bundle-285 slice S8, Q-940; plan sections 3.1 item 10, 5 rows W2 to W4, 6, 8; drawing moment 4c).
 *
 * A member votes on what will happen to its own records. A schema round carries `convertRecords`, and the row used to hide it. These specs
 * hold what the block must make true, in the pieces a later change could drop without any other test noticing:
 *
 * - the round's steps become one block per type that holds records here, the records of a renamed type named by their OLD name, the target
 *   of a split given no block of its own, and a step list a peer sent badly gives nothing instead of an error;
 * - the steps are read as sentences in the server's order (type steps first), every name as TEXT in a `.cv-tn` span, never as markup, and
 *   a step this client has no words for is a visible line, never a blank one and never a thrown error;
 * - the counts are THIS instance's: asked of the round's local space (not the network's id), only when the token may read it, and where they
 *   cannot be read the block shows no number, so a voter is never told a number that was not counted;
 * - a space with no records here says so alone, as the drawing does (nothing would be converted).
 *
 * The words are markers (`CONV-HEAD`), so no assertion depends on the English wording, and a key the block forgot shows as a raw key.
 *
 * ## Seen red
 *
 * Red on the bundle branch at 34ed9538b: `vote-conversion-block.component.ts` does not exist, and `convertBlocksOfRound` and
 * `orderedConversionSteps` are not exported by `core/vote-round-view.ts`.
 *
 * Slice S8b (Q-940) changed the two places that were the block's own guard: a step with no words, or a wrong shape, is now said by
 * `stepSentence` itself (the unknown-step sentence, no longer the bare operation name), and a count that failed, or a round with no space
 * here, now says so in words. Red on the bundle branch at 653766f53: those lines were the operation name alone and the two sentences did
 * not exist.
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import type { ConversionStep } from '../../core/conversion.types';
import { convertBlocksOfRound, orderedConversionSteps } from '../../core/vote-round-view';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { declaredNearest } from '../../testing/declared-style';
import { VoteConversionBlockComponent } from './vote-conversion-block.component';

const COUNTS = 'CONV-COUNTS n={{count}} type={{type}} stamped={{stamped}} rewritten={{rewritten}}';
const WORDS: Record<string, string> = {
  'networks.network.votes.convert.head': 'CONV-HEAD',
  'networks.network.votes.convert.counts.one': COUNTS,
  'networks.network.votes.convert.counts.other': COUNTS,
  'networks.network.votes.convert.none': 'CONV-NONE type={{type}}',
  'brain.review.unconverted.rung': 'CONV-NO-READ-RIGHT',
  'spaces.schema.convert.counting': 'CONV-COUNTING',
  'conversion.step.renameType': 'RENAME-TYPE {{from}} => {{to}}',
  'conversion.step.renameProperty': 'RENAME-PROP {{from}} => {{to}}',
  'conversion.step.mapEnum': 'MAP {{property}}: {{pairs}}',
  'conversion.step.mapPair': '{{from}}>{{to}}',
  'conversion.step.splitType': 'SPLIT {{type}} {{cases}} ELSE {{otherwise}}',
  'conversion.step.splitTypeOpen': 'SPLIT {{type}} {{cases}}',
  'conversion.step.splitCase': 'WHEN {{when}} TO {{to}}',
  'conversion.step.unknown': 'UNKNOWN-STEP {{op}}',
  'networks.network.votes.convert.countFailed': 'CONV-COUNT-FAILED',
  'networks.network.votes.convert.noSpace': 'CONV-NO-SPACE',
};

const renameProp: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' };
const renameType: ConversionStep = { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' };
const mapEnum: ConversionStep = { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { active: 'current', lead: 'prospect' } };
const split: ConversionStep = {
  op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'properties.kind == "org"', to: 'organization' }], otherwise: 'person',
};

describe('the blocks of a round\'s conversion', () => {
  it('a property step belongs to the type it names, of the kind it names', () => {
    expect(convertBlocksOfRound([renameProp])).toEqual([{ kind: 'entity', type: 'person', steps: [renameProp] }]);
  });

  it('a type rename and a property step on its NEW name are one block, whose records are held under the OLD name', () => {
    const onNew: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'customer', from: 'tel', to: 'phone' };
    expect(convertBlocksOfRound([renameType, onNew])).toEqual([
      { kind: 'entity', type: 'customer', was: 'client', steps: [renameType, onNew] },
    ]);
  });

  it('a split counts the records of the type it splits and gives its target types no block', () => {
    expect(convertBlocksOfRound([split])).toEqual([{ kind: 'entity', type: 'contact', steps: [split] }]);
  });

  it('two types are two blocks in the order they first appear, and the same name under two kinds stays apart', () => {
    const edge: ConversionStep = { op: 'renameProperty', kind: 'edge', type: 'person', from: 'a', to: 'b' };
    const blocks = convertBlocksOfRound([renameProp, split, mapEnum, edge]);
    expect(blocks.map(b => `${b.kind}:${b.type}`)).toEqual(['entity:person', 'entity:contact', 'edge:person']);
    expect(blocks[0]!.steps).toEqual([renameProp, mapEnum]);
  });

  it('anything but a list of steps gives no block, and an entry that is not a step is skipped: a peer wrote it', () => {
    for (const bad of [undefined, null, 'x', 7, {}, { steps: [] }]) {
      expect(convertBlocksOfRound(bad as never), `for ${JSON.stringify(bad)}`).toEqual([]);
    }
    expect(convertBlocksOfRound([null, 4, 'x', { nothing: 1 }, renameProp] as never)).toEqual([{ kind: 'entity', type: 'person', steps: [renameProp] }]);
  });

  it('puts type steps first, then property renames, then value maps, each group in the order given: the order the server applies them', () => {
    const another: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'x', to: 'y' };
    expect(orderedConversionSteps([mapEnum, renameProp, split, another, renameType]))
      .toEqual([split, renameType, renameProp, another, mapEnum]);
  });

  it('does not change the list it was given', () => {
    const given = [mapEnum, renameType];
    orderedConversionSteps(given);
    expect(given).toEqual([mapEnum, renameType]);
  });
});

describe('the conversion block of a vote row', () => {
  let http: HttpTestingController;

  const ADMIN = { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} };
  const NO_READ = { instanceAdmin: false, createSpaces: false, floor: { knowledge: 'none', schema: 'read' }, perSpace: {} };
  const READS_ONE_SPACE = { instanceAdmin: false, createSpaces: false, floor: { knowledge: 'none' }, perSpace: { 'team-notes': { knowledge: 'read' } } };

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [VoteConversionBlockComponent, getTranslocoModule({ translation: { en: WORDS } })],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  /** `null` is a round that names no local space (an argument left out is `team-notes`: a default parameter swallows `undefined`). */
  function mount(steps: unknown, localSpaceId: string | null = 'team-notes'): ComponentFixture<VoteConversionBlockComponent> {
    const fixture = TestBed.createComponent(VoteConversionBlockComponent);
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('localSpaceId', localSpaceId ?? undefined);
    fixture.detectChanges();
    return fixture;
  }
  const rightsAre = (rights: unknown): void => { http.expectOne('/api/tokens/me').flush({ id: 't', name: 't', rights }); };
  const filterBody = (r: TestRequest) => r.request.body as { space: string; filter: Record<string, unknown> };
  /** Answer the counts of a one-property-step block: the type's records, then the rewritten ones. */
  function countsAre(total: number, rewritten: number): TestRequest[] {
    const requests = http.match('/api/filter');
    for (const r of requests) {
      const n = '$or' in filterBody(r).filter ? rewritten : total;
      r.flush({ ok: true, data: { results: [], total: n, limit: 1, skip: 0, truncated: n > 1 } });
    }
    return requests;
  }
  const text = (f: ComponentFixture<VoteConversionBlockComponent>): string => (f.nativeElement as HTMLElement).textContent ?? '';
  const names = (f: ComponentFixture<VoteConversionBlockComponent>): string[] =>
    Array.from((f.nativeElement as HTMLElement).querySelectorAll('.cv-tn')).map(e => e.textContent ?? '');
  const items = (f: ComponentFixture<VoteConversionBlockComponent>): string[] =>
    Array.from((f.nativeElement as HTMLElement).querySelectorAll('li')).map(e => (e.textContent ?? '').trim());
  const state = (f: ComponentFixture<VoteConversionBlockComponent>): string | null =>
    (f.nativeElement as HTMLElement).querySelector('[data-counts]')?.getAttribute('data-counts') ?? null;

  it('says what comes with the change: the heading, then each step as a sentence, names as text in `.cv-tn` spans', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    countsAre(640, 599);
    f.detectChanges();
    expect(text(f)).toContain('CONV-HEAD');
    expect(items(f)).toEqual(['RENAME-PROP company => employer']);
    expect(names(f).slice(0, 2), 'the names of the step are not in name spans').toEqual(['company', 'employer']);
  });

  it('puts the steps in the server\'s order, not the order the proposer wrote them', () => {
    const f = mount([mapEnum, renameProp, renameType]);
    rightsAre(ADMIN);
    countsAre(10, 4);
    f.detectChanges();
    expect(items(f).map(s => s.split(' ')[0])).toEqual(['RENAME-TYPE', 'RENAME-PROP', 'MAP']);
  });

  it('words a map and a split with their pairs and cases', () => {
    const f = mount([mapEnum, split]);
    rightsAre(ADMIN);
    countsAre(10, 4);
    f.detectChanges();
    expect(items(f)).toEqual([
      'SPLIT contact WHEN properties.kind == "org" TO organization ELSE person',
      'MAP status: active>current, lead>prospect',
    ]);
  });

  it('counts THIS instance\'s records, in the round\'s local space, and says stamped and rewritten', () => {
    const f = mount([renameProp], 'team-notes');
    rightsAre(ADMIN);
    const asked = countsAre(640, 599);
    f.detectChanges();
    expect(asked.length).toBe(2);
    expect(asked.every(r => filterBody(r).space === 'team-notes'), 'a count asked of another space than the one this instance holds').toBe(true);
    expect(text(f)).toContain('CONV-COUNTS n=640 type=person stamped=41 rewritten=599');
    expect(state(f)).toBe('ready');
    expect(names(f)).toContain('person');
  });

  it('names the records of a renamed type by the name this instance holds them under', () => {
    const f = mount([renameType]);
    rightsAre(ADMIN);
    const asked = countsAre(212, 212);
    f.detectChanges();
    expect(asked.map(r => filterBody(r).filter['type'])).toEqual([{ $eq: 'client', $not: { $type: 'array' } }]);
    expect(text(f)).toContain('type=client');
    expect(text(f)).not.toContain('type=customer');
  });

  it('shows the single record sentence for one record', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    countsAre(1, 1);
    f.detectChanges();
    expect(text(f)).toContain('CONV-COUNTS n=1 type=person stamped=0 rewritten=1');
  });

  it('says there are no records alone when every block is empty here: no heading, no steps (as drawn)', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    countsAre(0, 0);
    f.detectChanges();
    expect(text(f)).toContain('CONV-NONE type=person');
    expect(text(f)).not.toContain('CONV-HEAD');
    expect(items(f)).toEqual([]);
    expect(text(f)).not.toContain('CONV-COUNTS');
  });

  it('two types: a type with records gets its counts and one without says none, the steps staying', () => {
    const other: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'invoice', from: 'a', to: 'b' };
    const f = mount([renameProp, other]);
    rightsAre(ADMIN);
    for (const r of http.match('/api/filter')) {
      const body = filterBody(r);
      const n = (body.filter['type'] as { $eq: string }).$eq === 'person' ? 5 : 0;
      r.flush({ ok: true, data: { results: [], total: n, limit: 1, skip: 0, truncated: false } });
    }
    f.detectChanges();
    expect(text(f)).toContain('CONV-HEAD');
    expect(items(f).length).toBe(2);
    expect(text(f)).toContain('CONV-COUNTS n=5 type=person');
    expect(text(f)).toContain('CONV-NONE type=invoice');
  });

  it('shows the counting state until the counts answer, and no number before then', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    expect(text(f)).toContain('CONV-COUNTING');
    expect(state(f)).toBe('loading');
    expect(items(f)).toEqual(['RENAME-PROP company => employer']);
    countsAre(3, 1);
    f.detectChanges();
    expect(text(f)).not.toContain('CONV-COUNTING');
  });

  it('without the read right on the local space it asks no count, shows no number and says why; the steps stay', () => {
    const f = mount([renameProp]);
    rightsAre(NO_READ);
    f.detectChanges();
    http.expectNone('/api/filter');
    expect(text(f)).toContain('CONV-NO-READ-RIGHT');
    expect(text(f)).not.toMatch(/\d/);
    expect(items(f)).toEqual(['RENAME-PROP company => employer']);
    expect(state(f)).toBe('noright');
  });

  it('a read right on THIS space is enough, whatever the floor says', () => {
    const f = mount([renameProp], 'team-notes');
    rightsAre(READS_ONE_SPACE);
    expect(http.match('/api/filter').length).toBe(2);
    f.destroy();
  });

  it('with rights it cannot read it still asks the count: unknown rights allow, the server decides', () => {
    const f = mount([renameProp]);
    http.expectOne('/api/tokens/me').flush({ error: 'no' }, { status: 403, statusText: 'Forbidden' });
    expect(http.match('/api/filter').length, 'the count was not asked after unreadable rights').toBe(2);
    f.destroy();
  });

  it('with no local space it asks nothing at all and shows the steps alone', () => {
    const f = mount([renameProp], null);
    f.detectChanges();
    http.expectNone('/api/tokens/me');
    http.expectNone('/api/filter');
    expect(items(f)).toEqual(['RENAME-PROP company => employer']);
    expect(text(f)).not.toContain('CONV-COUNTS');
    expect(text(f)).not.toContain('CONV-COUNTING');
    expect(state(f)).toBe('off');
  });

  it('a count that failed shows no number (never zero) and leaves the steps', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    // One refused read fails the whole count: the other read is cancelled with it, so only the first is answered.
    const asked = http.match('/api/filter');
    expect(asked.length).toBe(2);
    asked[0]!.flush({ error: 'x' }, { status: 500, statusText: 'Server Error' });
    f.detectChanges();
    expect(state(f)).toBe('failed');
    expect(text(f)).not.toContain('CONV-COUNTS');
    expect(text(f)).not.toContain('CONV-NONE');
    expect(items(f)).toEqual(['RENAME-PROP company => employer']);
  });

  it('a count that failed says so in words, under the steps, and offers nothing to click (the row\'s own reload reads it again)', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    http.match('/api/filter')[0]!.flush({ error: 'x' }, { status: 500, statusText: 'Server Error' });
    f.detectChanges();
    expect(text(f)).toContain('CONV-COUNT-FAILED');
    expect(text(f)).not.toContain('CONV-NO-SPACE');
    expect(text(f)).not.toMatch(/\d/);
    expect(items(f)).toEqual(['RENAME-PROP company => employer']);
    expect((f.nativeElement as HTMLElement).querySelectorAll('button, a, [role="button"], input').length, 'a failed count offers a control').toBe(0);
    const live = (f.nativeElement as HTMLElement).querySelector('[aria-live="polite"]');
    expect(live?.textContent, 'the failure is not in the live region').toContain('CONV-COUNT-FAILED');
  });

  it('a count that answers says neither that it failed nor that there is no space', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    countsAre(640, 599);
    f.detectChanges();
    expect(state(f)).toBe('ready');
    expect(text(f)).not.toContain('CONV-COUNT-FAILED');
    expect(text(f)).not.toContain('CONV-NO-SPACE');
  });

  it('while counting, and where the token cannot read, neither of the two sentences is said', () => {
    const loading = mount([renameProp]);
    expect(state(loading)).toBe('loading');
    expect(text(loading)).not.toContain('CONV-COUNT-FAILED');
    expect(text(loading)).not.toContain('CONV-NO-SPACE');
    rightsAre(NO_READ);
    loading.detectChanges();
    expect(state(loading)).toBe('noright');
    expect(text(loading)).not.toContain('CONV-COUNT-FAILED');
    expect(text(loading)).not.toContain('CONV-NO-SPACE');
  });

  it('a round whose space is not on this instance says so under the steps, and asks nothing', () => {
    const f = mount([renameProp], null);
    f.detectChanges();
    http.expectNone('/api/tokens/me');
    http.expectNone('/api/filter');
    expect(state(f)).toBe('off');
    expect(text(f)).toContain('CONV-NO-SPACE');
    expect(text(f)).not.toContain('CONV-COUNT-FAILED');
    expect(items(f)).toEqual(['RENAME-PROP company => employer']);
    expect((f.nativeElement as HTMLElement).querySelectorAll('button, a, [role="button"], input').length).toBe(0);
  });

  it('a space that is here but has no step to count says neither: nothing failed and the space is not missing', () => {
    const f = mount([{ op: 'dropProperty', kind: 'entity', type: 'person', property: 'x' }]);
    f.detectChanges();
    http.expectNone('/api/filter');
    expect(state(f)).toBe('off');
    expect(items(f)).toEqual(['UNKNOWN-STEP dropProperty']);
    expect(text(f)).not.toContain('CONV-NO-SPACE');
    expect(text(f)).not.toContain('CONV-COUNT-FAILED');
  });

  it('binds a peer\'s names as text: markup in a type, a property or a condition is shown, never parsed', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const f = mount([
      { op: 'renameProperty', kind: 'entity', type: evil, from: '<b>old</b>', to: evil },
      { op: 'splitType', kind: 'entity', from: evil, cases: [{ when: '<script>1</script>', to: evil }] },
    ]);
    rightsAre(ADMIN);
    countsAre(2, 1);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    expect(host.querySelector('img'), 'a type name was parsed as HTML').toBeNull();
    expect(host.querySelector('b'), 'a property name was parsed as HTML').toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(text(f)).toContain(evil);
    expect(names(f)).toContain('<b>old</b>');
  });

  it('a name that holds the marker characters cannot forge a name span or break the sentence', () => {
    const f = mount([{ op: 'renameProperty', kind: 'entity', type: 'person', from: 'a\u0002 b \u0001c', to: 'd' }]);
    rightsAre(ADMIN);
    countsAre(2, 1);
    f.detectChanges();
    expect(text(f)).not.toMatch(/[\u0001\u0002]/);
    expect(names(f).slice(0, 2)).toEqual(['a b c', 'd']);
  });

  it('a step this client has no words for is a visible line, not a blank one, and the others still read', () => {
    const f = mount([{ op: 'dropProperty', kind: 'entity', type: 'person', property: 'x' }, renameProp]);
    rightsAre(ADMIN);
    countsAre(2, 1);
    f.detectChanges();
    const lines = items(f);
    expect(lines.length).toBe(2);
    expect(lines.every(l => l.length > 0), 'a step rendered as a blank line').toBe(true);
    expect(lines, 'the unknown step is not said in the unknown-step sentence').toContain('UNKNOWN-STEP dropProperty');
    expect(lines).toContain('RENAME-PROP company => employer');
  });

  it('a known step with a shape a peer got wrong does not throw and is said in the unknown-step sentence', () => {
    const f = mount([{ op: 'mapEnum', kind: 'entity', type: 'person', property: 'status' }, { op: 'splitType', kind: 'entity', from: 'a' }]);
    f.detectChanges();
    const lines = items(f);
    expect(lines.length).toBe(2);
    expect(lines.every(l => l.length > 0), 'a malformed step rendered as a blank line').toBe(true);
    expect([...lines].sort(), 'a malformed step is not said in the unknown-step sentence').toEqual(['UNKNOWN-STEP mapEnum', 'UNKNOWN-STEP splitType']);
    // Neither names records it can count, so nothing is asked.
    http.expectNone('/api/tokens/me');
    http.expectNone('/api/filter');
  });

  it('a very long step list stays a list of lines that wrap: names and sentences break inside long words', () => {
    const long = 'x'.repeat(300);
    const f = mount([{ ...renameProp, from: long }]);
    rightsAre(ADMIN);
    countsAre(2, 1);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    const li = host.querySelector('li') as HTMLElement;
    const name = host.querySelector('.cv-tn') as HTMLElement;
    expect(declaredNearest(name, 'overflow-wrap', host) ?? declaredNearest(name, 'word-break', host), 'a long name cannot wrap').toMatch(/anywhere|break-word|break-all/);
    expect(declaredNearest(li, 'overflow-wrap', host) ?? declaredNearest(li, 'word-break', host), 'a long sentence cannot wrap').toMatch(/anywhere|break-word|break-all/);
    expect(declaredNearest(li, 'text-overflow', host), 'a step is cut off with an ellipsis').toBeNull();
  });

  it('is a labelled group: the heading names the list for a screen reader, and the list is a list', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    countsAre(2, 1);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    const group = host.querySelector('[role="group"]') as HTMLElement | null;
    expect(group, 'no labelled group').not.toBeNull();
    const labelId = group!.getAttribute('aria-labelledby') ?? '';
    expect(labelId).not.toBe('');
    expect(host.querySelector(`#${labelId}`)?.textContent).toContain('CONV-HEAD');
    expect(host.querySelector('ul li')).not.toBeNull();
  });

  it('reads the counts again when the round it shows changes, and drops the old ones', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    countsAre(640, 599);
    f.detectChanges();
    expect(text(f)).toContain('n=640');
    f.componentRef.setInput('localSpaceId', 'other-space');
    f.detectChanges();
    expect(text(f), 'the old space\'s count stayed on screen').not.toContain('n=640');
    rightsAre(ADMIN);
    const asked = countsAre(7, 3);
    f.detectChanges();
    expect(asked.every(r => filterBody(r).space === 'other-space')).toBe(true);
    expect(text(f)).toContain('n=7');
  });

  it('a count that answers after the block is gone changes nothing and throws nothing', () => {
    const f = mount([renameProp]);
    rightsAre(ADMIN);
    const pending = http.match('/api/filter');
    f.destroy();
    for (const r of pending) expect(r.cancelled, 'a count stayed in flight after the block was removed').toBe(true);
  });
});
