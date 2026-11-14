import type { TranslocoService } from '@jsverse/transloco';
import type { TypeReadFailure } from './schema-api.service';

/** A sentence to say: its key and its parameters, for the transloco pipe. */
export interface Words { key: string; params: Record<string, string> }

/**
 * How a definition's dates read (r4 §5.2, §7.8): "Current, since {date}", "{since} to {until}" or "From {since}". The history dialog,
 * the drawer's Compare target, the Brain column and the "Type definition: {span}" chip all say a definition this way, so the rule is
 * one function and a fifth reader cannot word it differently.
 *
 * `date` formats one instant (the app's `DateFormatService`), so no site prints a raw ISO string. A definition with no dates (one
 * only fetched from a member: fetched rows set no span) has no span, answered as null for the caller to leave out.
 */
export function definitionSpan(d: { current?: boolean; since?: string; until?: string }, date: (iso: string) => string): Words | null {
  if (d.current) return d.since ? { key: 'spaces.schema.history.currentSince', params: { since: date(d.since) } } : { key: 'spaces.schema.history.current', params: {} };
  if (d.since && d.until) return { key: 'spaces.schema.history.span', params: { since: date(d.since), until: date(d.until) } };
  if (d.since) return { key: 'spaces.schema.history.spanFrom', params: { since: date(d.since) } };
  return null;
}

/**
 * Why a type read failed, as the reason a "Could not …: {reason}" sentence takes: the three causes the app words itself (r4 §7.6),
 * or the server's own sentence for a refusal this client has no words for.
 */
export function typeReadReason(failure: TypeReadFailure, transloco: TranslocoService): string {
  switch (failure.reason) {
    case 'noAnswer': return transloco.translate('common.reason.noAnswer');
    case 'busy': return transloco.translate('common.reason.busy');
    case 'indexBuilding': return transloco.translate('common.reason.indexBuilding');
    default: return failure.error;
  }
}
