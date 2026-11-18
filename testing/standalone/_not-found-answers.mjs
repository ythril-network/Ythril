/**
 * Every text the server answers for a record, path or space that is not there (or not reachable), read from the source: the question
 * "does a value the CALLER chose reach this text without the bounded renderer?", asked once for the gate and its planted cases.
 *
 * ## What it reads
 *
 * A syntax tree, so a comment can neither satisfy nor fail the rule (the docblock that explains a fix names the old wording).
 * A TEXT is found where a door says "not found" or "not reachable":
 *
 *  - `new NotFoundError(<text>)` and `new NotEmbeddedYetError(<text>)`;
 *  - `new Error(<text>)` whose literal words say "not found" (a tool handler's plain Error is answered 400, and a REST route turns
 *    one ending in "not found" into a 404);
 *  - `<any>(404, <text>, ...)`, a call or `new` whose FIRST argument is the status (`fail(404, ...)`, `new ForkRefusal(404, ...)`);
 *  - `<res>.status(404).json({ error: <text> })`;
 *  - an object literal with `status: 404`, its `error` or its `body.error` (an act's answer).
 *
 * ## What a text may carry
 *
 * Every value in it (a template's `${...}`, an operand of `+`, both arms of `?:`) is judged: it passes when it is a call of one of
 * {@link BOUNDED_RENDERERS}, a literal, or an UPPER_CASE constant. `notFoundSentence` is held to its own shape: its noun is a literal
 * (a noun built from a caller's text would be the leak itself) and its `after` is a literal. Anything else is a value the caller may have
 * chosen, unless the allowlist names it with the reason it is not.
 *
 * ## What the answer is
 *
 * `unboundedTexts(file, source)` returns `{ file, line, expression, context }` for each value that is not bounded and `contexts` counts
 * every text it examined, so a caller can floor the scan: a scan that examined nothing reports clean about nothing.
 */
import { parseSource, ts, walkEveryNode, lineOf } from '../_shared/syntax-tree.mjs';

/** The functions whose result is a bounded rendering of what a caller chose: the one the rule names, and the renderers it is built on. */
export const BOUNDED_RENDERERS = Object.freeze(['notFoundSentence', 'peerText', 'peerList', 'unknownSpaceSentence']);

/** The statuses whose answers say a thing the caller named is not there. */
const STATUSES = new Set(['404']);
const NOT_FOUND_CLASSES = new Set(['NotFoundError', 'NotEmbeddedYetError']);

const unwrap = (e) => {
  let n = e;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression?.(n))) n = n.expression;
  return n;
};

const calleeName = (call) => {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
};

/** The literal words of a text (what is written between its values), for the "says not found" question. */
function literalWords(e) {
  const n = unwrap(e);
  if (!n) return '';
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => s.literal.text).join('');
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return literalWords(n.left) + literalWords(n.right);
  return '';
}

const propertyNamed = (obj, name) => obj.properties.find(p => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);

/** The value expressions of `e` that are not bounded: `{ node }[]`. */
function unboundedValues(e) {
  const n = unwrap(e);
  if (!n) return [];
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return [];
  if (ts.isTemplateExpression(n)) return n.templateSpans.flatMap(s => unboundedValues(s.expression));
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...unboundedValues(n.left), ...unboundedValues(n.right)];
  if (ts.isConditionalExpression(n)) return [...unboundedValues(n.whenTrue), ...unboundedValues(n.whenFalse)];
  if (ts.isIdentifier(n) && /^[A-Z][A-Z0-9_]*$/.test(n.text)) return [];
  if (ts.isCallExpression(n)) {
    const name = calleeName(n);
    if (name === 'notFoundSentence') return notFoundSentenceShape(n);
    if (BOUNDED_RENDERERS.includes(name)) return [];
  }
  return [n];
}

/** `notFoundSentence(noun, value, { after })`: the noun and `after` are literals, so only `value` and `space` are free (they are bounded inside). */
function notFoundSentenceShape(call) {
  const [noun, , opts] = call.arguments;
  const bad = [];
  if (!noun || !(ts.isStringLiteral(noun) || ts.isNoSubstitutionTemplateLiteral(noun))) bad.push(noun ?? call);
  if (opts && ts.isObjectLiteralExpression(opts)) {
    const after = propertyNamed(opts, 'after');
    if (after && !(ts.isStringLiteral(after.initializer) || ts.isNoSubstitutionTemplateLiteral(after.initializer))) bad.push(after.initializer);
  }
  return bad;
}

/**
 * The text expressions of one node, with the context that makes each one a not-found or out-of-reach text.
 *
 * Only `404` answers: a `403` is a rights refusal, whose words name an area and a rung, built at dozens of sites that are about the token and
 * not about a thing the caller named. A name or a call as a `404` text is judged too (a text built by a site this scan reads, or an exception
 * that says so).
 */
function textsOf(node) {
  const out = [];
  if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.arguments?.length) {
    const first = unwrap(node.arguments[0]);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const cls = node.expression.text;
      if (NOT_FOUND_CLASSES.has(cls)) out.push({ context: `new ${cls}`, text: node.arguments[0], status: '404' });
      else if (cls === 'Error' && /not found/i.test(literalWords(node.arguments[0]))) out.push({ context: 'new Error (says not found)', text: node.arguments[0], status: '404' });
    }
    if (first && ts.isNumericLiteral(first) && STATUSES.has(first.text) && node.arguments.length > 1) {
      out.push({ context: `${calleeName(node) ?? (ts.isNewExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : 'call')}(${first.text}, text)`, text: node.arguments[1], status: first.text });
    }
    if (ts.isCallExpression(node) && calleeName(node) === 'json' && ts.isPropertyAccessExpression(node.expression)) {
      const st = unwrap(node.expression.expression);
      if (st && ts.isCallExpression(st) && calleeName(st) === 'status') {
        const code = unwrap(st.arguments[0]);
        const body = unwrap(node.arguments[0]);
        if (code && ts.isNumericLiteral(code) && STATUSES.has(code.text) && body && ts.isObjectLiteralExpression(body)) {
          const err = propertyNamed(body, 'error');
          if (err) out.push({ context: `.status(${code.text}).json({ error })`, text: err.initializer, status: code.text });
        }
      }
    }
  }
  if (ts.isObjectLiteralExpression(node)) {
    const status = propertyNamed(node, 'status');
    const code = status && unwrap(status.initializer);
    if (code && ts.isNumericLiteral(code) && STATUSES.has(code.text)) {
      const err = propertyNamed(node, 'error');
      if (err) out.push({ context: `{ status: ${code.text}, error }`, text: err.initializer, status: code.text });
      const body = propertyNamed(node, 'body');
      const inner = body && unwrap(body.initializer);
      if (inner && ts.isObjectLiteralExpression(inner)) {
        const e2 = propertyNamed(inner, 'error');
        if (e2) out.push({ context: `{ status: ${code.text}, body: { error } }`, text: e2.initializer, status: code.text });
      }
    }
  }
  return out;
}

/**
 * @param {string} file   repo-relative path, as a finding names it
 * @param {string} source its text
 * @returns {{ findings: { file: string, line: number, expression: string, context: string }[], contexts: number, bounded: number }}
 *   `contexts` is every text examined; `bounded` is how many `notFoundSentence(` calls the file holds.
 */
export function unboundedTexts(file, source) {
  const sf = parseSource(file, source);
  const findings = [];
  let contexts = 0;
  let bounded = 0;
  walkEveryNode(sf, (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === 'notFoundSentence') bounded++;
    for (const { context, text } of textsOf(node)) {
      contexts++;
      for (const bad of unboundedValues(text)) {
        findings.push({ file, line: lineOf(sf, bad), expression: bad.getText(sf).replace(/\s+/g, ' '), context });
      }
    }
  });
  return { findings, contexts, bounded };
}
