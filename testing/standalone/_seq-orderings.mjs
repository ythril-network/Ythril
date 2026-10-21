/**
 * Where does server code ORDER or RANGE by `seq`? - the one answer, read from the type-checked program.
 *
 * ## The question, and why it is not a regex
 *
 * `every-seq-paged-reader-goes-through-the-keyset` used to read four text shapes (`.sort({ seq`, `sort: { seq`, `seq: { $gt`,
 * `settledSeqRange`) and concluded about EVERY reader. It missed a ternary (`brain/edges.ts`:
 * `.sort(sort ? toMongoSort(sort) : { seq: -1, ... })`) and a constant that reaches `.sort` through a default parameter
 * (`DEFAULT_QUERY_SORT`: declared in `brain/query.ts`, defaulted into `queryBrain`'s `sort`, imported by `mcp/tools/filter.ts` and
 * passed on). Both are seq orderings; neither is a shape. Bundle 81 moves paging from seq to a holder position, and a gate that cannot
 * see a reader cannot hold it to the move.
 *
 * So this module asks the CHECKER. It finds every SLOT a value reaches a Mongo ordering through, resolves the value in each to the literal
 * it came from (through identifiers, imports, consts, conditionals, default parameters, spreads of resolved literals, array literals,
 * strings and calls into a function's returns), and says what it found: a literal that names `seq`, or a slot it could not resolve.
 * Anything it cannot resolve is reported as `unresolved`, never dropped: a gate over this module fails closed on it.
 *
 * ## The slots
 *
 * - `.sort(x)` on anything that is not an array (the checker says so, the receiver's name is not read);
 * - the `sort`, `$sort` and `sortBy` properties of any object literal (`find(f, { sort })`, `{ $sort: ... }`, `$setWindowFields`/`$top`);
 * - a parameter DECLARED `sort` or `sortBy`: its default initialiser is a slot, and so is the argument at every call that the checker
 *   resolves to a signature declaring it (`find(filter, SEQ_KEYSET_SORT, n)` hands the sort positionally, which no property name shows).
 *
 * A bare parameter or property named `sort` that reaches a slot is `pass`: its value is supplied at the slots above, where it is read.
 *
 * ## The ranges
 *
 * Every object literal whose `seq` key holds `$gt|$gte|$lt|$lte|$not`, every one whose `_id` key does while it also names `seq` (a hand
 * tie page), and every `$expr` that names `'$seq'`.
 *
 * ## What it is NOT
 *
 * - Not a projection finder: a slot is a place a value is ORDERED by, so `readStoredById(coll, ids, { seq: 1 })` never enters. Walking
 *   only ordering slots is what keeps a projection from being read as an ordering.
 * - Not a verdict: whether an ordering is allowed is the gate's question (`every-seq-paged-reader-goes-through-the-keyset`).
 *
 * Lines are from `lineOf` against the original source. `function` is the OUTERMOST named function around the slot.
 */
import ts from 'typescript';
import { serverProgram } from '../_shared/server-program.mjs';
import { lineOf, walkEveryNode, unwrapExpression, outermostFunctionOf, walkOwnCode } from '../_shared/syntax-tree.mjs';

/** The module every seq position is built by. A literal DECLARED here is the allowed origin of an ordering or a range. */
export const KEYSET_FILE = 'server/src/util/seq-keyset.ts';

/** Properties and parameters whose value is an ordering. */
const SORT_PROPERTIES = new Set(['sort', '$sort', 'sortBy']);
/** A parameter or property declared with one of these names is a hand-over: its value is read where it is supplied. */
const PASS_NAMES = new Set(['sort', 'sortBy']);
/** The Mongo reads whose options object carries a `sort`: an unresolved `sort` there is reported, not assumed harmless. */
const MONGO_READS = new Set(['find', 'findOne', 'aggregate', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'distinct']);
const RANGE_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte', '$not']);
const SEQ_STRING = /^[+-]?seq(?:\s|:|$)/;
const MAX_DEPTH = 12;

const { checker, repoPath, serverSources } = serverProgram();

const fileOf = (node) => repoPath(node.getSourceFile().fileName);
const at = (node) => `${fileOf(node)}:${lineOf(node.getSourceFile(), node)}`;

const nameOfFunction = (fn) => {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (fn.name) return fn.name.getText();
  const p = fn.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && p.name) return p.name.getText();
  return null;
};

/** The outermost NAMED function around `node` (else the first named one inside the outermost), or `<module>`. */
export function enclosingFunctionName(node) {
  const chain = [];
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n) && !ts.isSourceFile(n)) chain.unshift(n);
  if (chain.length === 0) return '<module>';
  for (const fn of chain) {
    const name = nameOfFunction(fn);
    if (name) return name;
  }
  // `outermostFunctionOf` is the shared answer for "which function is this": an anonymous one is still a site.
  return outermostFunctionOf(node) ? '<anonymous>' : '<module>';
}

/** The text of a property name when it is a plain one; `null` for a computed name the checker cannot read as a string. */
function propertyKeyOf(nameNode) {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) || ts.isNumericLiteral(nameNode)) return nameNode.text;
  if (ts.isComputedPropertyName(nameNode)) {
    const e = unwrapExpression(nameNode.expression);
    if (ts.isStringLiteralLike(e)) return e.text;
  }
  return null;
}

const strip = (e) => {
  let x = unwrapExpression(e);
  while (x && ts.isTypeAssertionExpression(x)) x = unwrapExpression(x.expression);
  return x;
};

const symbolOf = (node) => {
  let s = checker.getSymbolAtLocation(node);
  if (s && (s.flags & ts.SymbolFlags.Alias)) s = checker.getAliasedSymbol(s);
  return s;
};

/**
 * What a value IS, read back from the program. One item per literal or unresolvable thing it can be:
 * `{ t: 'obj'|'arr'|'str', node, hasSeq, unresolved: string[], viaModule }`, `{ t: 'module', node }` (the value of a call into the keyset
 * module), `{ t: 'pass' }` (a sort parameter or property whose value is supplied at a slot), `{ t: 'ignore' }` (a number, a function, `undefined`:
 * nothing that orders), `{ t: 'unres', node, why }`. Every item carries `via`, the names the value travelled through.
 */
function resolve(expr, state = { depth: 0, seen: new Set(), via: [] }) {
  const e = strip(expr);
  if (!e) return [{ t: 'unres', node: expr, why: 'no expression', via: state.via }];
  if (state.depth > MAX_DEPTH) return [{ t: 'unres', node: e, why: 'resolution nested deeper than the limit', via: state.via }];
  const next = (via = state.via) => ({ depth: state.depth + 1, seen: state.seen, via });
  const unres = (why) => [{ t: 'unres', node: e, why, via: state.via }];

  if (ts.isObjectLiteralExpression(e)) return [analyseObject(e, state)];
  if (ts.isArrayLiteralExpression(e)) return [analyseArray(e, state)];
  if (ts.isStringLiteralLike(e)) return [{ t: 'str', node: e, hasSeq: SEQ_STRING.test(e.text), unresolved: [], via: state.via }];
  if (ts.isNumericLiteral(e) || ts.isBigIntLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword
    || e.kind === ts.SyntaxKind.NullKeyword || ts.isFunctionLike(e) || ts.isPrefixUnaryExpression(e) || ts.isVoidExpression(e)
    || ts.isTypeOfExpression(e) || ts.isClassExpression(e) || ts.isRegularExpressionLiteral(e)) return [{ t: 'ignore', via: state.via }];
  if (ts.isConditionalExpression(e)) return [...resolve(e.whenTrue, next()), ...resolve(e.whenFalse, next())];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return [...resolve(e.left, next()), ...resolve(e.right, next())];
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) return resolve(e.right, next());
    return unres(`a binary expression (${e.operatorToken.getText()}) is not followed`);
  }
  if (ts.isIdentifier(e)) {
    if (e.text === 'undefined') return [{ t: 'ignore', via: state.via }];
    return resolveSymbol(e, symbolOf(e), e.text, state);
  }
  if (ts.isPropertyAccessExpression(e)) return resolveSymbol(e, symbolOf(e.name), e.name.text, state);
  if (ts.isCallExpression(e)) return resolveCall(e, state);
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Map' && e.arguments?.length === 1) return resolve(e.arguments[0], next());
  return unres(`${ts.SyntaxKind[e.kind]} is not followed`);
}

function analyseObject(node, state) {
  const out = { t: 'obj', node, hasSeq: false, unresolved: [], viaModule: false, via: state.via, keys: [] };
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      const key = propertyKeyOf(p.name);
      if (key === null) out.unresolved.push(`${at(p)}: a computed key the checker cannot read as a string (${p.name.getText().slice(0, 40)})`);
      else {
        out.keys.push(key);
        if (key === 'seq') out.hasSeq = true;
      }
    } else if (ts.isSpreadAssignment(p)) {
      for (const r of resolve(p.expression, { depth: state.depth + 1, seen: state.seen, via: [...state.via, `...${p.expression.getText().slice(0, 30)}`] })) {
        if (r.t === 'obj') {
          out.hasSeq ||= r.hasSeq;
          out.keys.push(...r.keys);
          out.unresolved.push(...r.unresolved);
          out.viaModule ||= r.viaModule;
        } else if (r.t === 'module') out.viaModule = true;
        else if (r.t === 'unres') out.unresolved.push(`${at(r.node)}: spread of a value that cannot be resolved (${r.why})`);
        else if (r.t === 'str' || r.t === 'arr') out.unresolved.push(`${at(p)}: spread of a non-object`);
        // `pass` and `ignore` hold no key of their own.
      }
    }
  }
  return out;
}

function analyseArray(node, state) {
  const out = { t: 'arr', node, hasSeq: false, unresolved: [], viaModule: false, via: state.via };
  for (const el of node.elements) {
    if (ts.isSpreadElement(el)) { out.unresolved.push(`${at(el)}: a spread inside an ordering array`); continue; }
    for (const r of resolve(el, { depth: state.depth + 1, seen: state.seen, via: state.via })) {
      // `['seq', 1]` is one pair; `[['seq', 1], ['_id', 1]]` and `['seq', '-_id']` are lists of them.
      if (r.t === 'str') out.hasSeq ||= r.hasSeq;
      else if (r.t === 'arr') out.hasSeq ||= r.hasSeq || firstIsSeq(el);
      else if (r.t === 'unres') out.unresolved.push(`${at(r.node)}: ${r.why}`);
    }
  }
  if (firstIsSeq(node)) out.hasSeq = true;
  return out;
}

/** Whether an array literal's first element is the string `seq` (the `['seq', 1]` pair). */
function firstIsSeq(arrayNode) {
  const a = strip(arrayNode);
  if (!a || !ts.isArrayLiteralExpression(a) || a.elements.length === 0) return false;
  const first = strip(a.elements[0]);
  return !!first && ts.isStringLiteralLike(first) && /^[+-]?seq$/.test(first.text);
}

function resolveSymbol(node, sym, name, state) {
  const via = [...state.via, name];
  const unres = (why) => [{ t: 'unres', node, why, via }];
  if (!sym || !sym.declarations || sym.declarations.length === 0) {
    return PASS_NAMES.has(name) ? [{ t: 'pass', via }] : unres(`\`${name}\` has no declaration the checker can follow`);
  }
  const decl = sym.declarations[0];
  const where = repoPath(decl.getSourceFile().fileName);
  if (!where.startsWith('server/src/')) {
    return PASS_NAMES.has(name) ? [{ t: 'pass', via }] : [{ t: 'ignore', via }];
  }
  if (state.seen.has(decl)) return [{ t: 'ignore', via }];
  const seen = new Set(state.seen).add(decl);
  const go = (e) => resolve(e, { depth: state.depth + 1, seen, via });
  if (ts.isVariableDeclaration(decl)) {
    if (!decl.initializer) return PASS_NAMES.has(name) ? [{ t: 'pass', via }] : unres(`\`${name}\` is declared without a value`);
    return go(decl.initializer);
  }
  if (ts.isParameter(decl)) {
    const out = decl.initializer ? go(decl.initializer) : [];
    if (PASS_NAMES.has(name)) return [...out, { t: 'pass', via }];
    return decl.initializer ? out : unres(`parameter \`${name}\` has no default: its value is whatever a caller passes`);
  }
  if (ts.isPropertyAssignment(decl)) return go(decl.initializer);
  if (ts.isShorthandPropertyAssignment(decl)) return resolveSymbol(decl.name, checker.getShorthandAssignmentValueSymbol(decl), name, { ...state, seen });
  if (ts.isPropertyDeclaration(decl) && decl.initializer) return go(decl.initializer);
  if (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl) || ts.isBindingElement(decl)) {
    return PASS_NAMES.has(name) ? [{ t: 'pass', via }] : unres(`\`${name}\` is a declared field with no value of its own here`);
  }
  if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isEnumDeclaration(decl) || ts.isEnumMember(decl)
    || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isModuleDeclaration(decl)) return [{ t: 'ignore', via }];
  return unres(`${ts.SyntaxKind[decl.kind]} declaration of \`${name}\` is not followed`);
}

function resolveCall(call, state) {
  const via = [...state.via, `${call.expression.getText().slice(0, 40)}()`];
  const callee = strip(call.expression);
  // Object.freeze(x) is x.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') {
    if (callee.name.text === 'freeze' && call.arguments.length === 1) return resolve(call.arguments[0], { depth: state.depth + 1, seen: state.seen, via: state.via });
    if (callee.name.text === 'assign') return call.arguments.flatMap((a) => resolve(a, { depth: state.depth + 1, seen: state.seen, via: state.via }));
  }
  const sym = ts.isPropertyAccessExpression(callee) ? symbolOf(callee.name) : symbolOf(callee);
  const decl = sym?.declarations?.[0];
  if (!decl) return [{ t: 'unres', node: call, why: 'a call whose declaration the checker cannot find', via }];
  const where = repoPath(decl.getSourceFile().fileName);
  if (where === KEYSET_FILE) return [{ t: 'module', node: call, via }];
  if (!where.startsWith('server/src/')) return [{ t: 'unres', node: call, why: `a call into ${where}, outside the server's own code`, via }];
  const fn = ts.isVariableDeclaration(decl) && decl.initializer && ts.isFunctionLike(strip(decl.initializer)) ? strip(decl.initializer) : decl;
  if (!ts.isFunctionLike(fn) || !fn.body || state.seen.has(fn)) return [{ t: 'unres', node: call, why: 'a call whose body cannot be followed', via }];
  const seen = new Set(state.seen).add(fn);
  const returns = [];
  if (!ts.isBlock(fn.body)) returns.push(fn.body);
  else walkOwnCode(fn.body, (n) => { if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression); });
  if (returns.length === 0) return [{ t: 'unres', node: call, why: 'a call that returns nothing the program can follow', via }];
  return returns.flatMap((r) => resolve(r, { depth: state.depth + 1, seen, via }));
}

const isArrayReceiver = (callee) => {
  const t = checker.getTypeAtLocation(callee.expression);
  return checker.isArrayType(t) || checker.isTupleType(t) || (t.getSymbol()?.name === 'Array');
};

/** Whether `obj` is (directly) an argument of a call whose method is one of the Mongo reads. */
const isMongoReadOptions = (obj) => {
  const call = obj.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(obj)) return false;
  const callee = strip(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  return MONGO_READS.has(name);
};

/**
 * What the chain does after a `.sort(...)`: `['skip(n)', 'limit(1)', 'toArray()']`. An exemption that says "a maximum, not a position" asks
 * for the `limit(1)` here, not for "a limit somewhere in the statement" - which a hand-written position read also has.
 */
function chainAfter(sortCall) {
  const out = [];
  let c = sortCall;
  while (ts.isPropertyAccessExpression(c.parent) && ts.isCallExpression(c.parent.parent) && c.parent.parent.expression === c.parent) {
    c = c.parent.parent;
    out.push(`${c.expression.name.text}(${c.arguments.map((a) => a.getText()).join(', ')})`);
  }
  return out;
}

/** The stages after a `$sort` stage in the same pipeline array, by their first key: `['$limit']`. */
function stagesAfter(stage) {
  const arr = stage.parent;
  if (!ts.isArrayLiteralExpression(arr)) return [];
  const i = arr.elements.indexOf(stage);
  return arr.elements.slice(i + 1).map((s) => {
    const o = strip(s);
    const p = o && ts.isObjectLiteralExpression(o) ? o.properties[0] : null;
    return p && p.name ? p.name.getText() : '?';
  });
}

/** Every ordering slot in a file: `{ node: the value expression, kind: how it is reached, strict: report it when unresolved }`. */
function slotsOf(sf) {
  const slots = [];
  walkEveryNode(sf, (n) => {
    if (ts.isCallExpression(n)) {
      const callee = strip(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'sort' && n.arguments.length > 0 && !isArrayReceiver(callee)) {
        slots.push({ node: n.arguments[0], how: '.sort(argument)', strict: true, after: chainAfter(n) });
      }
      const sig = checker.getResolvedSignature(n);
      const params = sig?.declaration?.parameters ?? [];
      params.forEach((p, i) => {
        if (ts.isIdentifier(p.name) && PASS_NAMES.has(p.name.text) && n.arguments[i]) {
          slots.push({ node: n.arguments[i], how: `argument ${i} of a call whose parameter is declared \`${p.name.text}\``, strict: true, after: [] });
        }
      });
    } else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isObjectLiteralExpression(n.parent)) {
      const key = propertyKeyOf(n.name);
      if (key !== null && SORT_PROPERTIES.has(key)) {
        slots.push({ node: ts.isShorthandPropertyAssignment(n) ? n.name : n.initializer, how: `the \`${key}\` property`, strict: key !== 'sort' || isMongoReadOptions(n.parent), after: key === '$sort' ? stagesAfter(n.parent) : [] });
      }
    } else if (ts.isParameter(n) && ts.isIdentifier(n.name) && PASS_NAMES.has(n.name.text) && n.initializer) {
      slots.push({ node: n.initializer, how: `the default of parameter \`${n.name.text}\``, strict: true, after: [] });
    }
  });
  return slots;
}

/** The item's own literal location, or the thing the checker could not resolve. */
const itemNode = (it) => it.node;

function entriesForSlot(slot) {
  const out = [];
  const sf = slot.node.getSourceFile();
  const base = { file: fileOf(slot.node), line: lineOf(sf, slot.node), function: enclosingFunctionName(slot.node), slot: slot.how, after: slot.after };
  const origin = (it) => ({ origin: fileOf(itemNode(it)), originFunction: enclosingFunctionName(itemNode(it)), literalAt: at(itemNode(it)), via: it.via });
  for (const it of resolve(slot.node)) {
    if (it.t === 'obj' || it.t === 'arr' || it.t === 'str') {
      if (it.hasSeq) {
        out.push({ ...base, ...origin(it), kind: 'ordering', keys: it.keys ?? [], viaModule: it.viaModule ?? false });
      } else if (it.unresolved.length > 0 && slot.strict) {
        out.push({ ...base, ...origin(it), kind: 'unresolved', keys: it.keys ?? [], why: it.unresolved.join('; ') });
      }
    } else if (it.t === 'unres' && slot.strict) {
      out.push({ ...base, ...origin(it), kind: 'unresolved', keys: [], why: it.why });
    }
  }
  return out;
}

/** The names of the calls a node is an argument inside, innermost first (`['asFilter', 'deleteMany']`): what the range is USED for. */
function callsAround(node) {
  const out = [];
  // Up to the statement the literal is in, THROUGH a callback (`items.map((i) => ({ seq: { $lt } }))` is an argument of the delete around it).
  for (let n = node.parent; n && !ts.isBlock(n) && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isCallExpression(n)) {
      const callee = strip(n.expression);
      out.push(ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '?');
    }
  }
  return out;
}

/** Ranges: a `seq` (or tie `_id`) key holding a comparison, and `$expr` naming `$seq`. */
function rangesOf(sf) {
  const out = [];
  const add = (node, why) => out.push({
    file: fileOf(node), line: lineOf(sf, node), function: enclosingFunctionName(node), kind: 'range', origin: fileOf(node),
    originFunction: enclosingFunctionName(node), literalAt: at(node), via: [], why, inCalls: callsAround(node),
  });
  const holdsComparison = (valueNode) => resolve(valueNode).some((it) => it.t === 'obj' && it.node.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
    && RANGE_OPERATORS.has(propertyKeyOf(p.name) ?? '')));
  walkEveryNode(sf, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const keys = new Map();
    for (const p of n.properties) {
      if (ts.isPropertyAssignment(p)) {
        const k = propertyKeyOf(p.name);
        if (k !== null) keys.set(k, p);
      }
    }
    const seqProp = keys.get('seq');
    if (seqProp && holdsComparison(seqProp.initializer)) add(seqProp, 'a comparison on seq');
    else if (seqProp || [...n.properties].some((p) => ts.isShorthandPropertyAssignment(p) && p.name.text === 'seq')) {
      const idProp = keys.get('_id');
      if (idProp && holdsComparison(idProp.initializer)) add(idProp, 'a tie page: seq equal and _id compared');
    }
    const expr = keys.get('$expr');
    if (expr) {
      let names = false;
      walkEveryNode(expr.initializer, (m) => { if (ts.isStringLiteralLike(m) && m.text === '$seq') names = true; });
      if (names) add(expr, '$expr naming $seq');
    }
  });
  return out;
}

let cached = null;

/**
 * Every place server code orders or ranges by seq.
 *
 * @returns {{ entries: Array<{ file: string, line: number, function: string, kind: 'ordering'|'range'|'unresolved', origin: string,
 *   literalAt: string, via: string[], slot?: string, why?: string, viaModule?: boolean }>, slotCount: number, sourceCount: number }}
 *   `origin` is the file the literal (or the unresolved thing) is declared in, by the checker's symbol - NOT the file the slot is in.
 */
export function seqOrderings() {
  if (cached) return cached;
  const entries = [];
  const seenKey = new Set();
  let slotCount = 0;
  const sources = serverSources().filter((sf) => !sf.fileName.endsWith('.spec.ts'));
  for (const sf of sources) {
    const slotNodes = new Set();
    for (const slot of slotsOf(sf)) {
      // `.sort(x)` is a slot by its name and again by the driver's parameter name: one slot.
      if (slotNodes.has(slot.node)) continue;
      slotNodes.add(slot.node);
      slotCount++;
      for (const e of entriesForSlot(slot)) {
        const key = `${e.file}:${e.line}:${e.kind}:${e.literalAt}:${e.slot}`;
        if (!seenKey.has(key)) { seenKey.add(key); entries.push(e); }
      }
    }
    for (const e of rangesOf(sf)) {
      const key = `${e.file}:${e.line}:range:${e.why}`;
      if (!seenKey.has(key)) { seenKey.add(key); entries.push(e); }
    }
  }
  entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  cached = { entries, slotCount, sourceCount: sources.length };
  return cached;
}
