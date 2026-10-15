/**
 * Every answer that carries a vote round carries it through the one operator projection — the half of the gate that needs no
 * database (Q-456, R14; design v5 section 5.3).
 *
 * ## What Q-456 found
 *
 * The add-space door answered the STORED round (the space's whole schema in it, and the proposal body the projection exists to
 * withhold) while every other door answered a bare pointer, `{ networkId, networkLabel, roundId }`, and the operator had to make a
 * second call to learn what it was voting on. `roundForOperator` (`networks/vote-acts.ts`) is the one projection, and
 * `a-round-answered-to-an-operator-carries-no-credential` holds the list and the cast to it; the doors that OPEN a round were
 * outside what it reads. A rule written for the doors someone remembered is this repo's commonest defect.
 *
 * ## What it holds, over the doors DERIVED from the source
 *
 * A *door* is the OUTERMOST function around a call that opens a round (`outermostFunctionAt`: a call inside a `.map(() => …)` is the
 * function's, and a route handler written inline is named for its route). The openers are read from the server, not listed: every
 * opener the server defines — `openRoundHere` today, `proposeRound` once it exists — and a call inside another opener's own
 * definition is that opener's business, not a door.
 *
 * - **Every door has a row** in `_round-answer-doors.mjs` (a driver, or a stated reason it is not an operator door), and every row
 *   is a door that still exists: a new opener answers a round no test drove, and a row for code that is gone is a driver for nothing.
 * - **No object literal outside `networks/vote-acts.ts` spells the pointer** — `networkId`, `networkLabel` and `roundId` together, in any
 *   order, whatever the key quoting, so `rounds:` plural and `round:` singular are both caught. The one builder is `roundAnswer`.
 * - **Every `round` / `rounds` property of an answer a door builds takes a projection**: `roundForOperator(`, `roundAnswer(`, or what
 *   `proposeRound(` handed back. An answer is an object literal in `.json(…)`, `body: {…}` or `structuredContent: {…}`; a value that is
 *   an identifier is followed to what the door put in it (its initialiser and its `.push(…)` arguments), so building the array first
 *   and answering it after is allowed and building it raw is not.
 *
 * The predicates are shown to fire on fixture strings FIRST, because a gate that has never failed is a claim.
 *
 * Run: node --test testing/standalone/every-answer-that-carries-a-round-is-projected-in-source.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { parseSource, ts, walkEveryNode as walk } from '../_shared/syntax-tree.mjs';
import { outermostFunctionAt } from './_source-helpers.mjs';
import { DOORS } from './_round-answer-doors.mjs';

const POINTER_KEYS = ['networkId', 'networkLabel', 'roundId'];
const PROJECTION = /\b(?:roundForOperator|roundAnswer|proposeRound)\s*\(/;
const BUILDER_FILE = 'server/src/networks/vote-acts.ts';
/** The sites found when this gate was written, `0f704f66`: a floor on the derivation, so an empty set cannot pass. */
const SITE_FLOOR = 11;

const keyName = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) ? p.name.text : null;
const keysOf = (obj) => obj.properties.map(keyName).filter(Boolean);

/** Does this object literal spell the pointer — all three keys, in any order? */
export function spellsThePointer(obj) {
  const keys = keysOf(obj);
  return POINTER_KEYS.every(k => keys.includes(k));
}


/** Names of the functions this source DEFINES that are in `names`, with where each definition ends. */
function definitionsIn(sf, names) {
  const out = [];
  walk(sf, n => { if (ts.isFunctionDeclaration(n) && n.name && names.includes(n.name.text)) out.push({ name: n.name.text, start: n.getStart(sf), end: n.getEnd() }); });
  return out;
}

/** The call expressions in `sf` whose callee is one of `names` (`f(…)` or `x.f(…)`), as `{ index, name }`. */
function callsIn(sf, names) {
  const out = [];
  walk(sf, n => {
    if (!ts.isCallExpression(n)) return;
    const c = n.expression;
    const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null;
    if (name && names.includes(name)) out.push({ index: n.getStart(sf), name });
  });
  return out;
}

/**
 * The properties named `round` / `rounds` an answer literal carries, at any depth inside an ANSWER position — an object literal handed
 * to `.json(…)`, or the value of a `body` / `structuredContent` property — with the expression each takes.
 */
export function roundPropertiesOfAnswers(sf, range) {
  const found = [];
  const inRange = (n) => n.getStart(sf) >= range.start && n.getEnd() <= range.end;
  const collect = (obj) => walk(obj, n => {
    if (ts.isPropertyAssignment(n) && ['round', 'rounds'].includes(keyName(n) ?? '')) found.push({ key: keyName(n), value: n.initializer, at: n.getStart(sf) });
    else if (ts.isShorthandPropertyAssignment(n) && ['round', 'rounds'].includes(n.name.text)) found.push({ key: n.name.text, value: n.name, at: n.getStart(sf) });
  });
  walk(sf, n => {
    if (!inRange(n)) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'json') {
      for (const a of n.arguments) if (ts.isObjectLiteralExpression(a)) collect(a);
    } else if (ts.isPropertyAssignment(n) && ['body', 'structuredContent'].includes(keyName(n) ?? '') && ts.isObjectLiteralExpression(n.initializer)) {
      collect(n.initializer);
    }
  });
  return found;
}

/**
 * Does a `round` / `rounds` value take a projection? An expression carrying one does. An identifier is followed inside the door to what
 * was put in it: the initialiser and every `.push(…)` argument must each carry one, and there must be at least one, so a variable
 * the door never fills is not read as clean.
 */
export function takesAProjection(sf, range, expr) {
  if (PROJECTION.test(expr.getText(sf))) return true;
  // `answer.round`, `outcome.rounds`: the value is a member of something the door built, so it is the root that is followed.
  while (ts.isPropertyAccessExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr)) return false;
  const fills = [];
  walk(sf, n => {
    if (n.getStart(sf) < range.start || n.getEnd() > range.end) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === expr.text && n.initializer) fills.push(n.initializer);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'push'
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === expr.text) fills.push(...n.arguments);
  });
  const rows = fills.filter(f => !(ts.isArrayLiteralExpression(f) && f.elements.length === 0));
  return rows.length > 0 && rows.every(f => PROJECTION.test(f.getText(sf)));
}

/**
 * The call sites of the openers outside the openers' own definitions, and the doors they sit in (`<file>::<outermost function>`).
 * One function, so the gate and its fixture run the same derivation.
 */
export function deriveDoors(parsed, openers, defs) {
  const sites = parsed.flatMap(s => callsIn(s.sf, openers).map(c => ({ ...c, file: s.file, text: s.text, sf: s.sf })))
    .filter(c => !defs.some(d => d.file === c.file && c.index >= d.start && c.index < d.end))
    .map(c => ({ ...c, fn: outermostFunctionAt(c.file, c.text, c.index) }));
  const doors = new Map();
  for (const s of sites) {
    const key = `${s.file}::${s.fn?.name ?? '<module>'}`;
    doors.set(key, { key, file: s.file, sf: s.sf, range: s.fn ? { start: s.fn.start, end: s.fn.end } : { start: 0, end: s.text.length } });
  }
  return { sites, doors };
}

describe('the predicates fire on a fixture first', () => {
  it('a new opener call in a function with no row is a door the table does not know — the newly covered part, shown red', () => {
    const text = 'export function reopenSomething(net) {\n  net.rounds.forEach(() => { openRoundHere(net, {}); });\n}\n';
    const parsed = [{ file: 'server/src/networks/scratch.ts', text, sf: parseSource('server/src/networks/scratch.ts', text) }];
    const { doors } = deriveDoors(parsed, ['openRoundHere'], []);
    assert.deepEqual([...doors.keys()], ['server/src/networks/scratch.ts::reopenSomething'], 'a call inside a callback is the function\'s');
    const rows = new Set(DOORS.map(d => d.door));
    assert.deepEqual([...doors.keys()].filter(k => !rows.has(k)), ['server/src/networks/scratch.ts::reopenSomething'], 'and the table has no row for it');
  });

  const parse = (code) => parseSource('fixture.ts', code);
  const literals = (code) => { const out = []; walk(parse(code), n => { if (ts.isObjectLiteralExpression(n)) out.push(n); }); return out; };

  it('the pointer is spelled whatever the key order, quoting or shorthand — and two of the three is not the pointer', () => {
    assert.ok(literals('const a = { networkId: n.id, networkLabel: n.label, roundId };').some(spellsThePointer));
    assert.ok(literals('const a = { roundId, "networkLabel": l, networkId };').some(spellsThePointer));
    assert.ok(!literals('const a = { networkId: n.id, roundId };').some(spellsThePointer));
  });

  it('an answer carrying a raw round fails and one carrying the projection passes, by value and by what the door filled', () => {
    const door = (code) => { const sf = parse(code); const r = { start: 0, end: code.length }; return roundPropertiesOfAnswers(sf, r).map(p => takesAProjection(sf, r, p.value)); };
    assert.deepEqual(door('function f() { res.status(202).json({ round }); }'), [false], 'a shorthand raw round');
    assert.deepEqual(door('function f() { res.json({ round: roundForOperator(net, round) }); }'), [true]);
    assert.deepEqual(door('function f() { return { status: 202, body: { rounds: [roundAnswer(net, r)] } }; }'), [true]);
    assert.deepEqual(door('function f() { const rounds = []; rounds.push({ id }); res.json({ rounds }); }'), [false], 'an array filled raw');
    assert.deepEqual(door('function f() { const rounds = []; rounds.push(roundAnswer(net, r)); res.json({ rounds }); }'), [true], 'an array filled with the projection');
    assert.deepEqual(door('function f() { const rounds = []; res.json({ rounds }); }'), [false], 'a variable the door never fills is not clean');
    assert.deepEqual(door('function f() { const answer = proposeRound(net, spec); res.json({ round: answer.round }); }'), [true], 'a member of what the projection returned');
    assert.deepEqual(door('function f() { const answer = load(net); res.json({ round: answer.round }); }'), [false], 'a member of something else');
    assert.deepEqual(door('function f() { res.json({ status: 1 }); const x = { round }; }'), [], 'an object that is not an answer position carries nothing');
  });

  it('the outermost function is the door, a callback inside it is not', () => {
    const code = 'export function settle(a) {\n  a.forEach(() => { openRoundHere(x); });\n}\nrouter.post("/finalize", mw, async (req, res) => { openRoundHere(y); });\n';
    assert.equal(outermostFunctionAt('f.ts', code, code.indexOf('openRoundHere(x')).name, 'settle');
    assert.equal(outermostFunctionAt('f.ts', code, code.indexOf('openRoundHere(y')).name, 'POST /finalize');
    assert.equal(outermostFunctionAt('f.ts', code, code.length - 1), null, 'module level has no function');
  });
});

describe('every door that opens a round is in the table, and answers through the projection', () => {
  const sources = trackedSources('server/src', { untracked: true, floor: 100 });
  const parsed = sources.map(file => ({ file, text: readFileSync(file, 'utf8') })).map(s => ({ ...s, sf: parseSource(s.file, s.text) }));

  // The openers are what the server DEFINES among the names a round is opened by — derived, so `proposeRound` is in from the commit
  // that writes it. A name no file defines is not an opener, and none defined is a broken derivation.
  const CANDIDATES = ['openRoundHere', 'proposeRound'];
  const defs = parsed.flatMap(s => definitionsIn(s.sf, CANDIDATES).map(d => ({ ...d, file: s.file })));
  const openers = [...new Set(defs.map(d => d.name))];

  const { sites, doors } = deriveDoors(parsed, openers, defs);

  it('the derivation found the openers and their call sites, above the floor', () => {
    assert.ok(openers.includes('openRoundHere') || openers.includes('proposeRound'), `no opener of a round is defined in ${sources.length} sources`);
    assert.ok(sites.length >= SITE_FLOOR, `only ${sites.length} opener call site(s) found (${[...doors.keys()].join(', ')}) — the derivation is broken or a door was removed`);
  });

  it('a door with no row fails — a new opener answers a round no test drove', () => {
    const rows = new Set(DOORS.map(d => d.door));
    const missing = [...doors.keys()].filter(k => !rows.has(k));
    assert.deepEqual(missing, [], 'add each to _round-answer-doors.mjs with the driver that calls it, or the reason it is not an operator door');
  });

  it('a row for a door that is gone fails, so the table cannot keep a driver for nothing', () => {
    const stale = DOORS.map(d => d.door).filter(k => !doors.has(k));
    assert.deepEqual(stale, []);
  });

  it('no object literal outside the one builder spells the pointer { networkId, networkLabel, roundId }', () => {
    const spelled = [];
    for (const s of parsed) {
      if (s.file === BUILDER_FILE) continue;
      walk(s.sf, n => { if (ts.isObjectLiteralExpression(n) && spellsThePointer(n)) spelled.push(`${s.file}:${s.sf.getLineAndCharacterOfPosition(n.getStart(s.sf)).line + 1}`); });
    }
    assert.deepEqual(spelled, [], 'these answer a round as a bare pointer: build it with roundAnswer (networks/vote-acts.ts)');
  });

  it('every round / rounds an answer of a door carries takes a projection', () => {
    const exempt = new Set(DOORS.filter(d => d.exempt).map(d => d.door));
    const raw = [];
    let checked = 0;
    for (const door of doors.values()) {
      if (exempt.has(door.key)) continue;
      for (const p of roundPropertiesOfAnswers(door.sf, door.range)) {
        checked++;
        if (!takesAProjection(door.sf, door.range, p.value)) raw.push(`${door.key} ${p.key} (line ${door.sf.getLineAndCharacterOfPosition(p.at).line + 1})`);
      }
    }
    assert.ok(checked >= 1, 'no round-carrying answer was found in any door — the scan broke');
    assert.deepEqual(raw, [], 'these answers carry a round that did not go through roundForOperator / roundAnswer');
  });
});
