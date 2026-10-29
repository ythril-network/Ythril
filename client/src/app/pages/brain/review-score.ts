/**
 * How a 0..1 score is shown on a Review card: the whole percent, and the band its confidence meter is drawn in.
 *
 * One question: "how strong does this score look". The Duplicates and Suggestions cards and the Contradictions panel each draw the same
 * meter, and a band cut-off written once per component is how one of them would come to call 0.9 high while another called it mid.
 * The score is clamped, so a server value outside 0..1 cannot draw a bar wider or narrower than its track.
 */
export function scorePct(s: number): number {
  return Math.round(Math.min(Math.max(s, 0), 1) * 100);
}

export function scoreVariant(s: number): 'high' | 'mid' | 'low' {
  return s >= 0.95 ? 'high' : s >= 0.85 ? 'mid' : 'low';
}
