import { log, peerText } from '../util/log.js';

/**
 * Environment variables that USED to work and no longer do, refused at boot rather than ignored.
 *
 * ## Why a refusal and not silence
 *
 * `OLLAMA_URL`, `WHISPER_URL` and `WHISPER_MODEL` were the pre-2.1 spellings of `VISION_BASE_URL`,
 * `STT_BASE_URL` and `STT_MODEL`. They resolved through an alias for the whole of 3.x, warning once at
 * startup, and 4.0 removes them.
 *
 * **Deleting the alias without this file would be a silent misconfiguration**, which is the one thing a major
 * release is not allowed to do. An operator whose manifest still says `OLLAMA_URL=http://vllm:8000` would
 * boot fine, resolve nothing, fall through to the built-in `http://ollama:11434` default, and caption every
 * document against whatever answers there — with no error anywhere. The hosting guide describes exactly that
 * failure for the config-file half of the same rename, which is how we know what it looks like.
 *
 * So the removal is: the name stops CONFIGURING anything, and starts stopping the boot. A variable that is
 * present and has no effect is the worst of the three possible behaviours.
 *
 * ## The pattern is not new
 *
 * `refuseRemovedDescription` does the same for the space `description` field, for the same reason written
 * down there: the bodies are not strict, so a caller who kept sending it would get a 200 and no directive
 * written. Same defect, different door.
 *
 * ## What belongs here, and what does not
 *
 * Only a variable whose NAME is gone. A variable whose value is out of range belongs in `env-num.ts`, and a
 * config-FILE key that moved belongs in a migration that lifts it — `migrate-media-aliases.ts` is the
 * counterpart for these three, and it rewrites rather than refusing, because `config.json` is a file the
 * product itself owns and can fix.
 */
const REMOVED_ENV_VARS: ReadonlyArray<{ removed: string; use: string; configures: string; since: string }> = [
  { removed: 'OLLAMA_URL', use: 'VISION_BASE_URL', configures: 'vision.baseUrl', since: '4.0' },
  { removed: 'WHISPER_URL', use: 'STT_BASE_URL', configures: 'stt.baseUrl', since: '4.0' },
  { removed: 'WHISPER_MODEL', use: 'STT_MODEL', configures: 'stt.model', since: '4.0' },
];

/** The ones actually set in this environment, as sentences an operator can act on. */
export function removedEnvVarsInUse(): string[] {
  return REMOVED_ENV_VARS
    .filter(e => process.env[e.removed] !== undefined)
    .map(e => `${e.removed} was removed in ${e.since} — use ${e.use} instead. It configures ${e.configures} `
      + 'for every backend, not just the product the old name referred to.');
}

/**
 * Report and exit, or return.
 *
 * Deliberately its own check rather than a row in `env-num.ts`: that one validates a VALUE and can suggest
 * unsetting the variable to take the default. Here the variable itself is the problem and unsetting it loses
 * the operator's setting, so the message has to name the replacement instead.
 */
export function assertNoRemovedEnvVarsOrExit(): void {
  const problems = removedEnvVarsInUse();
  if (problems.length === 0) return;
  log.error(`Refusing to start: ${problems.length} environment variable${problems.length === 1 ? '' : 's'} `
    + 'in this environment was removed in a major release.');
  for (const p of problems) log.error(`  • ${peerText(p)}`);
  log.error('Continuing would be worse than stopping: the value would configure nothing, the built-in default '
    + 'would take its place, and nothing would say so — a vision or speech endpoint silently pointing at the '
    + 'wrong host. Rename the variable(s) above; both spellings worked in every 3.x build, so the rename is '
    + 'safe to make before or after this upgrade.');
  process.exit(1);
}
