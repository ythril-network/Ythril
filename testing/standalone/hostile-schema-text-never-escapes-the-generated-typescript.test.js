/**
 * Schema text is data in the TypeScript `typesOfSpaceMeta` writes: no name, description, pattern, enum value or default can end a
 * comment, start a directive, add an export or break the compile (Q-669, design v3 items 6 and 7; slice-B S5, S7).
 *
 * ## Why
 *
 * A type schema is written by whoever may edit a space's meta, and the generated source is compiled into an app. Text copied into a
 * comment can close it (a star and a slash), start a new line (LF, CR, U+2028, U+2029), and a line that then begins with `@ts-ignore`
 * or `@ts-expect-error` is a directive the app's compiler obeys; text copied into code is code. So the converter has one comment writer
 * (block comments only, the closing pair neutralised, the four line breaks replaced, a leading `@` escaped, no `//` comment carrying
 * schema text) and writes names and values only as string literals or as identifiers built from `\p{ID_Start}`/`\p{ID_Continue}`.
 *
 * ## What is held
 *
 * - **Hostile text** in a type description, a property description, a pattern, enum values and a default: the source compiles, no
 *   comment line starts a `@ts-` directive, no `//` comment carries schema text, no comment holds CR, U+2028 or U+2029, the marker
 *   the hostile text carries never appears outside a comment or a string literal, and the enum's values reach the type exactly.
 * - **Hostile names** (types and properties): the same texts, plus superscript two, a vulgar fraction, a circled digit, a combining
 *   mark, CJK, an emoji, a leading digit and reserved words. They compile, `SpaceTypes` is keyed by every name exactly, and each type
 *   keeps its own property keys exactly.
 * - **Nothing injected**: the source exports exactly what a meta with the same number of plainly named types exports.
 * - **Suffix collisions**: `x` and `x stored` would both want `<Kind>XStoredProperties`; both convert, each with its own properties,
 *   and the rename is reported (`renamed`).
 *
 * The non-ASCII characters are built from their code points (`cp`), so this file holds none raw.
 *
 * Run: node --test testing/standalone/hostile-schema-text-never-escapes-the-generated-typescript.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileInMemory, converted, assertReported, reportsLike, exportedNames, commentsOf, codeTokensOf, withLines, lit, unionOf,
} from './_typescript-of-space-meta.mjs';

/** The marker every hostile TEXT carries: it may sit in a comment or a string literal, never in code. */
const MARK = 'pwned';

/** A string from code points. */
const cp = (...points) => String.fromCodePoint(...points);
const LS = cp(0x2028);
const PS = cp(0x2029);
const RAW_BREAK = new RegExp(`[\\r${LS}${PS}]`);
const ANY_BREAK = new RegExp(`\\r\\n|[\\n\\r${LS}${PS}]`);

/** Texts that try to leave a comment, start a directive or become code. */
const TEXTS = [
  `end */ export const ${MARK}1 = 1; /* again`,
  `line\n@ts-ignore ${MARK}`,
  `carriage\r@ts-expect-error ${MARK}`,
  `ls${LS}@ts-nocheck ${MARK}`,
  `ps${PS}// ${MARK} line comment`,
  `@ts-ignore ${MARK} leading`,
  `@ts-expect-error ${MARK} leading`,
  `[a link](https://example.com/${MARK}) and <b>${MARK}</b>`,
  `\`${MARK}\` in backticks`,
  `\${${MARK}} a template hole`,
  `quote ' and " and \\ ${MARK}`,
  `*/ // ${MARK}\n*/`,
];

/** Names: the texts without the marker (a name becomes part of an identifier), and the Unicode and keyword cases. */
const NAMES = [
  ...TEXTS.map(t => t.replaceAll(MARK, 'injected')),
  `x${cp(0xb2)}`, `half${cp(0xbd)}`, `circled${cp(0x2460)}`, `cafe${cp(0x301)}`, cp(0x6f22, 0x5b57), `${cp(0x1f600)} emoji`,
  '1st', '123', 'class', 'default', 'interface', 'type', 'export', 'SpaceTypes', 'Properties', 'StoredProperties', '$dollar', '_under',
];

const TEXT_META = {
  typeSchemas: {
    entity: {
      described: {
        description: TEXTS.join(' | '),
        propertySchemas: Object.fromEntries(TEXTS.map((t, i) => [`p${i}`, { type: 'string', description: t, pattern: t.replace(/[\\]/g, ''), default: t }])),
      },
      enumerated: { propertySchemas: { pick: { type: 'string', enum: TEXTS } } },
    },
    fact: Object.fromEntries(TEXTS.map((t, i) => [`f${i}`, { description: t, propertySchemas: { v: { description: t } } }])),
  },
};

const NAME_META = {
  typeSchemas: {
    entity: Object.fromEntries(NAMES.map(name => [name, { propertySchemas: { [name]: { type: 'string' }, plain: { type: 'number' } } }])),
    edge: { holder: { propertySchemas: Object.fromEntries(NAMES.map(name => [name, { type: 'string' }])) } },
  },
};

const COLLIDE_META = {
  typeSchemas: {
    entity: { x: { propertySchemas: { a: { type: 'string' } } }, 'x stored': { propertySchemas: { b: { type: 'number' } } } },
    fact: { 'x stored': { propertySchemas: { c: { type: 'boolean' } } }, x: { propertySchemas: { d: { type: 'string' } } } },
  },
};

const typeCount = (meta) => Object.values(meta.typeSchemas).reduce((n, types) => n + Object.keys(types).length, 0);

/** A meta with the same number of types per kind, plainly named: what an uninjected source exports. */
const plainLike = (meta) => ({
  typeSchemas: Object.fromEntries(Object.entries(meta.typeSchemas).map(([kind, types]) => [kind,
    Object.fromEntries(Object.keys(types).map((_, i) => [`t${i}`, { propertySchemas: { a: { type: 'string' } } }]))])),
});

let memo;
function all() {
  if (memo) return memo;
  const out = { text: converted(TEXT_META), name: converted(NAME_META), collide: converted(COLLIDE_META) };
  const usage = [
    "import type { SpaceTypes as T } from './text';",
    "import type { SpaceTypes as N } from './name';",
    "import type { SpaceTypes as C } from './collide';",
    "import type { Equals, Expect, HasIndex } from './assert-types';",
    `type _e = Expect<Equals<Required<T['entity']['enumerated']['properties']>['pick'], ${unionOf(TEXTS)}>>;`,
    `type _f = Expect<Equals<keyof T['fact'], ${unionOf(TEXTS.map((_, i) => `f${i}`))}>>;`,
    `type _n = Expect<Equals<keyof N['entity'], ${unionOf(NAMES)}>>;`,
    ...NAMES.map((name, i) => `type _n${i} = Expect<Equals<keyof N['entity'][${lit(name)}]['properties'], ${unionOf([name, 'plain'])}>>;`),
    `type _h = Expect<Equals<keyof N['edge']['holder']['properties'], ${unionOf(NAMES)}>>;`,
    "type _c1 = Expect<Equals<keyof C['entity']['x']['properties'], 'a'>>;",
    "type _c2 = Expect<Equals<keyof C['entity']['x stored']['properties'], 'b'>>;",
    "type _c3 = Expect<Equals<keyof C['fact']['x stored']['properties'], 'c'>>;",
    "type _c4 = Expect<Equals<keyof C['fact']['x']['properties'], 'd'>>;",
    "type _c5 = Expect<HasIndex<C['entity']['x stored']['stored']>>;",
  ].join('\n') + '\n';
  const files = { text: out.text.source, name: out.name.source, collide: out.collide.source, usage };
  memo = { out, files, result: compileInMemory(files) };
  return memo;
}

/** The comment lines a TypeScript compiler would read a directive from: each line of each comment, its leading `//`, `/*` and `*` cut. */
const directiveLines = (source) => commentsOf(source)
  .flatMap(c => c.text.split(ANY_BREAK))
  .map(l => l.replace(/^\s*(\/\/+|\/\*+|\*+)?\s*/, ''))
  .filter(l => l.startsWith('@ts-'));

describe('the readers this file stands on, proven on planted sources', () => {
  it('a directive line, a // comment with the marker, a raw line separator and the marker in code are each seen', () => {
    const planted = `/**\n * fine\n * @ts-ignore\n */\n// ${MARK}\nexport const ${MARK} = '${MARK}';\n/* a${LS}b */\n`;
    assert.deepEqual(directiveLines(planted), ['@ts-ignore']);
    assert.ok(commentsOf(planted).some(c => c.text.startsWith('//') && c.text.includes(MARK)));
    assert.ok(commentsOf(planted).some(c => RAW_BREAK.test(c.text)));
    assert.deepEqual(codeTokensOf(planted).filter(t => t.includes(MARK)), [MARK]);
    assert.deepEqual(exportedNames(planted), [MARK]);
    const clean = `/** a ${MARK} in a comment */\nexport const s = '${MARK}';\n`;
    assert.deepEqual([directiveLines(clean), codeTokensOf(clean).filter(t => t.includes(MARK))], [[], []]);
  });
});

describe('hostile text stays data', () => {
  it('every source compiles, and names, keys and enum values reach the types exactly', () => {
    const { files, result } = all();
    assert.deepEqual(result.global, []);
    for (const f of Object.keys(files)) assert.equal(result.byFile[f].length, 0, `${f}:\n${withLines(result.byFile[f], files[f])}`);
  });

  for (const which of ['text', 'name', 'collide']) {
    it(`${which}: no comment line starts a @ts- directive, and no // comment carries schema text`, () => {
      const { source } = all().out[which];
      assert.deepEqual(directiveLines(source), [], 'a comment line the compiler would read as a directive');
      const lineComments = commentsOf(source).filter(c => c.text.startsWith('//'));
      const carrying = lineComments.filter(c => c.text.includes(MARK) || c.text.includes('injected') || /@ts-/.test(c.text));
      assert.deepEqual(carrying.map(c => c.text), [], 'a // comment carries schema text');
    });

    it(`${which}: no comment holds CR, U+2028 or U+2029`, () => {
      const raw = commentsOf(all().out[which].source).filter(c => RAW_BREAK.test(c.text));
      assert.deepEqual(raw.map(c => JSON.stringify(c.text.slice(0, 120))), [], 'a raw line break from schema text inside a comment');
    });

    it(`${which}: nothing injected - the exports are what a plainly named meta of the same size exports`, () => {
      const meta = { text: TEXT_META, name: NAME_META, collide: COLLIDE_META }[which];
      const names = exportedNames(all().out[which].source);
      const plain = exportedNames(converted(plainLike(meta)).source);
      assert.equal(names.length, plain.length, `exports: ${names.join(', ')}`);
      assert.equal(names.length, 1 + 2 * typeCount(meta), 'SpaceTypes and two interfaces per type');
      assert.equal(new Set(names).size, names.length, 'an export name repeats');
      assert.ok(names.includes('SpaceTypes'));
      assert.deepEqual(codeTokensOf(all().out[which].source).filter(t => t.includes(MARK)), [], `${MARK} reached the code`);
    });
  }
});

describe('suffix collisions', () => {
  it('x and "x stored" both convert with their own properties, and the rename is reported', () => {
    const { untranslated } = all().out.collide;
    const renamed = reportsLike(untranslated, { reason: 'renamed' });
    assert.ok(renamed.length >= 2, `one rename per kind is reported: ${JSON.stringify(untranslated)}`);
    assertReported(untranslated, { reason: 'renamed', kind: 'entity' }, 'entity');
    assertReported(untranslated, { reason: 'renamed', kind: 'fact' }, 'fact');
  });
});
