/**
 * `httpErrorReason` — the one place an HTTP failure becomes words a person reads.
 *
 * It had no test of its own, which is how the observability gap below survived: every error surface in the
 * app funnels through here, so an omission here is an omission everywhere at once.
 *
 * ## The finding (observability audit, lens 9)
 *
 * The server mints a correlation id per request, returns it as `X-Request-Id`, and logs it with every
 * unhandled error. The UI dropped it — so a 500 read "Internal server error" and the person looking at it
 * had nothing to quote, while the answer sat in the server log behind a key they could not see.
 */
import { describe, it, expect } from 'vitest';
import { httpErrorReason, withRequestId } from './http-error';

/** An HttpErrorResponse-shaped object: only the fields the function reads. */
const res = (over: Record<string, unknown> = {}) => ({
  status: 500,
  statusText: 'Internal Server Error',
  headers: { get: (n: string) => (n === 'X-Request-Id' ? 'req-1234' : null) },
  ...over,
});

describe('withRequestId — the same rule for a sentence the client worded itself', () => {
  it('appends the id to a server fault and to a request that got no answer, and to nothing the caller caused', () => {
    expect(withRequestId('Try again.', res())).toBe('Try again. (request req-1234)');
    expect(withRequestId('Try again.', res({ status: 0 }))).toBe('Try again. (request req-1234)');
    expect(withRequestId('Choose another name.', res({ status: 409 }))).toBe('Choose another name.');
  });

  it('leaves the sentence alone without the header, without a response, and when the headers throw', () => {
    expect(withRequestId('x', res({ headers: { get: () => null } }))).toBe('x');
    expect(withRequestId('x', null)).toBe('x');
    expect(withRequestId('x', res({ headers: { get: () => { throw new Error('no'); } } }))).toBe('x');
  });
});

describe('httpErrorReason — the message', () => {
  it('prefers the server\'s own error text', () => {
    expect(httpErrorReason(res({ status: 400, error: { error: 'Space not found' } })))
      .toBe('Space not found');
  });

  it('falls back to status text, then status, then a JS message', () => {
    expect(httpErrorReason(res({ status: 404, statusText: 'Not Found', headers: undefined }))).toBe('404 Not Found');
    expect(httpErrorReason({ status: 418 })).toBe('HTTP 418');
    expect(httpErrorReason({ message: 'boom' })).toBe('boom');
  });

  it('returns empty when there is nothing useful, rather than inventing a reason', () => {
    expect(httpErrorReason(null)).toBe('');
    expect(httpErrorReason({})).toBe('');
  });
});

describe('httpErrorReason — the request id', () => {
  it('appends it to a server fault, so the reader can quote it', () => {
    expect(httpErrorReason(res({ error: { error: 'Internal server error' } })))
      .toBe('Internal server error (request req-1234)');
  });

  it('appends it to a request that never got an answer (status 0)', () => {
    // A transport failure is exactly when the server log is the only record of what happened.
    expect(httpErrorReason(res({ status: 0, statusText: 'Unknown Error', error: undefined })))
      .toContain('request req-1234');
  });

  it('does NOT append it to a 4xx the caller caused', () => {
    // A validation message is self-explanatory, and an id on every one of them is noise that trains people
    // to ignore the id when it matters.
    expect(httpErrorReason(res({ status: 400, error: { error: 'tags must be an array' } })))
      .toBe('tags must be an array');
    expect(httpErrorReason(res({ status: 404, error: { error: 'Not found' } }))).toBe('Not found');
  });

  it('is unchanged when the header is absent, or the error is not an HTTP response at all', () => {
    expect(httpErrorReason(res({ headers: { get: () => null }, error: { error: 'oops' } }))).toBe('oops');
    expect(httpErrorReason(res({ headers: undefined, error: { error: 'oops' } }))).toBe('oops');
    expect(httpErrorReason(new Error('plain throw'))).toBe('plain throw');
  });

  it('survives a headers object that throws — this runs inside every error path', () => {
    const hostile = res({ error: { error: 'oops' }, headers: { get: () => { throw new Error('no'); } } });
    expect(httpErrorReason(hostile)).toBe('oops');
  });

  it('reports the id alone when there is genuinely nothing else', () => {
    // Status 0 with no status text and no message: a request that never reached anything. Every other
    // shape has a base to append to — a 500 still reads "HTTP 500 (request …)".
    expect(httpErrorReason(res({ status: 0, statusText: '', error: undefined, message: '' })))
      .toBe('request req-1234');
    expect(httpErrorReason(res({ status: 500, statusText: '', error: undefined, message: '' })))
      .toBe('HTTP 500 (request req-1234)');
  });
});
