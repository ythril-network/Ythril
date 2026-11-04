/**
 * A script's GitHub Actions annotation is one line that starts no other command, and it is spelled in one module (Q-710).
 *
 * ## The failure this prevents
 *
 * The runner reads every printed line that starts with `::` as a command. A message from an API error or a stack carries
 * newlines: printed raw, the annotation ends at the first one and the rest of the text is read line by line, so a line of it
 * that starts with `::` is a command the script never wrote. A `%` is the start of an escape, and a `:` or `,` in a title ends the
 * property. `scripts/test-times.mjs` blanked `%` and CR; `scripts/full-run-reuse.mjs` (Q-710) escaped them: two spellings of one
 * rule, which drift. `scripts/_shared/workflow-command.mjs` is the one place, and this file holds both halves:
 *
 * - `workflowCommand(level, title, message)` escapes the message and the title as the runner defines it, and throws on a level
 *   the runner ignores (a misspelt level is a warning lost without a sign);
 * - no other tracked script under `scripts/` prints a workflow annotation of its own (derived from the tracked sources, with a
 *   floor; comments stripped).
 *
 * Run: node --test testing/standalone/a-workflow-command-is-one-line-that-starts-nothing.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { workflowCommand } from '../../scripts/_shared/workflow-command.mjs';

const MODULE = 'scripts/_shared/workflow-command.mjs';

describe('workflowCommand prints one line that starts nothing', () => {
  it('a plain message is the command as the runner reads it', () => {
    assert.equal(workflowCommand('warning', 'baseline', 'run 7 was not read'), '::warning title=baseline::run 7 was not read');
  });

  it('a newline in the message cannot start a second command', () => {
    const line = workflowCommand('notice', 'Full run reuse', 'api error\n::error::forged\r\nend');
    assert.equal(line.split('\n').length, 1);
    assert.ok(!line.includes('\r'));
    assert.equal(line, '::notice title=Full run reuse::api error%0A::error::forged%0D%0Aend');
  });

  it('a percent sign is escaped first, so an existing escape is shown and not decoded', () => {
    assert.equal(workflowCommand('error', 't', '50% done, %0A literal'), '::error title=t::50%25 done, %250A literal');
  });

  it('a colon or comma in the title cannot end the property', () => {
    assert.equal(workflowCommand('warning', 'a:b,c', 'm'), '::warning title=a%3Ab%2Cc::m');
  });

  it('a message that is not a string is printed as text', () => {
    assert.equal(workflowCommand('notice', 't', 42), '::notice title=t::42');
  });

  for (const level of ['warn', 'debug', 'Warning', '']) {
    it(`refuses the level ${JSON.stringify(level)}, which the runner shows nowhere`, () => {
      assert.throws(() => workflowCommand(level, 't', 'm'), /is not one of notice, warning, error/);
    });
  }
});

describe('one module spells a workflow annotation', () => {
  // A template or string that starts an annotation: `::warning `, `::notice title=`, `::${level}` and the like.
  const SPELLING = /[`'"]::(?:warning|notice|error|\$\{)/;

  it('no tracked script but the shared module prints one itself', () => {
    const sources = readTrackedSources(['scripts'], { ext: ['.mjs', '.js', '.cjs'], floor: 20 });
    const spellers = sources.filter(({ text }) => SPELLING.test(stripComments(text))).map(({ file }) => file);
    assert.deepEqual(spellers, [MODULE]);
  });

  it('the pattern sees the spellings it exists to catch (mutation rows)', () => {
    for (const planted of [
      "const annotate = (what, m) => `::warning title=${what}::${m}`;",
      "console.log('::error::boom');",
      'const a = (level, t) => `::${level} title=x::${t}`;',
      'console.log("::notice title=x::y");',
    ]) assert.match(stripComments(planted), SPELLING, planted);
  });
});
