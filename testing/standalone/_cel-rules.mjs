/**
 * Fixtures for the CEL rules tests (F-46): the rule builders, the schema-body parsers and the record builders every
 * `a-cel-rule-*.test.js` file shares, so a rule written for one limit is the same rule when the next file asks about it.
 *
 * ## What the rules tests specify (the contract the implementation is held to)
 *
 * Wire shape. A type schema carries `rules: { <name>: { rule, message } }`; a space carries
 * `meta.rules: { <name>: { rule, message, kinds? } }` where `kinds` is a list of knowledge types (`entity`, `edge`,
 * `fact`, `chrono`; absent or empty = every kind). A rule is a CEL expression over `self`, the RECORD VIEW:
 * `title`, `type`, `description`, `tags`, `properties` (a map), and on an edge `label` (no `title`; never `from`/`to`).
 *
 * Seams the tests drive, in the order of how little they invent:
 *   - `TypeSchemasZ` / `SpaceMetaBody` (`spaces/body-schemas.ts`): save-time refusals, as zod issues;
 *   - `planSpaceMetaUpdate` / `mergeSpaceMeta` / `mergeReplicatedMeta` / `effectiveMeta` / `applyMetaRound`: the merges;
 *   - `validateEntity|Edge|Fact|Chrono(meta, view)` with `view = recordViewOf(kind, mergedRecord)` from `brain/record-view.ts`:
 *     evaluation. A violation of a rule is `{ field: 'rules.<name>' }` (`'meta.rules.<name>'` for a space rule), its `reason`
 *     the rule's message followed by a short hash of the rule text; a rule that could not run says "could not be evaluated"
 *     and one over the input caps says "too large to check", neither echoing a value;
 *   - `spaces/schema-rules.ts` for the three things only it can answer: `ruleEvaluationCount()` (a monotonic count of rule
 *     evaluations), `invalidRulesOf(meta)` (the stored rules that no longer compile, names only) and `checkStoredRules()` (the
 *     boot check's work, which also runs the canary self-test).
 *
 * A name the implementation chooses differently is changed HERE and in the one test that names it, not in forty places.
 */

export const REPO_DIST = '../../server/dist/';

export const { TypeSchemasZ, SpaceMetaBody } = await import(`${REPO_DIST}spaces/body-schemas.js`);

/** The four knowledge types a rule can govern, as the schema keys them (singular). */
export const KINDS = Object.freeze(['entity', 'edge', 'fact', 'chrono']);

/** A rule with a message; the message is what a refused write says, so it is distinctive per call. */
export const rule = (expression, message = 'the record must satisfy this rule') => ({ rule: expression, message });

/** `true && true && ...` with `n` operands: 2n - 1 AST nodes, whatever way a sensible counter walks it. */
export const andChain = (n) => Array(n).fill('true').join(' && ');

/**
 * An expression with EXACTLY `nodes` AST nodes (a call, a constant, an identifier and a selection each count one): 199 and
 * 201 are the plain `&&` chains of 100 and 101 operands, 200 is the chain of 100 under one `!`. (The parser folds `!!`, so a
 * second negation does not add a node.)
 */
export function expressionOfNodes(nodes) {
  if (nodes === 199) return andChain(100);
  if (nodes === 200) return `!(${andChain(100)})`;
  if (nodes === 201) return andChain(101);
  throw new Error(`no fixture of ${nodes} nodes`);
}

/** A string-comparison rule of EXACTLY `length` characters (padding sits inside the literal), on property `a`. */
export function ruleOfLength(length, property = 'a') {
  const head = `self.properties.${property} == '`;
  const tail = `'`;
  const pad = length - head.length - tail.length;
  if (pad < 0) throw new Error(`a rule of ${length} characters cannot hold ${head}`);
  return `${head}${'x'.repeat(pad)}${tail}`;
}

/** `n` distinct trivial rules, `<prefix>1 ... <prefix>n`, each reading property `a`. */
export function manyRules(n, { prefix = 'r', expression = `self.properties.a != 'forbidden'` } = {}) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i + 1}`, rule(expression, `rule ${prefix}${i + 1} failed`)]));
}

/** The properties every type fixture declares: a string, a number and a boolean. */
export const DECLARED = Object.freeze({
  a: { type: 'string' },
  b: { type: 'number' },
  flag: { type: 'boolean' },
});

/** `{ <kind>: { <typeName>: { propertySchemas, rules } } }` — the `typeSchemas` body for one type. */
export const typeSchemasOf = (kind, typeName, rules, propertySchemas = DECLARED) =>
  ({ [kind]: { [typeName]: { propertySchemas, ...(rules === undefined ? {} : { rules }) } } });

/** The save-time verdict on one type's rules (the zod body every write of a type schema parses through). */
export const parseTypeRules = (kind, rules, propertySchemas = DECLARED, typeName = 'thing') =>
  TypeSchemasZ.safeParse(typeSchemasOf(kind, typeName, rules, propertySchemas));

/** The save-time verdict on a space's rules. */
export const parseSpaceRules = (rules) => SpaceMetaBody.safeParse({ rules });

/** What a refusal says, flattened: the issue paths and messages, for an assertion that names both. */
export function issuesOf(result) {
  if (result.success) return [];
  // A type body is a union (a `$ref` or an inline schema), so a problem INSIDE the inline branch arrives as one
  // `invalid_union` issue whose real paths are nested: flatten them, with the parent's path in front.
  const flat = (issues, prefix) => issues.flatMap((i) => {
    const path = [...prefix, ...i.path];
    const here = { path: path.join('.'), message: i.message, ...(i.keys ? { keys: i.keys } : {}) };
    return i.code === 'invalid_union' ? [here, ...(i.errors ?? []).flatMap(branch => flat(branch, path))] : [here];
  });
  return flat(result.error.issues, []);
}
export const issuesText = (result) => JSON.stringify(issuesOf(result));

/** Assert a save-time refusal that is ABOUT the rule (its path runs through `rules`), not about some other key. */
export function refusedOnRules(assert, result, what) {
  assert.equal(result.success, false, `${what}: the body was ACCEPTED`);
  const onRules = issuesOf(result).filter(i => /(^|\.)rules(\.|$)/.test(i.path));
  assert.ok(onRules.length > 0,
    `${what}: refused, but not on \`rules\` (a refusal for another reason would pass this by accident): ${issuesText(result)}`);
  return onRules;
}

/** Assert a body is accepted, and say what refused it when it is not. */
export function accepted(assert, result, what) {
  assert.equal(result.success, true, `${what}: refused, ${issuesText(result)}`);
}

/** Mint the key a hostile caller would choose, as an OWN key (an object literal's `__proto__` sets the prototype instead). */
export const ownKeyed = (name, value) => JSON.parse(`{${JSON.stringify(name)}:${JSON.stringify(value)}}`);

// ── Evaluation fixtures ─────────────────────────────────────────────────────────────────────────────────────────────

/** A strict meta carrying `rules` on one type of one kind (and optionally space rules), the way a stored schema holds them. */
export function strictMeta({ kind = 'entity', typeName = 'thing', rules, spaceRules, propertySchemas = DECLARED, mode = 'strict' } = {}) {
  return {
    validationMode: mode,
    typeSchemas: typeSchemasOf(kind, typeName, rules, propertySchemas),
    ...(spaceRules ? { rules: spaceRules } : {}),
  };
}

/** The merged stored-shaped record `recordViewOf` takes, per kind: what a write would leave in the collection. */
export const recordOf = {
  entity: (o = {}) => ({ name: 'Acme', type: 'thing', description: '', tags: [], properties: {}, ...o }),
  edge: (o = {}) => ({ from: 'from-id', to: 'to-id', label: 'thing', description: '', tags: [], properties: {}, ...o }),
  fact: (o = {}) => ({ fact: 'a fact', type: 'thing', tags: [], properties: {}, ...o }),
  chrono: (o = {}) => ({ title: 'An event', type: 'thing', description: '', tags: [], properties: {}, ...o }),
};

/** `validateX` per kind, by name, so a loop over KINDS reads the exports without a switch. */
export const VALIDATOR = Object.freeze({ entity: 'validateEntity', edge: 'validateEdge', fact: 'validateFact', chrono: 'validateChrono' });

/** The rows of `violations` that belong to rules (a type rule's `rules.<name>` or a space rule's `meta.rules.<name>`). */
export const ruleRows = (violations) => violations.filter(v => /^(meta\.)?rules\./.test(v.field));

/** The loaded engine modules, built lazily so a file that only parses bodies never needs the evaluation half. */
export async function evaluation() {
  const [validation, writeValidation] = await Promise.all([
    import(`${REPO_DIST}spaces/schema-validation.js`),
    import(`${REPO_DIST}brain/write-validation.js`),
  ]);
  return { validation, writeValidation };
}

/** The one function that builds the view a validator takes (`brain/record-view.ts`). */
export const recordViewOf = async (kind, record) => (await import(`${REPO_DIST}brain/record-view.js`)).recordViewOf(kind, record);

/** Validate `record` of `kind` against `meta` the one way a write does: build the view, hand it to the validator. */
export async function validateRecord(meta, kind, record) {
  const { validation } = await evaluation();
  return validation[VALIDATOR[kind]](meta, await recordViewOf(kind, record));
}

/** The schema-rules module: limits, the evaluation counter, the stored-rule report and the boot check. */
export const schemaRules = () => import(`${REPO_DIST}spaces/schema-rules.js`);
