/**
 * Whether a document satisfies a MongoDB filter: the ONE evaluator the tests use, for the operators they use.
 *
 * ## The question it answers
 *
 * "Which documents does this filter select?" - asked of a rule that BUILDS a filter (`stalledJobFilter`,
 * `suppressedWithVectorFilter`) against fixture documents, and by the fake Ythril tool server for the `filter` tool.
 * It was written three times, each "enough Mongo" for its own filter, in two argument orders.
 *
 * ## What it prevents
 *
 * An operator one evaluator lacked was a throw in one test and, in the next, a silent non-match - and a matcher that
 * answers `false` for what it does not understand makes every "this rule selects nothing" test pass for the wrong
 * reason. So everything it does not know THROWS ({@link UnsupportedFilterError}, naming the operator): an unknown
 * operator, a `$or` / `$and` that is not a non-empty list, an `$in` / `$nin` without a list, and a list given as a
 * plain value (MongoDB would match an element of it; this matcher does not model that, and says so rather than
 * comparing by reference).
 *
 * Supported: equality (strict) on a dotted path, `$eq $ne $gt $gte $lt $lte $in $nin $exists` per field, and `$and`
 * `$or` at any level. A comparison (`$gt $gte $lt $lte`) against a missing or null value never matches, as in MongoDB:
 * JavaScript would read `null >= 0` as true.
 *
 * ## What it is not
 *
 * Not MongoDB. It is a model of these operators for checking a RULE; type brackets, arrays as values and collation are
 * a database's question (the `-db` tests have one). It never changes the document it is given.
 */

/** A filter this matcher cannot evaluate faithfully; `message` names the operator or shape. */
export class UnsupportedFilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedFilterError';
  }
}

/** The value at a dotted path, or undefined where the path leaves the document (through a scalar or a null). */
export function readPath(doc, path) {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const present = (v) => v !== undefined && v !== null;
const list = (op, operand) => {
  if (!Array.isArray(operand)) throw new UnsupportedFilterError(`${op} needs a list`);
  return operand;
};

/** Per-field operators: `(value, operand) => boolean`. */
const FIELD_OPERATORS = {
  $eq: (v, x) => v === x,
  $ne: (v, x) => v !== x,
  $gt: (v, x) => present(v) && v > x,
  $gte: (v, x) => present(v) && v >= x,
  $lt: (v, x) => present(v) && v < x,
  $lte: (v, x) => present(v) && v <= x,
  $in: (v, x) => list('$in', x).includes(v),
  $nin: (v, x) => !list('$nin', x).includes(v),
  $exists: (v, x) => (v !== undefined) === Boolean(x),
};

/** The branches of a `$and` / `$or`: a non-empty list. */
function branches(op, operand) {
  if (!Array.isArray(operand) || operand.length === 0) throw new UnsupportedFilterError(`${op} needs a non-empty list of filters`);
  return operand;
}

/**
 * @param {object} doc the document
 * @param {object} [filter] a MongoDB filter; absent or empty matches everything
 * @returns {boolean}
 * @throws {UnsupportedFilterError} for anything outside the operators above
 */
export function matchesFilter(doc, filter) {
  for (const [key, cond] of Object.entries(filter ?? {})) {
    if (key === '$and') {
      if (!branches(key, cond).every((f) => matchesFilter(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!branches(key, cond).some((f) => matchesFilter(doc, f))) return false;
      continue;
    }
    if (key.startsWith('$')) throw new UnsupportedFilterError(`filter operator ${key} is not supported by the test matcher`);
    const value = readPath(doc, key);
    if (Array.isArray(cond)) throw new UnsupportedFilterError(`${key}: a list as a value is not modelled by the test matcher; use $in`);
    if (cond !== null && typeof cond === 'object') {
      const proto = Object.getPrototypeOf(cond);
      if (proto !== Object.prototype && proto !== null) throw new UnsupportedFilterError(`${key}: an object that is not plain (a Date, say) is not modelled by the test matcher; compare its text`);
      if (Object.keys(cond).length === 0) throw new UnsupportedFilterError(`${key}: an empty operator object selects nothing the test matcher can name`);
      for (const [op, operand] of Object.entries(cond)) {
        const test = Object.hasOwn(FIELD_OPERATORS, op) ? FIELD_OPERATORS[op] : null;
        if (!test) throw new UnsupportedFilterError(`filter operator ${op} is not supported by the test matcher`);
        if (!test(value, operand)) return false;
      }
    } else if (value !== cond) return false;
  }
  return true;
}
