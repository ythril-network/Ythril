/**
 * The assist model's budget, fallback and API kind as the Models card edits and sends them (`F-33`, `F-33.1`).
 *
 * Pure, and apart from the state service for two reasons: that service sits close to its size ceiling, and these
 * are the rules a hand-written copy gets wrong. The server merges these two fields as "absent keeps, `null`
 * removes", so this card always sends them — an empty fallback or an unset budget as `null`, which is what the
 * operator cleared. The fallback's key is sent only from its own input, never echoed back from the masked value
 * the GET returns, or a save would overwrite a real credential with asterisks.
 */
import type { AssistApi, AssistBudgetCfg, AssistFallbackCfg, DocAssistCfg } from './media-processing.types';

/** A host a fallback is reached at, or '' when the URL does not parse. */
export function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : ''; } catch { return ''; }
}

/**
 * Loopback or a bare service name — nothing leaves the instance, so no consent is due. The same rule the server
 * applies (`isLocalModelEndpoint`); the server stays the authority and refuses what this lets through.
 */
export function isLocalEndpoint(url: string | undefined): boolean {
  const host = hostOf(url).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return !!host && (host === 'localhost' || host === '::1' || /^127\./.test(host) || !host.includes('.'));
}

/** The budget as it is sent: both numbers positive, or `null` — removed. */
export function budgetPatch(b: AssistBudgetCfg | null | undefined): AssistBudgetCfg | null {
  return b && b.tokens > 0 && b.perHours > 0 ? { tokens: Math.floor(b.tokens), perHours: b.perHours } : null;
}

/** The fallback as it is sent: `null` without an endpoint; its key only when one was typed. */
export function fallbackPatch(fb: AssistFallbackCfg | null | undefined, keyInput: string): AssistFallbackCfg | null {
  if (!fb?.baseUrl?.trim()) return null;
  return {
    api: fb.api ?? 'openai',
    baseUrl: fb.baseUrl.trim(),
    ...(fb.model?.trim() ? { model: fb.model.trim() } : {}),
    ...(fb.acknowledgedHost ? { acknowledgedHost: fb.acknowledgedHost } : {}),
    ...(fb.acknowledgedHostForConversations ? { acknowledgedHostForConversations: fb.acknowledgedHostForConversations } : {}),
    ...(keyInput ? { apiKey: keyInput } : {}),
  };
}

/** What the assist card adds to its patch for these three fields. */
export function assistExtrasPatch(a: DocAssistCfg, fallbackKeyInput: string): { api: AssistApi; budget: AssistBudgetCfg | null; fallback: AssistFallbackCfg | null } {
  return { api: a.api ?? 'openai', budget: budgetPatch(a.budget), fallback: fallbackPatch(a.fallback, fallbackKeyInput) };
}

/** An external fallback the documents use can reach, not yet consented for its host. */
export function fallbackNeedsAck(a: DocAssistCfg, repairReachable: boolean): boolean {
  const url = a.fallback?.baseUrl;
  const host = hostOf(url);
  return !!host && !isLocalEndpoint(url) && repairReachable && a.fallback?.acknowledgedHost !== host;
}
