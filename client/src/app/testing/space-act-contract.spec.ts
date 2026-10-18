/**
 * The client's idea of a space act's answers against the ones the server serves (Q-535, plan rev 2 design 10).
 *
 * ## What it prevents
 *
 * The client typed a delete or wipe answer as `{ pending }` and nothing else, so every field the server's answers carry —
 * `removedHere`, `refills`, `repeated`, `queued`, `retryAt`, `code: 'space_act_failed'`, the rounds — was dropped without an error, and
 * nothing read a space's `actPending` or a network's `owedSpaceActs` / `ownYesCarries` at all. The vote-round gate
 * (`vote-round-contract.spec.ts`) held one server shape to its client type; these shapes had no such gate, which is how the four
 * 202s became one `pending`.
 *
 * The rule, over sets DERIVED from source (never listed): every key a server act answer carries is declared by the client's type or
 * named in `NOT_READ` with why; `NOT_READ` names only keys the server has and the client does not read; and each derived set has a
 * floor, because an empty set passes every loop written over it.
 *
 * Where the sets come from:
 * - the answer bodies: `SpaceActFailureAnswer.body` and `queuedActBody`'s return type (`spaces/space-act-failure.ts`), every `body`
 *   literal of `deletionAnswer` (`spaces/space-deletion.ts`), every `.json({...})` of the admin wipe route (`app.ts`) -> the client's
 *   `SpaceActBody`;
 * - `ActEntryView` (`spaces/space-act-runner.ts`) -> the client's `ActEntryView` (a space's `actPending`);
 * - `networkAnswer`'s `owedSpaceActs` entries and the keys it adds to the view (`networks/network-acts.ts`) -> the client's
 *   `OwedSpaceAct` (with `ActEntryView`) and `Network`;
 * - `Space` must declare `actPending`.
 *
 * The client types are read from `core/space-act-outcome.ts` and `core/api.types.ts` together, so either may declare them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { interfaceBody, interfaceKeys, readClientSource, readRepoSource } from './server-source';
import { CLIENT_ROOT } from './tracked-sources';
import { ACT_TEXT_KEYS } from './space-act-bodies';

/** Server answer keys the client deliberately does not read, each with why. A list of decisions, not of the shape. */
const NOT_READ: Record<string, string> = {
  codeName: 'the store\'s driver code name for a store-side failure; it is for the operator\'s log, and the client words the failure from `code` and the HTTP status',
  retryable: 'the store\'s retry flag; the HTTP status (503) already says it, and the parser derives `retried` from `code` and status',
};

// ── derivation helpers: object-literal and inline-type keys ─────────────────────────────────────────────────────────────────────

/** The text between the brace at `open` and its partner. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces from offset ${open}`);
}

/** The text of the function `name` (its signature and body). Throws when absent: a gate over a moved function reports clean about nothing. */
function functionText(src: string, name: string): string {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`no function ${name} found — the source moved or was renamed`);
  const bodyOpen = src.indexOf('{', src.indexOf(')', m.index) + 1);
  // The return-type annotation may itself be an object type: skip `): { ... } {` to the body's brace.
  const sig = src.slice(m.index, bodyOpen);
  const annotated = /\)\s*:\s*$/.test(sig);
  const open = annotated ? src.indexOf('{', bodyOpen + balanced(src, bodyOpen).length + 2) : bodyOpen;
  return src.slice(m.index, open + 1) + balanced(src, open) + '}';
}

/**
 * The keys an object literal or an inline object type writes: `key:` (not a nested one: inner objects of `=> ({...})` are blanked
 * first), `key?:`, and a shorthand `key,` / `key }`; a spread of a local `const` is resolved to the keys of the literals that const holds.
 */
function literalKeys(text: string, scope: string): string[] {
  // String contents first: a refusal's prose ("`confirm: true` required", "an array of: …") is not a key the body carries.
  const unquoted = text.replace(/`(?:\\.|[^`\\])*`/g, '``').replace(/'(?:\\.|[^'\\])*'/g, '\'\'').replace(/"(?:\\.|[^"\\])*"/g, '""');
  const flat = unquoted.replace(/=>\s*\(\{[^{}]*\}\)/g, '=> X');
  const keys = new Set<string>();
  for (const m of flat.matchAll(/(?<![\w'".?])([A-Za-z_]\w*)\??\s*:(?!:)/g)) keys.add(m[1]!);
  for (const m of flat.matchAll(/(?:^|[{,])\s*([A-Za-z_]\w*)\s*(?=,|$)/g)) keys.add(m[1]!);
  for (const m of flat.matchAll(/\.\.\.([A-Za-z_]\w*)\b(?!\s*\()/g)) {
    const decl = new RegExp(`const\\s+${m[1]}\\s*=([^;]*);`).exec(scope);
    if (decl) for (const k of decl[1]!.matchAll(/\{\s*([A-Za-z_]\w*)\s*:/g)) keys.add(k[1]!);
  }
  for (const noise of ['as', 'const']) keys.delete(noise);
  return [...keys];
}

/** Every `<marker>{...}` literal in `text`, as its inner text. */
function literalsAfter(text: string, marker: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(marker)) out.push(balanced(text, m.index! + m[0].length - 1));
  return out;
}

const union = (...sets: string[][]) => [...new Set(sets.flat())].sort();

// ── the server's sets ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const failureSrc = readRepoSource('server/src/spaces/space-act-failure.ts');
const failureBodyKeys = (() => {
  const iface = interfaceBody(failureSrc, 'SpaceActFailureAnswer');
  const at = /\bbody\s*:\s*\{/.exec(iface);
  if (!at) throw new Error('SpaceActFailureAnswer has no inline `body` type — the shape moved');
  return literalKeys(balanced(iface, at.index + at[0].length - 1), failureSrc);
})();
const queuedKeys = (() => {
  const fn = functionText(failureSrc, 'queuedActBody');
  const ret = /\)\s*:\s*\{/.exec(fn);
  if (!ret) throw new Error('queuedActBody has no object return type — the shape moved');
  return literalKeys(balanced(fn, ret.index + ret[0].length - 1), failureSrc);
})();

const deletionSrc = readRepoSource('server/src/spaces/space-deletion.ts');
const deletionKeys = (() => {
  const fn = functionText(deletionSrc, 'deletionAnswer');
  return union(...literalsAfter(fn, /\bbody\s*:\s*\{/g).map(l => literalKeys(l, fn)));
})();

const appSrc = readRepoSource('server/src/app.ts');
const wipeKeys = (() => {
  const start = appSrc.indexOf('\'/api/admin/spaces/:spaceId/wipe\'');
  if (start < 0) throw new Error('the admin wipe route moved out of app.ts');
  const route = appSrc.slice(start, appSrc.indexOf('sendCaughtFailure(', start) + 200);
  return union(...literalsAfter(route, /\.json\(\s*\{/g).map(l => literalKeys(l, route)));
})();

const runnerSrc = readRepoSource('server/src/spaces/space-act-runner.ts');
const entryKeys = interfaceKeys(runnerSrc, 'ActEntryView');

const networkActsSrc = readRepoSource('server/src/networks/network-acts.ts');
const networkAnswerText = functionText(networkActsSrc, 'networkAnswer');
const networkViewKeys = [...networkAnswerText.matchAll(/view\['(\w+)'\]\s*=/g)].map(m => m[1]!);
const owedKeys = (() => {
  const at = /owedSpaceActs'\]\s*=[\s\S]*?\.map\(\s*\w+\s*=>\s*\(\{/.exec(networkAnswerText);
  if (!at) throw new Error('networkAnswer no longer maps owedSpaceActs entries from an object literal — the shape moved');
  const literal = balanced(networkAnswerText, at.index + at[0].length - 1);
  return union(literalKeys(literal, networkAnswerText), /\.\.\.actEntryView\(/.test(literal) ? entryKeys : []);
})();

const serverBodyKeys = union(failureBodyKeys, queuedKeys, deletionKeys, wipeKeys);

// ── the client's sets (read lazily: a missing client type is a red test, not a crash of the file) ───────────────────────────────

const clientTypes = () => readClientSource('src/app/core/space-act-outcome.ts') + '\n' + readClientSource('src/app/core/api.types.ts');
const clientKeys = (name: string) => interfaceKeys(clientTypes(), name);

describe('the server\'s space-act shapes are derived (floors: an empty set passes every loop written over it)', () => {
  it('the failure body, the queued body, the deletion answers and the wipe answers', () => {
    expect(failureBodyKeys, `failure body: ${failureBodyKeys.join(', ')}`).toEqual(expect.arrayContaining(['error', 'code', 'status', 'rounds']));
    expect(failureBodyKeys.length).toBeGreaterThanOrEqual(5);
    expect(queuedKeys, `queued body: ${queuedKeys.join(', ')}`).toEqual(expect.arrayContaining(['queued', 'retryAt', 'repeated']));
    expect(queuedKeys.length).toBeGreaterThanOrEqual(4);
    expect(deletionKeys, `deletion answers: ${deletionKeys.join(', ')}`).toEqual(expect.arrayContaining(['status', 'rounds', 'removedHere', 'repeated']));
    expect(wipeKeys, `wipe answers: ${wipeKeys.join(', ')}`).toEqual(expect.arrayContaining(['status', 'deleted', 'rounds', 'repeated', 'refills']));
    // A word inside a refusal's prose is not a key: the route's 400 says "`confirm: true` required" and "an array of …: …".
    expect(wipeKeys).not.toContain('confirm');
    expect(wipeKeys).not.toContain('of');
  });

  it('the act entry, the owed entry and the network view keys', () => {
    expect(entryKeys.length, `ActEntryView: ${entryKeys.join(', ')}`).toBeGreaterThanOrEqual(5);
    expect(entryKeys).toEqual(expect.arrayContaining(['kind', 'since', 'attempts', 'nextRetryAt', 'state']));
    expect(owedKeys, `owed entry: ${owedKeys.join(', ')}`).toEqual(expect.arrayContaining(['entryId', 'localSpaceId', 'networkSpaceId', 'rounds', 'kind', 'state']));
    expect(owedKeys).not.toContain('roundId');
    expect(networkViewKeys.sort()).toEqual(['owedSpaceActs', 'ownYesCarries']);
  });
});

describe('the client reads the space-act answers the server serves (Q-535)', () => {
  it('every key of a delete/wipe answer body is declared by SpaceActBody or named in NOT_READ with why', () => {
    const declared = clientKeys('SpaceActBody');
    const unclassified = serverBodyKeys.filter(k => !declared.includes(k) && !(k in NOT_READ));
    expect(unclassified, `answer keys the client neither reads nor has decided to ignore:\n  ${unclassified.join('\n  ')}`).toEqual([]);
  });

  it('NOT_READ names only keys the server sends and the client does not read — no stale reasons', () => {
    const declared = clientKeys('SpaceActBody');
    const stale = Object.keys(NOT_READ).filter(k => !serverBodyKeys.includes(k) || declared.includes(k));
    expect(stale, 'entries whose reason no longer describes a key').toEqual([]);
  });

  it('a space\'s actPending is typed with every ActEntryView key, and Space declares it', () => {
    const missing = entryKeys.filter(k => !clientKeys('ActEntryView').includes(k));
    expect(missing, 'ActEntryView keys the client does not type').toEqual([]);
    expect(clientKeys('Space')).toContain('actPending');
  });

  it('a network\'s owedSpaceActs entry is typed with every key networkAnswer writes, and Network declares the view keys', () => {
    const typed = union(clientKeys('OwedSpaceAct'), clientKeys('ActEntryView'));
    const missing = owedKeys.filter(k => !typed.includes(k));
    expect(missing, 'owedSpaceActs keys the client does not type').toEqual([]);
    const network = clientKeys('Network');
    expect(networkViewKeys.filter(k => !network.includes(k)), 'networkAnswer keys Network does not declare').toEqual([]);
  });
});

describe('the words for a space act exist in every language, and the retired one is gone (Q-535 design 4, 11)', () => {
  const LANGS = ['en', 'de', 'pl'] as const;
  const dict = (lang: string) => JSON.parse(readFileSync(resolve(CLIENT_ROOT, 'public/assets/i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
  /** The keys the plan names; the attempts line may be one key or a plural family (`.one`/`.other`). */
  const keys = Object.values(ACT_TEXT_KEYS);

  it('derives its key list (a floor)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });

  for (const lang of LANGS) {
    it(`${lang}: every act key is present (a plural family counts)`, () => {
      const d = dict(lang);
      const missing = keys.filter(k => !(k in d) && !Object.keys(d).some(x => x.startsWith(`${k}.`)));
      expect(missing, `${lang} lacks:\n  ${missing.join('\n  ')}`).toEqual([]);
    });

    it(`${lang}: spaces.dangerZone.notDoneYet is removed`, () => {
      expect('spaces.dangerZone.notDoneYet' in dict(lang)).toBe(false);
    });

    it(`${lang}: the act keys write placeholders as {{name}}, without spaces`, () => {
      const d = dict(lang);
      const spaced = Object.entries(d)
        .filter(([k]) => keys.some(p => k === p || k.startsWith(`${p}.`)))
        .filter(([, v]) => /\{\{\s+\w+\s*\}\}|\{\{\w+\s+\}\}/.test(v));
      expect(spaced.map(([k]) => k)).toEqual([]);
    });
  }
});
