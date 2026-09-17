/**
 * `maxBytes` counts BYTES, `maxChars` counts characters, and both apply when both are set.
 *
 * ## What was wrong
 *
 * `applyBudget` measured `JSON.stringify(record).length` — UTF-16 code units. For ASCII that equals bytes.
 * For anything else it does not, and the name, the parameter, the response field and the documentation all
 * said bytes.
 *
 * | a record whose text is | counted | real UTF-8 bytes | under-count |
 * |---|---|---|---|
 * | `Grüße aus Köln — ąćę` | 31 | 39 | 26 % |
 * | three emoji | 17 | 23 | 35 % |
 *
 * A transport or client limit IS expressed in bytes, and this budget exists to keep a response under one. So a
 * German or Polish space overran its stated budget by about a quarter — which is exactly the failure the
 * budget was built to prevent, and the canary's measured client refusal at "98,356" was counted this way too.
 *
 * ## Owner's decision, 2026-08-30 (option C)
 *
 * *"add maxChars, charsReturned and relink current implementation. Then add real maxBytes. I need a way for
 * both in reality. as with maxBytes and maxTokens: when both (then: 2 or 3) are set: lower wins."*
 *
 * **"Lower wins" is not a `Math.min` across the two.** Characters and bytes are different scales, so
 * collapsing them to one number would be meaningless. Both ceilings are carried and the loop stops when
 * EITHER would be exceeded — which is what "both apply" means, and what the existing `maxBytes`/`maxTokens`
 * pair already does within one unit.
 *
 * `maxTokens` lands on the CHARACTER side, where it always belonged: the conversion produces characters and
 * was only ever compared against a "byte" budget that was secretly counting them.
 *
 * ## Why the fixtures are multilingual
 *
 * A suite written with ASCII fixtures cannot tell characters from bytes at all. That is how this survived: for
 * ASCII the two numbers are equal, and every test anyone wrote was in ASCII.
 *
 * Run: node --test testing/standalone/a-byte-budget-counts-bytes.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mod;

/** A record whose serialised form is `n` characters of pure ASCII, so chars and bytes agree. */
const ascii = (n) => ({ t: 'a'.repeat(Math.max(0, n - 10)) });

/** The same shape in German and in emoji, where they do not. */
const german = { t: 'Grüße aus Köln — ąćę' };
const emoji = { t: '🙂🙃😀' };

const chars = (v) => JSON.stringify(v).length;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('the two units are actually different', () => {
  it('the fixtures prove it, or nothing below means anything', () => {
    // The floor. If these were equal, every assertion in this file would hold under the old character-only
    // implementation and the suite would be measuring nothing.
    assert.ok(bytes(german) > chars(german), `german: ${bytes(german)} bytes vs ${chars(german)} chars`);
    assert.ok(bytes(emoji) > chars(emoji), `emoji: ${bytes(emoji)} bytes vs ${chars(emoji)} chars`);
    assert.equal(bytes(ascii(50)), chars(ascii(50)), 'an ASCII fixture must NOT distinguish them');
  });
});

describe('resolving a budget', () => {
  before(async () => {
    mod = await import('../../server/dist/brain/result-budget.js');
  });

  it('the module is reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof mod.resolveBudget, 'function');
    assert.equal(typeof mod.applyBudget, 'function');
  });

  it('nothing stated gives the operator default in CHARACTERS, and no byte ceiling', () => {
    /*
     * `maxBytes` deliberately has no default. One equal to the character default would make it the binding
     * constraint on every non-ASCII response — bytes are always ≥ characters — which is the silent tightening
     * the owner rejected when they chose option C.
     */
    const r = mod.resolveBudget({});
    assert.equal(r.ok, true);
    assert.equal(r.chars, mod.DEFAULT_MAX_CHARS);
    assert.equal(r.bytes, null, 'a byte ceiling appeared without anybody asking for one');
  });

  it('the MCP door has its own character default and the same absence of a byte one', () => {
    const r = mod.resolveBudget({}, mod.MCP_DEFAULT_MAX_CHARS);
    assert.equal(r.chars, mod.MCP_DEFAULT_MAX_CHARS);
    assert.ok(mod.MCP_DEFAULT_MAX_CHARS < mod.DEFAULT_MAX_CHARS, 'the MCP default must stay the tighter one');
    assert.equal(r.bytes, null);
  });

  it('`maxBytes` resolves to the byte ceiling and leaves the char one alone', () => {
    const r = mod.resolveBudget({ maxBytes: 5_000 });
    assert.equal(r.bytes, 5_000);
    assert.equal(r.chars, mod.DEFAULT_MAX_CHARS,
      'stating a byte ceiling silently changed the character one, so the two are not independent');
  });

  it('`maxTokens` resolves against CHARACTERS, which is what the conversion produces', () => {
    /*
     * The RATIO comes from the module rather than from a `charsPerToken` argument, which was removed at
     * 5.0 — it did nothing unless `maxTokens` was also set, and a caller who needs the ceiling exact states
     * `maxChars`. Read from `DEFAULT_CHARS_PER_TOKEN` rather than written as 3.5 here: a number in an
     * assertion is a second copy of a fact the module already holds.
     */
    const ratio = mod.DEFAULT_CHARS_PER_TOKEN;
    const r = mod.resolveBudget({ maxTokens: 1_000 });
    assert.equal(r.chars, Math.floor(1_000 * ratio));
    assert.equal(r.bytes, null, 'a token ceiling produced a BYTE ceiling, which it cannot know anything about');
  });

  it('and the lower of `maxChars` and `maxTokens` wins, as it always did within one unit', () => {
    const converted = Math.floor(1_000 * mod.DEFAULT_CHARS_PER_TOKEN);
    assert.equal(mod.resolveBudget({ maxChars: converted - 500, maxTokens: 1_000 }).chars, converted - 500);
    assert.equal(mod.resolveBudget({ maxChars: converted + 500, maxTokens: 1_000 }).chars, converted);
  });

  it('a bad value in either unit is refused, and says which', () => {
    for (const [req, word] of [
      [{ maxChars: 0 }, 'maxChars'],
      [{ maxChars: 1.5 }, 'maxChars'],
      [{ maxBytes: -1 }, 'maxBytes'],
      [{ maxBytes: 'lots' }, 'maxBytes'],
      [{ maxTokens: 0 }, 'maxTokens'],
    ]) {
      const r = mod.resolveBudget(req);
      assert.equal(r.ok, false, `${JSON.stringify(req)} was accepted`);
      assert.match(r.error, new RegExp(word), `the refusal does not name ${word}`);
    }
  });

  it('and `maxBytes` is still described in bytes, because now it is', () => {
    const r = mod.resolveBudget({ maxBytes: 'lots' });
    assert.match(r.error, /bytes/, 'the refusal stopped saying bytes about a byte parameter');
  });
});

describe('applying it', () => {
  before(async () => {
    mod = await import('../../server/dist/brain/result-budget.js');
  });

  it('a character ceiling cuts on characters', () => {
    const rows = [ascii(100), ascii(100), ascii(100)];
    const out = mod.applyBudget(rows, { chars: 210, bytes: null });
    assert.equal(out.returned.length, 2);
    assert.equal(out.truncated, true);
  });

  it('a BYTE ceiling cuts sooner on non-ASCII than a character one of the same number', () => {
    /*
     * The whole finding, as one assertion. The same rows, the same number, two units: the byte ceiling admits
     * fewer because the content really is bigger than its character count says.
     */
    const rows = Array.from({ length: 20 }, () => german);
    const n = 200;
    const byChars = mod.applyBudget(rows, { chars: n, bytes: null }).returned.length;
    const byBytes = mod.applyBudget(rows, { chars: 1e9, bytes: n }).returned.length;
    assert.ok(byBytes < byChars,
      `a byte ceiling of ${n} admitted ${byBytes} rows and a char ceiling of ${n} admitted ${byChars} — for `
      + 'non-ASCII content those cannot be equal unless bytes are being counted as characters');
  });

  it('both ceilings apply, and it is the tighter one that bites — either direction', () => {
    const rows = Array.from({ length: 20 }, () => emoji);
    const tightChars = mod.applyBudget(rows, { chars: 60, bytes: 1e9 }).returned.length;
    const tightBytes = mod.applyBudget(rows, { chars: 1e9, bytes: 60 }).returned.length;
    const both = mod.applyBudget(rows, { chars: 60, bytes: 60 }).returned.length;
    assert.equal(both, Math.min(tightChars, tightBytes),
      'with both set the answer is not the tighter of the two, so one of them is being ignored');
  });

  it('both figures are reported, always', () => {
    // Reporting one is what let this hide: a caller comparing `bytesReturned` against their own byte limit
    // was comparing it against a character count, and had no second number to notice the difference with.
    const out = mod.applyBudget([german, german], { chars: 1e9, bytes: 1e9 });
    assert.equal(typeof out.charsReturned, 'number');
    assert.equal(typeof out.bytesReturned, 'number');
    assert.ok(out.bytesReturned > out.charsReturned,
      'the two reported figures are equal for non-ASCII content, so one of them is the other');
  });

  it('a single record larger than the whole budget is still returned, alone', () => {
    // Unchanged behaviour, restated because the change touches the loop: returning nothing would turn a
    // budget into a wall and leave a caller unable to read a record at all.
    const out = mod.applyBudget([ascii(500), ascii(500)], { chars: 10, bytes: 10 });
    assert.equal(out.returned.length, 1);
    assert.equal(out.truncated, true);
  });

  it('and an absent byte ceiling bounds nothing', () => {
    const rows = Array.from({ length: 5 }, () => emoji);
    const out = mod.applyBudget(rows, { chars: 1e9, bytes: null });
    assert.equal(out.returned.length, 5, 'a null byte ceiling behaved like a zero one');
    assert.equal(out.truncated, false);
  });
});
