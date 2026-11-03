/**
 * The logger does not print credentials that arrive inside a URL.
 *
 * ## The gap this closes, which the repo had already reasoned about elsewhere
 *
 * `audit/audit-changes.ts` keeps webhook routes out of the audit log **entirely**, and says why: "a
 * webhook URL can embed [a credential] in userinfo or a query string". That reasoning was applied to the
 * audit store and not to the application log — and `webhooks/store.ts` logs the target URL verbatim when
 * a webhook is created. Same secret, different retained store, and application logs usually have
 * *broader* access than the admin-only audit API, because they get shipped to an aggregator.
 *
 * The fix is central, in `redact()`, rather than at that one call site: a URL reaches a log line most
 * often inside an *error message* nobody wrote by hand, so fixing the call sites you can find leaves the
 * ones you cannot.
 *
 * ## What these tests are really checking
 *
 * Not "does the regex work" but **"is it safe to log a URL at all"** — plus the two ways a redactor goes
 * wrong: missing a case (a live credential in a retained store) and over-matching (redacting ordinary
 * text until the logs are useless and people stop reading them).
 *
 * Run: node --test testing/standalone/log-redaction-urls.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let log, getLogLines, redactSecrets, peerText;

before(async () => {
  ({ log, getLogLines, redactSecrets, peerText } = await import('../../server/dist/util/log.js'));
});

/** Log a line and return what actually landed in the ring buffer. */
function logged(msg) {
  log.warn(msg);
  const lines = getLogLines(1);
  return lines[lines.length - 1] ?? '';
}

describe('URL userinfo never reaches the log', () => {
  it('redacts user:password@host', () => {
    const out = logged('Webhook created: abc → https://svc:s3cr3t@hooks.example.com/path');
    assert.ok(!out.includes('s3cr3t'), `credential leaked: ${out}`);
    assert.ok(out.includes('hooks.example.com'), 'the host must survive, or the line explains nothing');
  });

  it('redacts a bare user@host too', () => {
    // A username alone is not a secret, but it is an identifier that does not belong in a log line and
    // the pattern that carries it is the same one that carries the password.
    const out = logged('peer https://deploybot@peer.internal/api/sync refused');
    assert.ok(!out.includes('deploybot'), `userinfo leaked: ${out}`);
    assert.ok(out.includes('peer.internal'));
  });

  it('leaves an @ in a path or query alone', () => {
    // Over-redaction is the other failure mode: an unreadable log gets ignored, and an ignored log is
    // not a log.
    const out = logged('GET https://api.example.com/users/me@example.com?sort=name ok');
    assert.ok(out.includes('me@example.com'), `over-redacted: ${out}`);
    assert.ok(out.includes('sort=name'));
  });
});

describe('credential-bearing query parameters', () => {
  for (const param of ['api_key', 'apikey', 'api-key', 'access_token', 'token', 'secret', 'password', 'sig', 'signature', 'key', 'auth']) {
    it(`redacts ?${param}=`, () => {
      const out = logged(`fetch failed: https://provider.example.com/v1/x?${param}=SUPERSECRETVALUE`);
      assert.ok(!out.includes('SUPERSECRETVALUE'), `${param} leaked: ${out}`);
      assert.ok(out.includes('provider.example.com'), 'the endpoint must still be identifiable');
    });
  }

  it('redacts a secret param that is not the first one', () => {
    const out = logged('https://x.example.com/a?page=2&api_key=LEAKME&sort=asc');
    assert.ok(!out.includes('LEAKME'), `leaked: ${out}`);
    assert.ok(out.includes('page=2') && out.includes('sort=asc'), 'harmless params must survive');
  });

  it('does NOT redact a param that merely ends in a secret-ish word', () => {
    // `sort_key`, `monkey`, `pubkey_id` are anchored out by requiring ? or & immediately before.
    const out = logged('https://x.example.com/a?sort_key=name&monkey=yes');
    assert.ok(out.includes('sort_key=name'), `over-redacted: ${out}`);
    assert.ok(out.includes('monkey=yes'), `over-redacted: ${out}`);
  });
});

describe('the existing redactions still hold', () => {
  it('Bearer tokens', () => {
    const out = logged('Authorization: Bearer abc123def456');
    assert.ok(!out.includes('abc123def456'), `bearer leaked: ${out}`);
  });
});

// ── Q-365: a scheme that starts with a digit, plus, dot or hyphen is still a scheme ────────────────────────────
//
// #1483 made the userinfo pattern linear with `(?<![a-z0-9+.\-])`, which also stops it matching a scheme run that
// BEGINS with a non-letter: `9https://u:pw@h` reached a log line with its password, where 5.6.3's (quadratic) regex
// redacted it. The corrected form lets a scheme begin with `[0-9+.-]*` before its first letter, keeps the lookbehind, and
// ends the userinfo at the LAST `@` before a `/` (`[^\s/]+@`), so a password containing `@` is masked whole.
describe('Q-365 the outcome table: what a URL with a non-letter scheme prefix does to a log line', () => {
  /** [what, text, secret that must not survive, text that must survive] */
  const TABLE = [
    ['a scheme run beginning with a digit', 'cloned 9https://u:pw1xyz@h.example/p', 'pw1xyz', 'h.example/p'],
    ['a scheme run beginning with a plus, dot and hyphen', 'cloned -+.https://u:pw1xyz@h.example/p', 'pw1xyz', 'h.example/p'],
    ['a scheme run beginning with a plus', 'x+https://u:pw1xyz@h.example/p', 'pw1xyz', 'h.example/p'],
    ['a scheme run with a digit inside it', 'a9b://u:pw1xyz@h.example', 'pw1xyz', 'h.example'],
    ['a digit-prefixed scheme at the start of the text', '9https://u:pw1xyz@h', 'pw1xyz', '@h'],
    ['two URLs on one line, the second digit-prefixed', 'https://a:aw1xyz@one.example and 9https://c:cw1xyz@two.example/x', 'cw1xyz', 'two.example/x'],
    ['two URLs on one line, the first digit-prefixed', '9https://a:aw1xyz@one.example and https://c:cw1xyz@two.example/x', 'aw1xyz', 'one.example'],
    ['a password that contains an @', 'mongodb://u:p@ss1xyz@host:27017/db', 'ss1xyz', 'host:27017/db'],
    ['a password that contains an @ after a digit-prefixed scheme', '9mongodb://u:p@ss1xyz@host:27017/db', 'ss1xyz', 'host:27017/db'],
    ['an @ in a path after the userinfo', 'see https://u:pw1xyz@h.example/path@y', 'pw1xyz', 'path@y'],
    ['a password with an unencoded ? (the userinfo ends at the @ whatever precedes it)', 'https://u:p?ss1xyz@h.example', 'p?ss1xyz', 'h.example'],
  ];
  for (const [what, text, secret, keep] of TABLE) {
    it(`redactSecrets: ${what}`, () => {
      const out = redactSecrets(text);
      assert.ok(!out.includes(secret), `credential leaked: ${out}`);
      assert.ok(out.includes(keep), `the readable part was lost: ${out}`);
    });
    it(`the logger line: ${what}`, () => {
      const out = logged(text);
      assert.ok(!out.includes(secret), `credential leaked: ${out}`);
      assert.ok(out.includes(keep), `the readable part was lost: ${out}`);
    });
  }

  it('mailto: carries an address, not a credential, and stays whole', () => {
    for (const text of ['write mailto:someone@example.com now', 'mailto:someone@example.com?cc=other@example.com']) {
      assert.equal(redactSecrets(text), text, 'an address was redacted as if it were userinfo');
    }
  });

  it('KNOWN LIMIT: a password with an unencoded `/` is not a userinfo a pattern can find, and the line is left as written', () => {
    // The authority ends at the first `/`, so `https://u:pa/ss@h` is a URL with host `u:pa` and a path: no userinfo regex can
    // tell it from one. Pinned so the limit is a stated outcome and a rewrite that "fixes" it by over-matching shows here.
    assert.equal(redactSecrets('https://u:pa/ss@h'), 'https://u:pa/ss@h');
  });
});

describe('Q-365 differential: nothing the old regex redacted is redacted LESS now', () => {
  // 5.6.3's pattern, built fresh per use (a global regex keeps lastIndex): unanchored, so it is quadratic on a long run, and
  // is run here only over short strings. Every string it redacts must be redacted by the real function too.
  const oldRedacts = (text, secret) => !text.replace(/([a-z][a-z0-9+.\-]*:\/\/)[^\s/@]+@/gi, '$1***@').includes(secret);
  const PREFIXES = ['', '9', '-+.', 'x+', 'a9', '1.2.', ' ', '"', '(', '=', '+', '.', '-'];
  const SCHEMES = ['https', 'mongodb+srv', 'a9b', 'ftp'];
  const USERINFO = ['u:pw1xyz', 'pw1xyz', 'u:p@ss1xyz', 'u'];
  const TAILS = ['@h', '@h/p', '@h:1/p?q=a@b', '@h tail'];

  it('over the cross product of prefixes, schemes, userinfos and tails', () => {
    const regressions = [];
    let compared = 0;
    for (const prefix of PREFIXES) for (const scheme of SCHEMES) for (const userinfo of USERINFO) for (const tail of TAILS) {
      const text = `${prefix}${scheme}://${userinfo}${tail}`;
      const secret = userinfo.includes('@') ? userinfo.slice(userinfo.indexOf('@') + 1) : userinfo.replace(/^u:/, '');
      if (!oldRedacts(text, secret)) continue;
      compared++;
      if (redactSecrets(text).includes(secret)) regressions.push(text);
    }
    assert.ok(compared > 100, `only ${compared} strings compared: the corpus no longer exercises the old regex`);
    assert.deepEqual(regressions, [], 'the old regex hid the credential in these and the current one does not');
  });
});

describe('Q-365 timing: the corrected pattern is linear on its worst inputs', () => {
  // 200 000 characters, a generous budget: a quadratic pattern costs seconds here, a linear one milliseconds, so a slow CI
  // machine cannot make the wrong one pass or the right one fail (the style of a-secret-is-masked-by-one-list.test.js).
  const N = 200_000;
  const BUDGET_MS = 1_000;
  const INPUTS = {
    'letters': 'a'.repeat(N),
    'letters then ://': `${'a'.repeat(N)}://`,
    'digits then a plus': `${'1'.repeat(N)}+`,
    'digit and letter alternating': '1a'.repeat(N / 2),
    'letter and plus alternating': 'a+'.repeat(N / 2),
    'every scheme character': '1a+.-'.repeat(N / 5),
    'hyphens and dots then a scheme': `${'-.'.repeat(N / 2)}a:/`,
    'schemes with no userinfo end': 'a://'.repeat(N / 4),
    'a scheme then a long userinfo with no @': `a://${'u'.repeat(N)}`,
    'a scheme then a long userinfo of @-free words': `https://${'u: '.repeat(N / 3)}`,
    'digit-prefixed schemes in a row': '9a://b '.repeat(N / 7),
  };
  for (const [what, text] of Object.entries(INPUTS)) {
    it(`redactSecrets over ${what} (${text.length} chars)`, () => {
      const t0 = performance.now();
      redactSecrets(text);
      const ms = performance.now() - t0;
      assert.ok(ms < BUDGET_MS, `${ms.toFixed(0)} ms: the userinfo pattern is not linear-time`);
    });
    it(`peerText over ${what} (${text.length} chars)`, () => {
      const t0 = performance.now();
      peerText(text);
      const ms = performance.now() - t0;
      assert.ok(ms < BUDGET_MS, `${ms.toFixed(0)} ms: the open-userinfo pattern is not linear-time`);
    });
  }

  it('the 5.6.4 canary survives: a cut value says how much was cut', () => {
    assert.match(peerText(`9https://u:pw@h/${'x'.repeat(N)}`), /…\(\+\d+ chars\)$/);
  });
});

describe('the webhook creation log is covered by this, not by hand', () => {
  it('logs the URL through the central logger rather than console', () => {
    // If this line ever moved to `console.log`, it would bypass redact() entirely and the tests above
    // would keep passing while the credential went straight out.
    const src = readFileSync('server/src/webhooks/store.ts', 'utf8');
    const line = src.split('\n').find(l => l.includes('Webhook created:'));
    assert.ok(line, 'the creation log line should still exist');
    assert.match(line, /log\.(info|warn|debug|error)\(/, 'it must go through the redacting logger');
  });
});
