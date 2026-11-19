/**
 * An HTTP trailer is declared and sent only on an answer that is chunked and carries content (bundle-269 slice E, drive findings 1 and 2).
 *
 * Node refuses a `Trailer` header on an answer that is not chunked (`ERR_HTTP_TRAILER_INVALID`, thrown while the headers are written): a
 * `HEAD` answer (no content, RFC 9110 §9.3.2) and an answer to an HTTP/1.0 client (no chunked coding, RFC 9112 §7.1, and `Connection: close`
 * instead) are not. The records export declared its trailers on every answer, so a `HEAD` and an HTTP/1.0 `GET` each ended the server.
 *
 * ## What it holds
 *
 * - `trailersFor(req, res, names)` (`server/src/export/export-trailers.ts`) decides once whether the answer carries trailers: an HTTP/1.1
 *   or later request whose method is not `HEAD`, before the headers are sent. Only then is `Trailer:` declared, and `send(values)` adds
 *   them; otherwise both do nothing, and the document's own ending says what the trailers would have.
 * - The guard cannot be dropped by a caller: no file of `server/src` but that module names `addTrailers(` or sets a `Trailer` header.
 *
 * Run: node --test testing/standalone/a-trailer-is-declared-only-on-a-chunked-answer.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';

const MODULE = 'server/src/export/export-trailers.ts';
const NAMES = ['Ythril-Export-Complete', 'Ythril-Skipped-Values'];

/** A request and a response stand-in recording what was declared and added. */
function exchange({ method = 'GET', major = 1, minor = 1, headersSent = false } = {}) {
  const set = {};
  let added = null;
  const req = { method, httpVersionMajor: major, httpVersionMinor: minor, httpVersion: `${major}.${minor}` };
  const res = {
    headersSent,
    setHeader(name, value) { set[name.toLowerCase()] = value; return this; },
    addTrailers(t) { added = t; },
  };
  return { req, res, set, added: () => added };
}

describe('a trailer is declared only on a chunked answer', () => {
  it('the module exists and exports trailersFor', async () => {
    assert.ok(existsSync(MODULE), `${MODULE} holds the one trailer guard`);
    const { trailersFor } = await import('../../server/dist/export/export-trailers.js');
    assert.equal(typeof trailersFor, 'function');
  });

  const cases = [
    ['GET over HTTP/1.1', {}, true],
    ['GET over HTTP/2-style version 2.0', { major: 2, minor: 0 }, true],
    ['HEAD over HTTP/1.1 (no content)', { method: 'HEAD' }, false],
    ['GET over HTTP/1.0 (no chunked coding)', { minor: 0 }, false],
    ['HEAD over HTTP/1.0', { method: 'HEAD', minor: 0 }, false],
    ['GET whose headers were already sent', { headersSent: true }, false],
  ];
  for (const [title, shape, carried] of cases) {
    it(`${title}: ${carried ? 'declared and sent' : 'neither declared nor sent'}`, async () => {
      const { trailersFor } = await import('../../server/dist/export/export-trailers.js');
      const x = exchange(shape);
      const t = trailersFor(x.req, x.res, NAMES);
      assert.equal(t.carried, carried);
      assert.equal(x.set['trailer'], carried ? NAMES.join(', ') : undefined);
      t.send({ 'Ythril-Export-Complete': 'true', 'Ythril-Skipped-Values': '0' });
      assert.deepEqual(x.added(), carried ? { 'Ythril-Export-Complete': 'true', 'Ythril-Skipped-Values': '0' } : null);
    });
  }

  it('no other file of server/src declares or adds a trailer', () => {
    const offenders = trackedSources(['server/src'], { floor: 100 })
      .filter(f => f.replace(/\\/g, '/') !== MODULE)
      .filter(f => {
        const src = readFileSync(f, 'utf8');
        return /\.addTrailers\s*\(/.test(src) || /setHeader\(\s*['"`]Trailer['"`]/i.test(src);
      });
    assert.deepEqual(offenders, [], `declare and add trailers only through trailersFor (${MODULE}), which holds the guard`);
  });
});
