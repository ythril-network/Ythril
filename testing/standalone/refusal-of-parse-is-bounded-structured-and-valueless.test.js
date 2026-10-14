/**
 * A zod parse failure is answered as bounded prose plus a structured, value-free issue list (`Q-362`, R5-4, R6-11).
 *
 * ## The finding
 *
 * Fifty-odd doors answer a body that failed its zod schema with `parsed.error.message`, which in zod 4 is the whole
 * issue array as JSON — and an issue for an unknown key quotes the key whole. A caller's megabyte key came back as a
 * 2 000 000-character 400 (and, through the MCP twin, as a megabyte log line). The MCP dispatcher's own validator
 * already bounds the same mistake, so one door was already bounded and the other was not.
 *
 * ## What one function owes, `refusalOfParse(error)` in `util/log.ts`, beside `peerText` and `peerList`
 *
 * It answers `{ error, issues }`:
 *  - `error` is PROSE (never a JSON array), at most `LOG_VALUE_MAX` characters, naming the path of each failing field;
 *  - `issues` is the structured half, `[{ code, path, keys? }]` and nothing else: no received value, no `expected`,
 *    no `values`, no message — a value is the one thing a refusal must not reflect back;
 *  - at most ten issues are shown and the rest are counted, so a body failing on a thousand fields is one answer;
 *  - every path segment and every key goes through `peerText` at `NAME_QUOTED`, so one oversized or line-breaking
 *    name neither floods the answer nor forges a line, and the `unrecognized_keys` sentence is rebuilt from `issue.keys`
 *    rather than copied from zod's message (which carries the key unbounded);
 *  - an `issue.message` a refinement wrote (a custom rule, a compiler error) goes through `peerText` too: it is text a
 *    caller can steer.
 *
 * Every assertion below is an identity or a bound, written by hand: a test that derived the expected answer from
 * `refusalOfParse` would compare it with itself.
 *
 * ## Seen red
 *
 * On 85c4c564 `refusalOfParse` is not exported by `util/log.ts`: every case below fails on that one fact.
 *
 * Run: node --test testing/standalone/refusal-of-parse-is-bounded-structured-and-valueless.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const log = await import('../../server/dist/util/log.js');
const { refusalOfParse, LOG_VALUE_MAX, NAME_QUOTED } = log;

const CUT = /…\(\+(\d+) chars\)$/;
const LS = String.fromCharCode(0x2028);
const LINE_BREAKING = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${LS}${String.fromCharCode(0x2029)}]`);
const HUGE = 'k'.repeat(1_000_000);

/** What a door hands `refusalOfParse`: the error of a failed parse. */
const failure = (schema, input) => {
  const r = schema.safeParse(input);
  assert.equal(r.success, false, 'the fixture parse was meant to fail');
  return r.error;
};

/** Everything an answer carries, as one string: a bound on it is a bound on every field of it. */
const wholeAnswer = (a) => `${a.error}\n${JSON.stringify(a.issues)}`;

describe('refusalOfParse is the one function a parse refusal is answered with', () => {
  it('util/log.ts exports it', () => {
    assert.equal(typeof refusalOfParse, 'function',
      'util/log.ts does not export refusalOfParse — every zod refusal still answers parsed.error.message, the issue array as JSON');
  });

  const Body = z.object({ name: z.string(), mode: z.enum(['a', 'b']) }).strict();

  it('answers prose in `error` and `{ code, path, keys? }` rows in `issues`, naming where each field failed', () => {
    const out = refusalOfParse(failure(Body, { name: 5, mode: 'SECRET-MODE', extra: 1 }));
    assert.equal(typeof out.error, 'string');
    assert.ok(Array.isArray(out.issues), '`issues` is not an array');
    assert.doesNotMatch(out.error, /^\s*[[{]/, '`error` is a JSON document, not prose — the shape the bodies had');
    assert.deepEqual(out.issues.map(i => [i.code, i.path]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      [['invalid_type', ['name']], ['invalid_value', ['mode']], ['unrecognized_keys', []]]);
    assert.deepEqual(out.issues.find(i => i.code === 'unrecognized_keys').keys, ['extra']);
    for (const field of ['name', 'mode', 'extra']) assert.match(out.error, new RegExp(`\\b${field}\\b`), `the prose does not name ${field}`);
  });

  it('an issue row holds a code, a path and (for unknown keys) keys — and no value, expectation or message', () => {
    const out = refusalOfParse(failure(Body, { name: 5, mode: 'SECRET-MODE', extra: 1 }));
    for (const issue of out.issues) {
      assert.deepEqual(Object.keys(issue).filter(k => !['code', 'path', 'keys'].includes(k)), [],
        `an issue row carries more than code, path and keys: ${JSON.stringify(issue)}`);
    }
    assert.doesNotMatch(wholeAnswer(out), /SECRET-MODE/, 'a received value was reflected back');
  });

  it('a path names the array index it failed at, between the names around it', () => {
    const Rows = z.object({ rows: z.array(z.object({ id: z.string() })) });
    const out = refusalOfParse(failure(Rows, { rows: [{ id: 'ok' }, { id: 7 }] }));
    assert.deepEqual(out.issues[0].path.map(String), ['rows', '1', 'id']);
  });

  it('a body failing on a hundred fields shows ten issues and says how many were left out', () => {
    const shape = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, z.string()]));
    const out = refusalOfParse(failure(z.object(shape), {}));
    assert.ok(out.issues.length <= 10, `${out.issues.length} issues came back — the answer grows with the body`);
    assert.ok(out.issues.length >= 1);
    assert.match(out.error, /\b90\b/, 'the prose does not say that 90 more issues were left out');
    assert.deepEqual(out.issues.map(i => i.path[0]), Array.from({ length: out.issues.length }, (_, i) => `f${i}`),
      'the issues shown are not the first ones, in order');
  });

  it('a megabyte unknown key is quoted at NAME_QUOTED in the prose and in `keys`, saying how much was cut', () => {
    const out = refusalOfParse(failure(z.object({ a: z.string() }).strict(), { a: 'x', [HUGE]: 1, [`bad${LS}FORGED`]: 2 }));
    const keys = out.issues.find(i => i.code === 'unrecognized_keys').keys;
    assert.equal(keys.length, 2, 'the second unknown key is no longer named');
    assert.equal(keys[0], log.peerText(HUGE, { max: NAME_QUOTED }), 'the key is not rendered by peerText at NAME_QUOTED');
    assert.match(keys[0], CUT);
    assert.ok(wholeAnswer(out).length < 2 * LOG_VALUE_MAX, `the answer is ${wholeAnswer(out).length} characters — the key came back whole`);
    assert.match(out.error, /FORGED/, 'the second unknown key is not named in the prose');
  });

  it('a line-breaking key is written escaped, never raw, in the prose or in `keys`', () => {
    const out = refusalOfParse(failure(z.object({}).strict(), { [`bad${LS}\r\nFORGED`]: 1 }));
    assert.doesNotMatch(out.error, LINE_BREAKING, 'a key\'s line-breaking character reached the prose raw');
    assert.doesNotMatch(JSON.stringify(out.issues[0].keys), LINE_BREAKING);
  });

  it('a megabyte KEY on the path of a failure is bounded the same way', () => {
    const Nested = z.object({ meta: z.record(z.string(), z.object({ x: z.string() })) });
    const out = refusalOfParse(failure(Nested, { meta: { [HUGE]: { x: 1 } } }));
    assert.equal(out.issues[0].path[1], log.peerText(HUGE, { max: NAME_QUOTED }));
    assert.ok(wholeAnswer(out).length < 2 * LOG_VALUE_MAX, 'the path segment came back whole');
  });

  it('a refinement\'s own message goes through peerText: text a caller steers is bounded and escaped', () => {
    const Rule = z.string().superRefine((v, ctx) => ctx.addIssue({ code: 'custom', message: `rule failed for ${v}` }));
    const out = refusalOfParse(failure(Rule, `${HUGE}${LS}FORGED`));
    assert.ok(wholeAnswer(out).length < 2 * LOG_VALUE_MAX, `a refinement message came back ${wholeAnswer(out).length} characters long`);
    assert.doesNotMatch(out.error, LINE_BREAKING);
  });

  it('an ordinary failure is answered in full: nothing short is cut, nothing is marked as cut', () => {
    const out = refusalOfParse(failure(z.object({ label: z.string().min(1) }), { label: '' }));
    assert.doesNotMatch(wholeAnswer(out), /…\(\+/);
    assert.deepEqual(out.issues.map(i => i.path), [['label']]);
  });
});
