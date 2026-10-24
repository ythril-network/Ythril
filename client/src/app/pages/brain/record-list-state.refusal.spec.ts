/**
 * The Brain edit path translates a refusal ONLY when the body carries a `code` (bundle-81, amendment decision 27, P44 half b;
 * design rev 8 §1a "The Brain edit path stops bypassing the words").
 *
 * ## The rule
 *
 * `RecordListState.failEdit` read every refusal through `httpErrorReason`, one untranslated string, so the new
 * `record_version_at_ceiling` refusal (a 409 with `{ error, code, id }`) would show the server's English to a German or Polish
 * reader. The path moves to `refusalText`, which translates a body `code` under `networks.refusal.*`. But the edit path also
 * answers schema refusals, `412` precondition failures and bodies with no JSON at all, and those carry no code: they keep
 * `httpErrorReason`'s text, so they read as they do today. Half a: a coded refusal is translated. Half b: an uncoded one is
 * untouched, byte for byte.
 *
 * ## What is driven
 *
 * The real `RecordListState` through the injector, with a Transloco whose `networks.refusal.record_version_at_ceiling` is a
 * sentinel sentence carrying `{{id}}`. The coded case must read the sentinel with the id filled in; the three uncoded cases (an
 * `{ error }` body with no code, a `412` with no body, a status with neither) must equal `httpErrorReason` of the same answer.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7 for half a: `failEdit` returns the server's prose for a coded body, and `en.json` has no
 * `networks.refusal.record_version_at_ceiling` (asserted on the real dictionaries below, in en, de and pl). Half b is green on
 * the base by construction: it holds the behaviour the change must keep.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary, LOCALES } from '../../testing/i18n-dictionary';
import { httpErrorReason } from '../../core/refusal-text';
import { RecordListState } from './record-list-state.service';

const SENTINEL = 'CEILING-SENTENCE for {{id}}';

function state(): RecordListState {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [getTranslocoModule({ translation: { en: { networks: { refusal: { record_version_at_ceiling: SENTINEL } } } } })],
    providers: [RecordListState],
  });
  return TestBed.inject(RecordListState);
}

describe('failEdit translates a refusal only when the body has a code (decision 27)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('half a: a coded 409 reads the translated sentence with its id, not the server\'s English', () => {
    const s = state();
    const failure = { status: 409, statusText: 'Conflict', error: { error: 'The record version is at the ceiling.', code: 'record_version_at_ceiling', id: 'fact-42' } };
    s.failEdit(failure);
    expect(s.editError()).toBe('CEILING-SENTENCE for fact-42');
    expect(s.editError()).not.toContain('The record version is at the ceiling.');
  });

  it('half b: a refusal with a body and NO code keeps httpErrorReason\'s text (a schema refusal)', () => {
    const s = state();
    const failure = { status: 400, statusText: 'Bad Request', error: { error: 'name: must be at most 200 characters' } };
    s.failEdit(failure);
    expect(s.editError()).toBe(httpErrorReason(failure));
    expect(s.editError()).toContain('must be at most 200 characters');
  });

  it('half b: a 412 with no body keeps httpErrorReason\'s text', () => {
    const s = state();
    const failure = { status: 412, statusText: 'Precondition Failed' };
    s.failEdit(failure);
    expect(s.editError()).toBe(httpErrorReason(failure));
    expect(s.editError()).toBe('412 Precondition Failed');
  });

  it('half b: a status and nothing else keeps httpErrorReason\'s text', () => {
    const s = state();
    const failure = { status: 500 };
    s.failEdit(failure);
    expect(s.editError()).toBe(httpErrorReason(failure));
  });

  it('the coded sentence exists in the real dictionaries of all three locales, with its {{id}} placeholder', () => {
    for (const locale of LOCALES) {
      const text = dictionary(locale)['networks.refusal.record_version_at_ceiling'];
      expect(text, `${locale}.json has no networks.refusal.record_version_at_ceiling`).toBeTruthy();
      expect(text).toContain('{{id}}');
    }
  });
});
