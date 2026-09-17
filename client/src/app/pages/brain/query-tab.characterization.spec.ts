/**
 * QueryTabComponent — characterization tests for the U-1 split.
 *
 * ## What these are, and what they are not
 *
 * They pin the recall request **as it is built today**, before the panel is split into a form and a results
 * view. They are not a claim that every rule here is right: a characterization test's job is to make a
 * refactor's regressions loud, and that requires recording what happens rather than what should. Where
 * something looks like a defect it is marked `AS-IS` with what it does, and changing it must be a deliberate
 * edit to the assertion rather than a deletion.
 *
 * ## Why now, and why these cases
 *
 * `query-tab.component.ts` is 652 lines and U-1 adds eleven controls plus a layout rework, so it is a split
 * and not an insertion. The existing specs cover the OnPush contract, the pure formatters, the truncation
 * banner and two of the numeric parameters. **What they do not cover is `runRecall`'s request building**, and
 * that is precisely the part a split moves: every rule below is a conditional in one method, each with a
 * stated reason in the code and no assertion anywhere.
 *
 * The rules are all of one kind — **when is a value SENT** — and they are not uniform, which is what makes
 * them worth pinning:
 *
 *   - three flags are sent only when true, one only when FALSE, and the difference is deliberate;
 *   - three numbers treat 0 as "say nothing", for three different reasons;
 *   - the type dropdown MERGES into a hand-written filter and overrides one key of it;
 *   - `types` and `minPerType` are derived from the same rows but by different tests.
 *
 * A split that carried eleven of these twelve across correctly would look finished and be wrong, and the one
 * it dropped would produce a plausible answer rather than an error.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, Subject } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { QueryTabComponent } from './query-tab.component';

/** The bodies the panel actually sent, in order, so a case can assert on the whole request. */
function makeApi(sent: Record<string, unknown>[]) {
  return {
    queryBrain: () => of({ results: [], count: 0 }),
    recallBrain: (_space: string, body: Record<string, unknown>) => { sent.push(body); return of({ results: [] }); },
  } as any;
}

describe('QueryTabComponent — the recall request (characterization for U-1)', () => {
  let sent: Record<string, unknown>[];

  function create() {
    sent = [];
    TestBed.configureTestingModule({
      imports: [QueryTabComponent, getTranslocoModule()],
      providers: [
        BrainStore,
        { provide: BrainApi, useValue: makeApi(sent) },
      ],
    });
    const fixture = TestBed.createComponent(QueryTabComponent);
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.detectChanges();
    const c = fixture.componentInstance as any;
    c.recallForm.query = 'who reports to whom';
    return c;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('a default run sends the question, topK, and nothing else it was not asked for', () => {
    /*
     * The floor for every case below: if this request grew a key, one of the "omitted unless asked" rules has
     * inverted, and the panel would be putting a parameter in every request that means what its absence
     * means.
     *
     * `minScore` is present-but-undefined rather than absent, which is what `minScore || undefined` produces
     * and is invisible over the wire. Pinned as it is: JSON.stringify drops it, so the request is correct, and
     * a split that "tidied" it to a conditional spread would also be correct.
     */
    const c = create();
    c.runRecall();
    expect(sent.length).toBe(1);
    const body = sent[0];
    expect(body['query']).toBe('who reports to whom');
    expect(body['topK']).toBe(10);
    expect(JSON.parse(JSON.stringify(body))).toEqual({ query: 'who reports to whom', topK: 10 });
  });

  it('a blank question sends nothing at all, not an empty recall', () => {
    const c = create();
    c.recallForm.query = '   ';
    c.runRecall();
    expect(sent.length).toBe(0);
  });

  it('the question is TRIMMED, so a trailing space is not part of what is embedded', () => {
    const c = create();
    c.recallForm.query = '  who reports to whom  ';
    c.runRecall();
    expect(sent[0]['query']).toBe('who reports to whom');
  });

  // ── the three numbers whose zero means "say nothing", each for its own reason ────────────────────────────

  it('traverse, maxTimeMS and maxBytes are omitted at 0 and sent above it', () => {
    /*
     * Three parameters, one shape, three different reasons — which is why a split has to carry all three and
     * not one rule applied thrice. `traverse: 0` IS the server default (no expansion), `maxTimeMS: 0` is not
     * a legal deadline, and `maxBytes: 0` means "use the instance default" against a server floor of 1000.
     */
    const c = create();
    c.runRecall();
    expect(sent[0]['traverse']).toBeUndefined();
    expect(sent[0]['maxTimeMS']).toBeUndefined();
    expect(sent[0]['maxBytes']).toBeUndefined();

    c.recallForm.depth = 2;
    c.recallForm.maxTimeMS = 8000;
    c.recallForm.maxBytes = 50_000;
    c.runRecall();
    // A deliberate edit: this asserted the bare number 2. The traversal is an OBJECT since U-1, because
    // the number reached the depth and left five other traversal parameters unreachable.
    expect(sent[1]['traverse']).toEqual({ depth: 2 });
    expect(sent[1]['maxTimeMS']).toBe(8000);
    expect(sent[1]['maxBytes']).toBe(50_000);
  });

  it('maxPerType 0 is NO CAP and must never reach the wire as a literal zero', () => {
    // The one whose wrong version is destructive rather than merely noisy: `maxPerType: 0` sent literally
    // caps every type at nothing, so the recall answers with an empty list and no error.
    const c = create();
    c.runRecall();
    expect(sent[0]['maxPerType']).toBeUndefined();

    c.recallForm.maxPerType = 3;
    c.runRecall();
    expect(sent[1]['maxPerType']).toBe(3);
  });

  // ── the flags, and the one that is inverted on purpose ───────────────────────────────────────────────────

  it('includeDiagnostics is sent ONLY when turned on', () => {
    /*
     * `includeFreshWrites` was asserted here too, and it is gone rather than merely unchecked: the scan it
     * gated now always runs, so there is no flag to send. Measured before removing it — a plain recall
     * could not see a just-written record for three seconds, and the parameter's only function was to let
     * a caller opt into that blind spot.
     */
    const c = create();
    c.runRecall();
    expect(sent[0]['includeDiagnostics']).toBeUndefined();

    c.recallForm.includeDiagnostics = true;
    c.runRecall();
    expect(sent[1]['includeDiagnostics']).toBe(true);
  });

  it('includeFileContent is the other way round — sent only when turned OFF', () => {
    /*
     * Deliberately inverted, and the reason is in the code: the server default is to include content, so a
     * request that spelled out `includeFileContent: true` would carry a parameter meaning exactly what its absence
     * means. Only an operator who switched it off is saying something.
     *
     * This is the case a split is most likely to "fix" into consistency with the three flags above, and doing
     * so would silently stop passages being returned.
     */
    const c = create();
    c.runRecall();
    expect(sent[0]['includeFileContent']).toBeUndefined();

    c.recallForm.includeFileContent = false;
    c.runRecall();
    expect(sent[1]['includeFileContent']).toBe(false);
  });

  // ── the two lists derived from the same rows ─────────────────────────────────────────────────────────────

  it('types comes from the ticked rows, and no ticks means the key is absent rather than empty', () => {
    const c = create();
    c.runRecall();
    expect(sent[0]['types']).toBeUndefined();

    c.recallTypeOpts.find((o: any) => o.type === 'entity').on = true;
    c.recallTypeOpts.find((o: any) => o.type === 'edge').on = true;
    c.runRecall();
    expect(sent[1]['types']).toEqual(['entity', 'edge']);
  });

  it('minPerType comes from the same rows but only where a minimum is above zero', () => {
    /*
     * Two derivations off one list, with different tests — a ticked row with no minimum contributes to `types`
     * and not to `minPerType`. A split that computed both from one predicate would send a floor of 0 for every
     * ticked type, which the route reads as a guarantee it must honour.
     */
    const c = create();
    const entity = c.recallTypeOpts.find((o: any) => o.type === 'entity');
    const edge = c.recallTypeOpts.find((o: any) => o.type === 'edge');
    entity.on = true; entity.min = 2;
    edge.on = true; edge.min = 0;
    c.runRecall();
    expect(sent[0]['types']).toEqual(['entity', 'edge']);
    expect(sent[0]['minPerType']).toEqual({ entity: 2 });
  });

  it('an UNTICKED row contributes nothing, even with a minimum typed into it', () => {
    const c = create();
    const entity = c.recallTypeOpts.find((o: any) => o.type === 'entity');
    entity.on = false; entity.min = 5;
    c.runRecall();
    expect(sent[0]['types']).toBeUndefined();
    expect(sent[0]['minPerType']).toBeUndefined();
  });

  // ── tags ────────────────────────────────────────────────────────────────────────────────────────────────

  it('tags are split on commas, trimmed, and empties dropped', () => {
    const c = create();
    c.recallForm.tags = ' alpha , , beta,  ';
    c.runRecall();
    expect(sent[0]['tags']).toEqual(['alpha', 'beta']);
  });

  it('a tags field of only separators sends no tags key at all', () => {
    // Not `tags: []`, which the route would read as "bearing all of no tags" — true of everything.
    const c = create();
    c.recallForm.tags = ' , , ';
    c.runRecall();
    expect(sent[0]['tags']).toBeUndefined();
  });

  // ── the filter, and the dropdown that merges into it ────────────────────────────────────────────────────

  it('a JSON filter is parsed and sent as an object', () => {
    const c = create();
    c.recallForm.filter = '{"tier":{"eq":"gold"}}';
    c.runRecall();
    expect(sent[0]['filter']).toEqual({ tier: { eq: 'gold' } });
  });

  it('invalid JSON is a form error and no request, so a typo is not a 400', () => {
    const c = create();
    c.recallForm.filter = '{tier:';
    c.runRecall();
    expect(sent.length).toBe(0);
    expect(c.recallError()).toBeTruthy();
  });

  it('valid JSON that is not an object is refused too — an array is not a filter', () => {
    const c = create();
    c.recallForm.filter = '[1,2]';
    c.runRecall();
    expect(sent.length).toBe(0);
    expect(c.recallError()).toBeTruthy();
  });

  it('the type dropdown becomes a filter clause, and OVERRIDES the type key of a hand-written one', () => {
    /*
     * The dropdown is a friendly shortcut for `filter: { type: { eq } }`, and it wins. Worth pinning because
     * "merge" and "override one key" are different behaviours and the layout rework moves these two controls
     * apart — the shortcut into the question group, the JSON into an advanced group — which is exactly when a
     * reader stops seeing that one silently beats the other.
     */
    const c = create();
    c.recallForm.filter = '{"type":{"eq":"note"},"tier":{"eq":"gold"}}';
    c.recallForm.type = 'person';
    c.runRecall();
    expect(sent[0]['filter']).toEqual({ type: { eq: 'person' }, tier: { eq: 'gold' } });
  });

  it('and with no hand-written filter it is the whole filter', () => {
    const c = create();
    c.recallForm.type = 'person';
    c.runRecall();
    expect(sent[0]['filter']).toEqual({ type: { eq: 'person' } });
  });

  // ── what a run clears before it starts ──────────────────────────────────────────────────────────────────

  it('a new run clears the previous error, results and truncation banner', () => {
    const c = create();
    c.recallError.set('previous failure');
    c.recallResults.set([{ id: 'old' } as any]);
    c.recallTruncated.set({ returned: 3, count: 99 });
    c.runRecall();
    expect(c.recallError()).toBe('');
    expect(c.recallTruncated()).toBeNull();
    expect(c.recallResults()).toEqual([]);
  });

  it('and clears them ON THE CLICK, not when the answer lands', () => {
    /*
     * The case above passes with the pre-clear deleted, and a surviving mutant is what said so: the success
     * handler recomputes all three from the response, and an instant stub makes "cleared before" and "cleared
     * after" indistinguishable.
     *
     * The difference is the only thing an operator ever sees. **The banner is the one that matters**: it says
     * the answer was SHORTENED, so a stale one sitting over an in-flight search claims that about results
     * nobody has received yet. Held open here, which is the only moment the two behaviours differ.
     */
    const pending = new Subject<any>();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [QueryTabComponent, getTranslocoModule()],
      providers: [
        BrainStore,
        { provide: BrainApi, useValue: { queryBrain: () => of({ results: [], count: 0 }), recallBrain: () => pending.asObservable() } },
      ],
    });
    const fixture = TestBed.createComponent(QueryTabComponent);
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.detectChanges();
    const c = fixture.componentInstance as any;
    c.recallForm.query = 'who reports to whom';
    c.recallTruncated.set({ returned: 3, count: 99 });
    c.recallError.set('previous failure');
    c.recallResults.set([{ id: 'old' } as any]);

    c.runRecall();

    expect(c.recallRunning()).toBe(true);
    expect(c.recallTruncated()).toBeNull();
    expect(c.recallError()).toBe('');
    expect(c.recallResults()).toEqual([]);
  });
});
