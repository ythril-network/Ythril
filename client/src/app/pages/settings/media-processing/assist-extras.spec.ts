/**
 * What the assist card sends for its budget, fallback and API kind (`F-33`, `F-33.1`), and when an external
 * fallback owes a consent. The server merges these as "absent keeps, `null` removes", so the card always sends
 * them; the fallback's key goes out only from its own input, never echoed back from the masked value.
 */
import { describe, it, expect } from 'vitest';
import { assistExtrasPatch, budgetPatch, fallbackPatch, fallbackNeedsAck, isLocalEndpoint } from './assist-extras';

describe('the assist card\'s extras', () => {
  it('sends a cleared budget and fallback as null, never omits them', () => {
    expect(assistExtrasPatch({}, '')).toEqual({ api: 'openai', budget: null, fallback: null });
  });

  it('a budget needs both numbers, and tokens are whole', () => {
    expect(budgetPatch({ tokens: 0, perHours: 24 })).toBeNull();
    expect(budgetPatch({ tokens: 1000.7, perHours: 24 })).toEqual({ tokens: 1000, perHours: 24 });
  });

  it('the fallback key is sent only when one was typed', () => {
    const fb = { baseUrl: ' http://ollama:11434/v1 ', model: 'small', apiKey: '••••' };
    expect(fallbackPatch(fb, '')).toEqual({ api: 'openai', baseUrl: 'http://ollama:11434/v1', model: 'small' });
    expect(fallbackPatch(fb, 'sk-new')?.apiKey).toBe('sk-new');
  });

  it('carries the Claude API kind for the primary and the fallback', () => {
    const p = assistExtrasPatch({ api: 'anthropic', fallback: { api: 'anthropic', baseUrl: 'https://api.anthropic.com' } }, '');
    expect(p.api).toBe('anthropic');
    expect(p.fallback?.api).toBe('anthropic');
  });

  it('a local fallback never owes a consent; an external one does while repair can reach it', () => {
    for (const url of ['http://ollama:11434', 'http://localhost:8080', 'http://127.0.0.1:1234']) expect(isLocalEndpoint(url)).toBe(true);
    expect(fallbackNeedsAck({ fallback: { baseUrl: 'http://ollama:11434' } }, true)).toBe(false);
    expect(fallbackNeedsAck({ fallback: { baseUrl: 'https://api.anthropic.com' } }, true)).toBe(true);
    expect(fallbackNeedsAck({ fallback: { baseUrl: 'https://api.anthropic.com' } }, false)).toBe(false);
    expect(fallbackNeedsAck({ fallback: { baseUrl: 'https://api.anthropic.com', acknowledgedHost: 'api.anthropic.com' } }, true)).toBe(false);
  });
});
