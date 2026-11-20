/**
 * No file of the stack suites makes a heavy call with the suite's shared token.
 *
 * ## The defect, and the failure that bought this
 *
 * The heavy-call limit is five a minute PER TOKEN, counted across every door that shares it (`server/src/rate-limit/heavy-tool.ts`): the
 * stored-data schema check, the conversion start, ingest, the file stamp report and the tools declared `heavy`. The files of one job all read
 * the same setup token, so whether a file is refused depends on which files ran in the minute before it. Main run 44736302108 was red on
 * `schema-validation.test.js`: `ingest-writes-a-conversation` had paid three slots at 12:37:05 and `one-call-two-doors` two more at 12:37:28,
 * all on the one token, so the sixth call (the schema check at 12:38:03) was a 429. The product was right; the files shared a budget.
 *
 * ## The rule
 *
 * Every file of `testing/integration`, `testing/sync`, `testing/red-team-tests` and every `@needs-instance` standalone file that names a heavy
 * door takes the token that call is made with from `ownTokens()` (`_shared/own-token.mjs`): minted for that file or case, removed after.
 * The doors are DERIVED from the product (`_heavy-doors.mjs`: whatever reaches a payer of the limiter), the bearer is found by following
 * the value (`_token-flow.mjs`: forwarding from a `token.txt` read, not "an identifier near the call").
 *
 * ## Proof it can fail
 *
 * Planted copies below: a call made with a token read from `token.txt`, through a wrapper function, through a session, through a
 * parameter, through a function that returns it, through an imported reader and through a deciding body key are each reported; the same
 * calls with an `ownTokens()` token, and a token minted by a call that merely USED the shared one as authority, are not. And the derivation
 * has to find the doors the product names in its own refusal sentences, so a derivation that finds nothing fails instead of clearing every file.
 *
 * Run: node --test testing/standalone/a-heavy-call-in-a-stack-test-spends-its-own-tokens-budget.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { readTrackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { splitStandalone } from '../_shared/standalone-split.mjs';
import { heavyDoors, doorSitesIn } from './_heavy-doors.mjs';
import { tokenFlow, OWN_TOKEN_MODULE } from './_token-flow.mjs';
import { ts, parseSource, lineOf, walkEveryNode, unwrapExpression } from '../_shared/syntax-tree.mjs';

const doors = heavyDoors(readTrackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], floor: 300 }));

const stackFiles = () => [
  ...readTrackedSources(['testing/integration', 'testing/sync', 'testing/red-team-tests'], { ext: ['.js', '.mjs'], floor: 150 }),
  ...splitStandalone().needsInstance.map(f => ({ file: `testing/standalone/${f}`, text: readFileSync(path.join(REPO_ROOT, 'testing/standalone', f), 'utf8') })),
];

/** `file:line door (shared token via name)` for every heavy-door site whose call reaches the shared token. */
function findings(files, readModule) {
  const flow = tokenFlow(files, readModule);
  const out = [];
  for (const { file, text } of files) {
    for (const site of doorSitesIn(file, text, doors)) {
      const hit = flow.sharedTokenAt(file, text, site.node);
      if (hit) out.push(`${file}:${site.line} ${site.door} (shared token via ${hit.name})`);
    }
  }
  return out;
}

const planted = (files) => {
  const byName = new Map(files.map(f => [f.file, f.text]));
  return findings(files, (f) => byName.get(f) ?? (f === OWN_TOKEN_MODULE ? readFileSync(path.join(REPO_ROOT, f), 'utf8') : null));
};
const READ = `const T = fs.readFileSync(path.join(C, 'a', 'token.txt'), 'utf8').trim();`;
const VALIDATE = (bearer) => `/* ${bearer} */ post(A, ${bearer}, \`/api/spaces/\${S}/validate-schema\`, {});`;

describe('the derivation finds the doors the product prices', () => {
  it('names the tools whose refusals say "rate limited"', () => {
    for (const tool of ['delete_space_data', 'view_purge_retired', 'ingest', 'file_stamp_report', 'schema_validate', 'space_schema_convert']) {
      assert.ok(doors.tools.includes(tool), `${tool} is priced on the heavy-call rail and was not derived: ${JSON.stringify(doors.tools)}`);
    }
  });
  it('names the routes and the body key', () => {
    const tails = new Set(doors.routes.map(r => r.tail));
    for (const tail of ['/ingest', '/file-stamp-report', '/validate-schema', '/schema-convert']) assert.ok(tails.has(tail), `route tail ${tail} not derived: ${JSON.stringify([...tails])}`);
    assert.ok(doors.bodyKeys.includes('convertRecords'), `the body key that prices a save was not derived: ${JSON.stringify(doors.bodyKeys)}`);
    assert.deepEqual(doors.unrecognised, [], 'a priced route has no static tail and no deciding body key: no test text can name it');
  });
});

describe('a planted heavy call with the shared token is found, the same call with its own token is not', () => {
  const file = 'testing/integration/planted.test.js';
  const own = `import { ownTokens } from '../_shared/own-token.mjs';\nconst own = ownTokens();\nlet T;\nbefore(async () => { T = await own.mint('x'); });`;
  const cases = [
    ['a token read from token.txt', `${READ}\n${VALIDATE('T')}`, `${own}\n${VALIDATE('T')}`],
    ['a wrapper function that writes the bearer', `let TA; before(() => { TA = fs.readFileSync(p('token.txt')); });\nasync function via(tool, a) { return fetch(\`\${B}/api/\${tool}\`, { headers: { Authorization: \`Bearer \${TA}\` } }); }\nit('x', () => via('delete_space_data', {}));`,
      `${own}\nasync function via(tool, a) { return fetch(\`\${B}/api/\${tool}\`, { headers: { Authorization: \`Bearer \${T}\` } }); }\nit('x', () => via('delete_space_data', {}));`],
    ['a session opened with it', `${READ}\nconst mcp = await openMcpSession(T);\nawait mcp.callTool('ingest', {});`, `${own}\nconst mcp = await openMcpSession(T);\nawait mcp.callTool('ingest', {});`],
    ['a function that returns it', `let TA; before(() => { TA = fs.readFileSync(p('token.txt')); });\nfunction token() { return TA; }\npost(A, token(), '/api/delete_space_data', {});`,
      `${own}\nfunction token() { return T; }\npost(A, token(), '/api/delete_space_data', {});`],
    ['a parameter its caller fills', `${READ}\nconst go = (tk) => post(A, tk, '/api/brain/spaces/x/ingest', {});\ngo(T);`, `${own}\nconst go = (tk) => post(A, tk, '/api/brain/spaces/x/ingest', {});\ngo(T);`],
    ['a token read through a path constant', `const F = path.join(C, 'c', 'token.txt');\nlet T;\nbefore(() => { T = fs.readFileSync(F, 'utf8').trim(); });\n${VALIDATE('T')}`, `${own}\nconst F = path.join(C, 'c', 'token.txt');\n${VALIDATE('T')}`],
    ['a body key that prices the save', `${READ}\npatch(A, T, '/api/spaces/x', { meta: {}, convertRecords: { steps: [] } });`, `${own}\npatch(A, T, '/api/spaces/x', { meta: {}, convertRecords: { steps: [] } });`],
    ['a token minted by a call that used the shared one as authority', `${READ}\nasync function mint() { return (await post(A, T, '/api/tokens', {})).body; }\nconst tok = await mint();\n${VALIDATE('tok.plaintext')}`, null],
  ];
  for (const [what, bad, good] of cases) {
    if (good !== null) {
      it(`reported: ${what}`, () => {
        const hits = planted([{ file, text: bad }]);
        assert.ok(hits.length >= 1, `not reported: ${what}\n${bad}`);
      });
      it(`not reported with its own token: ${what}`, () => assert.deepEqual(planted([{ file, text: good }]), [], what));
    } else {
      it(`not reported: ${what}`, () => assert.deepEqual(planted([{ file, text: bad }]), [], what));
    }
  }
  it('reported: a token reader imported from a helper', () => {
    const helper = { file: 'testing/sync/_pair.mjs', text: `export const tokenOf = (x) => fs.readFileSync(path.join(C, x, 'token.txt'), 'utf8').trim();` };
    const test = { file: 'testing/sync/planted.test.js', text: `import { tokenOf } from './_pair.mjs';\nconst tA = tokenOf('a');\npatch(A, tA, '/api/spaces/x', { convertRecords: {} });` };
    assert.ok(planted([helper, test]).length >= 1);
  });
});

/**
 * Where `ownTokens()` stands among the hooks of its block (the file, or the `describe` callback it is called in). A root `before` runs the
 * moment it is registered, so `const own = ownTokens()` below it is uninitialised when the hook reads it (Full run 44753447026: 87 cancelled
 * cases in two shards); and a plain `after` registered with it would run in registration order, before or after the token's removal. So: the
 * call comes before the first `before(` of its block, and the block has no plain `after(` (a cleanup that uses the token is `own.after(fn)`).
 */
function ownTokenPlacement(file, text) {
  const sf = parseSource(file, text);
  const problems = [];
  const hookName = (st) => (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && ts.isIdentifier(st.expression.expression)
    ? st.expression.expression.text : null);
  const isOwnCall = (st) => ts.isVariableStatement(st) && st.declarationList.declarations.some(d => d.initializer
    && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === 'ownTokens');
  // The names a `.mint(...)` result is put in: a plain `after` that reads one of them runs on a token another hook may already have removed.
  const minted = new Set();
  const mintCall = (e) => e && ts.isCallExpression(unwrapExpression(e)) && ts.isPropertyAccessExpression(unwrapExpression(e).expression) && unwrapExpression(e).expression.name.text === 'mint';
  walkEveryNode(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && mintCall(n.initializer)) minted.add(n.name.text);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && mintCall(n.right)) minted.add(n.left.text);
  });
  const usesMinted = (st) => { let hit = false; walkEveryNode(st, (n) => { if (ts.isIdentifier(n) && minted.has(n.text)) hit = true; }); return hit; };
  const blocks = [sf];
  walkEveryNode(sf, (n) => { if (ts.isBlock(n) && isFnBody(n)) blocks.push(n); });
  for (const block of blocks) {
    const statements = block.statements;
    const at = statements.findIndex(isOwnCall);
    if (at < 0) continue;
    statements.forEach((st, i) => {
      const hook = hookName(st);
      if (hook === 'before' && i < at) problems.push(`${file}:${lineOf(sf, st)} a before(...) is registered above ownTokens(): it runs at once and reads an uninitialised const`);
      if (hook === 'after' && usesMinted(st)) problems.push(`${file}:${lineOf(sf, st)} a plain after(...) beside ownTokens() that uses a minted token: use own.after(fn) so it runs before the token is removed`);
    });
  }
  return problems;
}
const isFnBody = (n) => n.parent && ts.isFunctionLike(n.parent);

describe('ownTokens() is placed so its hooks run in an order that works', () => {
  const ok = `import { ownTokens } from '../_shared/own-token.mjs';\nconst own = ownTokens();\nbefore(async () => { T = await own.mint('x'); });\nown.after(async () => {});`;
  it('reports a before registered above ownTokens()', () => {
    const bad = `before(async () => { T = await own.mint('x'); });\nconst own = ownTokens();`;
    assert.equal(ownTokenPlacement('testing/integration/p.test.js', bad).length, 1);
  });
  it('reports a plain after beside ownTokens()', () => {
    assert.equal(ownTokenPlacement('testing/integration/p.test.js', `${ok}\nafter(async () => { await del(A, T, '/x'); });`).length, 1);
    assert.deepEqual(ownTokenPlacement('testing/integration/p.test.js', `${ok}\nafter(async () => { await del(A, shared, '/x'); });`), [], 'an after that uses a token it did not mint is not ordered by the helper');
  });
  it('reports a misplaced call inside a describe too', () => {
    const bad = `describe('d', () => {\n  before(async () => { T = await own.mint('x'); });\n  const own = ownTokens();\n});`;
    assert.equal(ownTokenPlacement('testing/integration/p.test.js', bad).length, 1);
  });
  it('accepts the order the helper documents', () => assert.deepEqual(ownTokenPlacement('testing/integration/p.test.js', ok), []));
  it('holds for every stack-suite file that calls it', () => {
    const files = stackFiles().filter(f => f.text.includes('ownTokens('));
    assert.ok(files.length >= 10, `${files.length} files call ownTokens(); the scan is broken`);
    assert.deepEqual(files.flatMap(f => ownTokenPlacement(f.file, f.text)), []);
  });
});

describe('every stack-suite file that names a heavy door pays from a token of its own', () => {
  it('no heavy call is made with the shared token', () => {
    const files = stackFiles();
    const byName = new Map(files.map(f => [f.file, f.text]));
    const read = (f) => byName.get(f) ?? (existsSync(path.join(REPO_ROOT, f)) ? readFileSync(path.join(REPO_ROOT, f), 'utf8') : null);
    const found = findings(files, read);
    assert.deepEqual(found, [], `${found.length} heavy call(s) made with the suite's shared token; take the token from ownTokens() (testing/_shared/own-token.mjs):\n${found.join('\n')}`);
  });
});
