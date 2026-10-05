import type { Config } from './types.js';
import { log, peerText } from '../util/log.js';

/**
 * The four legacy `mediaEmbedding` spellings, and the modern field each one moved to.
 *
 * They are the *config-file* half of the 2.1 rename. The **env-var** half (`OLLAMA_URL`, `WHISPER_URL`,
 * `WHISPER_MODEL`) is deliberately PERMANENT and must not be touched here: breaking a documented env var to
 * improve its spelling turns an upgrade into an outage, and an operator's manifest is not their config.json.
 */
const ALIASES = [
  ['ollamaUrl', 'vision', 'baseUrl'],
  ['visionModel', 'vision', 'model'],
  ['whisperUrl', 'stt', 'baseUrl'],
  ['whisperModel', 'stt', 'model'],
] as const;

/**
 * Lift the legacy `mediaEmbedding` URL/model spellings onto their modern homes, and delete them.
 *
 * Removing the read fallbacks without this would be a **silent** downgrade, not an error: an instance whose
 * vision endpoint is configured as `mediaEmbedding.ollamaUrl` would fall through to the built-in default
 * `http://ollama:11434` and start captioning against whatever answers there — or nothing. Nobody gets an
 * error message; recall just quietly stops finding what images say.
 *
 * The modern field WINS when both are present, and the legacy key is removed either way. If the two
 * disagree, the modern one is by definition the more recent — it is the only one the Settings UI writes.
 *
 * Returns whether anything moved, so the caller knows whether to persist.
 */
export function migrateMediaProviderAliases(config: Config): boolean {
  const media = config.mediaEmbedding as Record<string, unknown> | undefined;
  if (!media) return false;

  let moved = false;
  for (const [legacy, block, field] of ALIASES) {
    const value = media[legacy];
    if (typeof value !== 'string' || value === '') continue;
    const target = (media[block] ??= {}) as Record<string, unknown>;
    if (target[field] === undefined || target[field] === '') target[field] = value;
    delete media[legacy];
    moved = true;
  }
  return moved;
}

/**
 * Run the lift at boot and persist it, mirroring `migrateProviderApiKeysOnBoot`.
 *
 * Lives beside the migration rather than in `loadConfig` for the reason the god-file ratchet exists:
 * `config/loader.ts` is frozen at a size it is supposed to come DOWN from, and the reasoning here is longer
 * than the call.
 *
 * Never throws — a failed write is logged and retried on the next boot. A config rewrite is not worth
 * refusing to start over.
 */
export function migrateMediaAliasesOnBoot(config: Config, saveConfig: (c: Config) => void): void {
  if (!migrateMediaProviderAliases(config)) return;
  try {
    saveConfig(config);
    log.info('Migrated mediaEmbedding ollamaUrl/visionModel/whisperUrl/whisperModel → vision.*/stt.*');
  } catch (err) {
    log.warn(`Could not persist mediaEmbedding alias migration (will retry next boot): ${peerText(err)}`);
  }
}
