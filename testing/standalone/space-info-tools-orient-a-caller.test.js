/**
 * The space-information tools orient a caller who has just connected.
 *
 * ## X-2, the space family
 *
 * `list_spaces` is the FIRST call an agent makes in an unfamiliar instance — every other tool takes a space
 * id, and the ids are not guessable from the labels. Its description listed the fields it returns and never
 * said that, nor that the `purpose` field is the space owner telling the agent how to behave there.
 *
 * A purpose exists because somebody needed it followed. A tool reference that presents it as one more string
 * among ids and counts is why it gets skipped.
 *
 * ## Counts are not search coverage
 *
 * `space_stats` returns totals. A record retired from semantic ranking is counted and cannot be recalled; a
 * record written seconds ago is counted before its embedding exists. So `count > what a search returned` is
 * NORMAL — and without being told, it reads as a broken index. This is the same family of misreading as an
 * empty `similar`: the number is right and the inference from it is wrong.
 *
 * ## Proxy spaces aggregate
 *
 * Both tools report a proxy's members combined. A caller who does not know that will read one large space
 * where there are four, and will write to it without the `targetSpace` a proxy write requires.
 *
 * Run: node --test testing/standalone/space-info-tools-orient-a-caller.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('server/src/mcp/tools/spaces.ts', 'utf8');
const tool = (name) => {
  const at = SRC.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} was not found — the scanner is wrong, not the code`);
  const next = SRC.indexOf("name: '", at + 20);
  return next === -1 ? SRC.slice(at) : SRC.slice(at, next);
};

const LIST = tool('list_spaces');
const STATS = tool('space_stats');

describe('list_spaces orients a new caller', () => {
  it('says to call it first, and why', () => {
    assert.match(LIST, /CALL THIS FIRST/, 'every other tool needs a space id');
    assert.match(LIST, /not guessable from the labels/,
      'say why guessing does not work, or a caller will guess');
  });

  it('tells the agent that `purpose` is instructions for it', () => {
    // The field most likely to be skipped, and the one a space owner wrote FOR the agent.
    assert.match(LIST, /what belongs there and how to behave/,
      'purpose is not a description, it is direction');
    assert.match(LIST, /somebody needed you to follow it/, 'say why it is there');
  });

  it('says the counts are for planning, not decoration', () => {
    assert.match(LIST, /planning tool rather than a directory/,
      'an empty space is not worth a recall; a huge one needs a filter');
  });

  it('says an absent space may simply be unreachable by this token', () => {
    assert.match(LIST, /holds no rung in/,
      'absent is not non-existent — otherwise a caller reports a space as missing');
  });
});

describe('get_stats says what its numbers do NOT mean', () => {
  it('warns that totals exceed search coverage, and that this is normal', () => {
    // Without it, a count larger than a search result reads as a broken index.
    assert.match(STATS, /TOTALS, not search coverage/, 'name the distinction plainly');
    assert.match(STATS, /is normal and is not evidence of a broken index/,
      'pre-empt the wrong inference, which is the whole point of saying it');
  });

  it('names the tool that answers the indexing question instead', () => {
    assert.match(STATS, /list_embed_jobs/,
      'a warning with no remedy sends the caller looking; name the tool');
  });
});

describe('both say a proxy aggregates', () => {
  for (const [label, text] of [['list_spaces', LIST], ['space_stats', STATS]]) {
    it(`${label} says a proxy reports its members combined`, () => {
      assert.match(text, /PROXY|proxy/, 'a proxy is not one space and the numbers are not one space\'s');
      // Matched without the apostrophe: it is escaped as \' inside the single-quoted TS string, so a regex
      // written against the rendered text does not match the source.
      assert.match(text, /totals combined/,
        'say that the figure is a sum, or four spaces read as one large one');
    });
  }
});
