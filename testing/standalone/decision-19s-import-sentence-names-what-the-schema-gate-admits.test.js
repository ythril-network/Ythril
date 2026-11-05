/**
 * Decision 19's sentence about what the schema package imports names exactly what the package-closure gate admits, the `typescript` carve-out included
 * (Q-687, design v3 items 12 and 14).
 *
 * ## The defect this prevents
 *
 * Decision 19 says "The package imports zod, the CEL engine and Node built-ins only." The gate that enforces it
 * (`an-outside-apps-schema-validates-through-the-schema-package.test.js`, over `_schema-package-imports.mjs`) now admits one thing more: `typescript`, by a dynamic
 * literal `import('typescript')` in `schema/src/from-typescript.ts` only. A decision that says "only" while the gate admits the compiler is a record that
 * contradicts the code it records, and the next reader re-opens a settled rule. The sentence and the carve-out are two statements of one rule; this lint
 * reads the rule from the gate's module and refuses a sentence that does not name each thing the gate admits.
 *
 * ## What is held
 *
 * - The decision (the file `docs/decisions/19-*.md`) has a sentence beginning "The package imports".
 * - It names each family the gate admits (`CLOSURE_WORDS` of `_schema-package-imports.mjs`: zod, the CEL engine, Node built-ins, and for the carve-out `typescript`,
 *   the file `from-typescript.ts` and that the import is dynamic).
 * - The checker is proven on planted sentences: the sentence as it was before the carve-out is refused, a complete one is accepted, and a sentence cut off at a
 *   file name's dot is read whole.
 *
 * Run: node --test testing/standalone/decision-19s-import-sentence-names-what-the-schema-gate-admits.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { importSentenceOf, sentenceProblems, TYPESCRIPT_CARVE_OUT } from './_schema-package-imports.mjs';

describe('the checker this lint stands on (planted sentences)', () => {
  it('refuses the sentence as it was before the carve-out', () => {
    const before = 'read at each parse. The package imports zod, the CEL engine and Node built-ins only. **What the server alone needs** stays.';
    const sentence = importSentenceOf(before);
    assert.equal(sentence, 'The package imports zod, the CEL engine and Node built-ins only.');
    const problems = sentenceProblems(sentence);
    assert.ok(problems.some(p => p.includes("'typescript'")) && problems.some(p => p.includes("'from-typescript.ts'")) && problems.some(p => p.includes("'dynamic'")), problems.join('\n'));
  });

  it('accepts a complete sentence, and reads one that names a file whole (the dot of .ts is not its end)', () => {
    const full = `The package imports zod, the CEL engine and Node built-ins, and in one file, \`${TYPESCRIPT_CARVE_OUT.file.replace(/^schema\/src\//, '')}\`, the caller's own typescript by a dynamic import. Next.`;
    const sentence = importSentenceOf(`x ${full}`);
    assert.ok(sentence.endsWith('dynamic import.'), sentence);
    assert.deepEqual(sentenceProblems(sentence), []);
  });

  it('finds no sentence in a text without one', () => {
    assert.equal(importSentenceOf('nothing about imports here'), null);
  });
});

describe('decision 19 states the closure the gate enforces', () => {
  const file = readdirSync('docs/decisions').find(f => /^19-.*\.md$/.test(f));

  it('is found', () => {
    assert.ok(file, 'docs/decisions has no decision 19');
  });

  it('has a sentence "The package imports ..." that names every family the gate admits', () => {
    const sentence = importSentenceOf(readFileSync(`docs/decisions/${file}`, 'utf8'));
    assert.ok(sentence, `${file} has no sentence beginning "The package imports"`);
    assert.deepEqual(sentenceProblems(sentence), [], `${file}: "${sentence}"`);
  });
});
