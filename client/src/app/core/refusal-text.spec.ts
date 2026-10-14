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

  it('reads a code in the key family it is given, and offers the answer\'s path to the sentence', () => {
    const words: Record<string, string> = { 'files.refusal.path_blocked': 'Blocked: {{path}}' };
    const t = { translate: (key: string, p?: { path?: string }) => (words[key] ?? key).replace('{{path}}', p?.path ?? '') } as Parameters<typeof refusalText>[0];
    const err = { error: { code: 'path_blocked', path: 'a.txt/x', error: 'server sentence' } };
    expect(refusalText(t, err, 'join.error.generic', 'files.refusal')).toBe('Blocked: a.txt/x');
    // The same code in the default (network) family has no words, so the server's sentence is said.
    expect(refusalText(t, err, 'join.error.generic')).toBe('server sentence');
  });

  it('offers the answer\'s heldBy to the sentence beside the path', () => {
    const words: Record<string, string> = { 'files.refusal.held': '{{path}} is held by {{heldBy}}' };
    const t = {
      translate: (key: string, p?: { path?: string; heldBy?: string }) =>
        (words[key] ?? key).replace('{{path}}', p?.path ?? '').replace('{{heldBy}}', p?.heldBy ?? ''),
    } as Parameters<typeof refusalText>[0];
    const err = { error: { code: 'held', path: 'b.txt', heldBy: 'o/c.txt', error: 'server sentence' } };
    expect(refusalText(t, err, 'join.error.generic', 'files.refusal')).toBe('b.txt is held by o/c.txt');
  });

  it('appends the request id to a server fault, whichever sentence was chosen, and to nothing the caller caused', () => {
    const headers = { get: (n: string) => (n === 'X-Request-Id' ? 'req-9' : null) };
    const fault = { status: 500, headers, error: { code: 'some_future_code', error: 'The server says why.' } };
    expect(refusalText(transloco, fault, 'join.error.generic')).toBe('The server says why. (request req-9)');
    const known500 = { status: 500, headers, error: { code: 'join_mapping_collision' } };
    expect(refusalText(transloco, known500, 'join.error.generic')).toBe('Two spaces would land in one. (request req-9)');
    const refused = { status: 409, headers, error: { code: 'join_mapping_collision' } };
    expect(refusalText(transloco, refused, 'join.error.generic')).toBe('Two spaces would land in one.');
  });

  it('uses the fallback key only when the answer carried neither', () => {
    expect(refusalText(transloco, { error: null }, 'join.error.generic')).toBe('Joining failed.');
    expect(refusalText(transloco, undefined, 'join.error.generic')).toBe('Joining failed.');
  });
});
