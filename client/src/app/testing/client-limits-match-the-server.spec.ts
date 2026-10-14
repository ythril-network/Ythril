/**
 * The rule limits the editor SHOWS are the ones the API ENFORCES, and the editor's `rules` types name every key the
 * API accepts for a rule.
 *
 * ## Why a gate
 *
 * The Schema tab prints a counter beside the rule and message boxes (characters used / limit), and refuses to
 * offer an "add rule" past the per-type and per-space caps. Those numbers are a SECOND COPY of constants the server
 * enforces in `spaces/schema-rules.ts`. This repo's most expensive recurring defect is one rule with two
 * implementations where the weaker one wins silently: a counter reading 1000 against a server that stopped at
 * 800 tells an operator a rule fits and then refuses the save. A copy is acceptable only while something compares
 * it, which turns the copy into a cache. Precedent: `testing/standalone/merge-fns-match-the-server.test.js`.
 *
 * ## Why it cannot pass vacuously
 *
 * Every subject is FOUND before it is compared. A server file that does not exist, a constant that was renamed, a
 * client module that was never written or one whose literal could not be parsed each fail with a sentence naming
 * what is missing — never as two empty things being equal.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT } from './tracked-sources';
import { interfaceBody, interfaceKeys, readClientSource, readRepoSource } from './server-source';

const SERVER_RULES = 'server/src/spaces/schema-rules.ts';
const SERVER_BODIES = 'server/src/spaces/body-schemas.ts';
const CLIENT_LIMITS = 'src/app/shared/rule-limits.ts';
const CLIENT_TYPES = 'src/app/core/api.types.ts';

/**
 * Which server constant each client limit answers. The six server names are the fixed contract of this change
 * (`MAX_RULE_LENGTH` ... `RULE_NAME_PATTERN`); the SET of server limits is derived below, so a seventh constant
 * with no client twin is a red line here rather than a number the editor never shows.
 */
const PAIRS: ReadonlyArray<readonly [client: string, server: string]> = [
  ['ruleMax', 'MAX_RULE_LENGTH'],
  ['messageMax', 'MAX_MESSAGE_LENGTH'],
  ['perType', 'MAX_RULES_PER_TYPE'],
  ['perSpace', 'MAX_RULES_PER_SPACE'],
  ['perRecord', 'MAX_APPLICABLE_RULES'],
  ['namePattern', 'RULE_NAME_PATTERN'],
];

const exists = (repoRelative: string): boolean => existsSync(resolve(CLIENT_ROOT, '..', repoRelative));

/** The server file's source, or an error that says WHICH file is missing rather than an ENOENT. */
function serverSource(path: string): string {
  if (!exists(path)) {
    throw new Error(`${path} does not exist — the rule limits the client shows have nothing to be compared against`);
  }
  return readRepoSource(path);
}

/** `export const NAME = <number | regex literal | string>` for every exported constant whose name starts MAX_ or ends _PATTERN. */
function serverConstants(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/export\s+const\s+((?:MAX_\w+)|(?:\w*_PATTERN))\s*(?::[^=]+)?=\s*([^;\n]+);?/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const asNumber = (literal: string): number => Number(literal.replace(/_/g, ''));

/** A pattern written as a regex literal or a string, reduced to its source text. */
function patternSource(literal: string): string {
  const re = /^\/(.*)\/[a-z]*$/.exec(literal);
  if (re) return re[1]!;
  const str = /^(['"`])(.*)\1$/.exec(literal);
  return str ? str[2]!.replace(/\\\\/g, '\\') : literal;
}

/** `RULE_LIMITS = { key: value, ... }` as literal text per key. */
function clientLimits(src: string): Record<string, string> {
  const m = /export\s+const\s+RULE_LIMITS\b[^=]*=\s*\{/.exec(src);
  if (!m) throw new Error(`no \`export const RULE_LIMITS = { ... }\` found in ${CLIENT_LIMITS}`);
  // The object's end is found by scanning with string literals skipped: a pattern value holds `{0,63}` itself.
  let i = m.index + m[0].length;
  const from = i;
  for (let depth = 1, quote = ''; i < src.length && depth > 0; i++) {
    const ch = src[i]!;
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  const inner = src.slice(from, i - 1);
  const out: Record<string, string> = {};
  for (const e of inner.matchAll(/(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^,\n]+)/g)) out[e[1]!] = e[2]!.trim();
  return out;
}

describe('the server rule limits exist and are found before anything is compared', () => {
  it('server/src/spaces/schema-rules.ts exports every limit the editor shows a counter for', () => {
    const found = serverConstants(serverSource(SERVER_RULES));
    for (const [, serverName] of PAIRS) {
      expect(found[serverName], `${SERVER_RULES} does not export ${serverName}`).toBeDefined();
    }
    // A floor on what the derivation read, so an extractor that stops matching cannot report six empty strings equal.
    expect(Object.keys(found).length).toBeGreaterThanOrEqual(PAIRS.length);
  });

  it('every limit the server exports has a client twin — a seventh constant is not left out of the editor', () => {
    const found = serverConstants(serverSource(SERVER_RULES));
    const paired = new Set(PAIRS.map(p => p[1]));
    const unpaired = Object.keys(found).filter(n => !paired.has(n));
    expect(unpaired, `these server limits have no RULE_LIMITS counterpart: ${unpaired.join(', ')}`).toEqual([]);
  });
});

describe('RULE_LIMITS (client/src/app/shared/rule-limits.ts) equals the server constants', () => {
  it('the client module exists and RULE_LIMITS declares every key the editor reads', () => {
    expect(exists(`client/${CLIENT_LIMITS}`), `client/${CLIENT_LIMITS} does not exist`).toBe(true);
    const limits = clientLimits(readClientSource(CLIENT_LIMITS));
    for (const key of [...PAIRS.map(p => p[0]), 'nameMax']) {
      expect(limits[key], `RULE_LIMITS.${key} is not declared`).toBeDefined();
    }
  });

  it.each(PAIRS)('RULE_LIMITS.%s is the server\'s %s', (clientKey, serverName) => {
    const server = serverConstants(serverSource(SERVER_RULES));
    const client = clientLimits(readClientSource(CLIENT_LIMITS));
    expect(server[serverName], `${serverName} not found on the server`).toBeDefined();
    expect(client[clientKey], `RULE_LIMITS.${clientKey} not found on the client`).toBeDefined();
    if (clientKey === 'namePattern') {
      expect(patternSource(client[clientKey]!)).toBe(patternSource(server[serverName]!));
    } else {
      const n = asNumber(server[serverName]!);
      expect(Number.isFinite(n), `${serverName} is not a number literal: ${server[serverName]}`).toBe(true);
      expect(asNumber(client[clientKey]!)).toBe(n);
    }
  });

  it('nameMax is the length the name pattern allows', () => {
    const server = serverConstants(serverSource(SERVER_RULES));
    const client = clientLimits(readClientSource(CLIENT_LIMITS));
    const pattern = patternSource(server['RULE_NAME_PATTERN'] ?? '');
    expect(pattern, 'RULE_NAME_PATTERN not found on the server').not.toBe('');
    // `^[a-z][a-zA-Z0-9_-]{0,63}$`: one leading character plus up to 63 more.
    const tail = /\{0,(\d+)\}\$?$/.exec(pattern);
    expect(tail, `RULE_NAME_PATTERN does not end in a {0,N} tail: ${pattern}`).not.toBeNull();
    expect(asNumber(client['nameMax'] ?? '')).toBe(Number(tail![1]) + 1);
  });
});

/** The text of one property declaration inside an interface body, up to the end of that declaration. */
function declaration(body: string, key: string): string | null {
  const m = new RegExp(`(?:^|[;\\n\\s])${key}\\??\\s*:`).exec(body);
  if (!m) return null;
  let depth = 0;
  let i = m.index + m[0].length;
  const from = i;
  for (; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '{' || ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') depth--;
    else if (depth === 0 && (ch === ';' || ch === '\n')) break;
  }
  return body.slice(from, i);
}

/** The keys of the first `z.object({ ... })` in `text` at its own level. */
function zodObjectKeys(text: string): string[] {
  const start = text.indexOf('z.object(');
  if (start < 0) return [];
  const open = text.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) break;
  }
  let inner = text.slice(open + 1, i);
  for (let prev = ''; prev !== inner;) { prev = inner; inner = inner.replace(/\{[^{}]*\}|\([^()]*\)|\[[^\[\]]*\]/g, '_'); }
  return [...inner.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*:/g)].map(m => m[1]!);
}

/**
 * The key set of each `rules:` shape in the server's body schemas: the expression after `rules:` is read for an
 * inline `z.object({...})`, or for the named schema it points at (in body-schemas.ts or schema-rules.ts).
 */
function serverRuleShapes(): string[][] {
  const bodies = serverSource(SERVER_BODIES);
  const sources = [bodies, exists(SERVER_RULES) ? readRepoSource(SERVER_RULES) : ''];
  const shapes: string[][] = [];
  for (const m of bodies.matchAll(/\brules\s*:\s*/g)) {
    // The expression runs to the end of its line group: take a generous window and cut at the first top-level comma.
    let depth = 0;
    let j = m.index! + m[0].length;
    const from = j;
    for (; j < bodies.length; j++) {
      const ch = bodies[j]!;
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
    }
    const expr = bodies.slice(from, j);
    let keys = zodObjectKeys(expr);
    if (!keys.length) {
      for (const id of expr.match(/\b[A-Za-z_]\w*\b/g) ?? []) {
        for (const src of sources) {
          const def = new RegExp(`(?:export\\s+)?const\\s+${id}\\s*=\\s*([\\s\\S]*?)\\n(?=export|const|function|\\/\\*|$)`).exec(src);
          if (def) { keys = zodObjectKeys(def[1]!); if (keys.length) break; }
        }
        if (keys.length) break;
      }
    }
    if (keys.length) shapes.push(keys);
  }
  return shapes;
}

describe('the client\'s rules types name every key the server accepts for a rule', () => {
  const types = () => readClientSource(CLIENT_TYPES);

  it('TypeSchema and SpaceMeta both declare `rules`', () => {
    for (const iface of ['TypeSchema', 'SpaceMeta']) {
      expect(interfaceKeys(types(), iface), `${iface} in api.types.ts does not declare rules`).toContain('rules');
    }
  });

  it('every key of a rule in the server body schemas is spelled in the client declaration of rules', () => {
    const shapes = serverRuleShapes();
    // Floor: one shape for a type's rules and one for the space's. Zero means the server declares no rules shape
    // (or the reader stopped finding it), and "every key present" over nothing is the vacuous pass this refuses.
    expect(shapes.length, `${SERVER_BODIES} declares no \`rules\` shape — nothing to compare the client against`).toBeGreaterThanOrEqual(2);
    const allKeys = [...new Set(shapes.flat())];
    expect(allKeys).toEqual(expect.arrayContaining(['rule', 'message']));

    const src = types();
    // Each client interface's `rules` declaration, plus the body of any interface it names for the rule itself.
    const declared = ['TypeSchema', 'SpaceMeta'].map(iface => {
      const decl = declaration(interfaceBody(src, iface), 'rules');
      expect(decl, `${iface} does not declare rules`).not.toBeNull();
      let text = decl!;
      for (const id of decl!.match(/\b[A-Z]\w*\b/g) ?? []) {
        try { text += '\n' + interfaceBody(src, id); } catch { /* not an interface: a builtin or alias */ }
      }
      return { iface, text };
    });

    const missing: string[] = [];
    for (const { iface, text } of declared) {
      const present = new Set([...text.matchAll(/\b([A-Za-z_]\w*)\??\s*:/g)].map(m => m[1]));
      // A key belongs to one level or both: `kinds` is the space rule's alone. So a key must be spelled by AT LEAST
      // one of the two declarations, and the type's declaration must cover every key the type-rule shape has.
      if (iface === 'TypeSchema') for (const k of shapes[0] ?? []) if (!present.has(k)) missing.push(`${iface}.rules.${k}`);
      if (iface === 'SpaceMeta') for (const k of shapes[shapes.length - 1] ?? []) if (!present.has(k)) missing.push(`${iface}.rules.${k}`);
    }
    expect(missing, `the server accepts these rule keys and the client types do not declare them: ${missing.join(', ')}`).toEqual([]);
  });
});
