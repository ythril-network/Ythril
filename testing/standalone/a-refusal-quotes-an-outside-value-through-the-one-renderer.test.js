/**
 * A refusal that quotes a value from outside this instance quotes it through the one renderer (`peerText` /
 * `peerList`, `util/log.ts`), at the length the refusal needs — never through a `.slice(0, N)` of its own
 * (bundle-30 stage I5, the diff pass of `assignment-find-duplicated-rule`, `Q-270`).
 *
 * ## The copies this replaces
 *
 *  - `sync/arrival-shape.ts`: a schema refusal quoted `JSON.stringify(issues).slice(0, 200)` — cut by code unit, so it
 *    could split a surrogate pair, and saying nothing about having been cut.
 *  - `sync/arrivals.ts`: an argument refusal quoted the driver's message `.slice(0, 200)` — the same, and the driver's
 *    message can carry the peer's value.
 *  - `brain/entity-refs.ts`: `invalidRefsMessage` and `missingRefsRefusal` each built `slice(0, 5)` + `(+N more)` by
 *    hand — a near-copy of `peerList` with no bound on an element, so a caller's megabyte reference came back whole in
 *    the 400 on the REST and MCP write doors.
 *
 * What a hand-written copy drops is the guard, so the guard lives in the renderer: a caller narrows the bound with
 * `{ max }` / `{ count }`, and a bound can only NARROW — a cap above the ceiling, or one that is not a number, still
 * gets the ceiling. A cap that could widen would make every call site a place to forget it.
 *
 * ## Seen red
 *
 * On 9004ccf9: `peerText` takes no bound (its second argument is ignored, so a 50-character cap returns 4096),
 * `peerList` shows 100 elements whatever it is asked, the arrival refusal is cut with no `…(+N chars)`, and a 10 000
 * character bad reference is echoed whole by both reference refusals.
 *
 * Run: node --test testing/standalone/a-refusal-quotes-an-outside-value-through-the-one-renderer.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './_push-door.mjs';

const log = await import('../../server/dist/util/log.js');
const shape = await import('../../server/dist/sync/arrival-shape.js');
const refs = await import('../../server/dist/brain/entity-refs.js');

const LS = String.fromCharCode(0x2028);
const LINE_BREAKING = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${LS}${String.fromCharCode(0x2029)}]`);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CUT = /…\(\+(\d+) chars\)$/;
const MORE = /…\(\+(\d+) more\)$/;

describe('the renderer takes a narrower bound, and only a narrower one', () => {
  it('peerText cuts at the `max` it is given, in rendered characters, and says by how much', () => {
    const out = log.peerText('x'.repeat(1000), { max: 50 });
    const cut = out.match(CUT);
    assert.ok(cut, `a 1000-character value under max 50 was not cut: ${out.length} characters came back`);
    assert.equal(out.length - cut[0].length, 50);
    assert.equal(Number(cut[1]), 950);
  });

  it('peerText under a narrow bound never splits a surrogate pair', () => {
    const out = log.peerText('a' + '\u{1F600}'.repeat(40), { max: 10 });
    assert.doesNotMatch(out, LONE_SURROGATE, 'half a surrogate pair reached the quote');
  });

  it('a bound above the ceiling, or one that is not a whole number, still gets the ceiling', () => {
    const big = 'y'.repeat(log.LOG_VALUE_MAX * 3);
    for (const max of [log.LOG_VALUE_MAX * 2, Infinity, NaN, -1, 2.5, '50', null]) {
      const out = log.peerText(big, { max });
      assert.ok(out.length <= log.LOG_VALUE_MAX + 32, `max ${String(max)} widened the bound: ${out.length} characters`);
      assert.match(out, CUT, `max ${String(max)}: the cut no longer says it was made`);
    }
  });

  it('peerList shows the `count` it is given and names the rest', () => {
    const out = log.peerList(Array.from({ length: 30 }, (_, i) => `v${i}`), ', ', { count: 5 });
    assert.equal(out, 'v0, v1, v2, v3, v4 …(+25 more)');
  });

  it('a count above the list ceiling, or one that is not a whole number, still gets the ceiling', () => {
    const many = Array.from({ length: 500 }, (_, i) => i);
    const ceiling = log.peerList(many).match(MORE);
    assert.ok(ceiling, 'peerList with no count shows every one of 500 values');
    for (const count of [10_000, Infinity, NaN, -3, 1.5]) {
      const out = log.peerList(many, ', ', { count });
      assert.equal(out.match(MORE)?.[1], ceiling[1], `count ${String(count)} moved the list bound`);
    }
  });
});

describe('every refusal that quotes an outside value quotes it through the renderer', () => {
  it('a schema refusal of an arriving document says it was cut, and is bounded', () => {
    // Every field wrong: the issue list is far longer than a refusal quotes.
    const { refused } = shape.admitArrivals('facts', [{ _id: 'f-bad', fact: 1, tags: 2, author: 3, createdAt: 4, seq: 'x' }]);
    assert.equal(refused.length, 1);
    const { reason } = refused[0];
    assert.match(reason, CUT, `the issue list was cut without saying so: ${reason}`);
    assert.ok(reason.length < 400, `the refusal is not bounded: ${reason.length} characters`);
    assert.doesNotMatch(reason, LINE_BREAKING);
  });

  it('a schema refusal never splits a surrogate pair at its cut', () => {
    // A key the strict file schema does not declare is peer text a zod issue quotes (`unrecognized_keys`), early
    // enough to reach the cut; emoji with a one- or two-letter pad put a pair across every cut position.
    for (let pad = 0; pad < 4; pad++) {
      const doc = build.filemeta('s', 'a.md', 3, { ['k'.repeat(pad) + '\u{1F600}'.repeat(120)]: 1 });
      const { refused } = shape.admitArrivals('filemeta', [doc]);
      assert.equal(refused.length, 1);
      assert.doesNotMatch(refused[0].reason, LONE_SURROGATE, `pad ${pad}: half a surrogate pair reached the refusal`);
    }
  });

  for (const [name, refuse] of [
    ['invalidRefsMessage', (bad) => refs.invalidRefsMessage('entityIds', 'entity', bad)],
    ['missingRefsRefusal', (bad) => refs.missingRefsRefusal('s', 'entityIds', 'entity', bad)?.message],
  ]) {
    it(`${name}: a megabyte reference comes back bounded, and a line-breaking one escaped`, () => {
      const msg = refuse(['z'.repeat(1_000_000), `bad${LS}FORGED`]);
      assert.ok(msg.length < 2 * log.LOG_VALUE_MAX, `the refusal echoed the reference whole: ${msg.length} characters`);
      assert.doesNotMatch(msg, LINE_BREAKING, 'a reference\'s line-breaking character reached the refusal raw');
      assert.match(msg, /FORGED/, 'the second reference is still named');
    });

    it(`${name}: five references are named, JSON-quoted, and the rest counted`, () => {
      const msg = refuse(Array.from({ length: 30 }, (_, i) => `bad-${i}`));
      assert.match(msg, /"bad-0", "bad-1", "bad-2", "bad-3", "bad-4" …\(\+25 more\)/);
      assert.doesNotMatch(msg, /"bad-5"/);
    });
  }
});

describe('a caller\'s unknown key is quoted by the same bound on both doors (C18)', () => {
  /*
   * Bundle-30 I6, C18. REST's strict read bodies (`unknownBodyFields`) and the MCP argument validator both name a key
   * the caller sent that the door does not take — REST as `Unknown field(s): …` (and `unrecognized_keys`), MCP as
   * `unexpected property '…'` with the key's path. Both echoed the key whole: the MCP list bounded the COUNT of errors
   * and never the element. One door at a time, each reading complete alone, is how one stays weaker: asserted on both.
   */
  const HUGE = 'k'.repeat(1_000_000);
  const doors = {
    async rest() {
      const { unknownBodyFields } = await import('../../server/dist/brain/query.js');
      const r = unknownBodyFields({ [HUGE]: 1, [`bad${LS}FORGED`]: 2 }, new Set(['query']));
      return [r.error, ...r.unrecognized_keys];
    },
    async mcp() {
      const { makeArgsValidator } = await import('../../server/dist/mcp/validate-args.js');
      const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
      const v = makeArgsValidator({ requiredSpace: { type: 'string', enum: ['general'] }, optionalSpace: { type: 'string', enum: ['general'] } }, ['general']);
      const recall = ALL_TOOLS.find(t => t.name === 'recall');
      return [v.validate(recall, { query: 'x', [HUGE]: 1, filter: { [HUGE]: { eq: 1 } }, [`bad${LS}FORGED`]: 2 })];
    },
  };
  it('each door names the key bounded, escaped, and still names the one after it', async () => {
    const wrong = [];
    for (const [door, answer] of Object.entries(doors)) {
      const texts = await answer();
      const all = texts.join(' ');
      if (all.length > 2 * log.LOG_VALUE_MAX) wrong.push(`${door}: ${all.length} characters — the key came back whole`);
      if (LINE_BREAKING.test(all)) wrong.push(`${door}: a key's line-breaking character came back raw`);
      if (!/FORGED/.test(all)) wrong.push(`${door}: the second unknown key is no longer named`);
    }
    assert.deepEqual(wrong, []);
  });
  it('an ordinary unknown key is named exactly as before on both doors', async () => {
    const { unknownBodyFields } = await import('../../server/dist/brain/query.js');
    assert.match(unknownBodyFields({ maxDeptth: 1 }, new Set(['query'])).error, /^Unknown field\(s\): maxDeptth\. Allowed: query$/);
    const { makeArgsValidator } = await import('../../server/dist/mcp/validate-args.js');
    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const v = makeArgsValidator({ requiredSpace: { type: 'string', enum: ['general'] }, optionalSpace: { type: 'string', enum: ['general'] } }, ['general']);
    assert.match(v.validate(ALL_TOOLS.find(t => t.name === 'recall'), { query: 'x', maxDeptth: 1 }), /unexpected property 'maxDeptth'/);
  });
});
