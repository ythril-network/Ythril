/**
 * The client's words for schema violations against the server's table of codes (bundle-285, Q-943).
 *
 * The server raises a violation row with a `code` from `SCHEMA_VIOLATION_CODES` (`server/src/spaces/schema-violation-codes.ts`) and the
 * `params` its sentence names; the client words the row from them (`core/violation-wording.ts`, `VIOLATION_PARAMS`). A code the server gains
 * that the client has no words for would show the server's English on every screen, and a param renamed on one side would make the client
 * fall back without a sound: both look correct to every spec written before the change. So this spec reads the server's source and holds:
 *
 * - the client words exactly the server's codes, no more and no fewer;
 * - per code, the client reads exactly the params the server always sends;
 * - a param the server types as a closed set (`allowlist`, `end`, `comparison`, `cause`, `bound`, `refKind`) has the same members on both
 *   sides, and a param the client narrows where the server says `string` (`type`, `got`) is narrowed to a set the server's source states.
 *
 * It reads server source because the client job does not build the server; it lives under `testing/` for that reason.
 */
import { describe, it, expect } from 'vitest';
import { interfaceBody, aliasLiterals, propertyLiterals, readRepoSource } from './server-source';
import { VIOLATION_PARAMS, VALUE_TYPE_NAMES, FOUND_TYPE_NAMES } from '../core/violation-wording';

const CODES = readRepoSource('server/src/spaces/schema-violation-codes.ts');
const VOCABULARY = readRepoSource('schema/src/vocabulary.ts');
const KNOWLEDGE = readRepoSource('server/src/config/types-knowledge.ts');

/** `code: { params: ['a', 'b'], ... }` per line of the `SCHEMA_VIOLATION_CODES` literal, as the server's own docblock says it is written. */
function serverCodes(): Map<string, string[]> {
  const start = /\bconst\s+SCHEMA_VIOLATION_CODES\s*=\s*\{/.exec(CODES);
  if (!start) throw new Error('no SCHEMA_VIOLATION_CODES literal found — the source moved or was renamed, and a gate over it would report clean about nothing');
  const end = CODES.indexOf('} as const', start.index);
  const body = CODES.slice(start.index + start[0].length, end);
  const out = new Map<string, string[]>();
  for (const m of body.matchAll(/^\s*([a-z_]+)\s*:\s*\{\s*params\s*:\s*\[([^\]]*)\]/gm)) out.set(m[1]!, [...m[2]!.matchAll(/'([^']+)'/g)].map(x => x[1]!));
  return out;
}

/** The type text of each param of one code in `interface SchemaViolationParamsByCode`. */
function serverParamTypes(code: string): Map<string, string> {
  const body = interfaceBody(CODES, 'SchemaViolationParamsByCode');
  const m = new RegExp(`(?:^|\\n)\\s*${code}\\s*:\\s*\\{([^}]*)\\}`).exec(body);
  if (!m) throw new Error(`SchemaViolationParamsByCode names no ${code}`);
  const out = new Map<string, string>();
  for (const p of m[1]!.split(';')) {
    const kv = /^\s*(\w+)\s*:\s*(.+?)\s*$/.exec(p);
    if (kv) out.set(kv[1]!, kv[2]!);
  }
  return out;
}

/** The members of a closed set the server types a param with: literals written out, or an alias of them. */
function serverMembers(typeText: string): string[] | null {
  const literals = [...typeText.matchAll(/'([^']+)'/g)].map(x => x[1]!);
  if (literals.length) return literals;
  if (typeText === 'RefKind') {
    const m = /\bconst\s+REF_KINDS\s*=\s*\[([^\]]*)\]/.exec(KNOWLEDGE);
    if (!m) throw new Error('no REF_KINDS found');
    return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!);
  }
  if (/^[A-Z]\w*$/.test(typeText)) return aliasLiterals(CODES, typeText);
  return null;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** Params the server types as plain text that the client words from a closed set, and the set in the server's source it must equal. */
const NARROWED: Record<string, () => readonly string[]> = {
  // The declared type of a property: PropertySchema.type in the schema package.
  'type.type': () => propertyLiterals(VOCABULARY, 'PropertySchema', 'type'),
  // `typeof value` of a JSON value the validator met after its own check (`typeof value !== expectedJsType`): never undefined, a function or a symbol.
  'type.got': () => ['string', 'number', 'boolean', 'object'],
};

describe('the client words exactly the server\'s schema violation codes (Q-943)', () => {
  const codes = serverCodes();

  it('reads the server\'s table (a floor, so a changed spelling of the table cannot pass by finding none)', () => {
    expect(codes.size).toBeGreaterThanOrEqual(15);
  });

  it('every server code has words, and the client words no code the server does not raise', () => {
    expect(sorted(Object.keys(VIOLATION_PARAMS))).toEqual(sorted([...codes.keys()]));
  });

  it('per code, the client reads exactly the params the server always sends', () => {
    const differ: string[] = [];
    for (const [code, params] of codes) {
      const client = Object.keys((VIOLATION_PARAMS as Record<string, Record<string, unknown>>)[code] ?? {});
      if (sorted(client).join() !== sorted(params).join()) differ.push(`${code}: server [${params.join(', ')}], client [${client.join(', ')}]`);
    }
    expect(differ).toEqual([]);
  });

  it('a param the server types as a closed set has the same members in the client\'s words; one it types as text is text, a number or a list there', () => {
    const differ: string[] = [];
    for (const code of codes.keys()) {
      const shapes = (VIOLATION_PARAMS as Record<string, Record<string, unknown>>)[code] ?? {};
      for (const [param, typeText] of serverParamTypes(code)) {
        const shape = shapes[param];
        const narrowed = NARROWED[`${code}.${param}`];
        if (narrowed) {
          if (!Array.isArray(shape) || sorted(shape).join() !== sorted(narrowed()).join()) differ.push(`${code}.${param}: narrowed to ${JSON.stringify(shape)}, the server's source says ${JSON.stringify(narrowed())}`);
          continue;
        }
        const want = typeText === 'string' ? 'text' : typeText === 'number' ? 'number' : typeText === 'string[]' ? 'list' : serverMembers(typeText);
        if (want === null) { differ.push(`${code}.${param}: server type \`${typeText}\` is not read by this spec`); continue; }
        const same = Array.isArray(want) ? Array.isArray(shape) && sorted(shape).join() === sorted(want).join() : shape === want;
        if (!same) differ.push(`${code}.${param}: server ${JSON.stringify(want)}, client ${JSON.stringify(shape)}`);
      }
    }
    expect(differ).toEqual([]);
  });

  it('the narrowed sets are the ones the words name (a type name the server can send has its own words)', () => {
    expect(sorted(VALUE_TYPE_NAMES)).toEqual(sorted(NARROWED['type.type']!()));
    expect(sorted(FOUND_TYPE_NAMES)).toEqual(sorted(NARROWED['type.got']!()));
  });

  it('the spec itself fails on a code or a param the client lacks (a gate that has never failed is a claim)', () => {
    const withNew = new Map([...codes, ['brand_new', ['x']]]);
    expect(sorted(Object.keys(VIOLATION_PARAMS))).not.toEqual(sorted([...withNew.keys()]));
    expect(serverParamTypes('type').get('got')).toBe('string');
    expect(serverMembers("'from' | 'to'")).toEqual(['from', 'to']);
    expect(serverMembers('RuleNotEvaluatedCause')).toContain('not_boolean');
    expect(serverMembers('RefKind')).toContain('file');
  });
});
