import type { TranslocoService } from '@jsverse/transloco';

/**
 * The sentence to show for a refused request: the translation of its `code` when this client knows the code, the
 * server's own sentence when it does not, and `fallbackKey` when the answer carried neither (`Q-133`).
 *
 * One place, because three screens show the same refusals (the join dialog, add-space, rename) and each had its own
 * `err.error?.error ?? …`. A code the client has no words for must still say something true, so the server's
 * sentence is the fallback — never a blank, never the raw code.
 */
export function refusalText(
  transloco: Pick<TranslocoService, 'translate'>,
  err: { error?: { error?: string; code?: string } | null; message?: string } | null | undefined,
  fallbackKey: string,
): string {
  const code = err?.error?.code;
  if (code) {
    const key = `networks.refusal.${code}`;
    const text = transloco.translate(key);
    if (text && text !== key) return text;
  }
  return err?.error?.error ?? transloco.translate(fallbackKey);
}
