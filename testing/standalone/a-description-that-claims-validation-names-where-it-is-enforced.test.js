/**
 * A tool description that says a field is validated, checked or held to an allowlist must be telling the truth
 * about THAT field: the validator of its record kind has to be able to refuse it.
 *
 * ## Why this, and the sentence it was written from
 *
 * `update_edge` told a caller, in its parameter list, that `type` is *"replaced when sent, and re-validated
 * against the space's edge-type allowlist."* Nothing validates it. `validateEdge` reads an edge's `label` and its
 * `properties` and refuses on nothing else; the edge-type allowlist is keyed by LABEL, and an edge's `type` is a
 * free-text property on every door. The sentence was a copy of its siblings' (`update_entity` and `update_chrono`
 * really do re-validate `type`), written when the tool was, and a caller who believed it would conclude a typo in
 * `type` is caught. **A validation claim is the one kind of sentence a caller relies on silently**: the day they
 * are wrong, the refusal they expected never comes and nothing reports it (`Q-441`, found by an audit, not a test).
 *
 * ## What counts as a claim, and what it is tied to
 *
 * A sentence of a description matching `validated against`, `re-validated`, `checked against` or `allowlist`.
 * It is held to a FIELD, and only a tied claim is held:
 *
 * - **In a property's own description**, the field is that property. The path says which collection it is in
 *   (`save_bulk`'s `entities.type` is an entity's `type`).
 * - **In a tool's description**, the fields are the backticked names in the SAME sentence that are parameters of
 *   the tool; when the sentence names none, it inherits the lead of its bullet (`- \`type\` — … Re-validated
 *   against the allowlist.`). A bullet leading several fields (`name` / `type` / `description`) does not make a
 *   sentence about one of them a claim about all three.
 * - **A sentence that names no field** (`the record … is checked against the space schema`) is about the whole
 *   record and is not held here: it has nothing to be wrong about at the level of one field.
 *
 * ## What counts as enforced
 *
 * The record kind comes from the tool's name (`update_edge` is an edge) or from the collection a bulk item sits
 * in, derived from the validators themselves. The claim holds when `validate<Kind>` in
 * `spaces/schema-validation.ts` pushes a violation naming the field (`field: 'type'`), or, for `properties`,
 * hands them to the helper that pushes `properties.<key>` violations. **A READ is not a refusal**: that a validator
 * mentions `edge.type` is not evidence it can refuse it.
 *
 * ## Stated limits
 *
 * It is found by a violation call naming the field, in the validator of the kind. A refusal that lives only in a
 * tool's own handler reads as unenforced here, which errs in the safe direction: move the check into the
 * validator (the one place both doors reach) or name it in the sentence. Tools with no record kind
 * (`update_file_meta`'s link refusals, `schema_update`'s setting, `list_tokens`) are outside what this checks, and
 * claims with no field in the sentence are not read. The title is about a description that CLAIMS validation of a
 * field; it is not a claim that every such sentence in the product has been checked.
 *
 * ## Derived, and floored
 *
 * The tools are the built registry, the kinds are the exported `validate<Kind>` functions, and the sentences are
 * read from the descriptions as shipped. Claims have to be found, enough of them tied, and at least one must hold,
 * before a clean result means anything: a scan that finds nothing passes.
 *
 * ## Seen red
 *
 * On the base this was written against: `update_edge`'s `type`. The other claims in the registry hold, which is
 * what the floor on the enforced ones is for.
 *
 * Run: node --test testing/standalone/a-description-that-claims-validation-names-where-it-is-enforced.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

const CLAIM = /validated against|re-validated|checked against|allowlist/i;
const SPACE_SCHEMAS = { requiredSpace: { type: 'string', description: 'Space.' }, optionalSpace: { type: 'string', description: 'Space.' } };
const VALIDATION_SOURCE = 'server/src/spaces/schema-validation.ts';

const validationSource = stripComments(readFileSync(join(REPO_ROOT, VALIDATION_SOURCE), 'utf8')).replace(/\r\n/g, '\n');

/** The text of one top-level function: from its `function name(` to the closing brace at column 0. */
function bodyOf(name) {
  const at = validationSource.search(new RegExp(`function ${name}\\s*\\(`));
  if (at === -1) return null;
  const end = validationSource.indexOf('\n}\n', at);
  return validationSource.slice(at, end === -1 ? undefined : end);
}

/** `entity` -> its validator body, for every exported `validate<Kind>` in the module. */
const VALIDATORS = new Map(
  [...validationSource.matchAll(/export function validate([A-Z]\w*)\s*\(/g)]
    .map(m => [m[1].toLowerCase(), bodyOf(`validate${m[1]}`)]));

/** `facts` -> `fact`, `entities` -> `entity`, `edges` -> `edge`, `chrono` -> `chrono`: a collection name read as a kind. */
function kindOfWord(word) {
  const w = word.toLowerCase();
  for (const candidate of [w, w.replace(/ies$/, 'y'), w.replace(/s$/, '')]) if (VALIDATORS.has(candidate)) return candidate;
  return null;
}

const sentencesOf = text => String(text).split(/(?<=[.;!?])\s+/).map(s => s.trim()).filter(Boolean);
const BULLET = /^-\s+((?:`[A-Za-z_][\w.]*`(?:\s*\/\s*)?)+)\s*[—-]/;

/** Every parameter name a tool's schema declares, at any depth. */
function parameterNames(schema, out = new Set()) {
  if (Array.isArray(schema)) { schema.forEach(s => parameterNames(s, out)); return out; }
  if (!schema || typeof schema !== 'object') return out;
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && v && typeof v === 'object') for (const [p, sub] of Object.entries(v)) { out.add(p); parameterNames(sub, out); }
    else parameterNames(v, out);
  }
  return out;
}

/**
 * Every claim sentence of one tool, with what it is tied to: `{ tool, where, sentence, kind, fields }`.
 * `fields` is empty when the sentence is not tied to one (and is then not held).
 */
function claimsOf(tool) {
  const schema = tool.inputSchema(SPACE_SCHEMAS);
  const params = parameterNames(schema);
  const toolKind = kindOfWord(tool.name.split('_').at(-1));
  const out = [];

  // A property's own description: the field is the property, the kind is the tool's or the collection's.
  (function walk(node, path) {
    if (Array.isArray(node)) { node.forEach(n => walk(n, path)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') {
        for (const sentence of sentencesOf(v).filter(s => CLAIM.test(s))) {
          const kind = toolKind ?? kindOfWord(path[0] ?? '');
          out.push({ tool: tool.name, where: path.join('.') || '(top)', sentence, kind, fields: path.length ? [path.at(-1)] : [] });
        }
      } else if (k === 'properties' && v && typeof v === 'object') {
        for (const [p, sub] of Object.entries(v)) walk(sub, [...path, p]);
      } else walk(v, path);
    }
  })(schema, []);

  // The tool's own description, line by line so a bullet's lead can be inherited.
  for (const line of String(tool.description).split('\n')) {
    const lead = BULLET.exec(line.trim());
    const leadFields = lead ? [...lead[1].matchAll(/`([^`]+)`/g)].map(m => m[1]) : [];
    for (const sentence of sentencesOf(line).filter(s => CLAIM.test(s))) {
      const named = [...sentence.matchAll(/`([A-Za-z_][\w.]*)`/g)].map(m => m[1]).filter(n => params.has(n));
      out.push({ tool: tool.name, where: '(description)', sentence, kind: toolKind, fields: named.length ? named : leadFields });
    }
  }
  return out;
}

const CLAIMS = ALL_TOOLS.flatMap(claimsOf);
const TIED = CLAIMS.filter(c => c.kind && c.fields.length > 0);

/** Does `validate<kind>` push a violation naming `field`? */
function enforced(kind, field) {
  const body = VALIDATORS.get(kind) ?? '';
  if (field === 'properties') {
    const helper = bodyOf('validatePropertiesAgainstSchema') ?? '';
    return body.includes('validatePropertiesAgainstSchema(') && /field:\s*`properties\./.test(helper);
  }
  return new RegExp(`field:\\s*'${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(body);
}

describe('the claim scan reads before it concludes', () => {
  it('finds the validators, the tools and the sentences', () => {
    assert.ok(VALIDATORS.size >= 4 && [...VALIDATORS.values()].every(Boolean), 'the `validate<Kind>` functions were not all found; the evidence search would find nothing');
    assert.ok(ALL_TOOLS.length >= 30, 'the built tool registry is not being read');
    assert.ok(CLAIMS.length >= 8, 'too few validation claims were found in the descriptions; the sentence scan broke');
  });

  it('enough claims are tied to a field and a kind, and the validators can hold some of them', () => {
    assert.ok(TIED.length >= 5, 'too few claims are tied to a field of a record kind; the tie rules stopped matching');
    assert.ok(TIED.some(c => c.fields.some(f => enforced(c.kind, f))),
      'no tied claim is enforced by its validator, so the evidence search is broken rather than every sentence untrue');
  });
});

describe('a description that claims validation of a field names a validator that refuses it', () => {
  it('every tied claim is enforced by the validator of its kind', () => {
    const offenders = [];
    for (const c of TIED) {
      for (const field of c.fields) {
        if (enforced(c.kind, field)) continue;
        offenders.push(`${c.tool} [${c.where}] claims \`${field}\` is validated, but validate${c.kind[0].toUpperCase()}${c.kind.slice(1)} `
          + `(${VALIDATION_SOURCE}) pushes no violation naming it: "${c.sentence.slice(0, 120)}"`);
      }
    }
    assert.deepEqual(offenders, [],
      'a tool description promises a refusal that no validator makes:\n  ' + offenders.join('\n  ')
      + '\n\nA caller who believes the sentence concludes a mistake in that field is caught. Either make the validator refuse it '
      + '(on every door, in `spaces/schema-validation.ts`) or say in the sentence what the field really is.');
  });
});
