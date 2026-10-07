/**
 * Every tombstone-authority comparison in a source file, read out of the syntax tree.
 *
 * ## The question it answers
 *
 * *"Where does this file decide whether one party may speak for another about a deleted object?"* — a call to
 * `tombstoneGoverns`, or an equality between two operands of DIFFERENT parties: ISSUER (`issuer`, `.issuer`),
 * AUTHOR (`author`, `.author.instanceId`, a variable initialised from one), PEER (`peerInstanceId`, `deliverer`) and
 * STAMP (`deliveredBy`). Two operands of the SAME party (`a.peerInstanceId === b.peerInstanceId`, a token lookup) ask
 * something else and are not findings.
 *
 * ## What it prevents
 *
 * A text match over source reads every comment, string and log line that says these words (the repo says them all
 * the time), so a gate built on one either drowns in false findings or is quietly narrowed until it sees nothing.
 * Reading the tree makes a comment impossible to match; a table in the gate that uses it holds the shapes it must and
 * must not flag, so the detector is itself seen red.
 */
import { parseSource, lineOf, ts, unwrapExpression } from '../_shared/syntax-tree.mjs';
import { lastName } from './_expression-names.mjs';

const PARTY = [
  ['ISSUER', /^issuer$/],
  ['PEER', /^(peerInstanceId|deliverer)$/],
  ['STAMP', /^deliveredBy$/],
  ['AUTHOR', /^author$/],
];
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The party an operand names, or undefined. `aliases` maps a variable initialised from a party to that party. */
function partyOf(expr, aliases) {
  const e = unwrapExpression(expr);
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'instanceId' && lastName(e.expression) === 'author') return 'AUTHOR';
  const name = lastName(e);
  if (name === undefined) return undefined;
  if (ts.isIdentifier(e) && aliases.has(name)) return aliases.get(name);
  return PARTY.find(([, re]) => re.test(name))?.[0];
}

const enclosingFunctionName = (node) => {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  return undefined;
};

/** Every tombstone-authority comparison in `text`, as `{ line, what, fn }` — `fn` the top-level function it sits in. */
export function authorityComparisons(file, text) {
  const sf = parseSource(file, text);
  const aliases = new Map();
  // One pass for `const author = doc.author?.instanceId`: the alias carries the party of what initialises it.
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const p = partyOf(node.initializer, new Map());
      if (p) aliases.set(node.name.text, p);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && lastName(node.expression) === 'tombstoneGoverns') {
      out.push({ line: lineOf(sf, node), what: 'a call to tombstoneGoverns', fn: enclosingFunctionName(node) });
    } else if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      const a = partyOf(node.left, aliases);
      const b = partyOf(node.right, aliases);
      if (a && b && a !== b) out.push({ line: lineOf(sf, node), what: `${node.left.getText(sf)} ${node.operatorToken.getText(sf)} ${node.right.getText(sf)} (${a} against ${b})`, fn: enclosingFunctionName(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

