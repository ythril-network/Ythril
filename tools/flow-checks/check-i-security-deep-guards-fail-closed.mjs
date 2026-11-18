#!/usr/bin/env node
/**
 * check-i-security-deep-guards-fail-closed: every guard that takes a rights matrix or a caller is fed an empty, a missing and an undefined policy
 * and reaches nothing, never everything.
 *
 * Rule (the flow node's stated assertion): derive the guards from the guard module; call each with empty, missing and undefined policy; each must deny.
 *
 *   - The guard module is the server's `auth/` folder (the tracked non-spec `.ts` files of it, read for their declarations); the built twin under
 *     `server/dist` is what is called, behind `_built-registry.mjs`'s refusal of a stale or missing build.
 *   - A GUARD is an exported, non-generic function of that folder whose FIRST parameter is a policy (its declared type names `TokenRights`, or a
 *     caller or holder type, or an object type with a `rights` member) and which answers a permission question in a shape that has a deny: a
 *     predicate (`boolean`, true permits) named as the module names them (`may*`, `can*`, `holds*`, `administers*`, `reaches*`, `is*Admin*`), a
 *     refusal (`string | null`, `null` permits) named `*Refusal`, or a list of spaces named `reachable*`, `spaces*` or `spaceAdmin*` (an empty list denies).
 *     The shape and the name together are the derivation: a function that asks something else (a token's liveness, whether MFA is required, whether a
 *     leave is allowed) is not a guard and is not called. A guard written under another name is outside the probe: the limit, said here.
 *   - THE POLICIES. For a rights parameter: `undefined`, `null`, `{}` and the empty rights the server itself builds (`repairRights({})`). For a
 *     caller or holder: `undefined`, `null`, `{}`, `{ rights: null }` and `{ rights: <the empty rights> }`. The other parameters are a space name, a list
 *     of one space, the first area and rung, a zero or false, by their declared type; an unknown type gets `{}`.
 *   - A guard PERMITS when it answers `true`, `null`, or a non-empty list; that is a finding (id `<file>:<name>`). A guard that THROWS on a missing
 *     policy fails closed (the call does not go through) and is counted in the verdict, not a finding.
 *   - Exceptions live only in `check-i-security-deep-guards-fail-closed.allow.json` beside this file (`{ id, reason, reviewBy }`), through
 *     `_allow.mjs`. The verdict says how many guards were derived, how many answered, how many threw, and how many exceptions it used.
 *
 * The failure that bought it (Q-917): the check is named by the security lens and answered "cannot answer" from a placeholder, while the repository's
 * own history is the shape: an unscoped token stored as `null` reached everything (`write-anywhere.ts`), and a missing area row read as reach
 * (`space-reach.ts`): an absent policy took for "no restriction".
 *
 *     npm run build:server && node tools/flow-checks/check-i-security-deep-guards-fail-closed.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackedSources, REPO_ROOT, SERVER_SOURCE_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { argumentsOf } from '../../testing/standalone/_structural-window.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { builtRegistry } from './_built-registry.mjs';

/** The guard module: the server's auth folder. */
export const GUARD_DIR = `${SERVER_SOURCE_ROOT}/auth`;

const PREDICATE_NAME = /^(?:may|can|holds?|administers|reaches|is\w*Admin\w*)/;
const REFUSAL_NAME = /Refusal$/;
const LIST_NAME = /^(?:reachable|spaces|spaceAdmin)/;

/** The type of a parameter text `name?: Type = default`, or null. */
const typeOf = (param) => /^\s*\.{0,3}\w+\??\s*:\s*([\s\S]*?)(?:\s*=[^=>][\s\S]*)?$/.exec(param)?.[1].trim() ?? null;

/** Is this first-parameter type a policy: a rights matrix or something that carries one? */
export const isPolicyType = (type) => /\bTokenRights\b|\bCaller\b|\bHolder\b|\brights\??\s*:/.test(type ?? '');

/** Is it the rights matrix itself, and not a record that carries one? */
export const isRightsType = (type) => /\bTokenRights\b/.test(type ?? '') && !/\brights\??\s*:|\bCaller\b|\bHolder\b/.test(type);

/**
 * `[{ file, name, kind, policy, rest }]`: the guards a source declares (comments stripped here). `kind` is `predicate`, `refusal` or `list`;
 * `policy` is `rights` or `record`; `rest` the declared types of the parameters after the policy.
 */
export function guardsIn(file, text) {
  const code = stripComments(text);
  const out = [];
  for (const m of code.matchAll(/^export\s+function\s+(\w+)\s*\(/gm)) {
    const open = m.index + m[0].length - 1;
    let params;
    try { params = argumentsOf(code, open, `${file} ${m[1]}`); } catch { continue; }
    let close = open;
    for (let depth = 0; close < code.length; close += 1) {
      if (code[close] === '(') depth += 1;
      else if (code[close] === ')' && --depth === 0) break;
    }
    const ret = /^\s*:\s*([^{;]+?)\s*\{/.exec(code.slice(close + 1, close + 200))?.[1];
    const first = typeOf(params[0] ?? '');
    if (!ret || !isPolicyType(first)) continue;
    const kind = /^boolean$/.test(ret) && PREDICATE_NAME.test(m[1]) ? 'predicate'
      : /^string\s*\|\s*null$/.test(ret) && REFUSAL_NAME.test(m[1]) ? 'refusal'
        : /\[\]$/.test(ret) && LIST_NAME.test(m[1]) ? 'list' : null;
    if (!kind) continue;
    out.push({ file, name: m[1], kind, policy: isRightsType(first) ? 'rights' : 'record', rest: params.slice(1).map((p) => (/^\s*\.{0,3}\w+\?\s*:/.test(p) ? null : typeOf(p))).filter((t) => t !== null) });
  }
  return out;
}

/** The members of an object type's text `{ a: T; b?: U }` as `[name, type]`, the optional ones left out; `null` when the text is not an object type. */
function membersOf(type) {
  const t = type.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const parts = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < t.length - 1; i += 1) {
    const c = t[i];
    if ('{[(<'.includes(c)) depth += 1;
    else if ('}])>'.includes(c) && !(c === '>' && t[i - 1] === '=')) depth -= 1;
    else if ((c === ';' || c === ',') && depth === 0) { parts.push(t.slice(start, i)); start = i + 1; }
  }
  parts.push(t.slice(start, t.length - 1));
  return parts.map((p) => /^\s*(\w+)(\??)\s*:\s*([\s\S]+)$/.exec(p)).filter((m) => m && !m[2]).map((m) => [m[1], m[3].trim()]);
}

/** A value for a parameter of this declared type. */
export function sampleFor(type) {
  const members = membersOf(type);
  if (members) return Object.fromEntries(members.map(([k, t]) => [k, sampleFor(t)]));
  if (/string\s*\[\]|Array<string>/.test(type)) return ['a-space'];
  if (/^string$|^string\s*\|/.test(type)) return 'a-space';
  if (/SpaceArea/.test(type)) return 'knowledge';
  if (/Rung/.test(type)) return 'read';
  if (/^number$/.test(type)) return 0;
  if (/^boolean$/.test(type)) return false;
  return {};
}

/** The policies a guard is fed: the empty, the missing and the undefined, in the shape its first parameter asks for. */
export function emptyPolicies(policy, emptyRights) {
  return policy === 'rights'
    ? [undefined, null, {}, emptyRights]
    : [undefined, null, {}, { rights: null }, { rights: emptyRights }];
}

/** `'permits'`, `'denies'` or `'threw'` for one call. */
export function outcomeOf(kind, call) {
  let r;
  try { r = call(); } catch { return 'threw'; }
  const permits = kind === 'predicate' ? r === true : kind === 'refusal' ? r === null : Array.isArray(r) ? r.length > 0 : r !== undefined && r !== null;
  return permits ? 'permits' : 'denies';
}

/**
 * `{ findings, answered, threw }`: each guard against each empty policy. `fns` maps `<file>:<name>` to the function.
 *
 * @param {object[]} guards from {@link guardsIn}
 * @param {Map<string, Function>} fns
 */
export function guardFindings(guards, fns, emptyRights) {
  const findings = [];
  let answered = 0;
  let threw = 0;
  const unreached = [];
  for (const g of guards) {
    const fn = fns.get(`${g.file}:${g.name}`);
    if (!fn) throw new CannotAnswer(`${g.file} declares ${g.name} and the build does not export it`);
    const rest = g.rest.map(sampleFor);
    const results = emptyPolicies(g.policy, emptyRights).map((p, i) => ({ i, p, o: outcomeOf(g.kind, () => fn(p, ...rest)) }));
    answered += results.filter((r) => r.o !== 'threw').length;
    threw += results.filter((r) => r.o === 'threw').length;
    if (results.every((r) => r.o === 'threw')) unreached.push(`${g.file}:${g.name}`);
    const bad = results.find((r) => r.o === 'permits');
    if (bad) findings.push({ id: `${g.file}:${g.name}`, text: `${g.file} ${g.name}() permits when its policy is ${bad.p === undefined ? 'undefined' : JSON.stringify(bad.p).slice(0, 60)}` });
  }
  return { findings, answered, threw, unreached };
}

export function decide({ guards, fns, emptyRights }, allow, todayDate) {
  if (guards.length < 10) throw new CannotAnswer(`only ${guards.length} guard(s) derived from the guard module: the declarations were not read`);
  const { findings, answered, threw, unreached } = guardFindings(guards, fns, emptyRights);
  // A guard that threw on every policy was not asked a question this probe can read: a sample argument may be the reason, so it is no pass.
  if (unreached.length) throw new CannotAnswer(`${unreached.length} guard(s) threw on every policy and were not read: ${unreached.slice(0, 4).join(', ')}`);
  const { problem, open, used } = applyAllow(findings, allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${guards.length} guard(s) derived, ${answered} answer(s), ${threw} call(s) threw and so failed closed, ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} guard(s) permit on an empty policy: ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`every guard denies an empty, missing or undefined policy (${tail})`);
}

/** The real tree's input for {@link decide}. */
export async function realInput() {
  await builtRegistry();
  const files = trackedSources([GUARD_DIR], { ext: ['.ts'], floor: 20, specs: false });
  const guards = files.flatMap((f) => guardsIn(f, readFileSync(join(REPO_ROOT, f), 'utf8')));
  const fns = new Map();
  for (const f of new Set(guards.map((g) => g.file))) {
    const mod = await import(pathToFileURL(join(REPO_ROOT, f.replace(`${SERVER_SOURCE_ROOT}/`, 'server/dist/').replace(/\.ts$/, '.js'))).href);
    for (const g of guards.filter((x) => x.file === f)) fns.set(`${f}:${g.name}`, mod[g.name]);
  }
  const shape = await import(pathToFileURL(join(REPO_ROOT, 'server', 'dist', 'config', 'rights-shape.js')).href);
  const emptyRights = shape.repairRights({})?.rights;
  if (!emptyRights) throw new CannotAnswer('the server builds no empty rights from repairRights({})');
  return { guards, fns, emptyRights };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(await realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
