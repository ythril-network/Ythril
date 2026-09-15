/**
 * `recallRequestFrom` — the ONE thing that turns the Search form into a recall request.
 *
 * ## Why this file is short and the characterization spec is long
 *
 * `query-tab.characterization.spec.ts` pins the same rules through the component, and did so BEFORE any of
 * this moved: 19 cases, each mutation-tested. They are the net that proves the extraction changed nothing.
 *
 * What is here is what only becomes assertable once the builder is a function: that the JSON an operator
 * COPIES and the request the button SENDS are the same object, and that a form which cannot produce a
 * request says which of the two reasons applies. Those are the whole argument for the extraction — a preview
 * built separately would be believed, and being wrong about a request somebody pastes is worse than being
 * wrong on screen.
 */
import { describe, it, expect } from 'vitest';
import { recallRequestFrom, recallRequestJson } from './recall-request';
import type { RecallFormState, RecallTypeOpt } from './recall-form.component';

/** The host's defaults, which are the server's defaults expressed as form state. */
function form(over: Partial<RecallFormState> = {}): RecallFormState {
  return {
    query: 'who reports to whom', topK: 10, minScore: 0, filter: '', projection: '', tags: '', type: '',
    maxPerType: 0, includeFreshWrites: false, includeContent: true, includeDiagnostics: false, includeRecordMeta: false,
    depth: 0, edgeLabels: '', direction: '',
    includeChrono: false, includeMemories: false, includeFiles: false,
    maxTimeMS: 0, maxBytes: 0, maxChars: 0, maxTokens: 0, charsPerToken: 0,
    skip: 0, remainderDump: false,
    ...over,
  };
}

const noTypes: RecallTypeOpt[] = [];

describe('the JSON an operator copies is the request the button sends', () => {
  it('the preview is the same object, stringified — not a second rendering of the form', () => {
    /*
     * The point of the extraction, asserted as an identity rather than trusted as a convention. If the
     * preview ever grows its own builder, this fails — and it is the only thing that would notice: a caller
     * pastes the JSON, gets a different answer from the one on screen, and nothing anywhere errors.
     */
    const f = form({ depth: 2, direction: 'inbound', edgeLabels: 'reports_to', skip: 20, maxTokens: 4000 });
    const { body } = recallRequestFrom(f, noTypes);
    const { json } = recallRequestJson(f, noTypes);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(body)));
  });

  it('and the preview drops the key that is only invisibly present', () => {
    // `minScore: form.minScore || undefined` leaves an explicit undefined on the object. It never reaches the
    // wire, so a preview showing it would be showing something the request does not contain.
    const { json } = recallRequestJson(form(), noTypes);
    expect(json).not.toContain('minScore');
    expect(JSON.parse(json)).toEqual({ query: 'who reports to whom', topK: 10 });
  });
});

describe('a form that cannot produce a request says which reason applies', () => {
  it('a blank question is a no-op, NOT an error', () => {
    /*
     * The two callers want opposite things here, which is why the result is a discriminated pair rather than
     * a throw or a null: the search stops silently, and the preview says "type a question" rather than
     * showing a failure for a form nobody has filled in yet.
     */
    const r = recallRequestFrom(form({ query: '   ' }), noTypes);
    expect(r.body).toBeUndefined();
    expect(r.errorKey).toBe('');
  });

  it('a broken filter names its own message, and a broken projection names a different one', () => {
    // Two boxes with the same rule and separate messages: "one of them is wrong" would leave an operator
    // checking both.
    expect(recallRequestFrom(form({ filter: '{oops' }), noTypes).errorKey).toBe('brain.query.filterInvalidJson');
    expect(recallRequestFrom(form({ filter: '[1,2]' }), noTypes).errorKey).toBe('brain.query.filterMustBeObject');
    expect(recallRequestFrom(form({ projection: '{oops' }), noTypes).errorKey).toBe('brain.query.projectionInvalidJson');
    expect(recallRequestFrom(form({ projection: '"x"' }), noTypes).errorKey).toBe('brain.query.projectionMustBeObject');
  });

  it('and there is no json to copy in either case', () => {
    expect(recallRequestJson(form({ query: '' }), noTypes).json).toBe('');
    expect(recallRequestJson(form({ filter: '[1]' }), noTypes).json).toBe('');
  });
});

describe('the traversal object', () => {
  it('carries only what was said, and nothing at depth 0', () => {
    expect(recallRequestFrom(form({ direction: 'both', edgeLabels: 'owns', includeFiles: true }), noTypes).body!.traverse)
      .toBeUndefined();

    expect(recallRequestFrom(form({ depth: 3 }), noTypes).body!.traverse).toEqual({ depth: 3 });

    expect(recallRequestFrom(form({
      depth: 1, direction: 'outbound', edgeLabels: ' owns , reports_to ',
      includeChrono: true, includeFiles: true,
    }), noTypes).body!.traverse).toEqual({
      depth: 1, direction: 'outbound', edgeLabels: ['owns', 'reports_to'], includeChrono: true, includeFiles: true,
    });
  });
});
