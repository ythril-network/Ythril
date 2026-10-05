/**
 * A value from outside this instance is rendered for a log line by ONE function, `peerText` (`util/log.ts`), which
 * redacts, cuts and escapes it in that order and never throws; `peerList` does the same for a list; and the meta
 * argument of every log call is rendered the same way where every line is built (`Q-231`, `Q-270`).
 *
 * ## The rule, clause by clause
 *
 *  - **Redact BEFORE the cut.** The userinfo pattern needs the `@` that ends it. Cut first, and a URL whose
 *    password straddles the cut loses its `@`, so the redactor no longer recognises it and the first half of the
 *    password is written to the log.
 *  - **Redact an authority the window cuts open.** Only `max + REDACT_MARGIN` characters of a long value are redacted, so
 *    a password longer than the margin has no `@` inside the window; the open authority at the window's end is redacted
 *    to its end (`OPEN_USERINFO_AT_END`) or the front of the password reaches the line.
 *  - **Cut on a code-point boundary.** Half a surrogate pair is not a character; a line holding one is invalid UTF-16
 *    and some log shippers drop or mangle the whole line.
 *  - **Say how much was cut.** `…(+N chars)`: an operator reading a cut value knows it was cut and by how much.
 *  - **Escape AFTER the cut**, so an escape is never cut in half (`\u00` with its digits gone reads as text).
 *  - **An Error renders its message.** `JSON.stringify(new Error('x'))` is `{}` — the reason a failure happened is
 *    exactly what the operator came to read.
 *  - **It never throws.** It runs inside a `catch` more often than not; a getter that throws, a cyclic object or a
 *    BigInt must not turn a logged failure into a second, unlogged one.
 *  - **`peerList` bounds the count and the length**, and escapes each element.
 *  - **The meta argument** (`log.warn(msg, meta)`) is rendered through the same rule inside `fmt`, so no call site has
 *    to remember it: a meta value carrying `\r\n` or a megabyte reaches the line escaped and bounded.
 *
 * `logSafe` is the older name for `peerText` and must stay the SAME function: every clause is asserted under both
 * names, so an alias that drifted into a second implementation fails here.
 *
 * ## Pins (green on the base, kept)
 *
 * `logSafe` already escapes every line-breaking character — C0, DEL, C1, U+2028, U+2029 — writing `\r`, `\n`, `\t`
 * short and the rest as `\uXXXX`, and leaves ordinary text, including non-ASCII, alone. Pinned so the new rule is
 * added to that behaviour rather than replacing it.
 *
 * ## The redaction outcome table, and the regex it holds to (release line 5.6.x)
 *
 * The userinfo pattern backtracks over a run of scheme characters, so redacting an unbounded value is QUADRATIC (measured
 * on 6eb5a333: 3.9 s for 100 000 letters, 8 s for 100 000 digit-letter pairs). Main's cure — a lookbehind that starts a
 * scheme only after a non-scheme character — is linear but changes WHAT is redacted: `9https://u:pw@h` is redacted by
 * the release line today (the scheme starts at the `h`) and not by the lookbehind (the `h` follows a `9`), so the
 * password reached the log. The release line's rule is "linear, and the same outcome as before", so this holds
 * `redactSecrets` and both renderers to a table of outcomes AND, over a seeded fuzz of scheme-like strings, to the
 * reference pattern copied below as a literal (a test fixture may be literal; it states what 5.6.3 redacted).
 * The table and the fuzz are PINS on `redactSecrets` (green on the base, kept); the renderers and the timing are red.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3, the base of the 5.6.4 patch): `peerText`, `peerList` and `LOG_VALUE_MAX` do not exist; `logSafe`
 * neither cuts, nor redacts, nor renders an Error (it prints `{}`), and throws on a cyclic object, a throwing getter and
 * a BigInt; `fmt` appends the meta argument raw — a meta value's `\r\n` starts a new line and a megabyte meta makes a
 * megabyte line; `redactSecrets` takes seconds on 100 000 letters.
 *
 * ## Seen red (round R, 5.6.4)
 *
 * Each by a mutation of the part it covers, restored by hand: `OPEN_USERINFO_AT_END`'s replacement written as `$&` (the
 * password-across-the-window case, under both names); `peerList`'s count of what it left out one short (both exact-tail
 * cases); `fmt` returning its line without `escapeLineBreaks` (the message-slot case, which the meta cases do not see
 * because they escape through `peerText` first). The fuzz is held to floors on its own strings, so a generator that falls
 * into a cycle (the one it replaced drew 1 081 distinct strings in 20 000) fails by name.
 *
 * Run: node --test testing/standalone/a-peer-value-is-rendered-escaped-redacted-and-bounded.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logLinesDuring } from './_log-lines.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const mod = await import('../../server/dist/util/log.js');

/**
 * How far past `LOG_VALUE_MAX` a value is read for redaction before it is cut (`REDACT_MARGIN` in `util/log.ts`). The
 * module does not export it, so it is READ out of the source: the case below that puts a URL authority across that
 * window is placed by the number the renderer uses, never by a copy of it that could go stale beside it.
 */
const REDACT_MARGIN = (() => {
  const src = stripComments(readFileSync(join(REPO_ROOT, 'server', 'src', 'util', 'log.ts'), 'utf8'));
  const m = /const REDACT_MARGIN = (\d+);/.exec(src);
  assert.ok(m, 'util/log.ts no longer declares `const REDACT_MARGIN = <number>;` — the window a value is redacted over');
  return Number(m[1]);
})();

/** U+2028 and U+2029, built from their numbers: written literally they end a line inside a regex or a string. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
/** Every character that must never reach a line raw: C0, DEL, C1, U+2028, U+2029. */
const LINE_BREAKING = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${LS}${PS}]`);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const RENDERERS = ['peerText', 'logSafe'];

function renderer(name) {
  assert.equal(typeof mod[name], 'function', `util/log.ts exports no function \`${name}\``);
  return mod[name];
}
function bound() {
  const max = mod.LOG_VALUE_MAX;
  assert.ok(Number.isInteger(max), 'util/log.ts exports no integer `LOG_VALUE_MAX` — the bound a value is cut at');
  assert.ok(max >= 64 && max <= 16_384, `LOG_VALUE_MAX is ${max}: too small to read a value, or too large to bound one`);
  return max;
}
/**
 * The bound a "a megabyte comes back bounded" case holds a result to: `LOG_VALUE_MAX` when it is exported, else the
 * largest value `bound()` accepts — so on a tree without the constant the case still fails for the LENGTH it sees.
 */
const ceiling = () => (Number.isInteger(mod.LOG_VALUE_MAX) ? mod.LOG_VALUE_MAX : 16_384);
/** The `N` of a `…(+N chars)` suffix, or null when the value was not cut. */
const cutBy = s => {
  const m = /…\(\+(\d+) chars\)$/.exec(s);
  return m ? Number(m[1]) : null;
};

describe('PIN: logSafe escapes every line-breaking character and leaves ordinary text alone', () => {
  it('short escapes for CR, LF and TAB; \\uXXXX for every other control; plain and non-ASCII text untouched', () => {
    const { logSafe } = mod;
    assert.equal(logSafe('plain id-1'), 'plain id-1');
    assert.equal(logSafe('a\r\nb\tc'), 'a\\r\\nb\\tc');
    assert.equal(logSafe(`x\u001by\u007fz\u0085w${LS}v${PS}`), 'x\\u001by\\u007fz\\u0085w\\u2028v\\u2029');
    assert.equal(logSafe('café 🦉 ünïcödé'), 'café 🦉 ünïcödé');
    for (let c = 0; c <= 0x9f; c++) {
      if (c > 0x1f && c < 0x7f) continue;
      assert.doesNotMatch(logSafe(`a${String.fromCharCode(c)}b`), LINE_BREAKING, `U+${c.toString(16)} reached the line raw`);
    }
  });
});

describe('peerText: redacted, cut, escaped, never throws', () => {
  it('peerText and peerList exist, and logSafe IS peerText', () => {
    renderer('peerText');
    renderer('peerList');
    assert.equal(mod.logSafe, mod.peerText, '`logSafe` must be the same function as `peerText`, not a second copy of the rule');
  });

  for (const name of RENDERERS) {
    describe(`under the name ${name}`, () => {
      it('a value no longer than LOG_VALUE_MAX is kept whole; a longer one is cut, saying by how much', () => {
        const render = renderer(name);
        const max = bound();
        const exact = 'x'.repeat(max);
        assert.equal(render(exact), exact, 'a value exactly at the bound was cut');
        const big = 'x'.repeat(max * 3 + 7);
        const out = render(big);
        const n = cutBy(out);
        assert.ok(n !== null, `a value of ${big.length} chars was not cut with …(+N chars): ${out.length} chars came back`);
        const kept = out.slice(0, out.lastIndexOf('…('));
        assert.ok(kept.length <= max, `kept ${kept.length} chars, more than the bound ${max}`);
        assert.equal(kept.length + n, big.length, 'the suffix does not state what was cut: kept + N must be the original length');
      });

      it('a megabyte comes back bounded', () => {
        const render = renderer(name);
        const max = ceiling();
        const out = render('9'.repeat(1_048_576));
        assert.ok(out.length <= max + 32, `a megabyte rendered as ${out.length} chars`);
      });

      it('a long run of letters is rendered in bounded TIME, not only to bounded length', () => {
        // The userinfo pattern backtracks over a run of scheme characters: measured on 0b066822, `redactSecrets` takes
        // 0.7 s for 40 000 letters and grows with the square — a megabyte `_id` of letters is minutes of event loop.
        // Redacting first must not mean redacting the whole of an unbounded value.
        const render = renderer(name);
        const t = performance.now();
        render('m'.repeat(100_000));
        const ms = performance.now() - t;
        assert.ok(ms < 1_000, `100 000 letters took ${Math.round(ms)} ms to render`);
      });

      it('redacts BEFORE the cut: a password straddling the bound never leaves a partial secret', () => {
        const render = renderer(name);
        const max = bound();
        const password = 'Pw0rdSecretSecretSecretSecretSecretSecret';
        // Every placement of the cut inside `user:password@`, so the order of redact and cut is what decides.
        for (const back of [5, 10, 20, 30, 40]) {
          const url = `https://admin:${password}@peer.example/api/sync`;
          const pad = 'p'.repeat(max - 'https://admin:'.length - back);
          const out = render(`${pad}${url} tail`);
          for (let k = 4; k <= password.length; k++) {
            assert.ok(!out.includes(password.slice(0, k)),
              `cut ${back} chars into the password, ${k} of its characters reached the line: …${out.slice(-80)}`);
          }
        }
        assert.ok(!render('Authorization: Bearer ythril_abcdef123456').includes('ythril_abcdef123456'), 'a bearer token was not redacted');
      });

      it('redacts a URL authority the redaction WINDOW cuts open: a password whose `@` lies past max + margin never reaches the line', () => {
        // Only `max + REDACT_MARGIN` characters of a long value are redacted, and the userinfo pattern needs the `@`
        // that ends the userinfo. A password longer than the margin has no `@` inside the window, so the pattern sees
        // nothing to redact and the front of the password would be written — unless the open authority at the window's
        // end is redacted to its end (`OPEN_USERINFO_AT_END`). The URL starts before the bound, so the front of the
        // password is inside what the line shows; its `@` is far past the window.
        const render = renderer(name);
        const max = bound();
        const password = Array.from({ length: REDACT_MARGIN + 400 }, (_, i) => `Pw${(i * 7919).toString(36)}`).join('').slice(0, REDACT_MARGIN + 400);
        const scheme = 'https://admin:';
        const shownPassword = 12;
        for (let pad = max - 200; pad <= max - scheme.length - shownPassword; pad += 13) {
          const text = `${'_'.repeat(pad)}${scheme}${password}@peer.example/api/sync`;
          assert.ok(pad + scheme.length + password.length > max + REDACT_MARGIN, 'fixture check: the `@` is inside the window, so this places nothing across it');
          assert.ok(text.indexOf('@') > max + REDACT_MARGIN, 'fixture check: the `@` is not past the window');
          const out = render(text);
          assert.ok(!out.includes(password.slice(0, shownPassword)),
            `pad ${pad}: the front of a password whose \`@\` lies past the window reached the line: …${out.slice(-60)}`);
          assert.ok(out.startsWith(`${'_'.repeat(pad)}https://[redacted]`), `pad ${pad}: the authority was not redacted to its end: …${out.slice(pad).split('\n')[0]}`);
        }
      });

      it('cuts on a code-point boundary: no lone surrogate, whichever side of a pair the bound falls on', () => {
        const render = renderer(name);
        const max = bound();
        for (const pad of [max - 3, max - 2, max - 1, max, max + 1]) {
          const out = render(`${'a'.repeat(pad)}${'🦉'.repeat(40)}`);
          assert.doesNotMatch(out, LONE_SURROGATE, `pad ${pad}: the cut split a surrogate pair`);
          assert.ok(cutBy(out) !== null, `pad ${pad}: not cut`);
        }
      });

      it('escapes AFTER the cut: no escape sequence is cut in half, and nothing line-breaking survives', () => {
        const render = renderer(name);
        const max = bound();
        for (const pad of [max - 3, max - 2, max - 1]) {
          const out = render(`${'a'.repeat(pad)}${'\u0001\r\n'.repeat(50)}`);
          assert.doesNotMatch(out, LINE_BREAKING);
          const body = out.slice(0, out.lastIndexOf('…('));
          // The input holds no backslash, so every one in the output starts an escape — which must be whole. Read at
          // the backslash by the escape's own grammar (a sticky match), not by a count of characters after it.
          for (const m of body.matchAll(/\\/g)) {
            const whole = /\\(?:[rnt]|u[0-9a-f]{4})/y;
            whole.lastIndex = m.index;
            assert.ok(whole.test(body), `pad ${pad}: an escape was cut: ${body.slice(m.index)}`);
          }
        }
      });

      it('an Error renders its message, escaped — not "{}"', () => {
        const render = renderer(name);
        const out = render(new Error('peer refused\r\nFORGED [ERROR] line'));
        assert.notEqual(out, '{}');
        assert.ok(out.includes('peer refused\\r\\nFORGED'), `an Error rendered as ${JSON.stringify(out)}`);
        assert.doesNotMatch(out, LINE_BREAKING);
      });

      it('never throws: a throwing getter, a cyclic object, a BigInt, a Symbol, a hostile Proxy, undefined', () => {
        const render = renderer(name);
        const cyclic = { a: 1 };
        cyclic.self = cyclic;
        const hostile = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
        const cases = {
          'a throwing getter': { get boom() { throw new Error('getter'); } },
          'a cyclic object': cyclic,
          'a BigInt': 10n ** 30n,
          'a Symbol': Symbol('s'),
          'a hostile Proxy': hostile,
          undefined: undefined,
          null: null,
        };
        for (const [label, value] of Object.entries(cases)) {
          let out;
          assert.doesNotThrow(() => { out = render(value); }, `${label} made it throw`);
          assert.equal(typeof out, 'string', `${label} rendered as ${typeof out}`);
          assert.doesNotMatch(out, LINE_BREAKING);
        }
      });
    });
  }
});

describe('peerList: a joined list bounded by count and length', () => {
  it('ten thousand ids come back bounded, saying how many were left out', () => {
    const peerList = renderer('peerList');
    const max = bound();
    const ids = Array.from({ length: 10_000 }, (_, i) => `id-${i}`);
    const out = peerList(ids);
    assert.ok(out.length <= max + 64, `a list of 10 000 ids rendered as ${out.length} chars`);
    assertExactTail(out, ids, 'ten thousand short ids');
  });

  it('a list cut by LENGTH rather than count says exactly how many it left out', () => {
    const peerList = renderer('peerList');
    // Each element is a fifth of the bound, so the length bound stops the list long before the count bound could.
    const ids = Array.from({ length: 60 }, (_, i) => `${'e'.repeat(Math.floor(bound() / 5))}-${i}`);
    const out = peerList(ids);
    const shown = assertExactTail(out, ids, 'sixty long elements');
    assert.ok(shown < 10, `fixture check: ${shown} elements fit, so the length bound was not what stopped the list`);
  });

  /**
   * `out` ends `<shown elements> …(+K more)` with K EXACTLY the number of elements left out: the elements are counted from
   * what the line shows (each id is distinct and carries its index), the tail is read at its end, and the two must add up.
   * Returns the number shown.
   */
  function assertExactTail(out, ids, what) {
    const tail = / …\(\+(\d+) more\)$/.exec(out);
    assert.ok(tail, `${what}: the list does not end with a space and …(+K more): …${out.slice(-80)}`);
    const body = out.slice(0, tail.index);
    const shownIds = body.split(', ');
    const shown = shownIds.length;
    assert.ok(shown >= 1 && body.length > 0, `${what}: no element was shown at all`);
    assert.deepEqual(shownIds, ids.slice(0, shown), `${what}: what is shown is not the leading elements, whole and in order`);
    assert.equal(Number(tail[1]), ids.length - shown, `${what}: the tail says ${tail[1]} left out, but ${ids.length} - ${shown} shown is ${ids.length - shown}`);
    return shown;
  }

  it('one huge element is bounded too, and every element is escaped', () => {
    const peerList = renderer('peerList');
    const max = bound();
    assert.ok(peerList(['x'.repeat(1_048_576)]).length <= max + 64, 'one megabyte element passed through');
    const out = peerList(['ok-1', 'bad\r\nFORGED [ERROR] x', 'ok-2']);
    assert.doesNotMatch(out, LINE_BREAKING);
    assert.ok(out.includes('ok-1') && out.includes('ok-2') && out.includes('bad\\r\\nFORGED'), `rendered as ${out}`);
  });

  it('never throws on what a list may hold', () => {
    const peerList = renderer('peerList');
    const cyclic = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => peerList([cyclic, 1n, Symbol('s'), undefined, new Error('e')]));
  });
});

describe('the meta argument is escaped and bounded where every line is built', () => {
  /**
   * The lines `fn` emitted, as written, with the console silenced — a megabyte line on stderr helps nobody. The
   * shared capture (`_log-lines.mjs`), not a copy of it (bundle-30 I6, T3).
   */
  const emitted = async (fn) => (await logLinesDuring(fn)).emitted;

  it('a meta value carrying CR LF starts no line of its own', async () => {
    const lines = await emitted(() => {
      mod.log.warn('a peer said', { id: 'x\r\nFORGED [ERROR] meta' });
      mod.log.warn('a peer failed', new Error('boom\r\nFORGED [ERROR] stack'));
      mod.log.warn('a peer sent', `raw${LS}FORGED [ERROR] string`);
    });
    assert.equal(lines.length, 3);
    for (const l of lines) assert.doesNotMatch(l, LINE_BREAKING, `a line carries a line-breaking character: ${JSON.stringify(l.slice(0, 200))}`);
  });

  it('a line-breaking character in the MESSAGE slot starts no line of its own, with or without a meta argument', async () => {
    // The message is the text a call site built: a slot that was not wrapped in `peerText` carries a peer's value raw
    // into it, and `fmt` escapes the line it writes as the last word, so a log line is one line whatever the slots held.
    const forged = `forged\r\n[2026-01-01T00:00:00.000Z] [ERROR] FORGED${LS}[ERROR] second${String.fromCharCode(0x85)}end\u001b[2J`;
    // `lines` is split the way a log reader splits, so a raw line break would show as more lines than calls.
    const { lines } = await logLinesDuring(() => {
      mod.log.info(`peer said ${forged}`);
      mod.log.warn(`peer said ${forged}`, { id: 'x' });
      mod.log.error(`peer said ${forged}`, new Error('boom'));
    });
    assert.equal(lines.length, 3, `a message carrying line breaks made ${lines.length} lines from 3 calls`);
    for (const l of lines) {
      assert.doesNotMatch(l, LINE_BREAKING, `a line carries a line-breaking character: ${JSON.stringify(l.slice(0, 200))}`);
      assert.ok(l.includes('forged\\r\\n[2026-01-01'), `the escape is not what an operator reads: ${JSON.stringify(l.slice(0, 200))}`);
    }
  });

  it('a long meta value of letters is written in bounded time (fmt redacts the line it builds)', async () => {
    const t = performance.now();
    const lines = await emitted(() => mod.log.warn('a peer sent', { id: 'm'.repeat(100_000) }));
    const ms = performance.now() - t;
    assert.equal(lines.length, 1);
    assert.ok(ms < 1_000, `a meta value of 100 000 letters took ${Math.round(ms)} ms to log`);
  });

  it('a megabyte meta value makes a bounded line', async () => {
    const max = ceiling();
    const lines = await emitted(() => {
      mod.log.warn('a peer sent', { seq: '9'.repeat(1_048_576) });
      mod.log.warn('a peer sent', '9'.repeat(1_048_576));
      // Digits, not letters: a run of letters is what the time case below is about, and here it would only slow
      // the length question down on a tree where redaction is quadratic.
      const e = new Error('9'.repeat(1_048_576));
      mod.log.warn('a peer failed', e);
    });
    for (const l of lines) assert.ok(l.length <= max + 200, `a line of ${l.length} chars`);
  });
});

describe('URL userinfo redaction: the outcome table, linear time, and the 5.6.3 pattern as reference', () => {
  /** What 5.6.3 redacted, as a literal: `scheme://userinfo@` keeps its scheme and loses its userinfo. */
  const REFERENCE = /([a-z][a-z0-9+.\-]*:\/\/)[^\s/@]+@/gi;
  const reference = s => s.replace(REFERENCE, '$1[redacted]@');

  /** [input, what a line shows]. Every row is the outcome of the 5.6.3 pattern, so a rewrite keeps it. */
  const TABLE = [
    ['https://u:pw@h', 'https://[redacted]@h'],
    ['9https://u:pw@h', '9https://[redacted]@h'],
    ['xhttps://u:pw@h', 'xhttps://[redacted]@h'],
    ['-+.https://u:pw@h', '-+.https://[redacted]@h'],
    ['1abc://u:pw@h', '1abc://[redacted]@h'],
    ['x1+y://u@h', 'x1+y://[redacted]@h'],
    ['HTTPS://U:P@H', 'HTTPS://[redacted]@H'],
    ['a://b@c', 'a://[redacted]@c'],
    ['a b://u@h', 'a b://[redacted]@h'],
    ['see postgres://admin:secret@db:5432/x', 'see postgres://[redacted]@db:5432/x'],
    ['first https://a:b@h1/p and ftp://c:d@h2/q end', 'first https://[redacted]@h1/p and ftp://[redacted]@h2/q end'],
    ['https://u@h:80@x', 'https://[redacted]@h:80@x'],
    // Left alone: no scheme, no userinfo before the first slash, or an `@` in the path.
    ['mailto:user@host', 'mailto:user@host'],
    ['https://host/path@x', 'https://host/path@x'],
    ['1://u@h', '1://u@h'],
    ['://u@h', '://u@h'],
  ];

  it('the table is what the reference pattern says (the fixture is honest)', () => {
    for (const [input, shown] of TABLE) assert.equal(reference(input), shown, `reference disagrees on ${JSON.stringify(input)}`);
  });

  it('PIN: redactSecrets redacts every row of the table as the release line always has', () => {
    for (const [input, shown] of TABLE) assert.equal(mod.redactSecrets(input), shown, `redactSecrets(${JSON.stringify(input)})`);
  });

  for (const name of RENDERERS) {
    it(`${name} redacts every row of the table`, () => {
      const render = renderer(name);
      for (const [input, shown] of TABLE) assert.equal(render(input), shown, `${name}(${JSON.stringify(input)})`);
    });
  }

  it('PIN: redactSecrets agrees with the reference pattern over a seeded fuzz of scheme-like strings', () => {
    // 5.6.3's pattern is the specification. Strings are built from the characters that decide a match — scheme
    // characters, digits that may lead a run, `:` `/` `@` and a space — so a lookbehind that refuses a start the old
    // pattern accepted (`9https://`) differs on some string here. Deterministic: a failure is the same failure twice.
    const alphabet = ['a', 'B', '1', '+', '.', '-', ':', '/', '/', '@', ' ', 'h', 'x', '9', '?', '_'];
    // mulberry32: a 32-bit generator with full-period mixing. The linear congruential one this replaced multiplied past
    // 2^53, lost its low bits and fell into a short cycle — 20 000 draws were 1 081 distinct strings.
    let state = 12345;
    const rnd = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** What a lookbehind with no lead (`9https://` not recognised) redacts — the regression this fuzz exists to see. */
    const WITHOUT_LEAD = /(?<![a-z0-9+.\-])([a-z][a-z0-9+.\-]*:\/\/)[^\s/@]+@/gi;
    const withoutLead = s => s.replace(WITHOUT_LEAD, '$1[redacted]@');
    const differing = [];
    const distinct = new Set();
    let redacting = 0;
    let leadOnly = 0;
    for (let i = 0; i < 20_000; i++) {
      let s = '';
      for (let j = 1 + Math.floor(rnd() * 24); j > 0; j--) s += alphabet[Math.floor(rnd() * alphabet.length)];
      if (rnd() < 0.5) s = s.replace(/.{3}/, m => m + '://');
      distinct.add(s);
      const expected = reference(s);
      if (expected !== s) redacting++;
      if (withoutLead(s) !== expected) leadOnly++;
      const got = mod.redactSecrets(s);
      if (got !== expected && differing.length < 5) differing.push(`${JSON.stringify(s)}: ${JSON.stringify(got)} != ${JSON.stringify(expected)}`);
    }
    assert.deepEqual(differing, [], 'redactSecrets redacts differently from the pattern 5.6.3 shipped');
    // The floors say the fuzz can fail: it covers many different strings, many of them ones the pattern redacts, and
    // enough where only the lead (`9https://`) decides the outcome that a lookbehind without it differs on them.
    assert.ok(distinct.size >= 10_000, `the fuzz drew ${distinct.size} distinct strings: the generator has fallen into a short cycle`);
    assert.ok(redacting >= 200, `only ${redacting} fuzz strings are ones the reference pattern redacts: the fuzz proves little about redaction`);
    assert.ok(leadOnly >= 50, `only ${leadOnly} fuzz strings separate a lookbehind with no lead from the reference: it could not see that regression`);
  });

  describe('redaction takes linear time on the shapes that make the userinfo pattern backtrack', () => {
    const SHAPES = {
      '100 000 letters': 'm'.repeat(100_000),
      'a1 pairs': 'a1'.repeat(50_000),
      'a. pairs': 'a.'.repeat(50_000),
      '1a pairs': '1a'.repeat(50_000),
      'scheme runs without an @': 'a://b '.repeat(20_000),
      'a long userinfo with no @': `https://${'u'.repeat(60_000)}`,
    };
    for (const [label, text] of Object.entries(SHAPES)) {
      it(`redactSecrets: ${label}`, () => {
        const t = performance.now();
        mod.redactSecrets(text);
        const ms = performance.now() - t;
        assert.ok(ms < 1_000, `${text.length} characters (${label}) took ${Math.round(ms)} ms to redact`);
      });
    }
  });
});
