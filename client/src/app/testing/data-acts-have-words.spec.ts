/**
 * Every act kind and every restore or migrate refusal the server can send has its words in en, de and pl (bundle-157, R4.5, A1).
 *
 * `actKindKey(kind)` builds `spaces.dangerZone.act.kind.<kind>` at runtime, so `i18n-key-coverage.spec.ts` (static keys only) cannot see
 * it: the server gained `restore` and the danger tab showed the raw key `spaces.dangerZone.act.kind.restore`, with every test green. The
 * same holds for the per-kind repeat hint and for `refusalText(..., 'data.refusal')`, which looks a code up by name.
 *
 * Derived, never listed: the kinds are the keys of the server's `SPACE_ACT_KINDS` (`server/src/config/types-space-acts.ts`) and the codes
 * are the `code: '...'` literals the data doors answer with, plus each instance-wide kind's `writeRefusalCode` and the backup's refusal
 * during a restore. Each read asserts a floor, so a moved file or a changed spelling cannot pass by finding nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aliasLiterals, readClientSource, readRepoSource } from './server-source';
import { callArguments } from './call-arguments';
import { trackedAppSources } from './tracked-sources';
import { actRowView } from '../core/space-act-view';
import { actSetVariant } from '../pages/settings/act-set-progress.component';

const I18N = resolve(__dirname, '../../../public/assets/i18n');
const LOCALES = ['en', 'de', 'pl'] as const;
const dict = (loc: string): Record<string, string> => JSON.parse(readFileSync(resolve(I18N, `${loc}.json`), 'utf8'));

/** The kinds the server's runtime list declares, in its order. */
function serverActKinds(): { kinds: string[]; instanceWideKinds: string[]; instanceWideCodes: string[]; writeClosedCodes: string[] } {
  const src = readRepoSource('server/src/config/types-space-acts.ts');
  const start = src.indexOf('SPACE_ACT_KINDS = {');
  const end = src.indexOf('} as const', start);
  if (start < 0 || end < 0) throw new Error('SPACE_ACT_KINDS not found in types-space-acts.ts: the record moved or was renamed');
  const body = src.slice(start, end);
  const entries = [...body.matchAll(/\n {2}([a-z][A-Za-z]*): \{([\s\S]*?)\n {2}\}/g)];
  const kinds = entries.map(m => m[1]!);
  const instanceWide = entries.filter(m => /instanceWide:\s*true/.test(m[2]!));
  const instanceWideKinds = instanceWide.map(m => m[1]!);
  const instanceWideCodes = instanceWide
    .map(m => /writeRefusalCode:\s*'([a-z_]+)'/.exec(m[2]!)?.[1])
    .filter((c): c is string => !!c);
  // The kind count when this gate was written: delete, wipe, rename, restore, migrate.
  if (kinds.length < 5) throw new Error(`found ${kinds.length} act kinds - fewer than 5, so the record's spelling changed and a check over each kind would report clean about nothing`);
  if (instanceWideCodes.length < 2) throw new Error(`found ${instanceWideCodes.length} instance-wide refusal codes - fewer than 2`);
  // `SpaceWriteClosedCode` is the type of every kind's `writeRefusalCode`: the code a write to the space is refused with while the act stands.
  const writeClosedCodes = entries
    .map(m => /writeRefusalCode:\s*'([a-z_]+)'/.exec(m[2]!)?.[1])
    .filter((c): c is string => !!c);
  if (writeClosedCodes.length !== kinds.length) throw new Error(`${kinds.length} act kinds but ${writeClosedCodes.length} write-refusal codes - a kind without one cannot be read here`);
  return { kinds, instanceWideKinds, instanceWideCodes, writeClosedCodes };
}

/**
 * The codes the abandon doors answer with (`server/src/spaces/act-set-abandon.ts`, Q-564): its `ABANDON_WORDS` record spells a `none`
 * and a `running` code per kind, and the module refuses to compile without both for every reported kind. Read from that record, with a
 * floor of two per instance-wide kind, so a kind whose codes this gate cannot see fails here rather than passing over nothing.
 */
function abandonCodes(): string[] {
  const src = readRepoSource('server/src/spaces/act-set-abandon.ts');
  const codes = [...src.matchAll(/\b(?:none|running): '([a-z_]+)'/g)].map(m => m[1]!);
  const floor = 2 * serverActKinds().instanceWideKinds.length;
  if (codes.length < floor) throw new Error(`found ${codes.length} abandon codes - fewer than ${floor}, so act-set-abandon.ts moved or its spelling changed`);
  return codes;
}

/** Every code the restore, migrate and backup doors answer with. */
function dataRefusalCodes(): string[] {
  const routes = [...readRepoSource('server/src/api/data.ts').matchAll(/code: '([A-Za-z_]+)'/g)].map(m => m[1]!);
  const backup = [...readRepoSource('server/src/db/backup-scheduler.ts').matchAll(/readonly code = '([A-Za-z_]+)'/g)].map(m => m[1]!);
  const codes = [...new Set([...routes, ...backup, ...abandonCodes(), ...serverActKinds().instanceWideCodes])];
  if (codes.length < 9) throw new Error(`found ${codes.length} data refusal codes - fewer than 9, so a source moved or its spelling changed`);
  return codes;
}

/**
 * Every family of translation keys a refusal's `code` is looked up under: `<prefix>.<code>` (bundle-162, Q-567).
 *
 * `refusalText` looks a code up under the prefix its CALLER hands it and falls back to the server's English sentence, so a code
 * with no words under one prefix is invisible: the screen shows English in a German UI and nothing is red. The server gained five
 * write-closed codes (`space_being_deleted`, `_wiped`, `_renamed`, `_restored`, `_migrated`) and the files, conflicts and views screens
 * had words for none of them, the networks screen for two.
 *
 * Derived from the client source, never listed: the string constants named for refusals (`FILE_REFUSAL_PREFIX`, the module-local
 * `DATA_REFUSALS`), `refusalText`'s default prefix, and every literal (or such a constant) a call hands as the prefix argument of
 * `refusalText` / `describeRefusal` - which is how a screen that spells its prefix inline is found. A prefix argument that is
 * none of those is reported, not skipped.
 */
function refusalPrefixes(): { prefixes: string[]; unresolved: string[] } {
  const sources = trackedAppSources().map(file => ({ file, src: readClientSource(file) }));
  const constants = new Map<string, string>();
  for (const { src } of sources) {
    // A string constant named for refusals, exported (`FILE_REFUSAL_PREFIX`) or module-local (`DATA_REFUSALS`).
    for (const m of src.matchAll(/\bconst (\w*REFUSAL\w*)\s*=\s*'([a-z][a-zA-Z.]*)'/g)) constants.set(m[1]!, m[2]!);
  }
  const prefixes = new Set(constants.values());
  const refusalText = sources.find(s => s.file.endsWith('core/refusal-text.ts'));
  if (!refusalText) throw new Error('core/refusal-text.ts is not among the tracked sources: the module moved, and a check over its prefixes would report clean about nothing');
  const defaults = [...refusalText.src.matchAll(/keyPrefix = '([a-z][a-zA-Z.]*)'/g)].map(m => m[1]!);
  if (!defaults.length) throw new Error('refusalText has no default keyPrefix any more - the spelling changed');
  for (const d of defaults) prefixes.add(d);
  const unresolved: string[] = [];
  const PREFIX_ARGUMENT = { refusalText: 3, describeRefusal: 4 } as const;
  for (const { file, src } of sources) {
    if (file === refusalText.file) continue;
    for (const [fn, at] of Object.entries(PREFIX_ARGUMENT)) {
      for (const m of src.matchAll(new RegExp(`(?<!function )\\b${fn}\\(`, 'g'))) {
        const arg = callArguments(src, m.index! + m[0].length - 1)[at];
        if (arg === undefined) continue; // the default prefix
        const where = `${file}:${src.slice(0, m.index!).split('\n').length}`;
        const literal = /^'([a-z][a-zA-Z.]*)'$/.exec(arg);
        if (literal) prefixes.add(literal[1]!);
        else if (!constants.has(arg)) unresolved.push(`${where}: ${fn} gets prefix \`${arg}\`, which is no literal and no *_REFUSAL_PREFIX constant`);
      }
    }
  }
  return { prefixes: [...prefixes].sort(), unresolved };
}

describe('every write-closed code has its sentence under every refusal prefix (bundle-162, Q-567)', () => {
  const { writeClosedCodes } = serverActKinds();
  const { prefixes, unresolved } = refusalPrefixes();

  it('finds the prefixes (a floor, so a changed spelling cannot pass by finding none) and resolves every prefix argument', () => {
    expect(prefixes.length, `refusal prefixes found: ${prefixes.join(', ')}`).toBeGreaterThanOrEqual(4);
    expect(unresolved, 'refusal prefixes this gate cannot read').toEqual([]);
  });

  for (const loc of LOCALES) {
    it(`${loc}: <prefix>.<code> for each write-closed code under each prefix the client renders refusals under`, () => {
      const d = dict(loc);
      const missing = prefixes.flatMap(p => writeClosedCodes.map(c => `${p}.${c}`)).filter(key => !d[key]);
      expect(missing, `${loc}.json lacks words for a refusal the server sends while an act stands`).toEqual([]);
    });
  }

  it('the file screens\' toast sets classify every write-closed code (a code in neither set is one nobody decided)', () => {
    const src = readClientSource('src/app/pages/files/file-listing.store.ts');
    const setOf = (name: string): string[] => {
      const m = new RegExp(`export const ${name}\\b[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(src);
      if (!m) throw new Error(`no exported set ${name} in file-listing.store.ts - the module moved or was renamed`);
      return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map(x => x[1]!);
    };
    const classified = [...setOf('FILE_REFUSALS_WITH_REMEDY'), ...setOf('FILE_REFUSALS_THAT_STATE_A_FACT')];
    expect(classified.length, 'codes the file screens classify').toBeGreaterThanOrEqual(5);
    expect(writeClosedCodes.filter(c => !classified.includes(c)), 'write-closed codes in neither toast set').toEqual([]);
  });
});

/**
 * The codes a network act answers with (bundle-162, Q-567), read from the `code?:` union of `NetworkActResult`
 * (`server/src/networks/network-acts.ts`): the network refusals, the write-closed codes, `space_retired`, and `space_act_failed` the
 * day the union carries it. The client words them under `networks.refusal`; a member of the union this reader does not know throws, so
 * a new family is a red line here and not a code nobody checked.
 */
function networkActCodes(): string[] {
  const src = readRepoSource('server/src/networks/network-acts.ts');
  const type = src.indexOf('export type NetworkActResult');
  const union = type < 0 ? null : /\bcode\?:\s*([^;]+);/.exec(src.slice(type));
  if (!union) throw new Error('no `code?:` union in NetworkActResult - network-acts.ts moved or its spelling changed');
  const refusalCodes = [...readRepoSource('server/src/networks/refusal-codes.ts').match(/NETWORK_REFUSAL_CODES = \[([\s\S]*?)\] as const/)![1]!.matchAll(/'([a-z_]+)'/g)].map(m => m[1]!);
  const codes = union[1]!.split('|').map(s => s.trim()).flatMap(member => {
    const literal = /^'([a-z_]+)'(?: as const)?$/.exec(member);
    if (literal) return [literal[1]!];
    if (member === 'NetworkRefusalCode') return refusalCodes;
    if (member === 'SpaceWriteClosedCode') return serverActKinds().writeClosedCodes;
    throw new Error(`NetworkActResult's code union has a member \`${member}\` this gate cannot read - teach networkActCodes about it`);
  });
  if (codes.length < 8) throw new Error(`found ${codes.length} network act codes - fewer than 8, so the union changed shape`);
  return [...new Set(codes)];
}

describe('every network act answer code has its sentence under networks.refusal (bundle-162, Q-567)', () => {
  const codes = networkActCodes();
  for (const loc of LOCALES) {
    it(`${loc}: networks.refusal.<code> for each code the network acts answer with`, () => {
      const d = dict(loc);
      expect(codes.filter(c => !d[`networks.refusal.${c}`]), `${loc}.json lacks networks.refusal sentences`).toEqual([]);
    });
  }
});

/**
 * Colour is read off what the row SAYS (bundle-162, Q-472): every state a restore or migrate report can show has words in every locale
 * and a colour the status pill declares, and an ended state is never the in-progress colour.
 *
 * `actStateVariant` and `setVariant` each name the literals they know, and a state the server gains (or the `<kind>_abandoned` of a kind
 * it learns) falls through to `pending` - an abandoned migrate read as work still running until bundle-157 fixed that one literal. The
 * states are read from the server's own types (`ActSetSpaceReport.state`, `SpaceActState`, the `<kind>_abandoned` template expanded over
 * the instance-wide kinds, the set's `state`), the pill's variants from `StatusVariant`; the client's own `stopped` is added for the
 * set because `setState()` can answer it.
 */
function actStates(): { rowStates: string[]; setStates: string[]; terminalRowStates: string[] } {
  const src = readRepoSource('server/src/spaces/act-set-report.ts');
  if (!src.includes('`${ReportedActSetKind}_abandoned`')) throw new Error('ActSetSpaceReport.state no longer spells `${ReportedActSetKind}_abandoned` - act-set-report.ts changed shape');
  const row = /interface ActSetSpaceReport\s*\{[\s\S]*?\bstate:\s*([^;]+);/.exec(src);
  if (!row) throw new Error('no ActSetSpaceReport.state found in act-set-report.ts');
  const reported = [...row[1]!.matchAll(/'([a-z]+)'/g)].map(m => m[1]!);
  const abandoned = serverActKinds().instanceWideKinds.map(k => `${k}_abandoned`);
  const spaceStates = aliasLiterals(readRepoSource('server/src/config/types-space-acts.ts'), 'SpaceActState');
  const set = /export type ActSetReport = \{[\s\S]*?\bstate:\s*([^;]+);/.exec(src);
  if (!set) throw new Error('no ActSetReport.state found in act-set-report.ts');
  const setStates = [...set[1]!.matchAll(/'([a-z]+)'/g)].map(m => m[1]!);
  const rowStates = [...new Set([...reported, ...spaceStates, ...abandoned])];
  if (rowStates.length < 7 || setStates.length < 3) throw new Error(`found ${rowStates.length} row states and ${setStates.length} set states - fewer than 7 and 3, so a type changed shape`);
  return { rowStates, setStates: [...setStates, 'stopped'], terminalRowStates: ['done', ...abandoned] };
}

describe('colour follows what is shown for every act state (bundle-162, Q-472)', () => {
  const { rowStates, setStates, terminalRowStates } = actStates();
  const variants = aliasLiterals(readClientSource('src/app/shared/status-pill.component.ts'), 'StatusVariant');

  it('the pill declares its variants (a floor)', () => {
    expect(variants.length).toBeGreaterThanOrEqual(5);
  });

  it('every row state, in every combination of tries, abandon-only and stopped, has words in every locale and a declared colour', () => {
    const wrong: string[] = [];
    for (const state of rowStates) {
      for (const attempts of [0, 1, 3]) for (const needsAbandon of [false, true]) for (const stopped of [false, true]) {
        const v = actRowView({ state, attempts, needsAbandon, stopped });
        for (const loc of LOCALES) if (!dict(loc)[v.stateKey]) wrong.push(`${loc}: ${v.stateKey} (state ${state})`);
        if (!variants.includes(v.variant)) wrong.push(`state ${state}: colour ${v.variant} is not a StatusVariant`);
      }
    }
    expect([...new Set(wrong)], 'act rows with no words or an undeclared colour').toEqual([]);
  });

  it('an ended row (done, <kind>_abandoned) is never the in-progress colour', () => {
    const pending = terminalRowStates.filter(state => actRowView({ state, attempts: 2 }).variant === 'pending');
    expect(pending, 'ended act states shown as pending').toEqual([]);
  });

  it('every set state has words in every locale and a declared colour', () => {
    const wrong: string[] = [];
    for (const s of setStates) {
      if (!variants.includes(actSetVariant(s))) wrong.push(`set state ${s}: colour ${actSetVariant(s)} is not a StatusVariant`);
      for (const loc of LOCALES) if (!dict(loc)[`data.progress.state.${s}`]) wrong.push(`${loc}: data.progress.state.${s}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a terminal set state (TERMINAL_ACT_SET_STATES, beside the union) is never the in-progress colour', () => {
    const src = readRepoSource('server/src/spaces/act-set-report.ts');
    const m = /export const TERMINAL_ACT_SET_STATES\b[^=]*=\s*(?:new Set\()?\[([^\]]*)\]/.exec(src);
    expect(m, 'server/src/spaces/act-set-report.ts exports no TERMINAL_ACT_SET_STATES: the set states that end a set are written nowhere, so each client reader keeps its own list').not.toBeNull();
    const terminal = [...m![1]!.matchAll(/'([a-z]+)'/g)].map(x => x[1]!);
    expect(terminal.length, 'terminal set states').toBeGreaterThanOrEqual(2);
    expect(terminal.filter(s => !setStates.includes(s)), 'terminal states that are no set state').toEqual([]);
    expect(terminal.filter(s => actSetVariant(s) === 'pending'), 'terminal set states shown as pending').toEqual([]);
  });
});

describe('every act kind has its words in every locale (bundle-157)', () => {
  const { kinds } = serverActKinds();

  for (const loc of LOCALES) {
    it(`${loc}: spaces.dangerZone.act.kind.<kind> and .repeatHint.<kind> for each of the server's kinds`, () => {
      const d = dict(loc);
      const missing = kinds.flatMap(k => [`spaces.dangerZone.act.kind.${k}`, `spaces.dangerZone.act.repeatHint.${k}`]).filter(key => !d[key]);
      expect(missing, `${loc}.json lacks words for act kinds the server sends`).toEqual([]);
    });
  }

  it('the states a restore or migrate report row can carry have their pill words (done, <kind>_abandoned for each instance-wide kind)', () => {
    const abandoned = serverActKinds().instanceWideKinds.map(k => `${k}_abandoned`);
    for (const loc of LOCALES) {
      const d = dict(loc);
      for (const s of ['owed', 'running', 'done', ...abandoned]) expect(d[`spaces.dangerZone.act.state.${s}`], `${loc}: state ${s}`).toBeTruthy();
    }
  });
});

describe('every restore, migrate and backup refusal code has its sentence (bundle-157)', () => {
  const codes = dataRefusalCodes();
  for (const loc of LOCALES) {
    it(`${loc}: data.refusal.<code> for each code the data doors answer with`, () => {
      const d = dict(loc);
      expect(codes.filter(c => !d[`data.refusal.${c}`]), `${loc}.json lacks data.refusal sentences`).toEqual([]);
    });
  }
});

describe('counts on the Data page go through pluralText, with every form a locale uses (bundle-157, A2)', () => {
  /** The plural bases the restore and migrate surfaces count with. */
  const BASES = ['data.restore.accepted', 'data.progress.spacesDone', 'data.restore.emptied', 'data.restore.leftOut', 'data.migrate.accepted'];
  // Every locale carries all four forms, as the existing plural families do: English and German use two of them, Polish all four, and
  // `i18n-key-coverage.spec.ts` holds the three files to one key set.
  const ALL = ['one', 'few', 'many', 'other'];
  const FORMS: Record<(typeof LOCALES)[number], string[]> = { en: ALL, de: ALL, pl: ALL };

  for (const loc of LOCALES) {
    it(`${loc}: every base has ${FORMS[loc].join(', ')}, each with {{count}}`, () => {
      const d = dict(loc);
      for (const base of BASES) {
        for (const form of FORMS[loc]) {
          const text = d[`${base}.${form}`];
          expect(text, `${loc}: ${base}.${form}`).toBeTruthy();
          expect(text, `${loc}: ${base}.${form} carries the count`).toContain('{{count}}');
        }
      }
    });
  }

  it('the backup id placeholder has no spaces ({{id}}), like every other key', () => {
    for (const loc of LOCALES) expect(dict(loc)['data.restore.typeIdToConfirm'], loc).toContain('{{id}}');
  });

  it('the migrate copy no longer says the server restarts automatically: the process exits when the copy completes', () => {
    for (const key of ['data.migrate.description', 'data.migrate.confirm', 'data.migrate.confirmMessage', 'data.migrate.success']) {
      expect(dict('en')[key] ?? '', key).not.toMatch(/restart/i);
    }
  });
});
