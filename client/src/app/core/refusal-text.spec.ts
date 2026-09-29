/**
 * A refusal always says something true: the client's words for a code it knows, the server's sentence for one it
 * does not, and the fallback only when the answer carried neither (`Q-133`). Never the raw code, never a blank.
 */
import { describe, expect, it } from 'vitest';
import { refusalText } from './refusal-text';

const known: Record<string, string> = {
  'networks.refusal.join_mapping_collision': 'Two spaces would land in one.',
  'join.error.generic': 'Joining failed.',
};
const transloco = { translate: (key: string) => known[key] ?? key } as Parameters<typeof refusalText>[0];

describe('refusalText', () => {
  it('translates a code the client knows', () => {
    const err = { error: { code: 'join_mapping_collision', error: 'server sentence' } };
    expect(refusalText(transloco, err, 'join.error.generic')).toBe('Two spaces would land in one.');
  });

  it("falls back to the server's sentence for a code the client has no words for", () => {
    const err = { error: { code: 'some_future_code', error: 'The server says why.' } };
    expect(refusalText(transloco, err, 'join.error.generic')).toBe('The server says why.');
  });

  it('uses the server sentence when there is no code', () => {
    expect(refusalText(transloco, { error: { error: 'Plain refusal.' } }, 'join.error.generic')).toBe('Plain refusal.');
  });

  it('uses the fallback key only when the answer carried neither', () => {
    expect(refusalText(transloco, { error: null }, 'join.error.generic')).toBe('Joining failed.');
    expect(refusalText(transloco, undefined, 'join.error.generic')).toBe('Joining failed.');
  });
});
