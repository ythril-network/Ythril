/**
 * A token-shaped string is masked by ONE list, owned by `testing/_shared/secret-masking.mjs` (bundle-56 dedup, item 7).
 *
 * ## What this prevents
 *
 * The same four families (`ythril_`, GitHub's `gh?_` and `github_pat_`, `Bearer`) were written three times: the
 * timing reporter's `SECRET_PATTERNS`, the recorder's `CREDENTIALS` (the same families again with looser length
 * floors, plus `Authorization:` and a JWT) applied AFTER the reporter's, and the Ythril client's `sentenceOf`
 * (`Bearer\s+\S+`). A family added to one was silently unmasked by the others, and the reporter's stricter-looking
 * floors were a promise the recorder broke: a credential masked by `maskText` was written, unmasked, to the
 * `test-results/` file and to the CI artifact (a public download) the reporter produced first.
 *
 * ## Which semantics won, and why
 *
 * The recorder's. Its floors were written "stricter on purpose, this is the last stop before a write", and for every
 * family they are the lower (so the wider) of the two; the reporter's list is a subset of it. The `ythril_` family
 * follows the real token's shape (`ythril_` + base62, `auth/tokens.ts`): a first run of 8 or more base62 characters,
 * and any `_`/`-`-joined runs after it. So a metric or harness name (`ythril_http_requests_total`, first run `http`)
 * stays readable in a timing record, while a typed test token with underscores is masked whole. `Bearer` still masks
 * the word after it whatever it is (`Bearer token missing`) — a leaked credential in a public artifact outweighs a
 * hidden word in a title.
 *
 * ## What the server's `redactSecrets` is, and why it stays separate
 *
 * `server/src/util/log.ts` `redactSecrets` answers a different question: "what must not reach a SERVER log line",
 * which is URL userinfo, credential query parameters and a `Bearer` value, windowed and linear-time over untrusted
 * peer text. It names none of the token families above, and it ships in the server image, which holds neither
 * `scripts/` nor `testing/`. Two lists for two stores; this gate is scoped to the maintainer scripts and the test
 * tooling, where the same question was asked three times.
 *
 * Run: node --test testing/standalone/a-secret-is-masked-by-one-list.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { startFakeYthril, FAKE_TOKEN, FAKE_SPACE } from '../_shared/fake-ythril-tool-server.mjs';

const MASKING = 'testing/_shared/secret-masking.mjs';
const url = (rel) => pathToFileURL(resolve(REPO_ROOT, rel)).href;

const B62 = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7kL9m'; // the shape of a real `ythril_` token: base62, 43 characters
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';

/**
 * The truth table: [what it is, text, text after masking]. The floors live in these rows, so a loosened floor
 * (or a dropped family) fails a named row. `Authorization:` takes the first token after it, as it always did.
 */
const ROWS = [
  ['a real ythril token', `key ythril_${B62} end`, 'key *** end'],
  ['a ythril-shaped test token with underscores', 'ythril_testtoken_0123456789abcdef', '***'],
  ['ythril_ with exactly the floor (8) after it', 'x ythril_abcdefgh y', 'x *** y'],
  ['ythril_ one under the floor', 'x ythril_abcdefg y', 'x ythril_abcdefg y'],
  ['a classic GitHub token', 'x ghp_abcdefghijklmnopqrstuvwxyz0123456789 y', 'x *** y'],
  ['ghp_ with exactly the floor (16) after it', 'x ghp_abcdefghijklmnop y', 'x *** y'],
  ['ghp_ one under the floor', 'x ghp_abcdefghijklmno y', 'x ghp_abcdefghijklmno y'],
  ['gho_, ghu_, ghs_ and ghr_ are the same family', 'gho_abcdefghijklmnop ghu_abcdefghijklmnop ghs_abcdefghijklmnop ghr_abcdefghijklmnop', '*** *** *** ***'],
  ['a fine-grained GitHub token', 'x github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz y', 'x *** y'],
  ['github_pat_ with exactly the floor (16)', 'x github_pat_abcdefghijklmnop y', 'x *** y'],
  ['github_pat_ one under the floor', 'x github_pat_abcdefghijklmno y', 'x github_pat_abcdefghijklmno y'],
  ['Bearer and an opaque credential', 'sent Bearer opaque-credential-0123456789 away', 'sent Bearer *** away'],
  ['Bearer with no floor on the value', 'Bearer abc', 'Bearer ***'],
  ['bearer, any case (the word is kept, written one way)', 'bearer abc', 'Bearer ***'],
  ['Bearer across any whitespace', 'Bearer \t abc', 'Bearer ***'],
  ['an Authorization header', 'failed with Authorization: secretvalue and more', 'failed with Authorization: *** and more'],
  ['an Authorization header carrying a scheme', 'Authorization: Bearer opaque-credential-0123456789', 'Authorization: ***'],
  ['an Authorization header carrying Basic', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: ***'],
  ['a JWT', `token ${JWT} end`, 'token *** end'],
  ['several in one line', `ythril_${B62} and ghp_abcdefghijklmnopqrstuvwxyz0123456789`, '*** and ***'],
  // A connection string carries its credential as URL userinfo (`scheme://user:pass@host`): the user and the password
  // are masked together, the host and path stay (`mongodb://` + the throwaway test password is what a failure line
  // from the harness can carry).
  ['a mongodb connection string with user and password', 'failed mongodb://ythril:ythril-test-pw@127.0.0.1:27017/db?x=1 here', 'failed mongodb://***@127.0.0.1:27017/db?x=1 here'],
  ['a mongodb+srv connection string', 'mongodb+srv://admin:s3cret@cluster0.example.net/app', 'mongodb+srv://***@cluster0.example.net/app'],
  ['a password that contains an @', 'mongodb://u:p@ss@host:27017/db', 'mongodb://***@host:27017/db'],
  ['URL userinfo with a token and no password', 'cloned https://tokenvalue123@example.com/org/repo.git', 'cloned https://***@example.com/org/repo.git'],
  ['a URL with no userinfo', 'GET https://example.com/path/a@b?q=1', 'GET https://example.com/path/a@b?q=1'],
  ['a host and port with no scheme', 'mongo-a:27017/db', 'mongo-a:27017/db'],
  ['an email address', 'mail someone@example.com', 'mail someone@example.com'],
  // What only LOOKS like one stays whole.
  ['a bare prefix', 'ghp_', 'ghp_'],
  ['the product name', 'ythril and ythril_', 'ythril and ythril_'],
  ['a metric name: its first run after ythril_ is short, so it is not a token', 'ythril_http_requests_total', 'ythril_http_requests_total'],
  ['a harness database name', 'ythril_harness_standalone_recall_filtered', 'ythril_harness_standalone_recall_filtered'],
  ['the word Bearer inside another word', 'the Bearers of news', 'the Bearers of news'],
  ['a plain sentence', 'a plain sentence', 'a plain sentence'],
  ['nothing', '', ''],
];

let mask;
let maskText;
let createYthrilApi;
let server;

before(async () => {
  ({ maskSecrets: mask } = await import(url(MASKING)));
  ({ maskText } = await import(url('scripts/test-times.mjs')));
  ({ createYthrilApi } = await import(url('scripts/_shared/ythril-api.mjs')));
  server = await startFakeYthril();
});
after(async () => { await server?.close(); });

describe('the one masking list', () => {
  for (const [what, text, masked] of ROWS) {
    it(`maskSecrets: ${what}`, () => assert.equal(mask(text), masked));
  }

  it('is idempotent on every row', () => {
    for (const [, text] of ROWS) assert.equal(mask(mask(text)), mask(text), JSON.stringify(text));
  });

  it('takes anything printable: a number, null and undefined become text, never a throw', () => {
    assert.equal(mask(42), '42');
    assert.equal(mask(null), 'null');
    assert.equal(mask(undefined), 'undefined');
  });
});

describe('every door that masks answers by that list', () => {
  for (const [what, text, masked] of ROWS) {
    it(`the recorder's maskText: ${what}`, () => assert.equal(maskText(text), masked));
  }

  for (const [what, text, masked] of ROWS) {
    it(`the Ythril client's error sentence: ${what}`, async () => {
      server.respond = () => ({ status: 500, body: { ok: false, error: text, data: null } });
      try {
        const api = createYthrilApi({ url: server.url, token: FAKE_TOKEN });
        await assert.rejects(
          api.call('filter', { space: FAKE_SPACE, collection: 'chrono' }),
          (err) => err.message === `filter: HTTP 500${masked ? `: ${masked}` : ''}`,
          `the sentence for ${JSON.stringify(text)}`,
        );
      } finally { server.respond = undefined; }
    });
  }

  it('the client also removes the exact token it holds, wherever it sits, before any shape is looked for', async () => {
    server.respond = () => ({ status: 500, body: { ok: false, error: `bad key ${FAKE_TOKEN}!`, data: null } });
    try {
      const api = createYthrilApi({ url: server.url, token: FAKE_TOKEN });
      await assert.rejects(api.call('filter', { space: FAKE_SPACE, collection: 'chrono' }), (err) => err.message === 'filter: HTTP 500: bad key ***!');
    } finally { server.respond = undefined; }
  });
});

describe('no other file re-writes the token regexes this gate knows', () => {
  /*
   * Derived, never listed: every tracked source of the maintainer scripts and the test tooling, tests and fixtures
   * excepted (a fixture may be literal). The SUBJECTS are derived; the shapes are not: they are the regexes of the
   * families named below, written out, so what this checks is a copy of THOSE, not "a list of token families" in
   * general. A family the masking module gains and no row here names is not looked for.
   */
  const SHAPES = [
    /ythril_\[A-Za-z0-9/,
    /gh\[pousr\]_/,
    /github_pat_\[/,
    /Bearer\\{1,2}s/,
  ];
  const sources = () => trackedSources(['scripts', 'testing', 'benchmarks'], { ext: ['.mjs', '.js'], floor: 200, exclude: [MASKING] })
    .filter(f => !f.endsWith('.test.js') && !f.includes('/_fixtures/'));

  it('only the masking module writes one', () => {
    const files = sources();
    assert.ok(files.length >= 50, `the scan saw only ${files.length} sources`);
    const copies = [];
    for (const f of files) {
      const text = stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
      for (const shape of SHAPES) if (shape.test(text)) copies.push(`${f}: ${shape}`);
    }
    assert.deepEqual(copies, [], `a token-family pattern is written outside ${MASKING}: import maskSecrets from it instead`);
  });

  it('the masking module is read by the three doors that used to keep their own', () => {
    for (const f of ['testing/_shared/timing-reporter.mjs', 'scripts/test-times.mjs', 'scripts/_shared/ythril-api.mjs']) {
      assert.match(readFileSync(resolve(REPO_ROOT, f), 'utf8'), /secret-masking\.mjs/, `${f} does not import the masking module`);
    }
  });
});
