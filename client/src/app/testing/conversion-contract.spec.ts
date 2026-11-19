/**
 * The client's idea of a record conversion against the one the server serves (bundle-285, Q-747).
 *
 * The conversion pages read six server shapes: the run's status, the save's convert notice, the Convert act's start answer, an unconverted
 * row and its list, the bulk dismiss, and the steps themselves. The client types them by hand (`core/conversion.types.ts`), and a hand copy
 * of a server shape is silent when the server adds a field: `ServerVoteRound` lost four keys exactly so (`vote-round-contract.spec.ts`).
 * Five page slices are built on these names side by side; a shape guessed twice is the defect this spec prevents.
 *
 * The rule, for each shape, over BOTH key sets derived from source: every key the server carries is either declared by the client's type or
 * named in a NOT_READ table with the reason the client does not read it; the client declares nothing the server does not send; and a
 * NOT_READ entry that no longer describes a key fails as stale. Closed sets (reasons, step ops, refusal codes, run states) are compared as
 * sets, and every server reason has a class in the client's table: a reason added on the server fails here, with its name.
 *
 * It reads server source because the client job does not build the server; it lives under `testing/` for that reason.
 *
 * ## Rows waiting on slice S1
 *
 * Slice S1 (server, runs beside this one) adds a list form of `reason` and `counts.openBy` / `counts.openByCut` to the unconverted list's
 * answer. The server source this spec was written against does not hold them, so those rows are marked WAITING_ON_S1: the client declares
 * them as the plan (sections 4 and 6) describes, and the comparison against the server's own source lifts by itself (`it.skipIf`) once the
 * source names them, so a skipped row is a row not yet checkable, never a green one.
 */
import { describe, it, expect } from 'vitest';
import { interfaceBody, interfaceKeys, propertyLiterals, aliasLiterals, readClientSource, readRepoSource } from './server-source';
import { UNCONVERTED_REASONS, UNCONVERTED_REASON_CLASS, UNCONVERTED_CLASSES } from '../core/unconverted-reasons';

// ── the server's source, read once ──────────────────────────────────────────────────────────────────────────────────

const RUN = readRepoSource('server/src/spaces/schema-convert-run.ts');
const TERMS = readRepoSource('server/src/spaces/unconverted-terms.ts');
const CONVERT_TERMS = readRepoSource('server/src/spaces/schema-convert-terms.ts');
const CONVERT_ACTS = readRepoSource('server/src/spaces/schema-convert-acts.ts');
const UNCONVERTED_ACTS = readRepoSource('server/src/spaces/unconverted-acts.ts');
const META_UPDATE = readRepoSource('server/src/spaces/meta-update.ts');
const STEPS = readRepoSource('schema/src/conversion-steps.ts');
const GOVERNANCE = readRepoSource('server/src/sync/governance.ts');
const VOCABULARY = readRepoSource('schema/src/vocabulary.ts');

const TYPES = readClientSource('src/app/core/conversion.types.ts');
const WORDS = readClientSource('src/app/core/conversion-step-words.ts');

// ── helpers: the few shapes `interfaceKeys` does not read ──────────────────────────────────────────────────────────

/** The string literals of `export const NAME = [ 'a', 'b' ] as const`; throws when there is no such constant. */
function constLiterals(src: string, name: string): string[] {
  const m = new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`no const array ${name} found — the source moved or was renamed, and a gate over it would report clean about nothing`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!);
}

/** The text after `=` of `type NAME =` up to its closing `;` at depth zero. */
function aliasText(src: string, name: string): string {
  const m = new RegExp(`\\btype\\s+${name}\\b[^=]*=`).exec(src);
  if (!m) throw new Error(`no type alias ${name} found`);
  let depth = 0;
  let i = m.index + m[0].length;
  const from = i;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--;
    else if (ch === ';' && depth === 0) break;
  }
  return src.slice(from, i);
}

/** The keys of one object-type text at its own level (nested braces blanked), as `interfaceKeys` reads an interface body. */
function ownKeys(objectBody: string): string[] {
  let body = objectBody;
  for (let prev = ''; prev !== body;) { prev = body; body = body.replace(/\{[^{}]*\}/g, '{}'); }
  return [...new Set([...body.matchAll(/(?:^|[;\n,{])\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/g)].map(m => m[1]!))];
}

/** Every top-level `{ ... }` block of a union alias, as its own body text. */
function unionMembers(src: string, name: string): string[] {
  const text = aliasText(src, name);
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 1;
    let j = i + 1;
    for (; j < text.length && depth > 0; j++) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; }
    out.push(text.slice(i + 1, j - 1));
    i = j - 1;
  }
  return out;
}

/** The ops of a step union and, per op, its own keys: `{ renameProperty: ['op', 'kind', ...], ... }`. */
function stepShapes(src: string, name: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const body of unionMembers(src, name)) {
    const op = /\bop\s*:\s*'(\w+)'/.exec(body)?.[1];
    if (!op) throw new Error(`a member of ${name} names no op: ${body}`);
    out[op] = ownKeys(body).sort();
  }
  return out;
}

/** The keys of the object literal that follows `marker` in `src` (shorthand and `key: value`), read at depth zero. */
function literalKeysAfter(src: string, marker: RegExp): string[] {
  const m = marker.exec(src);
  if (!m) throw new Error(`${marker} not found — the answer this gate reads moved`);
  let depth = 1;
  let i = m.index + m[0].length;
  const from = i;
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
  }
  const inner = src.slice(from, i - 1);
  const keys: string[] = [];
  let part = '';
  let d = 0;
  for (const ch of inner + ',') {
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
    if (ch === ',' && d === 0) {
      const key = /^\s*(?:\.\.\.)?([A-Za-z_]\w*)/.exec(part)?.[1];
      if (key && !part.trim().startsWith('...')) keys.push(key);
      part = '';
    } else part += ch;
  }
  return keys;
}

const sorted = (a: readonly string[]): string[] => [...a].sort();

/** The shared rule: every server key is declared by the client or named with its reason; no stale reason; nothing invented. */
function holdsShape(what: string, server: string[], client: string[], notRead: Record<string, string>, added: readonly string[] = []): void {
  const unclassified = server.filter(k => !client.includes(k) && !(k in notRead));
  expect(unclassified, `the server's ${what} carries keys the client neither reads nor has decided to ignore:\n  ${unclassified.join('\n  ')}`).toEqual([]);
  const stale = Object.keys(notRead).filter(k => !server.includes(k) || client.includes(k));
  expect(stale, `${what}: entries whose reason no longer describes a key`).toEqual([]);
  const invented = client.filter(k => !server.includes(k) && !added.includes(k));
  expect(invented, `${what}: client keys with no counterpart on the server`).toEqual([]);
}

// ── the run's status ───────────────────────────────────────────────────────────────────────────────────────────────

/** Server status keys the client deliberately does not read, each with why. */
const STATUS_NOT_READ: Record<string, string> = {
  toFp: 'the fingerprint the run converts toward: machinery; the run block reads state, counts and what is left',
  owed: 'LOCAL: a passed vote owes this instance its run; the block says the same thing whether the run is owed or not',
  syncedFirst: 'the first sync\'s bookkeeping (how many peers were asked); the block does not report it',
};

describe('the client reads the conversion status the server serves', () => {
  const server = interfaceKeys(RUN, 'SchemaConvertStatus');
  const client = interfaceKeys(TYPES, 'ConvertStatus');

  it('derives its key sets (a floor: an empty set passes every loop written over it)', () => {
    expect(server.length, `SchemaConvertStatus keys: ${server.join(', ')}`).toBeGreaterThan(10);
    expect(client.length, `ConvertStatus keys: ${client.join(', ')}`).toBeGreaterThan(8);
    expect(server).toContain('counts');
    expect(client).toContain('counts');
  });

  it('every status key is declared by ConvertStatus or named with the reason it is not read; nothing is invented', () => {
    holdsShape('status', server, client, STATUS_NOT_READ);
  });

  it('the counts are the five the run keeps', () => {
    expect(sorted(interfaceKeys(TYPES, 'ConvertCounts'))).toEqual(sorted(interfaceKeys(RUN, 'SchemaConvertCounts')));
  });

  it('a run type, a source and a refused step are the server\'s', () => {
    expect(sorted(interfaceKeys(TYPES, 'ConvertTypeRef'))).toEqual(sorted(interfaceKeys(RUN, 'SchemaConvertType')));
    expect(sorted(interfaceKeys(TYPES, 'ConvertRunType'))).toEqual(sorted([...interfaceKeys(RUN, 'SchemaConvertType'), 'done']));
    expect(sorted(interfaceKeys(TYPES, 'ConvertSource'))).toEqual(sorted(interfaceKeys(RUN, 'SchemaConvertSource')));
    expect(sorted(interfaceKeys(TYPES, 'ConvertRefusedStep'))).toEqual(sorted(interfaceKeys(RUN, 'SchemaConvertRefusedStep')));
  });

  it('the states are the run\'s three, and the two answers a status read can give instead of a run', () => {
    const states = propertyLiterals(RUN, 'SchemaConvertRunDoc', 'state');
    expect(states.length, 'the run document\'s states were not read').toBe(3);
    expect(sorted(aliasLiterals(TYPES, 'ConvertRunState'))).toEqual(sorted(states));
    const perMember = /export\s+const\s+SCHEMA_CONVERT_VIEW_STATE\s*=\s*'(\w+)'/.exec(CONVERT_ACTS)?.[1];
    expect(perMember, 'the per-member state was not found on the server').toBeDefined();
    expect(TYPES, 'ConvertStatusPerMember does not name the server\'s state').toContain(`'${perMember}'`);
    expect(TYPES, 'ConvertStatusNone does not name the state `none`').toMatch(/state:\s*'none'/);
    expect(CONVERT_ACTS, 'the server no longer answers { state: \'none\' } for a space that never ran').toMatch(/state:\s*'none'/);
  });
});

// ── the save's convert notice and the Convert act's start answer ───────────────────────────────────────────────────

describe('the client reads the convert notice a save answers and the start the Convert act answers', () => {
  it('ConvertRunNotice has the server\'s keys and states', () => {
    expect(sorted(interfaceKeys(TYPES, 'ConvertRunNotice'))).toEqual(sorted(interfaceKeys(META_UPDATE, 'ConvertRunNotice')));
    const states = propertyLiterals(META_UPDATE, 'ConvertRunNotice', 'state');
    expect(states.length, 'the notice\'s states were not read').toBe(4);
    expect(sorted(aliasLiterals(TYPES, 'ConvertNoticeState'))).toEqual(sorted(states));
  });

  it('the answer carries the notice under `convert`, on the applied and the vote-pending answer alike', () => {
    expect(META_UPDATE, 'a save answers the notice under another key').toMatch(/return\s*\{\s*convert:\s*outcome\.convertRun\s*\}/);
    expect(interfaceKeys(TYPES, 'SaveConvertAnswer')).toContain('convert');
  });

  it('the start answer (202) carries the keys StartAnswer declares', () => {
    const server = literalKeysAfter(CONVERT_ACTS, /status:\s*ACCEPTED,\s*body:\s*\{/);
    expect(server.length, 'the 202 body\'s keys were not read').toBeGreaterThanOrEqual(4);
    expect(sorted(interfaceKeys(TYPES, 'ConvertStartAnswer'))).toEqual(sorted(server));
  });
});

// ── the steps ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the client\'s ConversionStep is the schema package\'s', () => {
  const server = stepShapes(STEPS, 'ConversionStep');
  const client = stepShapes(TYPES, 'ConversionStep');

  it('derives the four ops', () => {
    expect(Object.keys(server).sort(), 'the server\'s step ops').toEqual(['mapEnum', 'renameProperty', 'renameType', 'splitType']);
  });

  it('has the same ops, each with the same fields', () => {
    expect(client).toEqual(server);
  });

  it('a split\'s case has the same fields', () => {
    const caseOf = (src: string): string[] => ownKeys(/cases:\s*\{([^}]*)\}\[\]/.exec(src)?.[1] ?? '');
    expect(caseOf(STEPS).length, 'the server\'s split case was not read').toBe(2);
    expect(sorted(caseOf(TYPES))).toEqual(sorted(caseOf(STEPS)));
  });

  it('the kinds are the knowledge types', () => {
    const kinds = constLiterals(VOCABULARY, 'KNOWLEDGE_TYPES');
    expect(kinds.length).toBe(4);
    expect(sorted(aliasLiterals(readClientSource('src/app/core/type-field.ts'), 'TypedKind'))).toEqual(sorted(kinds));
  });
});

// ── the reasons an item is listed for ──────────────────────────────────────────────────────────────────────────────

describe('every reason a record is left unconverted for has a class the page words', () => {
  const serverReasons = constLiterals(TERMS, 'UNCONVERTED_REASONS');

  it('derives the reasons (a floor)', () => {
    expect(serverReasons.length).toBeGreaterThan(8);
    expect(serverReasons).toContain('step_refused');
  });

  it('the client lists exactly the server\'s reasons', () => {
    expect(sorted(UNCONVERTED_REASONS)).toEqual(sorted(serverReasons));
  });

  it('every server reason has a class, and the class is one of the three the page switches on', () => {
    const unclassified = serverReasons.filter(r => !(r in UNCONVERTED_REASON_CLASS));
    expect(unclassified, `the server lists records for these reasons and the client gives them no class:\n  ${unclassified.join('\n  ')}`).toEqual([]);
    const stale = Object.keys(UNCONVERTED_REASON_CLASS).filter(r => !serverReasons.includes(r));
    expect(stale, 'the client classifies reasons the server does not have').toEqual([]);
    for (const r of serverReasons) expect(UNCONVERTED_CLASSES, `reason ${r}`).toContain(UNCONVERTED_REASON_CLASS[r as keyof typeof UNCONVERTED_REASON_CLASS]);
  });

  it('the classes are the three the plan draws: fit, exists, refused', () => {
    expect([...UNCONVERTED_CLASSES]).toEqual(['fit', 'exists', 'refused']);
  });

  it('the statuses are the server\'s', () => {
    expect(sorted(aliasLiterals(TYPES, 'UnconvertedStatus'))).toEqual(sorted(constLiterals(TERMS, 'UNCONVERTED_STATUSES')));
  });
});

// ── the unconverted row and its list ──────────────────────────────────────────────────────────────────────────────

/** The row's keys on the server: the stored item minus what is withheld, plus what the list adds (`UnconvertedRow`'s own definition). */
function serverRowKeys(): string[] {
  const alias = aliasText(TERMS, 'UnconvertedRow');
  const omitted = [...(/Omit<\s*UnconvertedItem\s*,\s*([^>]+)>/.exec(alias)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]!);
  expect(omitted.length, 'the keys the row withholds were not read').toBeGreaterThan(0);
  const added = ownKeys(/&\s*\{([\s\S]*)\}\s*$/.exec(alias.trim())?.[1] ?? '');
  expect(added, 'the keys the list adds to a row were not read').toContain('itemId');
  return [...interfaceKeys(TERMS, 'UnconvertedItem').filter(k => !omitted.includes(k)), ...added];
}

/** Row keys the client does not read, each with why. */
const ROW_NOT_READ: Record<string, string> = {
  seq: 'the record\'s version when the run read it: machinery for the staleness sweep, not what the card says',
  fromFp: 'the stamp the record carried: a fingerprint, which the card names nowhere',
  toFp: 'the fingerprint the run converted toward: the same',
  proposed: 'what the steps would have made of the record; the card\'s to-do sentence is one per reason class, not per proposal',
};

describe('the client reads the unconverted row the server lists', () => {
  const server = serverRowKeys();
  const client = interfaceKeys(TYPES, 'UnconvertedRow');

  it('derives its key sets (a floor)', () => {
    expect(server.length, `row keys: ${server.join(', ')}`).toBeGreaterThan(9);
    expect(client.length, `UnconvertedRow keys: ${client.join(', ')}`).toBeGreaterThan(8);
    expect(server).toContain('itemId');
    expect(server).not.toContain('_id');
    expect(server).not.toContain('typeDefinition');
  });

  it('every row key is declared by UnconvertedRow or named with the reason it is not read; nothing is invented', () => {
    holdsShape('unconverted row', server, client, ROW_NOT_READ);
  });

  it('a row\'s record part is the summary and nothing else (never a stored value)', () => {
    const body = /record\??\s*:\s*\{([^}]*)\}/.exec(interfaceBody(TYPES, 'UnconvertedRow'))?.[1] ?? '';
    expect(ownKeys(body)).toEqual(['summary']);
    expect(/record\??\s*:\s*\{([^}]*)\}/.exec(aliasText(TERMS, 'UnconvertedRow'))?.[1]).toMatch(/summary/);
  });

  it('a violation is a field and a reason', () => {
    const body = /violations\s*:\s*\{([^}]*)\}\[\]/.exec(interfaceBody(TERMS, 'UnconvertedItem'))?.[1] ?? '';
    expect(sorted(ownKeys(body))).toEqual(['field', 'reason']);
    expect(sorted(interfaceKeys(TYPES, 'UnconvertedViolation'))).toEqual(['field', 'reason']);
  });

  it('the list answer carries items and counts { open, dismissed }', () => {
    const answer = literalKeysAfter(UNCONVERTED_ACTS, /body:\s*\{(?=\s*items:)/);
    expect(answer).toContain('items');
    expect(answer).toContain('counts');
    const counts = literalKeysAfter(UNCONVERTED_ACTS, /counts:\s*\{/);
    expect(counts).toEqual(expect.arrayContaining(['open', 'dismissed']));
    const clientCounts = interfaceKeys(TYPES, 'UnconvertedCounts');
    for (const k of counts) expect(clientCounts, `UnconvertedCounts does not declare ${k}`).toContain(k);
  });

  it('the page fields the list answers beside its items are the list module\'s, and the pager reads each of them', () => {
    const listPage = readRepoSource('server/src/brain/list-page.ts');
    const page = literalKeysAfter(listPage, /return\s*\{(?=\s*\.\.\.budget)/);
    expect(page, 'the page fields were not read from list-page.ts').toEqual(expect.arrayContaining(['total', 'limit', 'skip', 'truncated']));
    const client = interfaceKeys(TYPES, 'UnconvertedListAnswer');
    for (const k of [...page, 'nextSkip', 'items', 'counts']) expect(client, `UnconvertedListAnswer does not declare ${k}`).toContain(k);
    expect(listPage, 'the page no longer says where the next one starts').toMatch(/nextSkip/);
  });
});

describe('the bulk dismiss and the one dismiss answer what the client reads', () => {
  it('answers { dismissed } and, refused, current or max', () => {
    expect(UNCONVERTED_ACTS).toMatch(/body:\s*\{\s*dismissed:\s*done\.dismissed\s*\}/);
    expect(UNCONVERTED_ACTS).toMatch(/detail:\s*\{\s*current:\s*done\.current\s*\}/);
    expect(UNCONVERTED_ACTS).toMatch(/detail:\s*\{\s*max:\s*done\.max\s*\}/);
    expect(interfaceKeys(TYPES, 'DismissShownAnswer')).toEqual(['dismissed']);
  });

  it('one dismiss answers { item }', () => {
    expect(UNCONVERTED_ACTS).toMatch(/body:\s*\{\s*item:\s*rowOf/);
    expect(interfaceKeys(TYPES, 'DismissOneAnswer')).toEqual(['item']);
  });

  it('the bulk dismiss takes the filter and `expect`', () => {
    const keys = [...TERMS.matchAll(/UnconvertedDismissShownParams\s*=\s*UnconvertedFilterParams\.extend\(\{\s*(\w+):/g)].map(m => m[1]);
    expect(keys).toEqual(['expect']);
    expect(sorted(interfaceKeys(TYPES, 'UnconvertedDismissRequest'))).toEqual(['expect', 'kind', 'reason', 'type']);
  });
});

// ── the refusal codes ──────────────────────────────────────────────────────────────────────────────────────────────

describe('every refusal code the conversion doors answer is a decision of the client', () => {
  const codes = [
    ...constLiterals(CONVERT_TERMS, 'SCHEMA_CONVERT_REFUSAL_CODES'),
    ...constLiterals(TERMS, 'UNCONVERTED_REFUSAL_CODES'),
    'convert_needs_meta',
  ];
  const table = Object.keys(interfaceTable());

  /** `CONVERSION_REFUSAL_KIND`'s keys, read from the client's source: the table the page words refusals by. */
  function interfaceTable(): Record<string, string> {
    const m = /export\s+const\s+CONVERSION_REFUSAL_KIND\b[^=]*=\s*\{([^}]*)\}/.exec(TYPES);
    if (!m) throw new Error('conversion.types.ts exports no CONVERSION_REFUSAL_KIND');
    return Object.fromEntries([...m[1]!.matchAll(/(\w+)\s*:\s*'(\w+)'/g)].map(x => [x[1]!, x[2]!]));
  }

  it('derives the codes (a floor)', () => {
    expect(codes.length).toBeGreaterThan(15);
    expect(codes).toContain('schema_convert_rate_limited');
    expect(codes).toContain('unconverted_changed');
  });

  it('the server sends the code a save answers for a convertRecords without a meta', () => {
    expect(META_UPDATE).toMatch(/code:\s*'convert_needs_meta'/);
  });

  it('every server code has a kind in the client\'s table, and the table names no code the server lacks', () => {
    const missing = codes.filter(c => !table.includes(c));
    expect(missing, `the server answers these codes and the client has no decision for them:\n  ${missing.join('\n  ')}`).toEqual([]);
    const stale = table.filter(c => !codes.includes(c));
    expect(stale, 'the client words codes the server does not answer').toEqual([]);
  });

  it('the codes the plan words by themselves are not left to the generic sentence', () => {
    const kinds = interfaceTable();
    expect(kinds['schema_convert_rate_limited']).toBe('rate_limited');
    expect(kinds['bad_conversion_step']).toBe('bad_step');
    expect(kinds['knowledge_rung']).toBe('no_right');
    expect(kinds['space_admin_required']).toBe('no_right');
    expect(kinds['schema_convert_running']).toBe('running');
    expect(kinds['unconverted_changed']).toBe('changed');
    expect(kinds['unconverted_too_many']).toBe('too_many');
    expect(kinds['unconverted_item_not_found']).toBe('item_gone');
  });
});

// ── why a step was refused (the run's `stepsRefused[].reason`) ─────────────────────────────────────────────────────

describe('every reason a step is refused for has words', () => {
  const issueCodes = aliasLiterals(STEPS, 'ConversionIssueCode');
  const roundCodes = aliasLiterals(GOVERNANCE, 'RoundConvertRefusal');
  const replaced = /reason:\s*'(replaced)'/.exec(RUN)?.[1];

  it('derives the codes (a floor)', () => {
    expect(issueCodes.length).toBeGreaterThan(20);
    expect(roundCodes).toEqual(expect.arrayContaining(['steps_not_signed', 'step_target_not_in_round', 'property_still_declared_here']));
    expect(replaced, 'the run no longer records a replaced step').toBe('replaced');
  });

  it('the client words every code the server can record, and no code the server lacks', () => {
    const server = [...new Set([...issueCodes, ...roundCodes, replaced!])];
    const list = /export\s+const\s+STEP_REFUSAL_CODES\b[^=]*=\s*\[([^\]]*)\]/.exec(WORDS)?.[1];
    expect(list, 'conversion-step-words.ts exports no STEP_REFUSAL_CODES').toBeDefined();
    const client = [...list!.matchAll(/'([^']+)'/g)].map(m => m[1]!);
    expect(sorted(client)).toEqual(sorted(server));
  });
});

// ── rows waiting on slice S1 ───────────────────────────────────────────────────────────────────────────────────────

/** Rows the server source in this checkout does not hold yet (slice S1 adds them); the client declares them as plan sections 4 and 6 say. */
const WAITING_ON_S1 = ['openBy', 'openByCut'] as const;

describe('rows waiting on slice S1 (the reason list form and counts.openBy)', () => {
  const serverHasOpenBy = /\bopenBy\b/.test(UNCONVERTED_ACTS) || /\bopenBy\b/.test(readRepoSource('server/src/brain/schema-convert-items.ts'));

  it('the client declares them already, as the plan describes (a group is kind, type, reason, n)', () => {
    const counts = interfaceKeys(TYPES, 'UnconvertedCounts');
    for (const key of WAITING_ON_S1) expect(counts, `UnconvertedCounts does not declare ${key}`).toContain(key);
    expect(sorted(interfaceKeys(TYPES, 'UnconvertedOpenGroup'))).toEqual(['kind', 'n', 'reason', 'type']);
  });

  it.skipIf(!serverHasOpenBy)('the server\'s openBy group has the keys the client declares (lifts when S1 is merged)', () => {
    const source = readRepoSource('server/src/brain/schema-convert-items.ts') + UNCONVERTED_ACTS + TERMS;
    for (const key of ['kind', 'type', 'reason', 'n']) expect(source).toMatch(new RegExp(`\\b${key}\\b`));
    expect(source).toMatch(/\bopenByCut\b/);
  });
});
