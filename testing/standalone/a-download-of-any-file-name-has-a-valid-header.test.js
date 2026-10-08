/**
 * A download is served whatever its file is called.
 *
 * ## What was broken
 *
 * The download route wrote the file's name into `Content-Disposition` as `filename="<name>"`. A header value may only
 * hold Latin-1, so Node refused the header for any name with a character above U+00FF — `日本.txt`, an emoji, or an
 * accent sent decomposed (`e` + U+0301, as a macOS client spells it) — and the route answered `500 Failed to read file`
 * while the bytes were there. Found by the bundle-71 verify drive, 2026-10-08; it is in every release that serves files.
 *
 * The header now carries an ASCII `filename` for old clients and the real name as `filename*` (RFC 6266 / RFC 5987,
 * UTF-8, percent-encoded), which every current browser prefers. The quote, backslash and line-break guard stays: a name
 * cannot end the parameter or start a new header.
 *
 * Run: npm run build in server/, then node --test testing/standalone/a-download-of-any-file-name-has-a-valid-header.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateHeaderValue } from 'node:http';

const { contentDispositionOf } = await import('../../server/dist/util/content-disposition.js');

/** The name a client recovers from the header: `filename*` when present (as browsers read it), else `filename`. */
function nameIn(header) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1]);
  return /filename="([^"]*)"/.exec(header)?.[1];
}

const NAMES = ['plain.txt', '日本.txt', 'café.txt', 'café.txt', '📄 notes.md', 'résumé (final).pdf', '50%.png', 'a;b.txt'];

describe('a download of any file name has a valid Content-Disposition', () => {
  for (const name of NAMES) {
    for (const disposition of ['inline', 'attachment']) {
      it(`${disposition}: ${JSON.stringify(name)} is a header Node accepts, and names the file`, () => {
        const header = contentDispositionOf(disposition, name);
        assert.doesNotThrow(() => validateHeaderValue('Content-Disposition', header), `Node refuses: ${header}`);
        assert.ok(header.startsWith(`${disposition};`), header);
        assert.equal(nameIn(header), name, `a client reads another name from: ${header}`);
      });
    }
  }

  it('a quote, a backslash or a line break cannot end the parameter or start a header', () => {
    for (const name of ['a"b.html', 'a\\b.html', 'a\r\nSet-Cookie: x=1.html', 'x\n.txt']) {
      const header = contentDispositionOf('attachment', name);
      assert.doesNotThrow(() => validateHeaderValue('Content-Disposition', header), header);
      assert.ok(!/[\r\n]/.test(header), `a line break survives: ${JSON.stringify(header)}`);
      const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
      assert.ok(!quoted.includes('\\'), `a backslash survives in the quoted name: ${header}`);
      assert.equal(header.match(/"/g)?.length, 2, `a raw quote survives: ${header}`);
    }
  });

  it('the ASCII fallback is ASCII', () => {
    const header = contentDispositionOf('inline', '日本 café.txt');
    const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    assert.match(quoted, /^[\x20-\x7e]*$/, header);
  });
});
