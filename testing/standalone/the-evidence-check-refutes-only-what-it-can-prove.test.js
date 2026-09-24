/**
 * The evidence check (`server/src/evidence/evidence-check.ts`): a deterministic gate in front of any model that
 * judges whether a text is supported by its evidence.
 *
 * It REFUTES only what code can prove — a name, a number or a date in the text that the evidence and the
 * allowed values do not contain — and otherwise says `undecided`, which means *ask the model*. It never says
 * `supported`: every term being present proves nothing about the relation between them, and a gate that passed
 * texts would be a second, weaker judge. Negation that disagrees is reported as a signal and decides nothing,
 * because negation words are too common to be proof.
 *
 * Run: node --test testing/standalone/the-evidence-check-refutes-only-what-it-can-prove.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let checkEvidence;
before(async () => { ({ checkEvidence } = await import('../../server/dist/evidence/evidence-check.js')); });

const turns = ['We adopted a cat yesterday! Her name is Luna.', 'She is 2 years old and has three kittens.'];

describe('what it refutes', () => {
  it('a name the evidence never mentions and nobody allowed', () => {
    const r = checkEvidence('Ada adopted a cat named Bella.', turns, { names: ['Ada'] });
    assert.equal(r.verdict, 'refuted');
    assert.match(r.reasons.join(' '), /Bella/);
  });
  it('a number the evidence does not contain — digits and words agree', () => {
    assert.equal(checkEvidence('Luna is 2 years old and has three kittens.', turns).verdict, 'undecided');
    assert.equal(checkEvidence('Luna is two years old and has 3 kittens.', turns).verdict, 'undecided', 'two = 2, 3 = three');
    const r = checkEvidence('Luna has five kittens.', turns);
    assert.equal(r.verdict, 'refuted');
    assert.match(r.reasons.join(' '), /5|five/);
  });
  it('a date outside the ones resolved for it', () => {
    const r = checkEvidence('Ada adopted Luna on 8 May 2023.', turns, { names: ['Ada'], dates: ['9 May 2023'] });
    assert.equal(r.verdict, 'refuted');
    assert.match(r.reasons.join(' '), /8 May 2023/);
    assert.equal(checkEvidence('Ada adopted Luna on 9 May 2023.', turns, { names: ['Ada'], dates: ['9 May 2023'] }).verdict, 'undecided');
  });
});

describe('what it never decides', () => {
  it('everything present is still only undecided — presence proves no relation', () => {
    const r = checkEvidence('Luna adopted Ada.', turns, { names: ['Ada'] });
    assert.equal(r.verdict, 'undecided');
  });
  it('a sentence-initial capital is not a name, and the words a, an are not numbers', () => {
    assert.equal(checkEvidence('Yesterday a cat was adopted.', turns).verdict, 'undecided');
    // Evidence with no article at all: were "a" the number one, this claim would be refuted for stating it.
    assert.equal(checkEvidence('Ada has a cat.', ['Ada has cats.']).verdict, 'undecided');
  });
  it('negation that disagrees is a signal, not a verdict', () => {
    const r = checkEvidence('Ada did not adopt a cat.', turns, { names: ['Ada'] });
    assert.equal(r.verdict, 'undecided');
    assert.equal(r.signals.negationMismatch, true);
  });
  it('the signals it computed are always returned, for the audit trail', () => {
    const r = checkEvidence('Luna has five kittens.', turns);
    assert.deepEqual(Object.keys(r.signals).sort(), ['missingDates', 'missingNames', 'missingNumbers', 'negationMismatch']);
    assert.deepEqual(r.signals.missingNumbers, ['5']);
  });
});
