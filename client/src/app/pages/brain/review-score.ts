/**
 * How a 0..1 score is shown on a Review card: the whole percent, and the band its confidence meter is drawn in.
 *
 * One question: "how strong does this score look". The Duplicates and Suggestions cards and the Contradictions panel each draw the same
 * meter, and a band cut-off written once per component is how one of them would come to call 0.9 high while another called it mid.
 * The score is clamped, so a server value outside 0..1 cannot draw a bar wider or narrower than its track.
 */
import { Signal, computed } from '@angular/core';
import { pageTranslator } from '../../core/page-translator';
import type { SummaryItem } from '../../shared/summary-strip.component';

export function scorePct(s: number): number {
  return Math.round(Math.min(Math.max(s, 0), 1) * 100);
}

export function scoreVariant(s: number): 'high' | 'mid' | 'low' {
  return s >= 0.95 ? 'high' : s >= 0.85 ? 'mid' : 'low';
}

/**
 * The Duplicates strip atop the Review tab: how many still need attention, how strong the matches are, how many are on screen.
 *
 * A signal that follows the language (`pageTranslator`), made in the component's field initializer; it lives here because the tab is a frozen file and
 * the rollup is arithmetic over the rows plus three labels (Q-185).
 */
export function duplicatesSummaryOf(rows: () => readonly { status: string; score: number }[], shown: () => readonly unknown[]): Signal<SummaryItem[]> {
  const say = pageTranslator();
  return computed<SummaryItem[]>(() => {
    const list = rows();
    const open = list.filter(r => r.status === 'open').length;
    const scores = list.map(r => r.score);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    return [
      { label: say('duplicates.summary.open'), value: String(open), variant: open ? 'warn' : 'ok' },
      { label: say('duplicates.summary.avgScore'), value: scores.length ? `${Math.round(avg * 100)}%` : '—' },
      { label: say('duplicates.summary.shown'), value: String(shown().length) },
    ];
  });
}
