/**
 * Q-942 (verify finding L2.3, L4.3): what an RDF door's failure says on the RDF screens.
 *
 * A server fault (a 5xx) is worded by status and carries the request id its log line is filed under, as every other refusal does
 * (`withRequestId`), and never the server's English. The dialog's Save words the RDF codes (`rdf_base_shared`, `rdf_base_nested`, ...)
 * through the RDF family, which the networks family does not hold.
 */
import { describe, it, expect } from 'vitest';
import { rdfRefusalText, isRdfRefusal } from './rdf-refusal';

const t = { translate: (k: string) => `T:${k}` };
const headers = (id: string | null) => ({ get: (n: string) => (n.toLowerCase() === 'x-request-id' ? id : null) });

describe('rdfRefusalText, a server fault', () => {
  it('words a 5xx by status and adds the request id', () => {
    expect(rdfRefusalText(t, { status: 502, error: { error: 'upstream exploded' }, headers: headers('req-77') })).toBe('T:rdf.refusal.failed (request req-77)');
  });

  it('a coded 4xx is the family\'s sentence with no request id: the caller caused it', () => {
    expect(rdfRefusalText(t, { status: 409, error: { error: 'x', code: 'rdf_base_shared' }, headers: headers('req-1') })).toBe('T:rdf.refusal.rdf_base_shared');
  });

  it('a 5xx with no request id header is the plain sentence, and a lost connection keeps its own', () => {
    expect(rdfRefusalText(t, { status: 500, error: { error: 'boom' }, headers: headers(null) })).toBe('T:rdf.refusal.failed');
    expect(rdfRefusalText(t, { status: 0 })).toBe('T:rdf.refusal.unreachable');
  });
});

describe('isRdfRefusal', () => {
  it('is true for the codes only the RDF family words, false for any other answer', () => {
    expect(isRdfRefusal({ status: 409, error: { code: 'rdf_base_shared' } })).toBe(true);
    expect(isRdfRefusal({ status: 409, error: { code: 'rdf_base_nested' } })).toBe(true);
    expect(isRdfRefusal({ status: 409, error: { code: 'space_being_wiped' } })).toBe(false);
    expect(isRdfRefusal({ status: 500, error: { error: 'boom' } })).toBe(false);
    expect(isRdfRefusal(null)).toBe(false);
  });
});
