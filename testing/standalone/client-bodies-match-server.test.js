/**
 * Every body key the CLIENT sends to a strict brain read route is a key the SERVER allows.
 *
 * ## Why this gate exists
 *
 * `/query`, `/recall`, `/traverse` and `/find-similar` were made strict because a silently dropped key
 * produces a *wrong answer with a 200* — the fleet integrator sent `skip`, got page one, and it cost them a fabricated
 * number. Strictness fixed the lying, but it moved the failure: a client key that is not in the server's
 * allowed set is now a **400 in the UI**, and nothing checked that our own client stays inside those sets.
 *
 * Two copies of one rule, and only one of them was enforced. The client's body types were verified BY HAND
 * on 2026-08-13 and were correct — which is exactly when to write the gate, because a hand-check does not
 * survive the next edit to either side.
 *
 * ## Direction: client ⊆ server, never the reverse
 *
 * The server may allow more than the client sends (`skip`, `sort` and `dir` exist for API callers and no UI
 * asks for them yet). A key the client sends and the server refuses is the defect.
 *
 * ## It reads the shipped call sites, not a list of files
 *
 * The routes are discovered by sweeping every tracked client source file for a `POST` to one of the four,
 * so a component that posts directly instead of going through `BrainApi` is covered the day it is written.
 * A hand-maintained file list would have shared the blind spot with the code it audits.
 *
 * Run: node --test testing/standalone/client-bodies-match-server.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const {
  QUERY_BODY_FIELDS, TRAVERSE_BODY_FIELDS, FIND_SIMILAR_BODY_FIELDS,
} = await import('../../server/dist/brain/query.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

/** A tool's published parameter names — the contract for any route that delegates to it. */
const toolParams = name => new Set(
  Object.keys(ALL_TOOLS.find(t => t.name === name).inputSchema({ requiredSpace: {}, optionalSpace: {} }).properties));

/**
 * The four strict routes, each pointing at the set the route actually gates on.
 *
 * **`recall` points somewhere different from the other three, and that is the whole reason this comment is
 * here.** `POST /api/brain/recall` no longer keeps a body-key list: it hands its body to `callTool`, which
 * validates against the `recall` tool's published `inputSchema`. So the client is checked against the
 * schema, and `RECALL_BODY_FIELDS` was deleted rather than left pointing at nothing — a list that gates no
 * request still reads like the contract to whoever finds it next, and the client would have been compared
 * against a set the server had stopped enforcing.
 */
const SETS = new Map([
  ['filter', QUERY_BODY_FIELDS],
  ['recall', toolParams('recall')],
  ['traverse', TRAVERSE_BODY_FIELDS],
  ['similar', FIND_SIMILAR_BODY_FIELDS],
]);

/** Comments are stripped: a doc comment inside a body type literal names keys it does not declare. */
const strip = s => s.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const clientSources = () =>
  trackedSources('client/src')
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

/** From the `{` at `open`, the matching `}` — inclusive of both braces. */
function literalAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** The keys declared at the literal's TOP level. Nested literals raise the depth and are skipped. */
function topLevelKeys(literal) {
  const keys = [];
  let depth = 0;
  let word = '';
  for (const c of literal) {
    if (c === '{' || c === '[' || c === '(' || c === '<') { depth++; word = ''; continue; }
    if (c === '}' || c === ']' || c === ')' || c === '>') { depth--; word = ''; continue; }
    if (depth !== 1) continue;
    if (/[A-Za-z0-9_$]/.test(c)) word += c;
    else if (c === '?') continue;                  // an optional key keeps its name
    else if (c === ':') { if (word) keys.push(word); word = ''; }
    else word = '';
  }
  return keys;
}

/**
 * Every `POST` to a strict brain route in the tracked client sources, with the body keys it sends.
 *
 * The second argument is either an inline object (keys read from it) or a parameter named `body`, whose type
 * is the nearest `body:` declaration above the call — one per method, so nearest is its own.
 *
 * That type is an inline literal, or a NAMED interface declared in the same file. Named is now the case for
 * `/recall`: `U-1` needed the same type for the request-preview panel, and a preview typed as a loose record
 * would compile with a key the strict route refuses — a 400 for whoever pasted the JSON. So the type had to
 * be shared, and this gate resolves the name rather than demanding an inline literal it can parse more
 * easily. Refusing the named form would have been a gate dictating a worse design.
 */
function clientPosts() {
  const found = [];
  for (const file of clientSources()) {
    const src = strip(readFileSync(file, 'utf8'));
    // TWO shapes, because 5.0 moved the search family off the space path: the older
    // `/api/brain/spaces/${id}/<route>` template, and the body-scoped `'/api/brain/<route>'` plain string
    // where the space rides in the body. A regex that knew only the first reported “no client POST found”
    // for a route the client calls on every search — an extractor defect that reads as a missing caller.
    const call = /\.post\s*<[^(;]*?>\s*\(\s*(?:`\/api\/brain\/spaces\/\$\{[^}]+\}\/([a-z-]+)`|'\/api\/brain\/([a-z-]+)')\s*,\s*/g;
    for (let m = call.exec(src); m; m = call.exec(src)) {
      const route = m[1] ?? m[2];
      if (!SETS.has(route)) continue;
      const argAt = m.index + m[0].length;
      if (src[argAt] === '{') {
        found.push({ file, route, keys: topLevelKeys(literalAt(src, argAt)), how: 'inline object' });
        continue;
      }
      const declared = src.lastIndexOf('body:', m.index);
      assert.ok(declared > 0, `${file}: POST /${route} sends something this gate cannot read — pass an inline
        object or a parameter named \`body\` with an inline type literal.`);
      const brace = src.indexOf('{', declared);
      let literal = brace > -1 && brace < declared + 8 ? literalAt(src, brace) : null;
      if (!literal) {
        // A named type: `body: RecallRequestBody,`. Resolve it in the same FILE — deliberately not across
        // files, because a gate that followed imports would be reading a type it cannot prove is the one the
        // route takes, and "somewhere in the repo there is an interface with these keys" is not the claim.
        // ANCHORED, with no character count: the regex is the bound. `slice(declared, declared + 80)` was
        // the obvious way to write this and `gates-bound-their-subject-structurally` refuses it — a window
        // that can fall short of its subject is a gate that can pass while checking less than it means to.
        const named = /^body:\s*([A-Z]\w*)\s*[,)]/.exec(src.slice(declared));
        if (named) {
          const decl = src.indexOf(`interface ${named[1]} {`);
          if (decl > -1) literal = literalAt(src, src.indexOf('{', decl));
        }
      }
      assert.ok(literal, `${file}: the \`body\` for POST /${route} is neither an inline type literal nor a
        named interface declared in this file, so its keys cannot be compared with the server's allowed set.`);
      assert.doesNotMatch(literal, /\[\s*\w+\s*:\s*string\s*\]\s*:/,
        `${file}: the \`body\` for POST /${route} has an index signature, which admits any key and makes this
        gate vacuous.`);
      found.push({ file, route, keys: topLevelKeys(literal), how: 'body parameter' });
    }
  }
  return found;
}

describe('the sweep itself found the call sites', () => {
  // Every extraction happens INSIDE an `it`. Called at collection time, a body this gate cannot read throws
  // before any test is registered, and `node --test` then reports zero tests — which reads like nothing was
  // wrong rather than like a failure.
  it('finds the three strict read routes the client actually calls', () => {
    const posts = clientPosts();
    // Asserted by IDENTITY, not by count: a regex that silently stops matching would otherwise report
    // "no client key is wrong" while having looked at nothing.
    const routes = new Set(posts.map(p => p.route));
    for (const route of ['filter', 'recall', 'traverse']) {
      assert.ok(routes.has(route), `no client POST to /${route} was found — the extractor is broken, or the
        call moved. This gate is worthless until it can see them.`);
    }
  });

  it('reads real keys out of every site it found', () => {
    for (const p of clientPosts()) {
      assert.ok(p.keys.length > 0, `${p.file}: POST /${p.route} parsed to zero body keys (${p.how})`);
    }
  });
});

/** The MCP tool that is the same capability as each REST route. `similar` is `similar` there. */
const MCP_TOOL = new Map([
  ['filter', 'filter'], ['recall', 'recall'], ['traverse', 'graph_traverse'], ['similar', 'similar'],
]);

/** What the router passes to every `inputSchema`. The `space` enum is token-scoped, so a stub is faithful. */
const SCHEMA_STUB = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };

/** `space` is transport, not a query parameter: REST carries it in the path. */
const TRANSPORT_ONLY = new Set(['space']);

describe('MCP advertises the same parameters the REST route accepts', () => {
  // The owner's standing rule is that the two doors take the same params, and `mcp-rest-parity` checks which
  // TOOLS exist, not which parameters they take. This half was unenforced, and it was hiding a real gap:
  // `similar` advertised `traverse` and `includeFileContent` — implemented in its handler — while the REST
  // route read neither, so a caller who read the tool schema got a 400 from the other door.
  for (const [route, tool] of MCP_TOOL) {
    it(`${route} ↔ ${tool}`, () => {
      const t = ALL_TOOLS.find(x => x.name === tool);
      assert.ok(t, `no MCP tool named ${tool}`);

      // `inputSchema` is a FUNCTION of the token-scoped schemas, not a literal. Reading it as an object gives
      // `properties: undefined`, which silently reports every REST field as missing from MCP — the first
      // version of this measurement did exactly that and concluded the opposite of the truth. So the
      // materialised schema is asserted to be a real object with real properties before anything is compared.
      assert.equal(typeof t.inputSchema, 'function', 'inputSchema must be materialised, not read as a literal');
      const props = Object.keys(t.inputSchema(SCHEMA_STUB).properties ?? {});
      assert.ok(props.length > 0, `${tool}'s materialised schema has no properties — the comparison below would
        pass or fail for a reason that has nothing to do with parity`);

      const allowed = SETS.get(route);
      const mcpOnly = props.filter(p => !allowed.has(p) && !TRANSPORT_ONLY.has(p));
      assert.deepEqual(mcpOnly, [], `${tool} advertises ${mcpOnly.join(', ')}, which POST /${route} answers 400
        for. A caller who reads the tool schema and switches door gets a refusal for a documented parameter.`);

      const restOnly = [...allowed].filter(p => !props.includes(p));
      assert.deepEqual(restOnly, [], `POST /${route} accepts ${restOnly.join(', ')} and ${tool} does not offer
        it. One API, two doors — a parameter reachable from only one of them is the gap this rule exists for.`);
    });
  }
});

describe('the integration guide lists exactly what each route accepts', () => {
  // The guide calls this table the authoritative list, and a schema description or a reference table is
  // treated as code here. It had drifted twice: `/query` gained `sort` and `dir` while the table still said
  // "there is no sort on /query", and `/find-similar` gained nothing while MCP had two extra parameters.
  const DOC = 'docs/integration-guide/04d-brain-ops-api.md';
  const rowFor = (route, src) =>
    src.split('\n').find(l => l.startsWith(`| \`POST /${route}\` |`));

  for (const [route, allowed] of SETS) {
    it(`${route} row`, () => {
      const src = readFileSync(DOC, 'utf8');
      const row = rowFor(route, src);
      assert.ok(row, `${DOC} has no accepted-fields row for POST /${route}`);
      const documented = new Set([...row.matchAll(/`([A-Za-z][\w]*)`/g)].map(m => m[1]).filter(k => k !== 'POST'));
      const undocumented = [...allowed].filter(k => !documented.has(k));
      assert.deepEqual(undocumented, [], `POST /${route} accepts ${undocumented.join(', ')} and the table does
        not list them. An integrator reading the guide cannot know the parameter exists.`);
      const overdocumented = [...documented].filter(k => !allowed.has(k));
      assert.deepEqual(overdocumented, [], `the table lists ${overdocumented.join(', ')} for POST /${route},
        which the route answers 400 for. Documenting a refused parameter is worse than omitting it.`);
    });
  }
});

describe('every key the client sends is a key the server allows', () => {
  // The loop is over the four ROUTES, which are static, so each gets a named test whether or not the client
  // calls it today. `similar` has no UI caller yet; the day one is added it is already covered.
  for (const [route, allowed] of SETS) {
    it(route, () => {
      const sites = clientPosts().filter(p => p.route === route);
      for (const p of sites) {
        const rejected = p.keys.filter(k => !allowed.has(k));
        assert.deepEqual(rejected, [], `${p.file} sends keys /${route} answers 400 unrecognized_keys for: `
          + `${rejected.join(', ')}. Either the server's allowed set is missing them, or the client is `
          + 'sending a parameter the route never read.');
      }
    });
  }
});
