/**
 * No REST or MCP door can pass the instance-written-keys exemption (Q-93), and the exemption has ONE source.
 *
 * ## What the exemption is, and what this gate is for
 *
 * A type that declares a property is closed: in a strict space a write that adds an undeclared key is refused. The keys
 * the extractor itself writes (an entity's `aliases`, an edge's `since` / `until`, a claim's `speaker` / `statedOn` /
 * `attributed`) are exempt, so an `ingest` into a space whose owner edited the shipped types does not fail on request
 * 340. The exemption is handed to the validator as a FUNCTION ARGUMENT, fed from one exported constant,
 * `INSTANCE_WRITTEN_PROPERTY_KEYS`, per kind.
 *
 * Which is exactly why this gate exists: an argument is something a caller can supply. The day a REST body or an MCP
 * tool argument reaches that parameter, "refused in strict" becomes "refused unless you ask", and the whole rule is a
 * request flag. So the door side must be unable to name it, and the keys must have one home that the extractor's own
 * sources can be held against.
 *
 * ## The clauses, each derived from tracked sources (never listed), with a floor
 *
 *  a. the identifier is EXPORTED exactly once under server/src. Zero means the exemption has no single source (it is
 *     spelled inline at each site, or not at all); two means the extractor and the validator can disagree about what
 *     the instance writes. RED on the base: the constant does not exist yet.
 *  b. no file under server/src/api/ or server/src/mcp/ mentions it (to pass it to a validator or classifier, one must
 *     name it), and none re-exports or aliases the whole constant.
 *  c. every file that mentions it lives under ALLOWED_DIRS.
 *  d. the PARAMETER it is passed as is derived from the call sites (`<name>: INSTANCE_WRITTEN_PROPERTY_KEYS` or a
 *     positional argument, resolved to the callee's parameter name), and no body-key declaration reads that name: no
 *     file under api/ or mcp/ mentions it, no zod-importing file declares it as a key, and no string literal in
 *     server/src spells it (the shared body-key lists are string tables). Pass the constant straight from its name at
 *     the call, or bind it once in the file (`const own = INSTANCE_WRITTEN_PROPERTY_KEYS[kind]`): a spelling the
 *     derivation cannot resolve is reported, never skipped. Name the parameter distinctively: a generic one
 *     (`keys`, `opts`) will hit every door that also has one, and that is the cost of a name nobody can grep for.
 *  e. the keys are really in the constant: the COMPILED constant (server/dist, the file derived from the export in
 *     clause a) holds, per kind, every key in the literal table below, and each of those names is still written by
 *     the extractor (server/src/extractor). Every key the constant exempts is likewise named by the extractor's
 *     sources: a key exempted that nothing writes widens the exemption for nobody's benefit.
 *
 * ## Seen red
 *
 * Every clause is a PURE function over `[{ file, text }]`, so the self-tests at the bottom feed each one an in-memory
 * list with a door that passes the constant, a second definition, an alias, a declaring zod body and a lookalike
 * comment, and assert it is reported. Nothing under server/src is edited to show it. Clause a goes red on the real
 * tree by itself, until the constant exists.
 *
 * ## Fixture is literal on purpose
 *
 * EXTRACTOR_KEYS states what the extractor writes TODAY. A fixture derived from the constant would assert the
 * constant equals itself; the extractor-source check below is what keeps the table from going stale silently. The
 * extractor writes no property on a chrono entry, so there is no chrono row.
 *
 * Run: `node --test testing/standalone/no-rest-or-mcp-door-can-pass-the-instance-written-keys-exemption.test.js`
 * (clause e needs a prior `npm run build` in server/; nothing else does)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

export const IDENT = 'INSTANCE_WRITTEN_PROPERTY_KEYS';
const SRC = 'server/src/';
const DOOR_DIRS = Object.freeze([`${SRC}api/`, `${SRC}mcp/`]);
/** Where the constant may be named, and why each directory may. A directory is added here with a reason or not at all. */
export const ALLOWED_DIRS = Object.freeze([
  { dir: `${SRC}extractor/`, reason: 'the extractor owns the keys: it writes them, and its writer hands the door what to exempt' },
  { dir: `${SRC}brain/`, reason: 'the batch door (bulk.ts) and the record writers run the validator on behalf of a caller who cannot choose the exemption' },
  { dir: `${SRC}spaces/`, reason: 'the validator and classifier live here; they take the exemption as a parameter' },
]);
/** What the extractor writes onto each kind today, by name. Literal (see the header). */
export const EXTRACTOR_KEYS = Object.freeze({
  entity: ['aliases'],
  edge: ['since', 'until'],
  fact: ['speaker', 'statedOn', 'attributed'],
});

/* ───────────────────────────── pure functions over [{ file, text }] ───────────────────────────── */

const WORD = (name) => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
/** Comments blanked, line numbers kept, so a report names the line a reader will find. */
const code = (sources) => sources.map(s => ({ file: s.file, text: blankComments(s.text) }));
const underAny = (file, dirs) => dirs.some(d => file.startsWith(d));

/** One row per file that names `name` as a word, at its first line. */
export function mentionsOf(sources, name = IDENT) {
  const re = WORD(name);
  return code(sources).flatMap(s => { const m = re.exec(s.text); return m ? [{ file: s.file, line: lineAt(s.text, m.index) }] : []; });
}

/** Where `IDENT` is EXPORTED: a declaration or a re-export. One row per export, so a second definition is two rows. */
export function exportsOf(sources, name = IDENT) {
  const decl = new RegExp(`export\\s+(?:declare\\s+)?(?:const|let|var|function|class|enum)\\s+${name}(?![\\w$])`, 'g');
  const list = new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*(?<![\\w$])${name}(?![\\w$])[^}]*\\}`, 'g');
  return code(sources).flatMap(s => [...s.text.matchAll(decl), ...s.text.matchAll(list)]
    .map(m => ({ file: s.file, line: lineAt(s.text, m.index) })));
}

/** Clause b: files under a door directory that name the constant (to pass a validator or classifier it, one must name it). */
export function doorsPassingTheExemption(sources, name = IDENT) {
  return mentionsOf(sources, name).filter(m => underAny(m.file, DOOR_DIRS));
}

/** Clause c: files that name the constant from outside the allowed directories. */
export function mentionsOutsideAllowedDirs(sources, name = IDENT, allowed = ALLOWED_DIRS) {
  return mentionsOf(sources, name).filter(m => !underAny(m.file, allowed.map(a => a.dir)));
}

/**
 * The whole constant under a second name: an import renamed, a re-export, or `const X = IDENT;`. A subscript or property
 * read (`IDENT[kind]`, `IDENT.entity`) is not an alias of the constant: it is its use.
 */
export function aliasesOf(sources, name = IDENT) {
  const forms = [
    new RegExp(`(?:const|let|var)\\s+[\\w$]+\\s*(?::[^=;]+)?=\\s*${name}\\s*(?:;|\\n|$)`, 'g'),
    new RegExp(`(?<![\\w$])${name}\\s+as\\s+[\\w$]+`, 'g'),
    new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*(?<![\\w$])${name}(?![\\w$])[^}]*\\}\\s*from`, 'g'),
    new RegExp(`export\\s*\\*\\s*from`, 'g'),
  ];
  const definers = new Set(exportsOf(sources, name).map(e => e.file));
  return code(sources).flatMap(s => {
    const hits = forms.slice(0, 3).flatMap(f => [...s.text.matchAll(f)]);
    // `export * from` hides the constant behind a module's own name: only a problem in a file that names it or defines it.
    if (definers.has(s.file) || WORD(name).test(s.text)) hits.push(...s.text.matchAll(forms[3]));
    return hits.map(m => ({ file: s.file, line: lineAt(s.text, m.index) }));
  });
}

/** Index of the bracket matching the one at `open`, or -1. */
function matching(text, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
  }
  return -1;
}
/** `text` split at its top-level commas. */
function topLevelPieces(text) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('({['.includes(c)) depth++; else if (')}]'.includes(c)) depth--; else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}
/** The parameter NAME at `index` of function `callee`, found in the sources, or undefined. */
function parameterName(sources, callee, index) {
  const re = new RegExp(`(?:function\\s*\\*?\\s+|(?:const|let|var)\\s+|^\\s*(?:async\\s+|static\\s+|public\\s+|private\\s+)*)${callee}\\s*(?:<[^(=]*>)?\\s*(?:=\\s*(?:async\\s*)?)?\\(`, 'm');
  for (const s of sources) {
    const m = re.exec(s.text);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matching(s.text, open);
    if (close < 0) continue;
    // A call statement is not a definition: a definition's parameter list is followed by a body (or a return type, then a body).
    if (!/^\s*(?::\s*[^;{=]+)?\s*(?:\{|=>)/.test(s.text.slice(close + 1))) continue;
    const piece = topLevelPieces(s.text.slice(open + 1, close))[index];
    const name = /^\s*(?:\.\.\.)?\s*(?:readonly\s+)?([\w$]+)/.exec(piece ?? '');
    if (name) return name[1];
  }
  return undefined;
}

/**
 * Clause d, derivation: the parameter name(s) `name` (and the file-local bindings of it) is passed as, from the call sites.
 * `{ names, unresolved }`: `unresolved` lists each spelling at a call this could not turn into a parameter name, with its
 * place, so an unreadable call is a finding and never a silence.
 */
export function argumentNamesPassing(sources, name = IDENT) {
  const names = new Set();
  const unresolved = [];
  const cs = code(sources);
  for (const s of cs) {
    const spellings = [name, ...[...s.text.matchAll(new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*(?::[^=;]+)?=\\s*(?:\\(?\\s*)?${name}(?![\\w$])`, 'g'))].map(m => m[1])];
    for (const spelling of spellings) {
      for (const m of s.text.matchAll(new RegExp(`(?<![\\w$.])${spelling.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))) {
        // The definition's own line and a local binding's right-hand side are not call sites.
        // The text of the line up to the mention: a structural bound (the statement's own line), not a count of characters.
        const before = s.text.slice(s.text.lastIndexOf('\n', m.index) + 1, m.index);
        if (/(?:const|let|var|function)\s+[\w$]*$/.test(before) || /(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?=\s*\(?\s*$/.test(before) || /export\s+(?:declare\s+)?(?:const|let|var)\s+$/.test(before)) continue;
        // Walk back to the nearest unmatched opener: `{` is an object property, `(` a positional argument, `[` an array element.
        let depth = 0, open = -1;
        for (let i = m.index - 1; i >= 0; i--) {
          const c = s.text[i];
          if (')}]'.includes(c)) depth++;
          else if ('({['.includes(c)) { if (depth === 0) { open = i; break; } depth--; }
        }
        const at = `${s.file}:${lineAt(s.text, m.index)}`;
        if (open < 0) { unresolved.push(`${at} (${spelling} outside any call or literal)`); continue; }
        const head = s.text.slice(open + 1, m.index);
        // An import or a re-export names the constant without using it; the alias clause reads those.
        if (s.text[open] === '{' && /(?:import|export)\s*(?:type\s*)?$/.test(s.text.slice(s.text.lastIndexOf('\n', open) + 1, open))) continue;
        if (s.text[open] === '{') {
          const prop = /(?:^|,)\s*([\w$]+)\s*:\s*(?:\(\s*)?$/.exec(head) ?? /(?:^|,)\s*\.\.\.\s*$/.exec(head);
          if (prop?.[1]) names.add(prop[1]); else unresolved.push(`${at} (${spelling} inside an object literal, not as a property value)`);
          continue;
        }
        if (s.text[open] === '(') {
          const callee = /([\w$]+)\s*(?:<[^()]*>)?\s*$/.exec(s.text.slice(s.text.lastIndexOf('\n', open) + 1, open))?.[1];
          const index = topLevelPieces(head).length - 1;
          const param = callee ? parameterName(cs, callee, index) : undefined;
          if (param) names.add(param); else unresolved.push(`${at} (${spelling} passed to ${callee ?? 'an unnamed call'} at position ${index}; its parameter was not found)`);
          continue;
        }
        unresolved.push(`${at} (${spelling} inside an array literal)`);
      }
    }
  }
  return { names: [...names].sort(), unresolved };
}

/**
 * Clause d: every place a body-key declaration could read the parameter's name — a file under api/ or mcp/ that mentions
 * it, a zod-importing file that declares it as a key, a string literal that spells it anywhere under server/src.
 */
export function declarationsOfArgument(sources, argName) {
  const word = WORD(argName);
  const quoted = new RegExp(`(['"\`])${argName.replace(/\$/g, '\\$')}\\1`);
  const key = new RegExp(`(?<![\\w$.])${argName.replace(/\$/g, '\\$')}\\??\\s*:`);
  const out = [];
  for (const s of code(sources)) {
    const reasons = [];
    if (underAny(s.file, DOOR_DIRS) && word.test(s.text)) reasons.push('a door file names it');
    if (/from\s+['"]zod['"]/.test(s.text) && key.test(s.text)) reasons.push('a zod body declares it as a key');
    if (quoted.test(s.text)) reasons.push('a string literal spells it (a body-key table)');
    if (reasons.length) {
      const m = word.exec(s.text) ?? quoted.exec(s.text);
      out.push({ file: s.file, line: m ? lineAt(s.text, m.index) : 1, why: reasons.join('; ') });
    }
  }
  return out;
}

/** The compiled file of a source file: `server/src/x/y.ts` is `server/dist/x/y.js`. */
export const compiledPathOf = (file) => file.replace(/^server\/src\//, 'server/dist/').replace(/\.ts$/, '.js');

/** The keys a per-kind entry holds, whether it is an array, a Set, or a record keyed by property name. */
export function keysOf(entry) {
  if (entry == null) return [];
  if (typeof entry[Symbol.iterator] === 'function' && typeof entry !== 'string') return [...entry];
  return typeof entry === 'object' ? Object.keys(entry) : [];
}
/** The entry for `kind`, by its singular or plural spelling (`entity` / `entities`, `edge` / `edges`, `fact` / `facts`). */
export function kindEntry(constant, kind) {
  const plural = kind === 'entity' ? 'entities' : `${kind}s`;
  return constant?.[kind] ?? constant?.[plural];
}

/** Whether `key` is named in the extractor's sources, as a word, outside comments. */
export function extractorNames(sources, key) {
  const word = WORD(key);
  return code(sources).filter(s => s.file.startsWith(`${SRC}extractor/`) && word.test(s.text)).map(s => s.file);
}

/* ───────────────────────────── the gate, over the real tree ───────────────────────────── */

const FLOOR = 300;
const sources = readTrackedSources('server/src', { ext: ['.ts'], floor: FLOOR });
const show = (rows) => rows.map(r => `${r.file}:${r.line}${r.why ? ` (${r.why})` : ''}`).join('\n  ');

describe('the instance-written-keys exemption has one source and no door can pass it', () => {
  it('reads the whole source tree, with the extractor, the doors and the validators in it', () => {
    assert.ok(sources.length >= FLOOR, `only ${sources.length} sources read`);
    for (const dir of [...DOOR_DIRS, ...ALLOWED_DIRS.map(a => a.dir)]) {
      assert.ok(sources.some(s => s.file.startsWith(dir)), `no source under ${dir}: the scan does not see that directory`);
    }
  });

  it('a. INSTANCE_WRITTEN_PROPERTY_KEYS is exported exactly once under server/src', () => {
    const found = exportsOf(sources);
    assert.equal(found.length, 1,
      `the exemption has no single source: ${found.length} export(s) of ${IDENT} under server/src${found.length ? `:\n  ${show(found)}` : ''}. `
      + 'The keys the extractor writes must be one exported constant, per kind, that the validator is handed — not spelled at each site.');
  });

  it('b. no REST or MCP door names the constant, passes it, or re-exports it', () => {
    const passing = doorsPassingTheExemption(sources);
    assert.deepEqual(passing, [], `a door names ${IDENT} — a caller could then reach the exemption:\n  ${show(passing)}`);
    const aliased = aliasesOf(sources);
    assert.deepEqual(aliased, [], `the whole constant is re-exported or aliased under another name, so no gate can follow it:\n  ${show(aliased)}`);
  });

  it('c. only the allowed directories name it', () => {
    const outside = mentionsOutsideAllowedDirs(sources);
    assert.deepEqual(outside, [],
      `${IDENT} is named outside ${ALLOWED_DIRS.map(a => a.dir).join(', ')}:\n  ${show(outside)}\n`
      + ALLOWED_DIRS.map(a => `  ${a.dir}: ${a.reason}`).join('\n'));
  });

  it('d. the parameter it is passed as is derived from the call sites, and no door or body declares that name', () => {
    const { names, unresolved } = argumentNamesPassing(sources);
    assert.deepEqual(unresolved, [], `a use of ${IDENT} could not be read as an argument, so its parameter could not be derived:\n  ${unresolved.join('\n  ')}`);
    assert.ok(names.length >= 1,
      `no call site passes ${IDENT} as an argument, so the exemption reaches no validator (the parameter name cannot be derived)`);
    for (const argName of names) {
      const declared = declarationsOfArgument(sources, argName);
      assert.deepEqual(declared, [], `the exemption's parameter '${argName}' is declared where a caller's body or tool arguments are read:\n  ${show(declared)}`);
    }
  });

  describe('e. the extractor\'s keys are inside the constant, and the constant holds nothing the extractor does not write', () => {
    let constant;
    const load = async () => {
      if (constant) return constant;
      const defs = exportsOf(sources);
      assert.equal(defs.length, 1, `cannot import the compiled constant: ${IDENT} is exported ${defs.length} time(s) (clause a)`);
      const dist = join(REPO_ROOT, compiledPathOf(defs[0].file));
      assert.ok(existsSync(dist), `${compiledPathOf(defs[0].file)} does not exist: run \`npm run build\` in server/`);
      constant = (await import(pathToFileURL(dist).href))[IDENT];
      assert.ok(constant, `${compiledPathOf(defs[0].file)} does not export ${IDENT} (the source declares it)`);
      return constant;
    };

    for (const [kind, keys] of Object.entries(EXTRACTOR_KEYS)) {
      it(`${kind}: ${keys.join(', ')} are in the constant and are still written by the extractor`, async () => {
        const entry = keysOf(kindEntry(await load(), kind));
        for (const key of keys) {
          assert.ok(entry.includes(key), `${IDENT} lacks '${key}' under ${kind} (it holds: ${entry.join(', ') || 'nothing'}): the extractor's own write would be refused in strict`);
          assert.ok(extractorNames(sources, key).length > 0,
            `the extractor's sources no longer name '${key}': this gate's literal table has gone stale, or the extractor stopped writing it`);
        }
      });
    }

    it('every key the constant exempts is one the extractor\'s sources name', async () => {
      const c = await load();
      const held = Object.keys(c).flatMap(kind => keysOf(c[kind]).map(key => ({ kind, key })));
      assert.ok(held.length >= Object.values(EXTRACTOR_KEYS).flat().length, `${IDENT} holds ${held.length} keys, fewer than the extractor writes`);
      const stale = held.filter(h => extractorNames(sources, h.key).length === 0);
      assert.deepEqual(stale, [], `exempted keys the extractor does not name: ${JSON.stringify(stale)}`);
    });
  });
});

/* ───────────────────────────── seen red: the same functions over mutated in-memory trees ───────────────────────────── */

describe('the clauses go red on a mutated tree (in memory; nothing under server/src is edited)', () => {
  const GOOD_DEF = { file: `${SRC}extractor/instance-written.ts`, text: `export const ${IDENT} = { entity: ['aliases'], edge: ['since', 'until'], fact: ['speaker', 'statedOn', 'attributed'] } as const;\n` };
  const VALIDATOR = { file: `${SRC}spaces/schema-validation.ts`, text: 'export function validateEntity(rec: R, schema: S, mode: M, instanceWritten: readonly string[] = []) { return []; }\n' };
  const WRITER = { file: `${SRC}brain/bulk.ts`, text: `import { ${IDENT} } from '../extractor/instance-written.js';\nvalidateEntity(rec, schema, mode, ${IDENT}.entity);\n` };
  const clean = () => [GOOD_DEF, VALIDATOR, WRITER, { file: `${SRC}api/brain/entities.ts`, text: "router.post('/x', (req) => validateEntity(rec, schema, mode));\n" }];

  it('the clean tree has one export, no door, no stray mention, and the parameter is derived positionally as instanceWritten', () => {
    const s = clean();
    assert.equal(exportsOf(s).length, 1);
    assert.deepEqual(doorsPassingTheExemption(s), []);
    assert.deepEqual(mentionsOutsideAllowedDirs(s), []);
    assert.deepEqual(aliasesOf(s), []);
    assert.deepEqual(argumentNamesPassing(s), { names: ['instanceWritten'], unresolved: [] });
    assert.deepEqual(declarationsOfArgument(s, 'instanceWritten'), []);
  });

  it('a. no export, and a second export, are both not exactly one', () => {
    assert.equal(exportsOf(clean().filter(x => x !== GOOD_DEF)).length, 0);
    assert.equal(exportsOf([...clean(), { file: `${SRC}spaces/own-copy.ts`, text: `export const ${IDENT} = { entity: ['aliases'] };\n` }]).length, 2);
    assert.equal(exportsOf([...clean(), { file: `${SRC}spaces/barrel.ts`, text: `export { ${IDENT} } from '../extractor/instance-written.js';\n` }]).length, 2, 'a re-export is a second export');
  });

  it('b. a REST route or an MCP tool that passes the constant, by name or by a renamed import, is reported with its file', () => {
    const rest = { file: `${SRC}api/brain/entities.ts`, text: `import { ${IDENT} } from '../../extractor/instance-written.js';\nvalidateEntity(rec, schema, mode, ${IDENT}.entity);\n` };
    const mcp = { file: `${SRC}mcp/tools/entity.ts`, text: `import { ${IDENT} as keys } from '../../extractor/instance-written.js';\nvalidateEntity(rec, schema, mode, keys.entity);\n` };
    const found = doorsPassingTheExemption([...clean().filter(s => !s.file.startsWith(`${SRC}api/`)), rest, mcp]);
    assert.deepEqual(found.map(f => f.file).sort(), [rest.file, mcp.file].sort());
    assert.ok(aliasesOf([GOOD_DEF, mcp]).some(a => a.file === mcp.file), 'the renamed import is an alias');
  });

  it('b. a mention in a comment is not a pass, and its line number is kept', () => {
    const commented = { file: `${SRC}api/brain/facts.ts`, text: `// never pass ${IDENT} here\n/* nor ${IDENT} */\nconst x = 1;\n` };
    assert.deepEqual(doorsPassingTheExemption([commented]), []);
    const real = { file: `${SRC}api/brain/facts.ts`, text: `// header\n\nconst y = ${IDENT};\n` };
    assert.deepEqual(doorsPassingTheExemption([real]), [{ file: real.file, line: 3 }]);
  });

  it('b. the whole constant bound to another name, or star-re-exported from its module, is an alias; reading a kind of it is not', () => {
    const bound = { file: `${SRC}brain/helper.ts`, text: `export const EXEMPT = ${IDENT};\n` };
    const star = { file: `${SRC}extractor/instance-written.ts`, text: `export * from './more.js';\nexport const ${IDENT} = {};\n` };
    const use = { file: `${SRC}brain/ok.ts`, text: `const own = ${IDENT}[kind];\nconst e = ${IDENT}.entity;\n` };
    assert.equal(aliasesOf([bound]).length, 1);
    assert.equal(aliasesOf([star]).length, 1);
    assert.deepEqual(aliasesOf([use]), []);
  });

  it('c. a mention from sync/, files/, util/ or config/ is outside the allowed directories; extractor/, brain/ and spaces/ are not', () => {
    for (const dir of ['sync', 'files', 'util', 'config', 'auth', 'networks']) {
      const stray = { file: `${SRC}${dir}/x.ts`, text: `use(${IDENT});\n` };
      assert.deepEqual(mentionsOutsideAllowedDirs([stray]).map(m => m.file), [stray.file], dir);
    }
    for (const { dir } of ALLOWED_DIRS) assert.deepEqual(mentionsOutsideAllowedDirs([{ file: `${dir}x.ts`, text: `use(${IDENT});\n` }]), [], dir);
  });

  it('d. the parameter is derived from `name: CONSTANT`, from a positional call, and through a file-local binding', () => {
    const named = { file: `${SRC}brain/a.ts`, text: `validateFact(rec, schema, { onValidation, exempt: ${IDENT}.fact });\n` };
    assert.deepEqual(argumentNamesPassing([named]).names, ['exempt']);
    assert.deepEqual(argumentNamesPassing([VALIDATOR, WRITER]).names, ['instanceWritten']);
    const bound = { file: `${SRC}brain/b.ts`, text: `const own = ${IDENT}[kind];\nclassifyUpdate(a, b, { ownKeys: own });\n` };
    assert.deepEqual(argumentNamesPassing([bound]).names, ['ownKeys']);
  });

  it('d. a call whose parameter cannot be found is reported unresolved, never skipped', () => {
    const lost = { file: `${SRC}brain/c.ts`, text: `somewhereElse(a, b, ${IDENT});\n` };
    const { names, unresolved } = argumentNamesPassing([lost]);
    assert.deepEqual(names, []);
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0], /somewhereElse/);
  });

  it('d. a REST body schema, an MCP inputSchema, a zod body or a body-key table that declares the parameter is reported', () => {
    const rest = { file: `${SRC}api/brain/entities.ts`, text: "const BODY_KEYS = ['id', 'name', 'instanceWritten'];\n" };
    const mcp = { file: `${SRC}mcp/tools/entity.ts`, text: 'inputSchema: { properties: { name: { type: "string" }, instanceWritten: { type: "array" } } }\n' };
    const zodBody = { file: `${SRC}spaces/body-schemas.ts`, text: "import { z } from 'zod';\nexport const B = z.object({ instanceWritten: z.array(z.string()) });\n" };
    const table = { file: `${SRC}brain/bulk.ts`, text: "export const BULK_ITEM_KEYS = ['name', 'instanceWritten'];\n" };
    const found = declarationsOfArgument([rest, mcp, zodBody, table, VALIDATOR, WRITER], 'instanceWritten');
    assert.deepEqual(found.map(f => f.file).sort(), [mcp.file, rest.file, table.file, zodBody.file].sort());
    // The validator's own parameter list is a declaration of the NAME, not a body key: it is not reported.
    assert.ok(!found.some(f => f.file === VALIDATOR.file));
  });

  it('d. a bare word elsewhere (a different variable, a comment) is not a declaration', () => {
    const other = { file: `${SRC}brain/unrelated.ts`, text: '// instanceWritten is documented elsewhere\nconst instanceWrittenCount = 3;\n' };
    assert.deepEqual(declarationsOfArgument([other], 'instanceWritten'), []);
  });

  it('e. the keys of a per-kind entry read the same from an array, a Set and a record; either spelling of a kind is found', () => {
    assert.deepEqual(keysOf(['a', 'b']), ['a', 'b']);
    assert.deepEqual(keysOf(new Set(['a', 'b'])), ['a', 'b']);
    assert.deepEqual(keysOf({ a: 1, b: 2 }), ['a', 'b']);
    assert.deepEqual(keysOf(undefined), []);
    assert.deepEqual(keysOf(kindEntry({ entities: ['aliases'] }, 'entity')), ['aliases']);
    assert.deepEqual(keysOf(kindEntry({ edge: ['since'] }, 'edge')), ['since']);
  });

  it('e. a key the extractor stopped writing is reported as unnamed; a key it still names is found', () => {
    const extractor = [{ file: `${SRC}extractor/conversation/assemble.ts`, text: "// speaker in a comment\nconst o = { statedOn: c.statedOn };\n" }];
    assert.deepEqual(extractorNames(extractor, 'statedOn'), [extractor[0].file]);
    assert.deepEqual(extractorNames(extractor, 'speaker'), [], 'a comment is not a write');
    assert.deepEqual(extractorNames([{ file: `${SRC}brain/x.ts`, text: 'statedOn' }], 'statedOn'), [], 'only the extractor\'s own sources count');
  });

  it('the compiled path is derived from the source path', () => {
    assert.equal(compiledPathOf('server/src/extractor/instance-written.ts'), 'server/dist/extractor/instance-written.js');
  });
});
