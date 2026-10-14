/**
 * Pure formatting helpers shared across the brain page — the shell, the record drawer, and the tab
 * components. No Angular, no `this`, no injection: extracted from BrainComponent (A17.9b) so every
 * owner can import them rather than reach back into the shell.
 */

/** An ISO timestamp as a local `YYYY-MM-DDTHH:mm` string for a `datetime-local` input; '' if invalid. */
export function toLocalDatetime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// `fmtApiError` lived here. A refusal is worded by ONE module now (`core/refusal-text.ts`: `describeRefusal` for a view with
// rows, `refusalText` for a string), in the viewer's language; nothing here builds an English sentence from an error body.
