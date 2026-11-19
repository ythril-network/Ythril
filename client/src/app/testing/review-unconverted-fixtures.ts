import type { Provider } from '@angular/core';
import { NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import { AuthApi } from '../core/auth-api.service';
import { BrainApi } from '../core/brain-api.service';
import { ConfirmDialogService } from '../core/confirm-dialog.service';
import { ConversionApi } from '../core/conversion-api.service';
import type { ConvertStatus, ConversionResult, UnconvertedListAnswer, UnconvertedOpenGroup, UnconvertedRow } from '../core/conversion.types';
import { RecordDrawerState } from '../pages/brain/record-drawer-state.service';
import type { TokenRights } from '../pages/settings/rights-glyph.component';
import { dictionary } from './i18n-dictionary';

/**
 * What the specs of the Review "Unconverted" section share (bundle-285, Q-939): the shipped English words as a tree, the rows and counts the
 * server answers, and the rights a caller holds. Three spec files (the state, the panel, the tab) read the same fixtures, so a row or a words
 * list is written once.
 *
 * ## The words
 *
 * `unconvertedWords()` is the REAL English of the keys the section reads, so a button is found by what a person reads on it. Keys the section
 * needs that the shipped files do not hold yet are listed in `PENDING_WORDS` with the sentence the section asks for; the shipped value wins
 * where there is one, so the day the locale files carry the key this table is dead weight a spec can drop, and nothing else changes.
 */

/** The prefixes the section reads under; everything else of the dictionary stays out so a flat key cannot collide with a tree node. */
const PREFIXES = [
  'brain.review.unconverted.', 'duplicates.status.', 'duplicates.statusFilterAria', 'brain.review.forks.kindNoun.',
  'spaces.schema.convert.locked', 'spaces.schema.convert.rateLimited', 'spaces.schema.convert.retryIn', 'spaces.schema.convert.running409',
  'spaces.schema.convert.run.counting', 'spaces.schema.convert.run.converting', 'spaces.schema.convert.run.types',
  'common.prev', 'common.next', 'common.cancel', 'common.loadFailed', 'common.retry', 'common.close',
];

/** Keys the section asks for that the locale files of slice S3 do not carry, with the English the section expects (the return of S7 lists them). */
export const PENDING_WORDS: Readonly<Record<string, string>> = {
  'brain.review.unconverted.count.one': '{{range}} of {{count}} record',
  'brain.review.unconverted.count.few': '{{range}} of {{count}} records',
  'brain.review.unconverted.count.many': '{{range}} of {{count}} records',
  'brain.review.unconverted.count.other': '{{range}} of {{count}} records',
  'brain.review.unconverted.emptyFilter.title': 'No records match these filters',
  'brain.review.unconverted.emptyFilter.body': 'There are unconverted records, but none for the reason, record type and status chosen. Choose All to see them.',
  'brain.review.unconverted.cut': 'The counts are incomplete: this space has more groups of unconverted records than the page counts. Choose a record type to see exact numbers.',
  'brain.review.unconverted.openFailed': 'This record could not be opened.',
  'brain.review.unconverted.actFailed': 'The change could not be made. Reload the list to see where it stands.',
  'brain.review.unconverted.confirm.bodyAll.one': 'This takes the {{count}} open record off the list. It is not converted and not changed. You can still find it under “Dismissed”.',
  'brain.review.unconverted.confirm.bodyAll.few': 'This takes the {{count}} open records off the list. They are not converted and not changed. You can still find them under “Dismissed”.',
  'brain.review.unconverted.confirm.bodyAll.many': 'This takes the {{count}} open records off the list. They are not converted and not changed. You can still find them under “Dismissed”.',
  'brain.review.unconverted.confirm.bodyAll.other': 'This takes the {{count}} open records off the list. They are not converted and not changed. You can still find them under “Dismissed”.',
};

/** The English words of the section as the tree `getTranslocoModule` takes. */
export function unconvertedWords(): Record<string, unknown> {
  const shipped = dictionary('en');
  const flat: Record<string, string> = { ...PENDING_WORDS };
  for (const [key, value] of Object.entries(shipped)) if (PREFIXES.some(p => key.startsWith(p))) flat[key] = value;
  const tree: Record<string, any> = {};
  for (const [key, value] of Object.entries(flat)) {
    let node = tree;
    const parts = key.split('.');
    parts.slice(0, -1).forEach(p => { node = node[p] ??= {}; });
    node[parts.at(-1)!] = value;
  }
  return tree;
}

/** One unconverted record as the list answers it; `n` makes its item id, record id and name distinct. */
export function unconvertedRow(n: number, over: Partial<UnconvertedRow> = {}): UnconvertedRow {
  return {
    itemId: `item-${n}`, space: 'customers', kind: 'entity', recordId: `7f3a91c2-${String(n).padStart(4, '0')}-4000-8000-000000000000`, type: 'person',
    reason: 'not_conforming', violations: [{ field: 'properties.age', reason: 'must be a number' }], status: 'open',
    detectedAt: '2026-11-17T10:00:00.000Z', record: { summary: `Person ${n}` }, ...over,
  };
}

/** The open items of one kind, type and reason, as `counts.openBy` groups them. */
export const openGroup = (type: string, reason: string, n: number, kind: UnconvertedOpenGroup['kind'] = 'entity'): UnconvertedOpenGroup => ({ kind, type, reason, n });

/** A list answer: the rows given, the groups given (`counts.open` is their sum unless `counts` says otherwise), the page the rows are. */
export function listAnswer(items: UnconvertedRow[], openBy: UnconvertedOpenGroup[], over: Partial<UnconvertedListAnswer> = {}): UnconvertedListAnswer {
  const open = openBy.reduce((sum, g) => sum + g.n, 0);
  return { items, count: items.length, total: items.length, limit: 25, skip: 0, truncated: false, counts: { open, dismissed: 0, openBy }, ...over };
}

export const okResult = <T>(value: T): ConversionResult<T> => ({ ok: true, value });
export const refused = <T = never>(refusal: Extract<ConversionResult<T>, { ok: false }>['refusal']): ConversionResult<T> => ({ ok: false, refusal });

/** A run in progress: `done` records checked, `left` still to read (null: not counted in time), `unconverted` of them listed so far. */
export function runningStatus(over: Partial<ConvertStatus> = {}): ConvertStatus {
  return {
    state: 'running', types: [{ kind: 'entity', type: 'person', done: false }], steps: [], stepsRefused: [], sources: [{ kind: 'write', at: '2026-11-17T10:00:00.000Z' }],
    startedAt: '2026-11-17T10:00:00.000Z', counts: { stamped: 100, rewritten: 80, unconverted: 4, moved: 0, edgesRestamped: 0 }, left: 816, failures: 0, ...over,
  };
}

/** The calls of `ConversionApi` the section makes, each a spy that answers an empty, healthy space unless a spec gives it another answer. */
export interface ConversionApiStub {
  listUnconverted: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  dismissOne: ReturnType<typeof vi.fn>;
  dismissShown: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

export interface UnconvertedHarnessOptions {
  /** The caller's rights; `null` leaves them unknown (the token never answers), absent is an instance administrator. */
  rights?: TokenRights | null;
  /** The answer of the confirm dialog, given the text asked; absent is yes. */
  confirm?: (data: { title: string; message: string }) => boolean;
}

/**
 * The providers the Unconverted section's state asks for, with `ConversionApi`, the token, the confirm dialog, the Brain's record read and the
 * record drawer replaced by spies. The state itself is not in the list: the spec that mounts the section provides it (or the tab does).
 */
export function unconvertedProviders(over: Partial<ConversionApiStub> = {}, opts: UnconvertedHarnessOptions = {}) {
  const api: ConversionApiStub = {
    listUnconverted: vi.fn(() => of(okResult(listAnswer([], [])))),
    status: vi.fn(() => of(okResult({ state: 'none' }))),
    dismissOne: vi.fn(() => of(okResult({ item: unconvertedRow(1, { status: 'dismissed' }) }))),
    dismissShown: vi.fn(() => of(okResult({ dismissed: 0 }))),
    start: vi.fn(() => of(okResult({ state: 'started', toFp: 'fp', types: [], steps: 0 }))),
    ...over,
  };
  const confirm = vi.fn((data: { title: string; message: string }) => Promise.resolve(opts.confirm ? opts.confirm(data) : true));
  const getRecord = vi.fn(() => of({ _id: 'x', name: 'Person 1' }));
  const drawerOpen = vi.fn();
  const token = () => (opts.rights === null ? NEVER : of({ id: 't', name: 't', rights: opts.rights ?? instanceAdminRights() }));
  const providers: Provider[] = [
    { provide: ConversionApi, useValue: api },
    { provide: AuthApi, useValue: { verifyToken: token } },
    { provide: ConfirmDialogService, useValue: { confirm } },
    { provide: BrainApi, useValue: { getRecord } },
    { provide: RecordDrawerState, useValue: { open: drawerOpen } },
  ];
  return { api, confirm, getRecord, drawerOpen, providers };
}

const rights = (p: Partial<TokenRights>): TokenRights => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...p });
/** A token with the knowledge rung `rung` on `customers` and nothing else: it may read, or read and dismiss, or (with `admin`) not yet convert. */
export const rightsWith = (rung: 'read' | 'write' | 'admin'): TokenRights => rights({ perSpace: { customers: { knowledge: rung } } as TokenRights['perSpace'] });
export const instanceAdminRights = (): TokenRights => rights({ instanceAdmin: true });
/** Knowledge admin and the administration of `customers`: what a conversion is priced at. */
export const convertingRights = (): TokenRights => rights({ perSpace: { customers: { knowledge: 'admin' } } as TokenRights['perSpace'], spaceAdmin: { floor: false, spaces: ['customers'] } });
