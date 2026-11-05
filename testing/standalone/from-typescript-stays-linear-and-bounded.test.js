/**
 * `spaceMetaFromTypeScript` stays linear in the source it is given and bounded in what it refuses and reads (Q-687, design v3 items 6
 * and 10; the lenses: performance, security S2 and S3).
 *
 * ## The axis stated
 *
 * The axis is the **characters of source**, from nothing up to SOURCE_MAX, and the cost is **time**. A source is a map of types, each a
 * handful of members; what scales is the number of types and members, which is the size. Held:
 *
 * - **Linear.** Four times the source takes at most eight times as long (a quadratic read of members or types takes sixteen, and the
 *   fixed compile cost makes a linear one take less than four), measured after a warm-up read that has loaded the compiler and parsed
 *   the lib. The slack is `SLACK_MS`, so a fast machine's noise does not fail a linear read.
 * - **Bounded.** A source of about 400 000 characters (or SOURCE_MAX, if it is smaller) is read within `BOUND_MS`; a source of enums
 *   of 200 literals, as many as fit in the same size, is read within it too (a literal union is the compiler's costliest member); a source of three thousand refusals
 *   lists ten, counts the rest in `more`, and answers within it; a source twenty times SOURCE_MAX is refused in a fraction of a second
 *   without the compiler (the size is judged before anything is parsed).
 *
 * Before the entry exists every case is red for the one reason the first case names.
 *
 * Run: node --test testing/standalone/from-typescript-stays-linear-and-bounded.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { entry, read, sourceOf, assertRead, assertRefusedShape, CONTROL_SOURCE, REFUSAL_NAMES_MAX, ENUM_LITERAL_MAX, MEMBER_REFUSALS } from './_from-typescript.mjs';

/** What a read of the largest source this file builds may take, on the slow container the suites run in. */
const BOUND_MS = 30_000;
/** Added to the linear ratio so a noisy small read does not fail a linear implementation. */
const SLACK_MS = 400;
/** The most characters a source built here has: SOURCE_MAX, or this when it is larger. */
const BUILT_CHARS_MAX = 400_000;

/** A `SpaceTypes` of `types` entity types of ten members each (strings, numbers, booleans, a small enum, optional ones). */
function mapOfTypes(types) {
  const members = (i) => Array.from({ length: 10 }, (_, j) => (j % 5 === 0 ? `m${j}: string;` : j % 5 === 1 ? `m${j}?: number;` : j % 5 === 2 ? `m${j}: boolean;` : j % 5 === 3 ? `m${j}?: "a" | "b" | "c${i}";` : `m${j}: "x" | "y";`)).join(' ');
  const entries = Array.from({ length: types }, (_, i) => `    "t${i}": { properties: { ${members(i)} } };`);
  return `export interface SpaceTypes {\n  "entity": {\n${entries.join('\n')}\n  };\n}\n`;
}

/** The largest `mapOfTypes` source no longer than `chars`, with its type count. */
function mapWithin(chars) {
  const perType = mapOfTypes(2).length - mapOfTypes(1).length;
  const types = Math.max(1, Math.floor((chars - mapOfTypes(0).length) / perType));
  return { source: mapOfTypes(types), types };
}

async function timed(source) {
  const started = performance.now();
  const answer = await read(source);
  return { answer, ms: performance.now() - started };
}

describe('the source scales linearly, and a large one is read within the bound', () => {
  it('the entry is built', async () => {
    await entry();
  });

  it(`four times the source takes at most eight times as long (plus ${SLACK_MS} ms), after a warm-up read`, async () => {
    const { SOURCE_MAX } = await entry();
    const big = mapWithin(Math.min(SOURCE_MAX, BUILT_CHARS_MAX));
    const small = mapWithin(Math.floor(big.source.length / 4));
    assert.ok(big.types >= 3 * small.types && big.types > 100, `the two sizes differ by about four times (${small.types} and ${big.types} types)`);
    assertRead(await read(CONTROL_SOURCE), 'warm-up: the compiler is loaded and the lib parsed');
    const quarter = await timed(small.source);
    assertRead(quarter.answer, `${small.types} types`);
    const full = await timed(big.source);
    assertRead(full.answer, `${big.types} types`);
    assert.equal(Object.keys(full.answer.meta.typeSchemas.entity).length, big.types, 'every type of the large source is read');
    assert.ok(full.ms <= 8 * quarter.ms + SLACK_MS, `${big.source.length} characters took ${Math.round(full.ms)} ms, ${small.source.length} took ${Math.round(quarter.ms)} ms: more than eight times, so the read is not linear in the source`);
    assert.ok(full.ms < BOUND_MS, `${Math.round(full.ms)} ms is over the ${BOUND_MS} ms bound`);
  });

  it(`enums of ${ENUM_LITERAL_MAX} literals (the compiler's costliest member), as many as fit in ${BUILT_CHARS_MAX} characters or SOURCE_MAX, are read within the bound`, async () => {
    const { SOURCE_MAX } = await entry();
    const union = Array.from({ length: ENUM_LITERAL_MAX }, (_, i) => `"value-${i}"`).join(' | ');
    const member = (i) => `e${i}: ${union};`;
    const count = Math.max(10, Math.floor((Math.min(SOURCE_MAX, BUILT_CHARS_MAX) - 400) / (member(1000).length + 1)));
    const source = sourceOf(Array.from({ length: count }, (_, i) => member(i)).join('\n'));
    assert.ok(source.length <= SOURCE_MAX, `precondition: the source (${source.length} characters) is within SOURCE_MAX (${SOURCE_MAX})`);
    const { answer, ms } = await timed(source);
    assertRead(answer, `${count} long enums`);
    assert.equal(Object.keys(answer.meta.typeSchemas.entity.thing.propertySchemas).length, count);
    assert.ok(ms < BOUND_MS, `${Math.round(ms)} ms is over the ${BOUND_MS} ms bound`);
  });
});

describe('what is refused is refused in bounded time and a bounded list', () => {
  it(`three thousand refusals list ${REFUSAL_NAMES_MAX}, count the rest in more, and answer within the bound`, async () => {
    const { SOURCE_MAX } = await entry();
    const members = Array.from({ length: 3000 }, (_, i) => `d${i}: Date;`).join(' ');
    const source = sourceOf(members);
    assert.ok(source.length <= SOURCE_MAX, `precondition: the source (${source.length} characters) is within SOURCE_MAX (${SOURCE_MAX})`);
    const { answer, ms } = await timed(source);
    await assertRefusedShape(answer, 'three thousand dates');
    assert.equal(answer.refusals.length, REFUSAL_NAMES_MAX);
    assert.equal(answer.more, 3000 - REFUSAL_NAMES_MAX, 'more counts every refusal the list does not show');
    assert.ok(answer.refusals.every(r => r.reason === MEMBER_REFUSALS.date));
    assert.ok(ms < BOUND_MS, `${Math.round(ms)} ms is over the ${BOUND_MS} ms bound`);
  });

  it('a source twenty times SOURCE_MAX is refused source-too-large in well under a second: its size is judged before it is parsed', async () => {
    const { SOURCE_MAX } = await entry();
    assertRead(await read(CONTROL_SOURCE), 'warm-up');
    const { answer, ms } = await timed(`${CONTROL_SOURCE}//${'x'.repeat(20 * SOURCE_MAX)}`);
    await assertRefusedShape(answer, 'a source twenty times too large');
    assert.deepEqual(answer.refusals.map(r => r.reason), ['source-too-large']);
    assert.ok(ms < 1000, `${Math.round(ms)} ms to refuse a size`);
  });
});
