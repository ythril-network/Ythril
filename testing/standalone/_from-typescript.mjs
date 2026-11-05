/**
 * What the tests of `@ythril/schema/from-typescript` (`spaceMetaFromTypeScript`, Q-687, design v3) share: the guarded load of the entry,
 * the source builder, the refusal and result shape checks, the recording compiler that stands in for the loaded TypeScript module, and
 * the round-trip oracle over `typesOfSpaceMeta`'s output.
 *
 * ## The question it answers
 *
 * *"Does the reverse direction read what the forward direction wrote, and does it touch nothing else?"* Six test files ask it (the loading,
 * the closed host, the refusals, the round trip, the bounds and the 6.x run). Each writing its own fake compiler, source builder or
 * oracle would be six copies that differ in the one line that decides the answer, so they live here once.
 *
 * ## What it prevents
 *
 * - **A missing entry hiding every case.** The entry (`schema/dist/from-typescript.js`) is imported through {@link entry}, which turns
 *   "module not found" into one assertion that names the entry, so each case fails on its own line and says why (before the build
 *   exists, the whole suite is red for that one reason).
 * - **A compiler fake that accepts anything.** {@link recordingCompiler} answers `sys` from a Proxy over the real one, records every
 *   call and fails on any file-system call whose path is not an exact lib path. A host that reads one other file is a failing case,
 *   not a quiet read.
 * - **An oracle that copies the implementation.** {@link expectedProperty} states what the forward direction writes for one property
 *   and so what the reverse direction must say, from the forward direction's documented rules (`MEMBER_TYPE`, `ENUM_LITERAL_MAX`, the
 *   JSDoc notes), never from the module under test. A shape it does not model throws, so a fixture that grows one is a failing
 *   test and not a silent skip.
 *
 * ## What the tests fix where the design leaves a name open
 *
 * - The entry exports `spaceMetaFromTypeScript`, `UNREPRESENTED_REASONS` and `SOURCE_MAX`.
 * - A result is `{ ok: true, meta: { typeSchemas }, notRead }` or `{ ok: false, refusals, more }`, nothing else.
 * - A refusal is `{ path: string[], reason, detail }`, and `source-does-not-compile` also carries `code` (the diagnostic's number).
 * - A `notRead` entry is `{ path: string[] }`: `[kind, type, 'propertySchemas', key, <field>]`, the field being one of
 *   {@link NOT_READ_FIELDS}.
 * - The reasons of the member shapes the design refuses "by name" are `<shape>-not-representable` ({@link MEMBER_REFUSALS}); a map that is
 *   not declared is `map-not-found`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as schema from '../../schema/dist/index.js';
import { REPO_ROOT } from './_sources.mjs';

/** The built entry: `@ythril/schema/from-typescript` (schema/src/from-typescript.ts, compiled to schema/dist). */
export const ENTRY_URL = new URL('../../schema/dist/from-typescript.js', import.meta.url);

/**
 * The entry, imported once and checked for the three names these tests read. A module that is not there is ONE assertion that names it,
 * so no case hides behind a failed import; any other import error is rethrown as it is.
 */
export async function entry() {
  let mod;
  try {
    mod = await import(ENTRY_URL.href);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('from-typescript')) {
      assert.fail(`@ythril/schema/from-typescript is built at schema/dist/from-typescript.js (Q-687, design v3 item 1): ${error.message}`);
    }
    throw error;
  }
  assert.equal(typeof mod.spaceMetaFromTypeScript, 'function', 'the entry exports spaceMetaFromTypeScript(source, options?)');
  assert.ok(Array.isArray(mod.UNREPRESENTED_REASONS), 'the entry exports UNREPRESENTED_REASONS, the closed list of refusal reasons (item 11)');
  assert.ok(Number.isInteger(mod.SOURCE_MAX) && mod.SOURCE_MAX > 0, 'the entry exports SOURCE_MAX, the most characters of source it reads (item 6)');
  return mod;
}

/** `spaceMetaFromTypeScript(source, options)` through the guarded entry. */
export async function read(source, options) {
  const mod = await entry();
  return options === undefined ? mod.spaceMetaFromTypeScript(source) : mod.spaceMetaFromTypeScript(source, options);
}

/** The real TypeScript module this repository's tests compile with (the devDependency). */
export const REAL_TS = ts;

/** The most refusals one answer lists, and the package's own bounds on a quoted text: the numbers the answer is held to. */
export const { REFUSAL_NAMES_MAX, LOG_VALUE_MAX, ENUM_LITERAL_MAX, KNOWLEDGE_TYPES } = schema;

/** The most characters a detail holds: peerText cuts at LOG_VALUE_MAX and says how much it cut, in a marker of its own (`…(+N more)`). */
export const DETAIL_MAX = LOG_VALUE_MAX + 64;

/** The shapes of a member type the design refuses by name (item 8), each with the reason that names it. */
export const MEMBER_REFUSALS = Object.freeze({
  date: 'date-not-representable',
  object: 'object-not-representable',
  array: 'array-not-representable',
  union: 'union-not-representable',
  method: 'method-not-representable',
  generic: 'generic-not-representable',
  template: 'template-not-representable',
  branded: 'branded-not-representable',
});

/** The fields of a property the forward direction writes as a JSDoc note and the reverse direction reports in `notRead`, never reads back (item 9). */
export const NOT_READ_FIELDS = Object.freeze(['description', 'pattern', 'minimum', 'maximum', 'default', 'mergeFn', 'required', 'type', 'enum']);

/**
 * A source declaring one `SpaceTypes` with one type under one kind: `members` is the text between the braces of `properties`.
 * Only the one kind is written (the design reads kind -> type -> `{ properties }`; a kind that is not there has no types).
 */
export function sourceOf(members, { kind = 'entity', type = 'thing', map = 'SpaceTypes', before = '', after = '', stored } = {}) {
  const storedPart = stored === undefined ? '' : ` stored: { ${stored} };`;
  return `${before}export interface ${map} {\n  ${JSON.stringify(kind)}: {\n    ${JSON.stringify(type)}: { properties: { ${members} };${storedPart} };\n  };\n}\n${after}`;
}

/** A source that is read: one entity type with one string member. The control every refusal row is a one-token change of. */
export const CONTROL_SOURCE = sourceOf('name: string;');

/** `answer` is `{ ok: true, meta, notRead }`, and says so with the answer in the message. */
export function assertRead(answer, why) {
  assert.equal(answer?.ok, true, `${why}: expected a read, got ${JSON.stringify(answer)?.slice(0, 800)}`);
  assert.deepEqual(Object.keys(answer).sort(), ['meta', 'notRead', 'ok'], 'a read answers { ok, meta, notRead } and nothing else');
  assert.deepEqual(Object.keys(answer.meta), ['typeSchemas'], 'the meta holds typeSchemas and nothing else');
  assert.ok(Array.isArray(answer.notRead), 'notRead is a list');
  for (const item of answer.notRead) {
    assert.ok(Array.isArray(item?.path) && item.path.every(s => typeof s === 'string'), `a notRead entry has a path of strings: ${JSON.stringify(item)}`);
  }
  return answer;
}

/** A raw control character, DEL or line separator: what peerText never lets through. Built from escapes so the file holds none. */
const RAW_CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]');

/**
 * `answer` is `{ ok: false, refusals, more }`: whole or nothing (no `meta`), the refusals at most REFUSAL_NAMES_MAX, each
 * `{ path, reason, detail }` with a reason of the closed list and a detail that is bounded plain text (peerText: no control character,
 * at most LOG_VALUE_MAX characters).
 */
export async function assertRefusedShape(answer, why) {
  const { UNREPRESENTED_REASONS } = await entry();
  assert.equal(answer?.ok, false, `${why}: expected a refusal, got ${JSON.stringify(answer)?.slice(0, 800)}`);
  assert.deepEqual(Object.keys(answer).sort(), ['more', 'ok', 'refusals'], 'a refusal answers { ok, refusals, more } and no meta');
  assert.ok(Number.isInteger(answer.more) && answer.more >= 0, 'more counts the refusals the list does not show');
  assert.ok(answer.refusals.length >= 1 && answer.refusals.length <= REFUSAL_NAMES_MAX, `the list holds 1 to ${REFUSAL_NAMES_MAX} refusals, got ${answer.refusals.length}`);
  for (const refusal of answer.refusals) {
    const keys = Object.keys(refusal).sort();
    const allowed = refusal.reason === 'source-does-not-compile' ? ['code', 'detail', 'path', 'reason'] : ['detail', 'path', 'reason'];
    assert.deepEqual(keys, allowed, `a refusal of ${refusal.reason} has exactly ${allowed.join(', ')}`);
    assert.ok(UNREPRESENTED_REASONS.includes(refusal.reason), `${refusal.reason} is in UNREPRESENTED_REASONS`);
    assert.ok(Array.isArray(refusal.path) && refusal.path.every(s => typeof s === 'string'), `a refusal path is a list of strings: ${JSON.stringify(refusal.path)}`);
    assert.equal(typeof refusal.detail, 'string');
    assert.ok(refusal.detail.length <= DETAIL_MAX, `a detail is bounded by peerText (${refusal.detail.length} > ${DETAIL_MAX})`);
    assert.ok(!RAW_CONTROL.test(refusal.detail), `a detail carries no raw control or line character: ${JSON.stringify(refusal.detail.slice(0, 120))}`);
    if (refusal.reason === 'source-does-not-compile') assert.ok(Number.isInteger(refusal.code), 'source-does-not-compile carries the diagnostic code');
  }
  return answer;
}

/** Reads `source`, asserts the whole answer is a refusal of the stated shape that holds `reason`, and returns the refusals of that reason. */
export async function refusedWith(source, reason, options) {
  const answer = await read(source, options);
  await assertRefusedShape(answer, `a source that must be refused as ${reason}`);
  const found = answer.refusals.filter(r => r.reason === reason);
  assert.ok(found.length > 0, `expected a refusal ${reason}, got ${JSON.stringify(answer.refusals).slice(0, 800)}`);
  return found;
}

/** The property schema the answer holds for `kind.type.key`. */
export function propertyOf(answer, kind, type, key) {
  return answer.meta.typeSchemas?.[kind]?.[type]?.propertySchemas?.[key];
}

/** True when `answer.notRead` holds a path equal to `path`. */
export function notReadHas(answer, path) {
  return answer.notRead.some(e => e.path.length === path.length && e.path.every((s, i) => s === path[i]));
}

/** Every `notRead` path of the answer that is about a property, as JSON strings of the path, sorted (a name with a dot reads the same on both sides). */
export function propertyNotRead(answer) {
  return answer.notRead.map(e => e.path).filter(p => p[2] === 'propertySchemas').map(p => JSON.stringify(p)).sort();
}

/** The directory of the garden fixtures: one made-up app's schemas, the outside-app test fixtures. */
export const FIXTURE_DIR = join(REPO_ROOT, 'testing/fixtures/outside-app-schemas');

/** The garden fixtures' metas, `{ name, meta }`, with a floor so an empty listing cannot pass. */
export function gardenFixtures() {
  const files = readdirSync(FIXTURE_DIR).filter(f => /^garden-.*\.json$/.test(f)).sort();
  assert.ok(files.length >= 3, `the garden fixtures are there (garden-beds, garden-plants, garden-season), got ${files.join(', ')}`);
  return files.map(f => ({ name: f, meta: JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) }));
}

/** `{ kind, type, def }` for every type of a meta's `typeSchemas`, in the meta's order. */
export function typesOfMeta(meta) {
  const out = [];
  for (const [kind, defs] of Object.entries(meta.typeSchemas ?? {})) for (const [type, def] of Object.entries(defs)) out.push({ kind, type, def });
  return out;
}

const MEMBER_TYPE = { string: 'string', number: 'number', boolean: 'boolean', date: 'string' };

/**
 * What the reverse direction must say about one property the forward direction wrote, from the forward direction's rules alone
 * (typescript.ts `memberType`, `propertyDoc`):
 *
 * - `type`: the property's own, a date as `string`; an untyped property with an enum of one base type reads as that base type; a
 *   mixed enum has no type (`undefined`).
 * - `required`: only a required property with no default.
 * - `enum`: the distinct values of the declared type, IN ORDER; none for a boolean (a union of both is boolean), for an enum longer than
 *   ENUM_LITERAL_MAX (written as its base type), and for a single boolean literal (it widens).
 * - `lost`: the fields the source can only carry as a note or not at all, which `notRead` must name: description, pattern, minimum,
 *   maximum, default and mergeFn when set; `type` for a date; `required` for a required property with a default; `enum` for a single
 *   boolean literal.
 *
 * A shape this does not model (an enum emptied by its type, an untyped boolean enum) throws: the oracle never guesses.
 */
export function expectedProperty(property) {
  const declared = property.type === undefined ? undefined : MEMBER_TYPE[property.type];
  const lost = [];
  for (const field of ['description', 'pattern', 'minimum', 'maximum', 'default', 'mergeFn']) if (property[field] !== undefined && property[field] !== '') lost.push(field);
  if (property.type === 'date') lost.push('type');
  if (property.required === true && property.default !== undefined) lost.push('required');
  let type = property.type === undefined ? undefined : declared;
  let values;
  if (Array.isArray(property.enum)) {
    const distinct = [...new Set(property.enum.filter(v => declared === undefined || typeof v === declared))];
    assert.ok(distinct.length > 0, `the oracle does not model an enum emptied by its type: ${JSON.stringify(property)}`);
    if (distinct.length <= ENUM_LITERAL_MAX) {
      const kinds = new Set(distinct.map(v => typeof v));
      assert.ok(!(declared === undefined && kinds.has('boolean')), `the oracle does not model an untyped enum with a boolean: ${JSON.stringify(property)}`);
      if (declared === 'boolean') {
        if (distinct.length === 1) lost.push('enum');
      } else {
        values = distinct;
        if (declared === undefined && kinds.size === 1) type = [...kinds][0];
      }
    }
  }
  return { type, required: property.required === true && property.default === undefined, enum: values, lost };
}

/**
 * Asserts `answer` (a read) agrees with `meta`, the one `typesOfSpaceMeta` wrote the source of: the same types, and per property the
 * kind, required and the enum IN ORDER (never compared as sets), nothing else on the property, and `notRead` naming exactly the
 * property fields the source cannot carry. A type with no properties comes back open (no `propertySchemas`).
 */
export function assertAgrees(answer, meta, why) {
  assertRead(answer, why);
  const want = typesOfMeta(meta).map(t => `${t.kind}/${t.type}`).sort();
  const got = typesOfMeta(answer.meta).map(t => `${t.kind}/${t.type}`).sort();
  assert.deepEqual(got, want, `${why}: the types come back as they were`);
  const lost = [];
  for (const { kind, type, def } of typesOfMeta(meta)) {
    const back = answer.meta.typeSchemas[kind][type];
    const properties = def.propertySchemas ?? {};
    const keys = Object.keys(properties);
    if (keys.length === 0) {
      assert.equal(back.propertySchemas, undefined, `${why}: ${kind}.${type} declared no property, so it is open and has no propertySchemas`);
      continue;
    }
    assert.deepEqual(Object.keys(back.propertySchemas), keys, `${why}: ${kind}.${type} members in source order`);
    for (const key of keys) {
      const expected = expectedProperty(properties[key]);
      const actual = back.propertySchemas[key];
      const at = `${why}: ${kind}.${type}.${key}`;
      assert.ok(Object.keys(actual).every(k => ['type', 'required', 'enum'].includes(k)), `${at} carries only type, required and enum, got ${JSON.stringify(actual)}`);
      assert.equal(actual.type, expected.type, `${at} kind`);
      assert.equal(actual.required === true, expected.required, `${at} required`);
      assert.deepEqual(actual.enum, expected.enum, `${at} enum, in order`);
      for (const field of expected.lost) lost.push(JSON.stringify([kind, type, 'propertySchemas', key, field]));
    }
  }
  assert.deepEqual(propertyNotRead(answer), lost.sort(), `${why}: notRead names, by path, exactly the property fields the source cannot carry`);
  const valid = schema.validateSpaceMeta(answer.meta);
  assert.equal(valid.ok, true, `${why}: the server accepts what was read: ${JSON.stringify(valid).slice(0, 400)}`);
}

/** The forward direction's source for `meta`: the one call every round-trip row makes. */
export function sourceOfMeta(meta) {
  const { source } = schema.typesOfSpaceMeta(meta);
  assert.equal(typeof source, 'string');
  return source;
}

// ---------------------------------------------------------------------------------------------------------------------
// The recording compiler
// ---------------------------------------------------------------------------------------------------------------------

/** The `sys` methods that touch the file system: any of them, on a path that is not an exact lib path, is a read the closed host must not make. */
const FILE_SYSTEM_METHODS = new Set([
  'readFile', 'fileExists', 'directoryExists', 'readDirectory', 'getDirectories', 'realpath', 'getFileSize', 'getModifiedTime',
  'writeFile', 'createDirectory', 'deleteFile', 'watchFile', 'watchDirectory', 'setModifiedTime',
]);

/** The directory of the compiler's own lib files, as the compiler names it. */
export function libDirOf(compiler) {
  return posix.dirname(compiler.getDefaultLibFilePath({}));
}

/** True when `path` is an exact `lib.*.d.ts` directly inside `libDir`. */
export function isLibPath(path, libDir) {
  return typeof path === 'string' && posix.dirname(path) === libDir && /^lib\.[a-z0-9.]+\.d\.ts$/i.test(path.slice(libDir.length + 1));
}

/**
 * A stand-in for the loaded TypeScript module: the real one, with `sys` answered by a Proxy that records every call and fails on a
 * file-system call whose path is not an exact lib path, and `createProgram` wrapped to record its arguments (and to run `probe`
 * with them first). Pass it as `options.typescript`; it is a new object each call, so it is a new module to the entry.
 *
 * @param {object} [options]
 * @param {(name: string) => boolean} [options.failLibRead] a lib file name for which `sys.readFile` answers `undefined`
 * @param {(seen: { rootNames: string[], options: object, host: object, compiler: object }) => void} [options.probe] run with each createProgram's arguments before the real call
 * @param {(...args: unknown[]) => unknown} [options.createProgram] replaces the real createProgram (a compiler that throws)
 */
export function recordingCompiler({ failLibRead = () => false, probe, createProgram } = {}, base = ts) {
  const libDir = libDirOf(base);
  const calls = [];
  const violations = [];
  const programs = [];
  const sys = new Proxy(base.sys, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls.push({ method: String(prop), path: args[0] });
        if (FILE_SYSTEM_METHODS.has(String(prop))) {
          if (!isLibPath(args[0], libDir)) {
            violations.push(`${String(prop)}(${JSON.stringify(args[0])})`);
            throw new Error(`the closed host reached the file system: ${String(prop)}(${JSON.stringify(args[0])})`);
          }
          if (prop === 'readFile' && failLibRead(args[0].slice(libDir.length + 1))) return undefined;
        }
        return value.apply(target, args);
      };
    },
  });
  const compiler = {
    ...base,
    sys,
    createProgram(...args) {
      const object = !Array.isArray(args[0]) && args[0] !== null && typeof args[0] === 'object';
      const seen = { rootNames: object ? args[0].rootNames : args[0], options: object ? args[0].options : args[1], host: object ? args[0].host : args[2], compiler };
      programs.push(seen);
      if (probe) probe(seen);
      return createProgram ? createProgram(...args) : base.createProgram(...args);
    },
  };
  return {
    compiler,
    libDir,
    calls,
    violations,
    programs,
    /** The distinct lib file names `sys.readFile` was asked for. */
    libReads: () => [...new Set(calls.filter(c => c.method === 'readFile').map(c => c.path.slice(libDir.length + 1)))].sort(),
    /** How many `sys.readFile` calls there have been. */
    readCount: () => calls.filter(c => c.method === 'readFile').length,
  };
}

/** A compiler that counts how many times it is asked for a program, and otherwise is the real one. */
export function countingCompiler(base = ts) {
  const state = { programs: 0 };
  const compiler = { ...base, createProgram: (...args) => { state.programs++; return base.createProgram(...args); } };
  return { compiler, state };
}

/** The `typescript-6` devDependency's module (`npm:typescript@^6`), resolved from the schema package, then the repository root. */
export async function typescript6() {
  let resolved;
  for (const from of ['schema/package.json', 'package.json']) {
    try {
      resolved = createRequire(join(REPO_ROOT, from)).resolve('typescript-6');
      break;
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  assert.ok(resolved, 'typescript-6 (npm:typescript@^6) is a devDependency of the schema package or the repository (design v3 item 3), so one test can run the harness on 6.x');
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default ?? mod;
}
