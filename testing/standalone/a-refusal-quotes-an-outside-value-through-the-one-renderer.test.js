/**
 * A refusal that quotes a value from outside this instance quotes it through the one renderer (`peerText` /
 * `peerList`, `util/log.ts`), at the length the refusal needs — never through a `.slice(0, N)` of its own
 * (`Q-231`, `Q-270`; main's bundle-30 stage I5/I6, carried to 5.6.x as the ANSWER side of the bounded-values fix).
 *
 * ## The copies this replaces
 *
 *  - `brain/entity-refs.ts`: `invalidRefsMessage` and the missing-reference refusal each built `slice(0, 5)` + ` (+N more)`
 *    by hand — a near-copy of `peerList` with no bound on an element, so a caller's megabyte reference came back whole in
 *    the 400 on the REST and MCP write doors (the missing-reference half needs a store: `a-megabyte-from-a-peer-…-db`).
 *  - `brain/query.ts` `unknownBodyFields` and `mcp/validate-args.ts`: the REST and MCP doors both name a key the caller
 *    sent that the door does not take, and both echoed it whole.
 *
 * What a hand-written copy drops is the guard, so the guard lives in the renderer: a caller narrows the bound with
 * `{ max }` / `{ count }` / `{ each }`, and a bound can only NARROW — a cap above the ceiling, or one that is not a
 * number, still gets the ceiling. A cap that could widen would make every call site a place to forget it.
 *
 * ## What the release line does NOT change (pins, green on the base)
 *
 *  - **`unrecognized_keys` keeps its LENGTH.** Main cuts the array to its first ten; that is a change to a REST body
 *    a caller may read, so 5.6.4 cuts each ELEMENT at `NAME_QUOTED` and keeps every element (a wire-shape decision the
 *    patch does not take). Pinned with thirty keys.
 *  - **An ordinary key is named exactly as before**, on both doors.
 *
 * ## The one wording change, pinned
 *
 * `invalidRefsMessage` named the rest as ` (+25 more)`; the renderer says `…(+25 more)` (no space, an ellipsis), the
 * same tail every other bounded list in the product has. Wording only, and stated in the release notes — so it is
 * asserted here, where a reader of the notes can find what the new text is.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): `peerText` takes no bound (it does not exist), `peerList` does not exist, a 1 000 000 character
 * bad reference is echoed whole by `invalidRefsMessage`, and the same megabyte key comes back whole in
 * `unrecognized_keys` and in the MCP `unexpected property`.
 *
 * Round R (5.6.4): the bound is `NAME_QUOTED` from the module, asserted exactly (kept characters, and the number the tail
 * states) on REST's `unrecognized_keys`, on the MCP unexpected-property quote and on the MCP error PATH. Seen red by
 * widening each of the two MCP `peerText` calls in `mcp/validate-args.ts` to twice the bound (one case each), and the
 * list tail by `peerList` counting one left-out too few; restored by hand.
 *
 * Run: node --test testing/standalone/a-refusal-quotes-an-outside-value-through-the-one-renderer.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const log = await import('../../server/dist/util/log.js');
const refs = await import('../../server/dist/brain/entity-refs.js');

const LS = String.fromCharCode(0x2028);
const LINE_BREAKING = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${LS}${String.fromCharCode(0x2029)}]`);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CUT = /…\(\+(\d+) chars\)$/;
const MORE = /…\(\+(\d+) more\)$/;
/** How much of one name a refusal quotes — the renderer's own number, shared by every door that names a caller's keys. */
const { NAME_QUOTED } = log;
assert.ok(Number.isInteger(NAME_QUOTED) && NAME_QUOTED > 0, 'util/log.ts exports no whole `NAME_QUOTED`');

/**
 * `quoted` is `original` cut after exactly `NAME_QUOTED` characters, with the renderer's `…(+N chars)` saying N: the
 * characters that were cut. Exact, not "short enough": a cut one character too early or too late is a different bound.
 */
function assertCutAtNameQuoted(quoted, original, what) {
  const cut = CUT.exec(quoted);
  assert.ok(cut, `${what}: an oversized name was not cut with …(+N chars): ${quoted.length} characters came back`);
  assert.equal(cut.index, NAME_QUOTED, `${what}: kept ${cut.index} characters, not NAME_QUOTED (${NAME_QUOTED})`);
  assert.equal(Number(cut[1]), original.length - NAME_QUOTED, `${what}: the tail does not say how much was cut`);
  assert.equal(quoted.slice(0, NAME_QUOTED), original.slice(0, NAME_QUOTED), `${what}: what is kept is not the front of the name`);
}

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

  it('peerList cuts one oversized element at `each`, so the elements after it are still named', () => {
    const out = log.peerList(['k'.repeat(10_000), 'second', 'third'], ', ', { each: 20 });
    assert.match(out, /second, third$/, `the oversized first element took the list's budget: ${out.slice(-60)}`);
    assert.ok(out.length < 100, `${out.length} characters`);
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
  it('invalidRefsMessage: a megabyte reference comes back bounded, and a line-breaking one escaped', () => {
    const msg = refs.invalidRefsMessage('entityIds', 'entity', ['z'.repeat(1_000_000), `bad${LS}FORGED`]);
    assert.ok(msg.length < 2 * log.LOG_VALUE_MAX, `the refusal echoed the reference whole: ${msg.length} characters`);
    assert.doesNotMatch(msg, LINE_BREAKING, 'a reference\'s line-breaking character reached the refusal raw');
    assert.match(msg, /FORGED/, 'the second reference is still named');
  });

  it('invalidRefsMessage: five references are named, JSON-quoted, and the rest counted with the renderer\'s tail', () => {
    const msg = refs.invalidRefsMessage('entityIds', 'entity', Array.from({ length: 30 }, (_, i) => `bad-${i}`));
    assert.match(msg, /"bad-0", "bad-1", "bad-2", "bad-3", "bad-4" …\(\+25 more\)/);
    assert.doesNotMatch(msg, /"bad-5"/);
  });

  it('invalidRefsMessage: a file reference is quoted the same way', () => {
    const msg = refs.invalidRefsMessage('files', 'file', ['../' + 'f'.repeat(1_000_000)]);
    assert.ok(msg.length < 2 * log.LOG_VALUE_MAX, `${msg.length} characters`);
  });

  it('PIN: an ordinary bad reference is quoted exactly as before (the UUID wording is asserted by other suites)', () => {
    assert.match(refs.invalidRefsMessage('linkEntities', 'entity', ['Traefik']), /^`linkEntities` expects entity IDs \(UUID v4\), got "Traefik"\./);
  });
});

describe('a caller\'s unknown key is quoted by the same bound on both doors (C18)', () => {
  /*
   * REST's strict read bodies (`unknownBodyFields`) and the MCP argument validator both name a key the caller sent that the
   * door does not take — REST as `Unknown field(s): …` (and `unrecognized_keys`), MCP as `unexpected property '…'` with
   * the key's path. Both echoed the key whole: the MCP list bounded the COUNT of errors and never the element. One door
   * at a time, each reading complete alone, is how one stays weaker: asserted on both.
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

  it('PIN: REST keeps EVERY unrecognized key in the array (main\'s cut to ten is a wire change the patch does not take)', async () => {
    const { unknownBodyFields } = await import('../../server/dist/brain/query.js');
    const body = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key-${i}`, i]));
    const r = unknownBodyFields(body, new Set(['query']));
    assert.equal(r.unrecognized_keys.length, 30, 'the array of unrecognized keys changed length: a wire-shape change, not a fix');
    assert.deepEqual(r.unrecognized_keys.slice(1, 4), ['key-1', 'key-2', 'key-3'], 'an ordinary key is not changed');
  });

  it('each element of unrecognized_keys is cut at NAME_QUOTED, saying by how much, the array keeping its length', async () => {
    const { unknownBodyFields } = await import('../../server/dist/brain/query.js');
    const body = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${i === 0 ? HUGE : 'key'}-${i}`, i]));
    const r = unknownBodyFields(body, new Set(['query']));
    assert.equal(r.unrecognized_keys.length, 30, 'the array of unrecognized keys changed length');
    const [first, ...rest] = r.unrecognized_keys;
    assertCutAtNameQuoted(first, `${HUGE}-0`, 'unrecognized_keys[0]');
    // The sentence quotes the same key by the same bound (`peerList`'s `each`), so the two REST spellings agree.
    assert.ok(r.error.includes(`Unknown field(s): ${first}, `), `the error sentence does not quote the key as unrecognized_keys does: ${r.error.slice(0, 200)}`);
    for (const k of rest) assert.ok(k.length < NAME_QUOTED, `an ordinary element was cut: ${k}`);
  });

  it('the MCP validator cuts an unknown property at NAME_QUOTED, the same bound REST names a key by', async () => {
    const [message] = await doors.mcp();
    // The huge key is quoted between single quotes, as `unexpected property '…'`; the key after it is named in full.
    const quoted = [...message.matchAll(/unexpected property '([^']*)'/g)].map(m => m[1]);
    const huge = quoted.find(q => q.startsWith(HUGE.slice(0, 20)));
    assert.ok(huge, `fixture check: the oversized key is not quoted as an unexpected property: ${message.slice(0, 200)}`);
    assertCutAtNameQuoted(huge, HUGE, 'the MCP unexpected property');
  });

  it('the MCP validator cuts the PATH of an error at NAME_QUOTED too: a megabyte key inside a map is not echoed whole', async () => {
    const { makeArgsValidator } = await import('../../server/dist/mcp/validate-args.js');
    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const v = makeArgsValidator({ requiredSpace: { type: 'string', enum: ['general'] }, optionalSpace: { type: 'string', enum: ['general'] } }, ['general']);
    // `properties` of a save is a map of scalar values: a key under it that holds an array fails the schema AT a path
    // that carries the caller's key.
    const message = v.validate(ALL_TOOLS.find(t => t.name === 'save_fact'), { space: 'general', fact: 'x', properties: { [HUGE]: [1] } });
    assert.ok(message, 'fixture check: the arguments were accepted, so no path was quoted');
    const path = /^Invalid arguments for 'save_fact': (\/properties\/[^:]*): /.exec(message);
    assert.ok(path, `fixture check: the error is not at the key's path: ${message.slice(0, 200)}`);
    // The whole path is the quoted value, so the cut counts the `/properties/` in front of the key too.
    assertCutAtNameQuoted(path[1], `/properties/${HUGE}`, 'the MCP error path');
  });

  it('PIN: an ordinary unknown key is named exactly as before on both doors', async () => {
    const { unknownBodyFields } = await import('../../server/dist/brain/query.js');
    assert.match(unknownBodyFields({ maxDeptth: 1 }, new Set(['query'])).error, /^Unknown field\(s\): maxDeptth\. Allowed: query$/);
    assert.deepEqual(unknownBodyFields({ maxDeptth: 1 }, new Set(['query'])).unrecognized_keys, ['maxDeptth']);
    const { makeArgsValidator } = await import('../../server/dist/mcp/validate-args.js');
    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const v = makeArgsValidator({ requiredSpace: { type: 'string', enum: ['general'] }, optionalSpace: { type: 'string', enum: ['general'] } }, ['general']);
    assert.match(v.validate(ALL_TOOLS.find(t => t.name === 'recall'), { query: 'x', maxDeptth: 1 }), /unexpected property 'maxDeptth'/);
  });
});
