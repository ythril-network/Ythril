/**
 * `F-31` — the extractors' decision model, resolved; and how an operator changes it.
 *
 * The model every extractor asks its judgement questions (see `Config.decisionModel` for what, and
 * `extractor/decide.ts` for how). Its own module rather than more lines in `loader.ts` and
 * `api/media-config.ts`, both of which are at their size ceiling — and because it is one question, *"which
 * decision endpoint, and may this instance send to it"*, with a read side and a write side that must agree.
 *
 * ## Resolution
 *
 * env (`DECISION_URL` / `DECISION_MODEL` / `DECISION_API_KEY`) > config / secrets > defaults. The defaults are
 * TypeSafe's System One, whose contract the extractors are written against. `acknowledgedHost` is config-only,
 * like the assist model's: consent is the operator's act, and infrastructure can pin an endpoint but never
 * consent to it on the operator's behalf.
 *
 * ## The write side
 *
 * Settable through `PATCH /api/admin/media-config` as a top-level `decisionModel` block, beside `embedding`
 * and `modelSlots` — the Models tab saves one card through one door. The key goes to `secrets.json`, never
 * `config.json`. A block pinned by env is refused (`403`) rather than silently overridden at the next read.
 * A patch that sets the endpoint up without consent to its host is refused with the host named, by the same
 * `refuseUnacknowledgedEgress` the assist and face models use: the decision slot has no rung to sit behind,
 * so it is reachable the moment it is configured.
 */
import { z } from 'zod';
import { getConfig, getSecrets, saveSecrets } from './loader.js';
import { egressConsented, refuseUnacknowledgedEgress } from './egress-consent.js';
import { isSsrfSafeUrl } from '../util/ssrf.js';
import { allowPrivateForSlot, privateAddressHint } from './model-egress-policy.js';
import type { Config } from './types.js';

export const DECISION_MODEL_DEFAULTS = { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' } as const;

/** The env vars that pin the block. Any one of them locks the card, like the assist model's three. */
const DECISION_ENV = ['DECISION_URL', 'DECISION_MODEL', 'DECISION_API_KEY'] as const;

export function decisionModelLockedByEnv(): boolean {
  return DECISION_ENV.some(k => !!process.env[k]);
}

/** The decision model as it would be called now. */
export function getDecisionModelConfig(): { baseUrl: string; model: string; acknowledgedHost?: string } {
  let base: Config['decisionModel'];
  try { base = getConfig().decisionModel; } catch { base = undefined; }
  return {
    baseUrl: process.env['DECISION_URL'] || base?.baseUrl || DECISION_MODEL_DEFAULTS.baseUrl,
    model: process.env['DECISION_MODEL'] || base?.model || DECISION_MODEL_DEFAULTS.model,
    ...(base?.acknowledgedHost ? { acknowledgedHost: base.acknowledgedHost } : {}),
  };
}

/** env (`DECISION_API_KEY`) > secrets.json. Never config.json. */
export function getDecisionApiKey(): string | undefined {
  if (process.env['DECISION_API_KEY']) return process.env['DECISION_API_KEY'];
  try { return getSecrets().decisionApiKey; } catch { return undefined; }
}

/** What the GET returns: the resolved block, the key MASKED, and the two states the card has to show. */
export function decisionModelView(): Record<string, unknown> {
  const d = getDecisionModelConfig();
  return {
    ...d,
    apiKey: getDecisionApiKey() ? '••••••••' : undefined,
    locked: decisionModelLockedByEnv(),
    inUse: egressConsented(d),
  };
}

export const DecisionModelPatchSchema = z.object({
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).max(128).optional(),
  /** `null` or `''` removes the key. */
  apiKey: z.string().max(512).optional().nullable(),
  acknowledgedHost: z.string().max(255).optional(),
}).strict();
export type DecisionModelPatch = z.infer<typeof DecisionModelPatchSchema>;

/** Why this patch may not be applied, or null. Checked before anything is written. */
export function refuseDecisionModelPatch(patch: DecisionModelPatch | undefined): { status: number; body: Record<string, unknown> } | null {
  if (patch === undefined) return null;
  if (decisionModelLockedByEnv()) {
    return { status: 403, body: {
      error: 'The decision model is pinned by environment variables (DECISION_URL / DECISION_MODEL / DECISION_API_KEY) and cannot be changed via the UI',
      locked: ['decisionModel'],
    } };
  }
  const stored = getConfig().decisionModel ?? {};
  const effBaseUrl = patch.baseUrl ?? stored.baseUrl ?? DECISION_MODEL_DEFAULTS.baseUrl;
  if (patch.baseUrl !== undefined && !isSsrfSafeUrl(effBaseUrl, allowPrivateForSlot('decision'))) {
    return { status: 400, body: { error: 'decisionModel.baseUrl rejected: must be a public http(s) URL (no private/loopback/metadata addresses)' + privateAddressHint('decision') } };
  }
  return refuseUnacknowledgedEgress({
    what: 'decision model',
    sends: 'conversation text and the questions the extractor asks about it',
    effBaseUrl,
    effAck: patch.acknowledgedHost ?? stored.acknowledgedHost,
    reachableAfterThisPatch: true,
    // Removing the key, or WITHDRAWING consent (`acknowledgedHost: ''`), sends nothing anywhere — so neither
    // asks for consent. Refusing them would make the one safe edit impossible without first agreeing to egress.
    causedByThisPatch: patch.baseUrl !== undefined || patch.model !== undefined || !!patch.apiKey
      || !!patch.acknowledgedHost,
  });
}

/** Write an accepted patch: the key to secrets, the rest merged into `cfg.decisionModel`. Mutates `cfg`. */
export function applyDecisionModelPatch(cfg: Config, patch: DecisionModelPatch | undefined): void {
  if (patch === undefined) return;
  const { apiKey, ...block } = patch;
  if (apiKey !== undefined) {
    const secrets = getSecrets();
    if (apiKey === null || apiKey === '') delete secrets.decisionApiKey;
    else secrets.decisionApiKey = apiKey;
    saveSecrets(secrets);
  }
  cfg.decisionModel = { ...(cfg.decisionModel ?? {}), ...block };
}
