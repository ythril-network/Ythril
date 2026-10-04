import type { Config, SecretsFile } from './types.js';
import { log, peerText } from '../util/log.js';

/**
 * Lift any provider API key still sitting in `config.json` into `secrets.json`, and delete it from the
 * config.
 *
 * `secrets.json` is written `0o600`; `config.json` is not, and it is the file an operator copies around,
 * pastes into an issue, and mounts as a ConfigMap. A key in there is the one deprecation in this release
 * that is a disclosure rather than an inconvenience — which is why it is MOVED rather than dropped.
 *
 * The Settings → Models page has written keys to `secrets.json` and deleted them from the config for some
 * time, so this only ever fires for an instance that has not saved that page since. That is exactly the
 * instance nobody is watching.
 *
 * An existing secret WINS and the config copy is discarded: the secrets file is the current store, so if
 * the two disagree the config value is by definition the older one. Returns whether anything moved, so the
 * caller knows to persist both files.
 *
 * **Five providers, not four.** The text-embedding key is handled by `liftEmbeddingKey` below, because it
 * lives at the top level of both files rather than under `mediaEmbedding` — which is exactly why it was
 * missed until 4.0.
 */
export function migrateProviderApiKeysToSecrets(config: Config, secrets: SecretsFile): boolean {
  // No early return on a missing `mediaEmbedding`. It used to bail here, which was right while this
  // function only knew about the four blocks underneath it — and became wrong the moment a FIFTH provider
  // was added at the top level: a config with an inline `embedding.apiKey` and no media block at all would
  // have been reported as nothing to do. The loop below already tolerates an absent block per provider.
  const media = (config.mediaEmbedding ?? {}) as Record<string, { apiKey?: string } | undefined>;
  const PROVIDERS: ReadonlyArray<[string, 'visionApiKey' | 'sttApiKey' | 'nliApiKey' | 'rerankApiKey']> = [
    ['vision', 'visionApiKey'], ['stt', 'sttApiKey'], ['nli', 'nliApiKey'], ['rerank', 'rerankApiKey'],
  ];
  let moved = false;
  for (const [block, secretKey] of PROVIDERS) {
    const stored = media[block];
    if (!stored || typeof stored.apiKey !== 'string' || stored.apiKey === '') continue;
    secrets.mediaEmbedding ??= {};
    if (!secrets.mediaEmbedding[secretKey]) secrets.mediaEmbedding[secretKey] = stored.apiKey;
    delete stored.apiKey;
    moved = true;
  }
  return moved || liftEmbeddingKey(config, secrets);
}

/**
 * The FIFTH provider, and the one every name-keyed sweep walked past.
 *
 * The text-embedding key lives at the TOP level of both files — `config.embedding.apiKey` and
 * `secrets.embedding.apiKey` — not under `mediaEmbedding`, so the loop above never saw it. The rule this
 * module exists for was asserted for `vision`, `stt`, `nli` and `rerank` BY NAME, and `embedding` is not one
 * of those names, so it kept its `config.json` read path for a whole release: `getEmbeddingConfig` resolved
 * `apiKey: embApiKey ?? base.apiKey`.
 *
 * That made it the quietest version of the disclosure this file is about. A modern save writes the new key
 * to `secrets.json` and never deleted the inline one, and the secrets value wins the resolution — so the
 * stale copy sat in a file that is not `0o600`, doing nothing, visible to anyone who read it and to nobody
 * who ran the product.
 *
 * Same rule as the other four: an existing secret WINS, because if the two disagree the config value is by
 * definition the older one, and the config copy goes either way.
 */
function liftEmbeddingKey(config: Config, secrets: SecretsFile): boolean {
  const emb = config.embedding as { apiKey?: string } | undefined;
  if (!emb || typeof emb.apiKey !== 'string' || emb.apiKey === '') return false;
  const s = secrets as SecretsFile & { embedding?: { apiKey?: string } };
  s.embedding ??= {};
  if (!s.embedding.apiKey) s.embedding.apiKey = emb.apiKey;
  delete emb.apiKey;
  return true;
}

/**
 * Run the lift at boot and persist it, mirroring `migrateTokenRightsOnBoot`.
 *
 * Lives here rather than in `loadConfig` for the reason the god-file ratchet exists: the reasoning below is
 * longer than the call, and `config/loader.ts` is already frozen at a size it is supposed to come DOWN from.
 *
 * **`secrets.json` is written FIRST, deliberately.** If the process dies between the two writes this order
 * leaves the key in both files — which still resolves correctly and is cleaned up on the next boot. The other
 * order deletes the only copy, and the symptom is a provider that stops authorising for a reason nothing in
 * the config explains.
 *
 * Never throws: a failed write is logged and retried next boot, exactly like the other boot migrations. A
 * config rewrite is not worth refusing to start over.
 */
export function migrateProviderApiKeysOnBoot(
  config: Config,
  secrets: SecretsFile,
  saveSecrets: (s: SecretsFile) => void,
  saveConfig: (c: Config) => void,
): void {
  if (!migrateProviderApiKeysToSecrets(config, secrets)) return;
  try {
    saveSecrets(secrets);
    saveConfig(config);
    log.info('Moved provider API key(s) from config.json into secrets.json (0o600)');
  } catch (err) {
    log.warn(`Could not persist provider API key migration (will retry next boot): ${peerText(err)}`);
  }
}
