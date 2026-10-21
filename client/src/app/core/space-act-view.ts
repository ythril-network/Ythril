/**
 * How a standing space act (a delete, wipe or rename that is owed or running) is put in words — for the danger tab and the Networks page,
 * which show the same entry (`ActEntryView`) and must not describe one debt in two vocabularies (Q-535).
 *
 * What a hand copy gets wrong, and the functions below do not: a retry time already past is never shown as "5 minutes ago" (it reads
 * "now"), a missing one never as an empty string (it reads "shortly"), and a time ahead always carries its exact instant as visible text,
 * not only a hover.
 */
import type { StatusVariant } from '../shared/status-pill.component';
import type { DateFormatService } from './date-format.service';
import { translatedOrEmpty, type KeyTranslator } from './translated-text';

const ABANDONED = '_abandoned';

/**
 * Did the act end by an abandon: the server's `<kind>_abandoned` (`restore_abandoned`, `migrate_abandoned`, and the state of any kind a
 * newer server can abandon). ONE rule, read by the colour and by "ended" alike (Q-564): each used to name the literals it knew, and an
 * abandoned migrate read as pending work in one place and as ended in the other.
 */
export function isAbandonedState(state: string): boolean {
  return state.length > ABANDONED.length && state.endsWith(ABANDONED);
}

/** An owed act, and one that ended by an abandon, is a warning (neither finishes by itself); every other state is work in progress. */
export function actStateVariant(state: string): StatusVariant {
  if (state === 'done') return 'ok';
  return state === 'owed' || isAbandonedState(state) ? 'warn' : 'pending';
}

export const actStateKey = (state: string): string => `spaces.dangerZone.act.state.${state}`;

/** What a row's words depend on: the server's state, the tries so far, and whether only an abandon ends it. */
export interface ActRowFacts {
  state: string; attempts: number; needsAbandon?: boolean;
  /** The process that runs the act has exited (a migrate that completed): an act that had not finished is not running any more. */
  stopped?: boolean;
}

/** How one row reads: its state word and colour, and whether its tries and its next try are said. */
export interface ActRowView { stateKey: string; variant: StatusVariant; showsAttempts: boolean; showsNextTry: boolean }

/**
 * How ONE standing act's row reads, for the Data page's progress card and the Networks page's owed-acts list (Q-561).
 *
 * The server calls an act `owed` from the moment it is registered, so "Retry owed - Attempts so far: 0 - Next try: shortly" was said of
 * acts that had not started, and of acts no retry will ever run (`needsAbandon`), where it contradicted the sentence beside it. Said
 * once here, so no list keeps the old wording:
 * - owed, only an abandon ends it: no retry, so no "retry owed" and no next try;
 * - owed or registered, no try yet: it has not started, so it is WAITING, with no tries and no next try to name (the server's
 *   `registered` is the same case: a pending space of a migrate reads Waiting in the pill, so its sentence says no next try either);
 * - owed, tried before: a real retry, with its tries and its next try;
 * - the process has exited (`stopped`): an act that had not finished is Stopped, never Running, with no tries and no next try.
 * Any other state keeps its own word; an act that ended (`done`, or `<kind>_abandoned` by {@link isAbandonedState}) names no tries and no
 * next try.
 */
export function actRowView(row: ActRowFacts): ActRowView {
  const owed = row.state === 'owed';
  const ended = row.state === 'done' || isAbandonedState(row.state);
  if (row.stopped && !ended) return { stateKey: actStateKey('stopped'), variant: 'warn', showsAttempts: false, showsNextTry: false };
  if (owed && row.needsAbandon) return { stateKey: actStateKey('abandonOnly'), variant: 'warn', showsAttempts: true, showsNextTry: false };
  if ((owed || row.state === 'registered') && row.attempts === 0) {
    return { stateKey: actStateKey('registered'), variant: 'pending', showsAttempts: false, showsNextTry: false };
  }
  const retryable = owed || row.state === 'registered' || row.state === 'draining';
  return { stateKey: actStateKey(row.state), variant: actStateVariant(row.state), showsAttempts: !ended, showsNextTry: retryable };
}

export const actKindKey = (kind: string): string => `spaces.dangerZone.act.kind.${kind}`;

/**
 * The hint for pressing again while an act stands, in the words for ITS kind (`spaces.dangerZone.act.repeatHint.<kind>`): a repeated
 * delete or wipe joins the act, while a rename, a restore or a migrate is not joined by any button on the tab. A kind this client has no
 * words for gets the generic `.other` sentence, never the delete-or-wipe one - the kind stays the server's string, with no closed set here.
 */
export function actRepeatHintKey(transloco: KeyTranslator, kind: string): string {
  const key = `spaces.dangerZone.act.repeatHint.${kind}`;
  return translatedOrEmpty(transloco, key) ? key : 'spaces.dangerZone.act.repeatHint.other';
}

/** When the next try is, in words: a time ahead (relative and exact), "now" for a past one, "shortly" when the server gave none. */
export function actWhenText(transloco: KeyTranslator, dates: Pick<DateFormatService, 'relative' | 'format'>, retryAt: string | undefined, nowMs: number): string {
  const at = retryAt ? Date.parse(retryAt) : NaN;
  if (Number.isNaN(at)) return transloco.translate('spaces.dangerZone.act.runsShortly');
  if (at <= nowMs) return transloco.translate('spaces.dangerZone.act.retryingNow');
  return `${dates.relative(retryAt, nowMs)} (${dates.format(retryAt, 'datetime')})`;
}
