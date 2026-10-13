import type { TranslocoService } from '@jsverse/transloco';

/**
 * The sentence to show for a refused request: the translation of its `code` when this client knows the code, the
 * server's own sentence when it does not, and `fallbackKey` when the answer carried neither (`Q-133`).
 *
 * One place, because three screens show the same refusals (the join dialog, add-space, rename) and each had its own
 * `err.error?.error ?? …`. A code the client has no words for must still say something true, so the server's
 * sentence is the fallback — never a blank, never the raw code.
 *
 * `keyPrefix` is the family of keys the codes live in: the network refusals by default, `files.refusal` for a file
 * act. A code names a sentence only inside its own family, so a code two surfaces both use can still read differently.
 * The answer's `path`, when it names one, is offered to the sentence as `{{path}}`.
 */
export function refusalText(
  transloco: Pick<TranslocoService, 'translate'>,
  err: { error?: { error?: string; code?: string; path?: string } | null; message?: string } | null | undefined,
  fallbackKey: string,
  keyPrefix = 'networks.refusal',
): string {
  const code = err?.error?.code;
  if (code) {
    const key = `${keyPrefix}.${code}`;
    const text = transloco.translate(key, { path: err?.error?.path ?? '' });
    if (text && text !== key) return text;
  }
  return err?.error?.error ?? transloco.translate(fallbackKey);
}
