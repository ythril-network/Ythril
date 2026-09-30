/**
 * The cache key for a cached validator is EXACTLY what a tool's schema depends on, and that stays true (`Q-114`).
 *
 * `validatorFor(ids)` caches a compiled validator under the reachable space ids. That is only correct while a
 * tool's schema is a pure function of (tool, ids). Three facts keep it so, each a gate below:
 *
 * 1. **Ajv is constructed in ONE place.** An Ajv keeps every schema it has compiled for the life of the
 *    instance, so a second `new Ajv(` anywhere is either an unbounded cache outside the LRU or a second
 *    validation policy that can disagree with the first.
 * 2. **No tool's `inputSchema` builder reads config, env or rights.** If one did, the schema would depend on
 *    something the key does not carry, and the cache would serve one caller another caller's schema.
 * 3. **No tool schema declares `$id`.** Ajv refuses a second compile of a schema with the same `$id` in one
 *    instance, and two reaches sharing an instance would make that a runtime throw instead of a test failure.
 *
 * ## How these are derived, never listed
 *
 * The Ajv constructors are found from the `import` of an `ajv*` specifier in every tracked server source, not
 * by searching for the word `Ajv`: a renamed import (`import { Ajv as A }`) or the 2020 build
 * (`ajv/dist/2020.js`) is the same constructor. The tool files and the tools themselves are read out of the
 * repository and the loaded `ALL_TOOLS`, each with a floor, since an empty set passes every loop.
 *
 * Run: npm run build -w server && node --test testing/standalone/ajv-is-built-in-one-place-and-tool-schemas-read-nothing-else.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom, argumentsOf, bodyOf } from './_structural-window.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');

const VALIDATOR_HOME = 'server/src/mcp/validate-args.ts';

/** Every local name an `ajv*` import binds: default, named (after `as`), and namespace. */
function ajvBindings(src) {
  const names = [];
  const namespaces = [];
  const importRe = /import\s+(?:type\s+)?([^;]*?)\s+from\s+['"](ajv[^'"]*)['"]/g;
  for (const m of src.matchAll(importRe)) {
    const clause = m[1];
    if (/^type\s/.test(m[0].replace(/^import\s+/, ''))) continue; // a type-only import builds nothing
    const ns = clause.match(/\*\s+as\s+(\w+)/);
    if (ns) namespaces.push(ns[1]);
    const def = clause.match(/^(\w+)\s*(?:,|$)/);
    if (def) names.push(def[1]);
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const p = part.trim();
        if (!p || /^type\s/.test(p)) continue;
        const asMatch = p.match(/\bas\s+(\w+)$/);
        names.push(asMatch ? asMatch[1] : p);
      }
    }
  }
  return { names, namespaces };
}

/** Each `new X(` where X is an Ajv constructor bound by an `ajv*` import in this source. */
function ajvConstructions(src) {
  const { names, namespaces } = ajvBindings(src);
  const hits = [];
  for (const n of names) for (const m of src.matchAll(new RegExp(`\\bnew\\s+${n}\\s*\\(`, 'g'))) hits.push(m[0]);
  for (const ns of namespaces) for (const m of src.matchAll(new RegExp(`\\bnew\\s+${ns}\\.\\w+\\s*\\(`, 'g'))) hits.push(m[0]);
  return hits;
}

/**
 * The code of a body with its prose removed. A schema's DESCRIPTIONS say "right", "rights" and "config" in plain
 * English, and what this gate asks is whether the CODE reads them. Template literals keep only their `${...}`
 * expressions, since `${rights}` is code.
 */
function codeOnly(body) {
  return body
    .replace(/`(?:\\.|[^`\\])*`/g, t => [...t.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]).join(' '))
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
}

describe('Ajv is constructed in one place', () => {
  const sources = readTrackedSources('server/src', { floor: 200 }).map(s => ({ file: s.file, text: stripComments(s.text) }));

  it('the scan found the validator module and imports of ajv (floor)', () => {
    const importers = sources.filter(s => ajvBindings(s.text).names.length + ajvBindings(s.text).namespaces.length > 0);
    assert.ok(importers.some(s => s.file === VALIDATOR_HOME), `${VALIDATOR_HOME} no longer imports ajv: re-anchor this gate`);
  });

  it('exactly one `new <ajv import>(` exists in server/src, and it is in validate-args.ts', () => {
    const found = sources.flatMap(s => ajvConstructions(s.text).map(hit => ({ file: s.file, hit })));
    assert.ok(found.length >= 1, 'no Ajv construction found at all: the gate is broken, not the code');
    assert.deepEqual(found.map(f => f.file), [VALIDATOR_HOME],
      `Ajv is constructed outside ${VALIDATOR_HOME} (or more than once): ${JSON.stringify(found)}`);
  });
});

describe('a tool schema is a function of the ids and nothing else', () => {
  const toolFiles = readTrackedSources('server/src/mcp/tools', { floor: 15, specs: false })
    .map(s => ({ file: s.file, text: stripComments(s.text) }));

  /** The expression text of one `inputSchema:` property value, following a named reference to its body. */
  function schemaBodies(file, text) {
    const bodies = [];
    for (const m of text.matchAll(/\binputSchema\s*:\s*/g)) {
      const at = m.index + m[0].length;
      const rest = text.slice(at);
      const ident = rest.match(/^([A-Za-z_$][\w$]*)\s*[,}]/);
      if (ident) { bodies.push({ file, name: ident[1], body: bodyOf(text, ident[1], `${file} inputSchema -> ${ident[1]}`) }); continue; }
      const arrow = text.indexOf('=>', at);
      assert.ok(arrow > -1, `${file}: an inputSchema that is neither a reference nor an arrow function at ${at}`);
      bodies.push({ file, name: '(inline)', body: balancedFrom(text, arrow, `${file} inputSchema`) });
    }
    return bodies;
  }

  it('the scan found the tool files and their schema builders (floor)', () => {
    const all = toolFiles.flatMap(f => schemaBodies(f.file, f.text));
    assert.ok(all.length >= ALL_TOOLS.length - 5,
      `found ${all.length} inputSchema builders for ${ALL_TOOLS.length} loaded tools: the extraction misses tools`);
    for (const b of all) assert.ok(b.body.length > 20, `${b.file} ${b.name}: an empty body proves nothing`);
  });

  it('no inputSchema builder reads getConfig, process.env or a token\'s rights', () => {
    const offenders = [];
    for (const f of toolFiles) {
      for (const b of schemaBodies(f.file, f.text)) {
        const m = codeOnly(b.body).match(/\bgetConfig\b|\bgetMediaEmbeddingConfig\b|\bgetDocumentProcessingConfig\b|process\.env|\brights?\b|\bRights\b/);
        if (m) offenders.push(`${f.file} ${b.name}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], 'a schema that reads these depends on something the validator cache key does not carry');
  });

  it('no tool schema declares $id', () => {
    const schemas = toolSchemasFor(['alpha', 'beta']);
    assert.ok(ALL_TOOLS.length >= 40, `only ${ALL_TOOLS.length} tools loaded`);
    let nodes = 0;
    const found = [];
    const walk = (v, path, inPropertyMap) => {
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, false)); return; }
      if (!v || typeof v !== 'object') return;
      nodes++;
      for (const [k, child] of Object.entries(v)) {
        // a key of a `properties` map is a property NAME, even when it is spelled "$id"
        if (!inPropertyMap && k === '$id') found.push(`${path}.$id`);
        walk(child, `${path}.${k}`, !inPropertyMap && k === 'properties');
      }
    };
    for (const t of ALL_TOOLS) walk(t.inputSchema(schemas), t.name, false);
    assert.ok(nodes > ALL_TOOLS.length * 5, `walked ${nodes} schema nodes: the walk is not reaching the schemas`);
    assert.deepEqual(found, []);
  });
});
