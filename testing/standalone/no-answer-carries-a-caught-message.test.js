/**
 * No answer carries a caught message: what a caller reads about a failure is built from what the failure IS (Q-458, Q-541).
 *
 * ## The defect
 *
 * A `catch` that answers `{ error: err.message }`, `String(err)` or `${err}` hands the caller whatever the thrower wrote. For our
 * own refusal classes that is our sentence. For anything else it is the runtime's: a file-system error's message names the
 * server's absolute data path, a socket error names an internal host and port, a library error says what the library thought.
 * The sites that did it (`api/files.ts` read, move, delete; the upload door; `reembed.ts`; the join's 502) each looked reasonable
 * alone, and nothing said what may reach an answer.
 *
 * ## The rule
 *
 * Every answer body or tool text built inside a `catch` (or a `.catch(...)` callback) from the caught value — `.message`,
 * `String(x)`, `${x}`, `'...' + x`, or a local built from one of those — is allowed only where a preceding `instanceof` narrows
 * the caught value to one of OUR refusal classes. The set is DERIVED from `server/src`: every class extending `Error` or
 * `RangeError` (or one of ours) whose constructor does not build its message from another error's `.message` or `String(...)`.
 * A bare `RangeError` is NOT one of ours (the runtime throws it too): only `RequestRefusal`, which stands on it, and what extends
 * `Error` or one of ours. `StoredFileUnreadable` is out by that derivation (its message repeats its cause's).
 *
 * An answer is: the argument of `res.json(...)` / `res.send(...)`, the `text` of a `{ type: 'text', text }` tool content, the
 * fallback body handed to `sendCaughtFailure`, and the argument of `new X(...)` for every class `answerThrown` answers with its
 * message (derived from `mcp/call-tool.ts`, so a class that joins that list is held here too).
 *
 * Exempt, by derivation and nothing else: a route mounted with `requireAdmin` (on the route or on its router), whose operator acts
 * on the exception's text. `requireAdminMfaScoped` is NOT that guard — it admits space-restricted administrators — so a
 * space-admin route (`spaces-reembed.ts`, `spaces.ts` rebuild-indexes, `spaces-activity.ts`, `spaces-file-stamp-report.ts`) is held.
 *
 * Scoped to file-system and other caught errors: a driver's text is held by `no-door-answers-with-the-drivers-text`.
 *
 * And the upload door's own half (Q-541): no catch on it chooses a `400` by `instanceof RangeError`, because the runtime throws
 * `RangeError` too, and a sync sender reads `400` as refused about the bytes.
 *
 * Red against da4cafd8: the day-one sites (`api/files.ts`, `api/files-upload.ts`, `api/reembed.ts`, the join's 502) and the
 * upload door's four `instanceof RangeError` 400s.
 *
 * Run: node --test testing/standalone/no-answer-carries-a-caught-message.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ts, parseSource, lineOf, unwrapExpression, walkEveryNode } from '../_shared/syntax-tree.mjs';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';

const CALL_TOOL = 'server/src/mcp/call-tool.ts';
const UPLOAD_DOOR = 'server/src/api/files-upload.ts';

// ── Derivations ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether `expr` builds text from another error: `x.message` or `String(x)` of anything. */
const buildsFromAnotherMessage = (expr) => {
  let found = false;
  walkEveryNode(expr, (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'message') found = true;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String') found = true;
  });
  return found;
};

/**
 * Our refusal classes: every class in `sources` extending `Error`, `RangeError` or another of ours whose constructor's `super(...)`
 * does not build its message from another error. A class with no constructor passes its caller's message through, and the caller is
 * our code. A class extending `RangeError` is ours only when it is `RequestRefusal`; `RangeError` itself never is.
 */
const REFUSAL_ROOT = 'RequestRefusal';
export function refusalClassesOf(sources) {
  const classes = new Map();
  for (const { file, text } of sources) {
    const sf = parseSource(file, text);
    walkEveryNode(sf, (n) => {
      if (!ts.isClassDeclaration(n) || !n.name) return;
      const ext = n.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
      if (!ext || !ts.isIdentifier(ext)) return;
      const ctor = n.members.find(ts.isConstructorDeclaration);
      let wraps = false;
      if (ctor?.body) {
        walkEveryNode(ctor.body, (c) => {
          if (ts.isCallExpression(c) && c.expression.kind === ts.SyntaxKind.SuperKeyword && c.arguments[0] && buildsFromAnotherMessage(c.arguments[0])) wraps = true;
        });
      }
      classes.set(n.name.text, { base: ext.text, wraps, file });
    });
  }
  // `RangeError` itself is NOT seeded: the runtime throws it too (an invalid array length, a bad `toFixed` digit), so a catch that
  // narrows to it answers a fault in the thrower's words. Our refusals are the typed classes below it (`RequestRefusal` and the rest).
  const ours = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, c] of classes) {
      if (ours.has(name) || c.wraps) continue;
      // The one class allowed to stand on `RangeError` is the refusal root (`util/errors.ts`), so a class that extends the runtime's
      // own `RangeError` any other way is not ours.
      if (c.base === 'Error' || ours.has(c.base) || (c.base === 'RangeError' && name === REFUSAL_ROOT)) { ours.add(name); grew = true; }
    }
  }
  return ours;
}

/** The classes `answerThrown` answers with their own message (`Error: ${message}`): a `new X(caught.message)` anywhere reaches a caller. */
export function classesAnsweredByMessage(callToolText) {
  const sf = parseSource(CALL_TOOL, callToolText);
  let fn;
  walkEveryNode(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === 'answerThrown') fn = n; });
  assert.ok(fn, `${CALL_TOOL} no longer declares answerThrown — re-anchor this gate`);
  const out = new Set();
  walkEveryNode(fn, (n) => {
    if (!ts.isIfStatement(n)) return;
    const cond = unwrapExpression(n.expression);
    if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword || !ts.isIdentifier(cond.right)) return;
    let echoes = false;
    walkEveryNode(n.thenStatement, (t) => {
      if (ts.isTemplateSpan(t) && ts.isIdentifier(t.expression) && t.expression.text === 'message') echoes = true;
    });
    if (echoes) out.add(cond.right.text);
  });
  return out;
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);
const MIDDLEWARE = 'server/src/auth/middleware.ts';

/**
 * The guards that admit an INSTANCE administrator and nobody else, derived from what `auth/middleware.ts` exports: every
 * `requireAdmin*` that names neither a space administrator (`...SpaceAdmin...`) nor a scope (`...Scoped`), which admit
 * space-restricted administrators too.
 */
export function instanceAdminGuards(middlewareText) {
  const sf = parseSource(MIDDLEWARE, middlewareText);
  const out = new Set();
  walkEveryNode(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      && /^requireAdmin/.test(n.name.text) && !/SpaceAdmin|Scoped/.test(n.name.text)) out.add(n.name.text);
  });
  return out;
}
let ADMIN_GUARDS = new Set(['requireAdmin']);
const isAdminGuard = (a) => ts.isIdentifier(a) && ADMIN_GUARDS.has(a.text);

/** The routers a file guards whole with `requireAdmin` (`xRouter.use(..., requireAdmin, ...)`). */
function adminOnlyRouters(sf) {
  const out = new Set();
  walkEveryNode(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'use'
      && ts.isIdentifier(n.expression.expression) && n.arguments.some(isAdminGuard)) {
      out.add(n.expression.expression.text);
    }
  });
  return out;
}

/** The route registration `node` sits in, as `{ router, method, path, admin }`, or null. */
function routeOf(node, adminRouters) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ROUTE_METHODS.has(n.expression.name.text)
      && ts.isIdentifier(n.expression.expression) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const router = n.expression.expression.text;
      const admin = adminRouters.has(router) || n.arguments.some(isAdminGuard);
      return { router, method: n.expression.name.text, path: n.arguments[0].text, admin };
    }
  }
  return null;
}

// ── The subject ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether `expr` carries the caught value named in `names`. */
function carries(expr, names) {
  let found = false;
  const isCaught = (e) => { const u = unwrapExpression(e); return u && ts.isIdentifier(u) && names.has(u.text); };
  walkEveryNode(expr, (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'message' && isCaught(n.expression)) found = true;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String' && n.arguments[0] && isCaught(n.arguments[0])) found = true;
    if (ts.isTemplateSpan(n) && isCaught(n.expression)) found = true;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && (isCaught(n.left) || isCaught(n.right))) found = true;
    if (ts.isIdentifier(n) && names.has(`alias:${n.text}`)) found = true;
  });
  return found;
}

/** The answers built inside `body`: `[node, expression]` pairs, each expression once (a fallback body is also an `{ status, error }`). */
function answersIn(body, answeredClasses) {
  const pairs = [];
  const out = { push: (pair) => { if (!pairs.some(([, e]) => e === pair[1] || e.getStart() <= pair[1].getStart() && pair[1].end <= e.end)) pairs.push(pair); } };
  walkEveryNode(body, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['json', 'send'].includes(n.expression.name.text)) {
      const root = n.expression.getText().split(/[.(]/)[0];
      if (/^(res|response|reply)$/.test(root)) for (const a of n.arguments) out.push([n, a]);
    }
    if (ts.isObjectLiteralExpression(n)) {
      const prop = (k) => n.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === k);
      const type = prop('type');
      if (type && ts.isStringLiteralLike(type.initializer) && type.initializer.text === 'text' && prop('text')) out.push([n, prop('text').initializer]);
      // An answer handed back for a door to send: `{ status, error }` (the join's acts return one).
      if (prop('status') && prop('error')) out.push([n, prop('error').initializer]);
      // The other spelling of the same handed-back answer: `{ status, body: { error } }` (member introductions' confirm).
      const body = prop('body');
      if (prop('status') && body && ts.isObjectLiteralExpression(body.initializer)) {
        const inner = body.initializer.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'error');
        if (inner) out.push([n, inner.initializer]);
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'sendCaughtFailure' && n.arguments[3]) out.push([n, n.arguments[3]]);
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && answeredClasses.has(n.expression.text)) for (const a of n.arguments ?? []) out.push([n, a]);
  });
  return pairs;
}

/** Whether `node`, inside the catch whose caught value is `name`, sits under an `instanceof` of our refusal classes only. */
function narrowedToOurs(node, stopAt, name, ours) {
  const targetsOf = (cond) => {
    const t = [];
    walkEveryNode(cond, (c) => {
      if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
        const l = unwrapExpression(c.left);
        if (l && ts.isIdentifier(l) && l.text === name && ts.isIdentifier(c.right)) t.push(c.right.text);
      }
    });
    return t;
  };
  const negated = (cond) => { const u = unwrapExpression(cond); return ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.ExclamationToken; };
  for (let n = node; n && n !== stopAt; n = n.parent) {
    const p = n.parent;
    if (p && ts.isIfStatement(p) && p.thenStatement === n && !negated(p.expression)) {
      const t = targetsOf(p.expression);
      if (t.length > 0 && t.every(c => ours.has(c))) return true;
    }
    if (p && ts.isConditionalExpression(p) && p.whenTrue === n && !negated(p.condition)) {
      const t = targetsOf(p.condition);
      if (t.length > 0 && t.every(c => ours.has(c))) return true;
    }
    // An earlier `if (!(x instanceof Ours)) throw|return` in the same block narrows everything after it.
    if (p && ts.isBlock(p)) {
      for (const s of p.statements) {
        if (s === n) break;
        if (ts.isIfStatement(s) && negated(s.expression)) {
          const t = targetsOf(s.expression);
          const exits = ts.isThrowStatement(s.thenStatement) || ts.isReturnStatement(s.thenStatement)
            || (ts.isBlock(s.thenStatement) && s.thenStatement.statements.some(x => ts.isThrowStatement(x) || ts.isReturnStatement(x)));
          if (t.length > 0 && exits && t.every(c => ours.has(c))) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Every answer built from a caught value in `text`: `{ file, line, route, admin, allowed }`. `allowed` is true when an `instanceof` of
 * our refusal classes narrows it; `admin` when the route it answers is mounted with `requireAdmin`.
 */
export function caughtAnswersIn(file, text, { ours, answeredClasses }) {
  const sf = parseSource(file, text);
  const adminRouters = adminOnlyRouters(sf);
  const out = [];
  const visitHandler = (name, body) => {
    const names = new Set([name]);
    // A local built from the caught value carries it: `const msg = err instanceof Error ? err.message : String(err)`.
    walkEveryNode(body, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && carries(n.initializer, names)) names.add(`alias:${n.name.text}`);
    });
    for (const [node, expr] of answersIn(body, answeredClasses)) {
      if (!carries(expr, names)) continue;
      const route = routeOf(node, adminRouters);
      out.push({ file, line: lineOf(sf, node), route: route ? `${route.method.toUpperCase()} ${route.path}` : null, admin: !!route?.admin,
        allowed: narrowedToOurs(node, body, name, ours) });
    }
  };
  walkEveryNode(sf, (n) => {
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) visitHandler(n.variableDeclaration.name.text, n.block);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch') {
      const cb = n.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name)) {
        visitHandler(cb.parameters[0].name.text, cb.body);
      }
    }
  });
  return out;
}

// ── The gate ───────────────────────────────────────────────────────────────────────────────────────────────────────

/*
 * The local agent connector is a second express app in a second process with its own auth, and its two routes are not this
 * server's (`_routes.mjs` excludes it for the same reason): what it answers is held by its own contract, not by this door's.
 */
const CONNECTOR = 'server/src/local-agent-connector/index.ts';
const SOURCES = readTrackedSources('server/src', { specs: false, floor: 200, exclude: [CONNECTOR] });
ADMIN_GUARDS = instanceAdminGuards(readFileSync(join(REPO_ROOT, MIDDLEWARE), 'utf8'));
const OURS = refusalClassesOf(SOURCES);
const ANSWERED = classesAnsweredByMessage(readFileSync(join(REPO_ROOT, CALL_TOOL), 'utf8'));
const ALL = SOURCES.flatMap(({ file, text }) => caughtAnswersIn(file, text, { ours: OURS, answeredClasses: ANSWERED }));
const at = (s) => `${s.file}:${s.line}${s.route ? ` (${s.route})` : ''}`;

describe('no answer carries a caught message', () => {
  it('the derivations found what they must, so the sweep is about something', () => {
    // Floors, and identities the derivation must get right in each direction.
    assert.ok(OURS.size >= 10, `only ${OURS.size} refusal classes derived — the class scan is broken: ${[...OURS]}`);
    for (const c of ['RequestRefusal', 'ToolRefusal', 'QuotaError', 'NotFoundError', 'PathBlocked']) {
      assert.ok(OURS.has(c), `${c} is one of our refusal classes and the derivation lost it: ${[...OURS].sort()}`);
    }
    assert.ok(!OURS.has('RangeError'), 'a bare RangeError is also thrown by the runtime, so it is not one of our refusal classes');
    assert.ok(!OURS.has('StoredFileUnreadable'), 'StoredFileUnreadable builds its message from its cause\'s, so it is not a refusal class');
    assert.ok(ADMIN_GUARDS.has('requireAdmin') && ADMIN_GUARDS.has('requireAdminMfa') && !ADMIN_GUARDS.has('requireAdminMfaScoped'),
      `instance-admin guards derived as ${[...ADMIN_GUARDS]}`);
    assert.ok(ANSWERED.has('ToolRefusal') && ANSWERED.has('NotFoundError'), `answerThrown's message-answered classes derived as ${[...ANSWERED]}`);
    assert.ok(ALL.length >= 15, `only ${ALL.length} answers built from a caught value found across server/src — the subject scan is broken`);
    assert.ok(ALL.some(s => s.allowed), 'no answer narrowed to our refusal classes was found — the narrowing never matched');
    assert.ok(ALL.some(s => s.admin), 'no requireAdmin route was found among the answers — the exemption derivation never matched');
  });

  it('every answer built from a caught value is narrowed to our refusal classes, or answers an instance-admin route', () => {
    const offenders = ALL.filter(s => !s.allowed && !s.admin);
    assert.deepEqual(offenders.map(at), [],
      'these answers carry a caught error\'s own text to the caller; answer it by what it is (the classifier), or narrow it with '
      + 'an instanceof of one of our refusal classes first');
  });

  it('the upload door never chooses a 400 by `instanceof RangeError` (Q-541)', () => {
    const text = readFileSync(join(REPO_ROOT, UPLOAD_DOOR), 'utf8');
    const sf = parseSource(UPLOAD_DOOR, text);
    const found = [];
    let catches = 0;
    walkEveryNode(sf, (n) => {
      if (!ts.isCatchClause(n)) return;
      catches += 1;
      walkEveryNode(n.block, (s) => {
        if (!ts.isIfStatement(s)) return;
        let rangeError = false;
        walkEveryNode(s.expression, (c) => {
          if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(c.right) && c.right.text === 'RangeError') rangeError = true;
        });
        if (!rangeError) return;
        let fourHundred = false;
        walkEveryNode(s.thenStatement, (c) => {
          if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'status'
            && c.arguments[0] && ts.isNumericLiteral(c.arguments[0]) && c.arguments[0].text === '400') fourHundred = true;
        });
        if (fourHundred) found.push(`${UPLOAD_DOOR}:${lineOf(sf, s)}`);
      });
    });
    assert.ok(catches >= 4, `only ${catches} catch clauses on the upload door — re-anchor this gate`);
    assert.deepEqual(found, [], 'the runtime throws RangeError too: a catch on the upload door must answer our refusal by its class (or a marker), '
      + 'and any other RangeError as the server fault it is');
  });

  describe('the rule, not its spelling: the sweep judges each shape', () => {
    const judge = (src) => caughtAnswersIn('fixture.ts', src, { ours: OURS, answeredClasses: ANSWERED });
    it('an answer of err.message, String(err), a template or a local built from them is caught', () => {
      for (const body of ['res.status(500).json({ error: err.message })', 'res.json({ error: String(err) })',
        'res.status(400).json({ error: `failed: ${err}` })', 'const msg = err instanceof Error ? err.message : String(err); res.status(400).json({ error: msg })',
        "return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }",
        "sendCaughtFailure(res, 'w', err, { error: (err as Error).message })", 'throw new ToolRefusal(400, err.message)',
        'return { status: 502, error: `Could not reach the peer: ${err}` }',
        'return { status: 502, body: { error: `Could not reach the introduced address: ${err}` } }']) {
        const found = judge(`r.post('/x', requireAuth, async (req, res) => { try { work(); } catch (err) { ${body} } });`);
        assert.equal(found.length, 1, `not seen: ${body}`);
        assert.equal(found[0].allowed || found[0].admin, false, `seen and excused: ${body}`);
      }
    });
    it('narrowed to our refusal class it is allowed; narrowed to RangeError, StoredFileUnreadable or TypeError it is not', () => {
      const one = (cls) => judge(`r.get('/x', async (req, res) => { try { w(); } catch (err) { if (err instanceof ${cls}) { res.status(400).json({ error: err.message }); return; } } });`)[0];
      assert.equal(one('QuotaError').allowed, true);
      assert.equal(one('RequestRefusal').allowed, true);
      assert.equal(one('RangeError').allowed, false, 'the runtime throws RangeError too');
      assert.equal(one('StoredFileUnreadable').allowed, false);
      assert.equal(one('TypeError').allowed, false);
    });
    it('a requireAdmin route is exempt; a requireAdminMfaScoped one is not', () => {
      const route = (guard) => judge(`r.post('/x', ${guard}, async (req, res) => { try { w(); } catch (e) { res.status(500).json({ error: e.message }); } });`)[0];
      assert.equal(route('requireAdmin').admin, true);
      assert.equal(route('requireAdminMfa').admin, true);
      assert.equal(route("requireAdminMfaScoped('id')").admin, false);
      assert.equal(route('requireAdminOrSpaceAdmin').admin, false);
      const whole = judge(`r.use(globalRateLimit, requireAdmin); r.get('/y', (req, res) => { try { w(); } catch (e) { res.status(400).json({ error: e.message }); } });`)[0];
      assert.equal(whole.admin, true, 'a router guarded whole by requireAdmin exempts its routes');
    });
    it('a comment mentioning err.message is not an answer', () => {
      assert.deepEqual(judge('r.get(\'/x\', (req, res) => { try { w(); } catch (err) { /* res.json({ error: err.message }) */ res.status(500).json({ error: \'failed\' }); } });'), []);
    });
  });
});
