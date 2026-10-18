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
import type { KeyTranslator } from './translated-text';

/** An owed act is a warning (it will not finish by itself until its time); every other state is work in progress. */
export function actStateVariant(state: string): StatusVariant {
  return state === 'owed' ? 'warn' : 'pending';
}

export const actStateKey = (state: string): string => `spaces.dangerZone.act.state.${state}`;
export const actKindKey = (kind: string): string => `spaces.dangerZone.act.kind.${kind}`;

/** When the next try is, in words: a time ahead (relative and exact), "now" for a past one, "shortly" when the server gave none. */
export function actWhenText(transloco: KeyTranslator, dates: Pick<DateFormatService, 'relative' | 'format'>, retryAt: string | undefined, nowMs: number): string {
  const at = retryAt ? Date.parse(retryAt) : NaN;
  if (Number.isNaN(at)) return transloco.translate('spaces.dangerZone.act.runsShortly');
  if (at <= nowMs) return transloco.translate('spaces.dangerZone.act.retryingNow');
  return `${dates.relative(retryAt, nowMs)} (${dates.format(retryAt, 'datetime')})`;
}
