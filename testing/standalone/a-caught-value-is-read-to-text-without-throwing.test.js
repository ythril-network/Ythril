/**
 * `messageOf` (`util/errors.ts`) turns whatever a `catch` caught into text, and it cannot throw: it runs inside catch
 * blocks, where a throw replaces the failure being handled with one nobody reads (Q-361 part 1).
 *
 * ## What is asserted
 *
 * - an `Error` answers its `message`, and a subclass too;
 * - anything else answers what `String` says of it (a string, a number, `undefined`, `null`, a plain object);
 * - a value whose text cannot be read — a Proxy whose `message` getter throws (it IS an `Error` by `instanceof`),
 *   an object whose `toString` throws, a Symbol-keyed hostile `toPrimitive` — answers one fixed, non-empty sentence
 *   that is the same for every such value and contains nothing the value held, and does not throw.
 *
 * The fixed sentence is private to the module (`UNREADABLE_ERROR`), so it is compared across the hostile cases rather than
 * copied here.
 *
 * Seen red by hand, restored by hand: the `try`/`catch` in `messageOf` removed (a hostile getter then throws out of the
 * call).
 *
 * Run: node --test testing/standalone/a-caught-value-is-read-to-text-without-throwing.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let messageOf, NotFoundError;
before(async () => {
  ({ messageOf, NotFoundError } = await import('../../server/dist/util/errors.js'));
});

describe('messageOf reads a caught value to text and never throws', () => {
  it('an Error answers its message, a subclass too', () => {
    assert.equal(messageOf(new Error('boom')), 'boom');
    assert.equal(messageOf(new TypeError('bad type')), 'bad type');
    assert.equal(messageOf(new NotFoundError('no such thing')), 'no such thing');
  });

  it('a value that is not an Error answers what String says of it', () => {
    for (const v of ['plain text', 42, undefined, null, true, { toString: () => 'custom text' }, [1, 2]]) {
      assert.equal(messageOf(v), String(v), `${typeof v} ${String(v)}`);
    }
  });

  it('a value whose text cannot be read answers one fixed sentence and does not throw', () => {
    const secret = 'SECRET-THE-VALUE-HELD';
    const hostile = [
      ['an Error whose message getter throws', new Proxy(new Error(secret), { get(t, p) { if (p === 'message') throw new Error(secret); return Reflect.get(t, p); } })],
      ['an object whose toString throws', { toString() { throw new Error(secret); } }],
      ['an object whose toPrimitive throws', { [Symbol.toPrimitive]() { throw new Error(secret); } }],
      ['an object with no prototype', Object.create(null)],
    ];
    const answers = hostile.map(([what, v]) => {
      let text;
      assert.doesNotThrow(() => { text = messageOf(v); }, what);
      return text;
    });
    for (const text of answers) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.ok(!text.includes(secret), 'the sentence carries what the value held');
      assert.equal(text, answers[0], 'two unreadable values answered differently');
    }
    assert.match(answers[0], /unreadable/i);
  });
});
