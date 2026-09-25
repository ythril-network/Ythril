/**
 * The assist model has a fallback and a token budget, decided in ONE place (`F-33`).
 *
 * Owner, 2026-09-24: *"we need a fallback assistant model and a budget on assistant model (x tokens resets every y
 * hours) - that way one can add a big hosted public model like claude and say you have x token per hour and when that
 * isnt reachable or session limit or the specified token per hour are used fallback to a local llm"*.
 *
 * `pickAssistBackend` is the decision, pure so every rule is checked here without a model: the primary answers while
 * it is configured, consented for the use, not cooling down after a failure and not over its budget; otherwise the
 * fallback, if it is configured and either local or consented itself; otherwise nothing. The window is rolling, and a
 * reply that reports no usage is counted at an estimate — never as free, or an endpoint that omits usage would never
 * spend its budget.
 *
 * And the callers: every path that reaches the assist slot goes through the resolver — none reads
 * `assistModel` to pick an endpoint itself, which is how a fifth caller would skip the budget.
 *
 * Run: node --test testing/standalone/the-assist-model-falls-back-and-keeps-a-budget.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

let pickAssistBackend, spentInWindow, tokensOf;
before(async () => {
  ({ pickAssistBackend, spentInWindow, tokensOf } = await import('../../server/dist/config/assist-backend.js'));
});

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 12);
const primary = { baseUrl: 'https://api.example.com/v1', model: 'big', acknowledgedHost: 'api.example.com', acknowledgedHostForConversations: 'api.example.com' };
const local = { baseUrl: 'http://ollama:11434', model: 'small' };
const pick = (over = {}) => pickAssistBackend({ primary, fallback: local, usage: [], now: NOW, use: 'conversations', ...over });

describe('which backend answers', () => {
  it('the primary, while it may', () => {
    assert.equal(pick()?.which, 'primary');
    assert.equal(pick()?.model, 'big');
  });

  it('the fallback when the primary is not consented for this use', () => {
    const r = pick({ primary: { ...primary, acknowledgedHostForConversations: undefined } });
    assert.equal(r?.which, 'fallback');
    assert.equal(pick({ primary: { ...primary, acknowledgedHostForConversations: undefined }, use: 'repair' })?.which, 'primary');
  });

  it('the fallback while the primary cools down after failing', () => {
    assert.equal(pick({ primaryDownUntil: NOW + 1 })?.which, 'fallback');
    assert.equal(pick({ primaryDownUntil: NOW - 1 })?.which, 'primary', 'a cooldown that has passed is over');
  });

  it('the fallback once the budget is spent in the window, and the primary again when the window rolls on', () => {
    const budget = { tokens: 1000, perHours: 1 };
    const spent = [{ at: NOW - 10 * 60_000, tokens: 600 }, { at: NOW - 5 * 60_000, tokens: 400 }];
    assert.equal(pick({ budget, usage: spent })?.which, 'fallback');
    assert.equal(pick({ budget, usage: spent.map(u => ({ ...u, at: u.at - HOUR })) })?.which, 'primary');
    assert.equal(pick({ budget, usage: [{ at: NOW - 60_000, tokens: 999 }] })?.which, 'primary', 'under the budget is not over it');
  });

  it('an EXTERNAL fallback needs its own consent; a local one does not', () => {
    const external = { baseUrl: 'https://other.example.org/v1', model: 'mid' };
    assert.equal(pick({ primaryDownUntil: NOW + 1, fallback: external }), null);
    assert.equal(pick({ primaryDownUntil: NOW + 1, fallback: { ...external, acknowledgedHostForConversations: 'other.example.org' } })?.which, 'fallback');
    assert.equal(pick({ primaryDownUntil: NOW + 1, fallback: { ...external, acknowledgedHost: 'other.example.org' } }), null,
      'a documents consent does not cover conversations on the fallback either');
  });

  it('nothing when neither may answer, and the fallback alone when no primary is configured', () => {
    assert.equal(pick({ primaryDownUntil: NOW + 1, fallback: undefined }), null);
    assert.equal(pick({ primary: undefined })?.which, 'fallback');
    assert.equal(pick({ primary: undefined, fallback: undefined }), null);
  });
});

describe('what a reply costs', () => {
  it('the reported usage, in either shape', () => {
    assert.equal(tokensOf({ prompt_tokens: 120, completion_tokens: 30 }, 0), 150);
    assert.equal(tokensOf({ total_tokens: 99 }, 0), 99);
    assert.equal(tokensOf({ input_tokens: 10, output_tokens: 5 }, 0), 15);
  });

  it('an estimate when the reply reports none — never zero', () => {
    assert.ok(tokensOf(undefined, 4000) > 0);
    assert.ok(tokensOf({}, 4000) > 0);
  });

  it('the window counts only what fell inside it', () => {
    assert.equal(spentInWindow([{ at: NOW - 2 * HOUR, tokens: 5 }, { at: NOW - HOUR / 2, tokens: 7 }], NOW, 1), 7);
  });
});

describe('every caller goes through the resolver', () => {
  it('no source outside it reads the assist config AND calls a model with it', () => {
    // A settings route or a connectivity probe reads the config without calling the model for real work, so it is
    // not a caller — the set is code that both reads `assistModel` off the config and makes a model call.
    const files = trackedSources(['server/src'], { floor: 100 }).filter(f => !f.endsWith('config/assist-backend.ts'));
    const reads = /(\bcfg|getDocumentProcessingConfig\(\))\??\.assistModel\b/;
    const calls = /\b(postWithBackoff|repairMarkdownExternal|describeDocumentText|decide|generate)\(/;
    const pickers = files.filter(f => { const src = stripComments(readFileSync(f, 'utf8')); return reads.test(src) && calls.test(src); });
    assert.deepEqual(pickers, [], `these pick an assist endpoint themselves, skipping the budget and fallback: ${pickers.join(', ')}`);
  });

  it('and the four known callers do go through it, so the sweep above has something to be about', () => {
    for (const f of ['server/src/extractor/decide.ts', 'server/src/extractor/generate.ts', 'server/src/files/converters/describe.ts', 'server/src/files/converters/vlm-extract.ts']) {
      const src = stripComments(readFileSync(f, 'utf8'));
      assert.match(src, /\bassistBackend\(/, `${f} no longer asks the resolver`);
      assert.match(src, /\bviaAssist\(/, `${f} calls the assist model without recording what it cost`);
    }
  });
});
