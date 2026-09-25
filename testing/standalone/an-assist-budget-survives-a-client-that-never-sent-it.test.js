/**
 * The assist model's budget and fallback (`F-33`) merge as "absent keeps, `null` removes" — unlike the rest of the block.
 *
 * Every other assist field is replaced whole by a Models-card save, which works because the card always sends them
 * all. A client written before these two fields never sends them, so under that rule its next save would delete a
 * budget the operator set — the one control capping spend on a paid model — with nothing said.
 *
 * And the fallback is egress like the primary unless it is local: a public URL without a consent is refused, a local
 * one needs neither the public-URL rule nor a consent, and its API key never reaches config.json.
 *
 * Run: node --test testing/standalone/an-assist-budget-survives-a-client-that-never-sent-it.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mergeAssistExtras, refuseAssistFallback, assistFallbackKeyChange;
before(async () => {
  ({ mergeAssistExtras, refuseAssistFallback, assistFallbackKeyChange } = await import('../../server/dist/config/assist-model-patch.js'));
});

const stored = { budget: { tokens: 1000, perHours: 24 }, fallback: { baseUrl: 'http://ollama:11434', model: 'small' } };

describe('merging a patch into the stored block', () => {
  it('a patch that never mentions them keeps both', () => {
    const next = { baseUrl: 'https://api.example.com/v1', model: 'big' };
    mergeAssistExtras(next, stored);
    assert.deepEqual(next.budget, stored.budget);
    assert.deepEqual(next.fallback, stored.fallback);
  });
  it('an explicit null removes each', () => {
    const next = { budget: null, fallback: null };
    mergeAssistExtras(next, stored);
    assert.equal('budget' in next, false);
    assert.equal('fallback' in next, false);
  });
  it('a sent value replaces the stored one', () => {
    const next = { budget: { tokens: 5, perHours: 1 } };
    mergeAssistExtras(next, stored);
    assert.deepEqual(next.budget, { tokens: 5, perHours: 1 });
  });
  it('the fallback key and its unset consents never reach config.json', () => {
    const next = { fallback: { baseUrl: 'http://ollama:11434', model: 's', apiKey: 'sk-x', acknowledgedHost: null } };
    mergeAssistExtras(next, undefined);
    assert.deepEqual(next.fallback, { baseUrl: 'http://ollama:11434', model: 's' });
  });
});

describe('the fallback key', () => {
  it('absent keeps it, null removes it, a string sets it', () => {
    assert.equal(assistFallbackKeyChange({}), undefined);
    assert.equal(assistFallbackKeyChange({ fallback: null }), null);
    assert.equal(assistFallbackKeyChange({ fallback: { apiKey: 'k' } }), 'k');
    assert.equal(assistFallbackKeyChange({ fallback: { model: 'm' } }), undefined);
  });
});

describe('refusing a fallback', () => {
  it('a local one is never refused', () => {
    for (const baseUrl of ['http://ollama:11434', 'http://localhost:8080/v1', 'http://127.0.0.1:1234']) {
      assert.equal(refuseAssistFallback({ baseUrl }, true), null, baseUrl);
    }
  });
  it('a public one without a consent is refused while repair can reach it', () => {
    const r = refuseAssistFallback({ baseUrl: 'https://api.example.com/v1' }, true);
    assert.ok(r && r.status >= 400, JSON.stringify(r));
  });
  it('a public one with its consent passes', () => {
    assert.equal(refuseAssistFallback({ baseUrl: 'https://api.example.com/v1', acknowledgedHost: 'api.example.com' }, true), null);
  });
});
