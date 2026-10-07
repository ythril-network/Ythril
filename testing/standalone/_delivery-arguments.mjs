/**
 * Where does the delivery handed to a tombstone apply come from?
 *
 * ## The question it answers
 *
 * For every call of `applyPeerTombstones` / `applyPeerFileTombstones` in a source file: is its third argument a call to
 * `deliveryOf`, or an identifier every declaration of which (in that file) is initialised from one? An object literal,
 * a spread, a missing argument, a variable assigned by hand and a PARAMETER are all "not from deliveryOf" — a
 * parameter because the gate cannot see where it came from, so the answer has to be given at the door that admits the
 * page.
 *
 * ## What it prevents
 *
 * Reading the tree means a comment, a string or the function's own definition is never a call, and a call through a
 * namespace import is still one. Matching call text would have missed the second and tripped on the first.
 */
import { parseSource, lineOf, ts } from '../_shared/syntax-tree.mjs';
import { unwrapExpression, calleeNameOf } from './_expression-names.mjs';

export const APPLIES = Object.freeze(['applyPeerTombstones', 'applyPeerFileTombstones']);

/** The delivery is the third parameter of both: `(localSpaceId, raw, delivery, where)`. */
export const DELIVERY_PARAM = 2;

const isDeliveryOf = (expr) => { const e = unwrapExpression(expr); return !!e && ts.isCallExpression(e) && calleeNameOf(e) === 'deliveryOf'; };

/**
 * Every call of one of `names` in `text`, each with a verdict on its delivery argument: `{ name, line, ok, why }`.
 */
export function deliveryArgumentsOf(file, text, names = APPLIES) {
  const sf = parseSource(file, text);
  const declarations = new Map();   // identifier -> every declaration of it in the file
  const note = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const list = declarations.get(n.name.text) ?? [];
      list.push({ kind: 'variable', init: n.initializer });
      declarations.set(n.name.text, list);
    } else if (ts.isParameter(n) && ts.isIdentifier(n.name)) {
      const list = declarations.get(n.name.text) ?? [];
      list.push({ kind: 'parameter' });
      declarations.set(n.name.text, list);
    }
    ts.forEachChild(n, note);
  };
  note(sf);

  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeNameOf(node);
      if (names.includes(name)) {
        const arg = node.arguments[DELIVERY_PARAM];
        let ok = false;
        let why;
        if (!arg) why = `the call passes ${node.arguments.length} argument(s); the delivery is the third`;
        else if (isDeliveryOf(arg)) ok = true;
        else if (ts.isIdentifier(unwrapExpression(arg))) {
          const id = unwrapExpression(arg).text;
          const decls = declarations.get(id) ?? [];
          if (decls.length === 0) why = `\`${id}\` is not declared in this file`;
          else if (decls.some(d => d.kind === 'parameter')) why = `\`${id}\` is a PARAMETER here; the delivery must be built by deliveryOf where the door admits the page`;
          else if (decls.every(d => d.init && isDeliveryOf(d.init))) ok = true;
          else why = `\`${id}\` is not initialised from deliveryOf(…)`;
        } else why = `the delivery is \`${arg.getText(sf).slice(0, 80)}\`, written by hand`;
        out.push({ name, line: lineOf(sf, node), ok, why });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
