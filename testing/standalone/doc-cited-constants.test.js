/**
 * Numbers the docs quote must match the constants they are quoting.
 *
 * Slice 4d of the pre-release documentation audit. The audit's only real finding so far (#489) was
 * exactly this shape: the user guide said offsite backups were kept forever, the constant said 14, and
 * the mismatch had been silently deleting archives.
 *
 * A cited number is the most quietly dangerous thing a doc can contain. Prose that is vaguely out of
 * date reads as vague; a specific figure reads as authoritative and gets planned around. "Requests
 * time out after 30 s" sets a client's own timeout. "Entries are kept for 90 days" sets a compliance
 * answer. Nothing fails when the constant moves — the sentence just quietly becomes false.
 *
 * ── Explicit pairs, not a scanner ───────────────────────────────────────────────────────────────
 *
 * Earlier slices taught the cost of a clever scanner: matching prose numbers to code constants
 * generically produced far more noise than signal (69 and then 36 false proposals on config keys, 89
 * on routes). So this file names each pair. It is more typing and it will not catch a constant nobody
 * listed — but every failure it reports is real, which is the property that decides whether a check
 * survives or gets skipped.
 *
 * To extend: add a row. The `doc` pattern should be specific enough that it only matches the sentence
 * making the claim.
 *
 * Run: node --test testing/standalone/doc-cited-constants.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
/**
 * Read a file — and treat a SPLIT guide as **the whole guide**, not its index.
 *
 * Both the integration guide and the user guide are directories of parts with a link-list index at the
 * old path. Naming a part in a row here would tie it to a numeric prefix, so renumbering on insert would
 * break checks that have nothing to do with the change. The rows say "this number is documented in the
 * guide", which stays true wherever inside it the statement lives.
 *
 * **The split is detected, not listed.** Naming `integration-guide` literally is what made the userguide
 * split a hunt for callers — and the offsite-backup row would have gone on passing against an index that
 * no longer contains the number, which is the exact bug (#489) this file exists for.
 */
const read = (rel) => {
  // `.md` stripped and then tested for being a DIRECTORY, not merely existing: rows also pass source
  // paths through here (`server/src/config/types.ts`), and an existence check alone matches the file
  // itself and hands it to `readdirSync`.
  const dir = join(ROOT, rel.replace(/\.md$/, ''));
  if (rel.endsWith('.md') && existsSync(dir) && statSync(dir).isDirectory()) {
    return readdirSync(dir).filter(f => f.endsWith('.md')).sort()
      .map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  }
  return readFileSync(join(ROOT, rel), 'utf8');
};

/**
 * A small count as prose spells it: the numeral or the word, and `a minute` for one. For the user guide, which says
 * "ten minutes" where the integration guide says `10`; a pattern built from it still carries the VALUE read from the source.
 */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const counted = (v, unit) => {
  assert.ok(Number.isInteger(v) && v >= 1 && v < NUMBER_WORDS.length, `${v} ${unit}(s) is not a count this helper can spell`);
  return v === 1 ? `(?:1|one|a) ${unit}` : `(?:${v}|${NUMBER_WORDS[v]}) ${unit}s`;
};

/**
 * Each row: a constant in the source, and the doc sentence that quotes its value.
 *
 * `code` must capture the number in group 1. `doc` must MATCH (the value is interpolated into it), so
 * a changed constant makes the pattern stop matching and the test names both sides.
 */
const CITED = [
  {
    what: 'sync peer request timeout',
    source: 'server/src/sync/peer-timeouts.ts',
    code: /const FETCH_TIMEOUT_MS = ([0-9_]+);/,
    scale: 1000,   // ms in code, seconds in prose
    doc: 'docs/network-types.md',
    text: (v) => new RegExp(`${v}\\s*s\\b[^.]*small requests`, 'i'),
  },
  {
    what: 'sync batch transfer timeout',
    source: 'server/src/sync/peer-timeouts.ts',
    code: /const BATCH_FETCH_TIMEOUT_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/network-types.md',
    text: (v) => new RegExp(`${v}\\s*s\\b[^.]*batch transfers`, 'i'),
  },
  {
    what: 'schema-library catalog proxy timeout',
    source: 'server/src/api/schema-library.ts',
    code: /const CATALOG_PROXY_TIMEOUT_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`request times out\\*\\*\\s*\\(${v}\\s*s\\)`, 'i'),
  },
  {
    what: 'audit entry retention',
    source: 'server/src/audit/audit.ts',
    code: /const DEFAULT_RETENTION_DAYS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`retentionDays\`? \\(default ${v}\\)`),
  },
  {
    what: 'record-change retention',
    source: 'server/src/audit/change-retention.ts',
    code: /export const DEFAULT_RECORD_CHANGE_RETENTION_DAYS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`recordChangeRetentionDays\`[^|]*\\|[^|]*\\|\\s*\`${v}\``),
  },
  {
    what: 'offsite backup retention — the claim that was WRONG and started this slice',
    source: 'server/src/db/backup-scheduler.ts',
    code: /const DEFAULT_KEEP_OFFSITE = ([0-9_]+);/,
    doc: 'docs/userguide.md',
    text: (v) => new RegExp(`Default: ${v}\\*\\*`),
  },
  {
    what: 'SSRF redirect hop limit',
    source: 'server/src/util/ssrf.ts',
    code: /const maxRedirects = opts\.maxRedirects \?\? ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`defaults to ${v} and is configurable via \`webhookMaxRedirects\``),
  },
  {
    what: 'minimum detectable face size, as a fraction of the shorter image side',
    source: 'server/src/config/loader.ts',
    code: /minFaceSizeFraction: (0\.[0-9]+),/,
    scale: 0.01,   // fraction in code, percent in prose
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`default: ${v}% of the shorter image side`),
  },
  {
    // Set from measurement (`testing/bench/merge-hub-in-one-transaction.mjs`), so it is a number that MOVES — and a
    // caller sizes its own hub-splitting around the one the guide states.
    what: 'the most records one merge relinks (integration guide)',
    source: 'server/src/brain/merge.ts',
    code: /export const MERGE_MAX_RELINKS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`One merge relinks at most \\*\\*${v}\\*\\* records`),
  },
  {
    what: 'the most records one merge relinks (user guide)',
    source: 'server/src/brain/merge.ts',
    code: /export const MERGE_MAX_RELINKS = ([0-9_]+);/,
    doc: 'docs/userguide.md',
    text: (v) => new RegExp(`more than \\*\\*${v}\\*\\* links, relationships`),
  },
  {
    what: 'the most characters of one value a log line carries (integration guide)',
    source: 'server/src/util/log.ts',
    code: /export const LOG_VALUE_MAX = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`cut at \\*\\*${v}\\*\\* characters per value`),
  },
  {
    what: 'how many references a write\'s reference refusal names (integration guide)',
    source: 'server/src/brain/entity-refs.ts',
    code: /const REFS_NAMED = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`names its first \\*\\*${v}\\*\\* references`),
  },
  {
    what: 'how much of one reference a reference refusal quotes (integration guide)',
    source: 'server/src/brain/entity-refs.ts',
    code: /const REF_QUOTED = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`references, each cut at \\*\\*${v}\\*\\* characters`),
  },
  {
    what: 'how many unknown keys a REST body refusal names (integration guide, bundle-30 I6 C18)',
    source: 'server/src/brain/query.ts',
    code: /const UNKNOWN_NAMED = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`its first \\*\\*${v}\\*\\* unknown keys`),
  },
  {
    what: 'how much of one unknown key either door quotes (integration guide, bundle-30 I6 C18)',
    source: 'server/src/util/log.ts',
    code: /export const NAME_QUOTED = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`each unknown key\\s+cut at \\*\\*${v}\\*\\* characters`),
  },
  {
    what: 'contradiction-scanner similarity threshold',
    source: 'server/src/config/types.ts',
    code: /Default: (0\.[0-9]+)\./,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`default is therefore left at ${v}`),
  },
  {
    // A constant, not a setting, so the guide states the figure and not the name (`env-var-docs-coverage` reads every
    // upper-case name in the guide as an environment variable). It is added to how long a hold can last (`Q-380`).
    what: 'how long the write bound\'s backstop spends ending the server operation before it answers',
    source: 'server/src/db/write-bound.ts',
    code: /export const KILL_WAIT_MS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`within at most ${v} ms\\. Only then is the hold released`),
  },
  // ── bundle-53: the figures an operator plans around when the database slows or stops answering ─────────────────────────
  // Every one is read from the module that owns it; the guide states them in the sentence the pattern names, so a figure
  // that moves makes the sentence stop matching and this row names both sides.
  {
    what: 'the client\'s connect timeout when MONGO_URI names none (MONGO_URI row, hosting)',
    source: 'server/src/db/client-options.ts',
    code: /export const CONNECT_TIMEOUT_MS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`\`connectTimeoutMS=${v}\``),
  },
  {
    what: 'the client\'s heartbeat frequency when MONGO_URI names none (MONGO_URI row, hosting)',
    source: 'server/src/db/client-options.ts',
    code: /export const HEARTBEAT_FREQUENCY_MS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`\`heartbeatFrequencyMS=${v}\``),
  },
  {
    what: 'the client\'s server-selection timeout when MONGO_URI names none (MONGO_URI row, hosting)',
    source: 'server/src/db/client-options.ts',
    code: /export const SERVER_SELECTION_TIMEOUT_MS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`\`serverSelectionTimeoutMS=${v}\``),
  },
  {
    what: 'the per-operation bound of a background housekeeping job (hosting, environment table)',
    source: 'server/src/db/write-bound.ts',
    code: /const DEFAULT_HOUSEKEEPING_OP_MS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`\\| \`YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS\` \\| \`${v}\` \\|`),
  },
  {
    what: 'the bound of a queue claim or a stall reset (background jobs note, setup API)',
    source: 'server/src/db/write-bound.ts',
    code: /export const CLAIM_OP_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`claim or a stall reset[^.]*\\*\\*${v} s\\*\\*`, 'i'),
  },
  {
    what: 'how many spaces in a row may time out before a housekeeping pass stops (background jobs note, setup API)',
    source: 'server/src/util/housekeeping-walk.ts',
    code: /export const STALLED_AFTER_TIMEOUTS = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`\\*\\*${v}\\*\\* spaces in a row`),
  },
  {
    what: 'the first quarantine of a space that timed out (background jobs note, setup API)',
    source: 'server/src/util/housekeeping-walk.ts',
    code: /export const QUARANTINE_BASE_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`quarantine starts at \\*\\*${v} s\\*\\*`),
  },
  {
    what: 'the longest a quarantine grows to (background jobs note, setup API)',
    source: 'server/src/util/housekeeping-walk.ts',
    code: /export const QUARANTINE_MAX_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`doubles up to \\*\\*${v} s\\*\\*`),
  },
  {
    what: 'how often one failure is said in the log, per step and space (background jobs note, setup API)',
    source: 'server/src/util/space-failure.ts',
    code: /export const SPACE_FAILURE_WINDOW_MS = ([0-9_]+) \* 60_000;/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`once per \\*\\*${v} minutes\\*\\*`),
  },
  {
    what: 'how often the retention sweep runs (write semantics)',
    source: 'server/src/brain/ttl-sweep.ts',
    code: /export const SWEEP_INTERVAL_MS = ([0-9_]+) \* 60_000;/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`every \\*\\*${v} minutes\\*\\*`),
  },
  {
    what: 'the most records the retention sweep deletes per collection per cycle (write semantics)',
    source: 'server/src/brain/ttl-sweep.ts',
    code: /export const SWEEP_BATCH = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`up to \\*\\*${v}\\*\\* records? per collection`),
  },
  {
    what: 'the most distinct records the retention sweep looks at per collection per cycle (write semantics)',
    source: 'server/src/brain/ttl-sweep.ts',
    code: /export const ATTEMPT_CAP = ([0-9_]+);/,
    doc: 'docs/integration-guide.md',
    text: (v) => new RegExp(`no more than \\*\\*${v}\\*\\* distinct records`),
  },

  // ── the user guide's copies of the same figures (bundle-53 G28), in the operator's words ───────────────────────────────
  // Prose spells a small number ("ten minutes", "a minute"), so these patterns take the numeral or the word
  // (`counted`), and a sentence that wraps across a line is matched with `\s+`.
  {
    what: 'the connect timeout when MONGO_URI names none (user guide, MongoDB connection)',
    source: 'server/src/db/client-options.ts',
    code: /export const CONNECT_TIMEOUT_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`connectTimeoutMS\` \\(how long a new connection may take, \\*\\*${v} seconds\\*\\*`),
  },
  {
    what: 'the heartbeat frequency when MONGO_URI names none (user guide, MongoDB connection)',
    source: 'server/src/db/client-options.ts',
    code: /export const HEARTBEAT_FREQUENCY_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`heartbeatFrequencyMS\` \\(how often the server is asked whether it is alive, \\*\\*${v} seconds\\*\\*`),
  },
  {
    what: 'the server-selection timeout when MONGO_URI names none (user guide, MongoDB connection)',
    source: 'server/src/db/client-options.ts',
    code: /export const SERVER_SELECTION_TIMEOUT_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`serverSelectionTimeoutMS\` \\(how long an operation waits to find a server, \\*\\*${v} seconds\\*\\*`),
  },
  {
    what: 'how long Test Connection waits by default (user guide, MongoDB connection)',
    source: 'server/src/db/conn-test.ts',
    code: /const TEST_TIMEOUT_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`it waits \\*\\*${v} seconds\\*\\* by default`),
  },
  {
    what: 'the housekeeping bound, in minutes (user guide, Server Log)',
    source: 'server/src/db/write-bound.ts',
    code: /const DEFAULT_HOUSEKEEPING_OP_MS = ([0-9_]+);/,
    scale: 60_000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`\\*\\*${v} minutes\\*\\* by default \\(\`YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS\``),
  },
  {
    what: 'the housekeeping bound, in ms, in the line the log says (user guide, Server Log)',
    source: 'server/src/db/write-bound.ts',
    code: /const DEFAULT_HOUSEKEEPING_OP_MS = ([0-9_]+);/,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`past its time bound of\\s+${v} ms \\(YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS\\)`),
  },
  {
    what: 'the first quarantine, in the line the log says (user guide, Server Log)',
    source: 'server/src/util/housekeeping-walk.ts',
    code: /export const QUARANTINE_BASE_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`retried after quarantine \\(${v}s\\)`),
  },
  {
    what: 'the first quarantine, in words (user guide, Server Log)',
    source: 'server/src/util/housekeeping-walk.ts',
    code: /export const QUARANTINE_BASE_MS = ([0-9_]+);/,
    scale: 60_000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`left alone by every background job for ${counted(v, 'minute')}, then for longer`),
  },
  {
    what: 'the longest quarantine, in words (user guide, Server Log)',
    source: 'server/src/util/housekeeping-walk.ts',
    code: /export const QUARANTINE_MAX_MS = ([0-9_]+);/,
    scale: 60_000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`up to ${counted(v, 'minute')}\\*\\*, so the other spaces`),
  },
  {
    what: 'how often one failure is said, in words (user guide, Server Log)',
    source: 'server/src/util/space-failure.ts',
    code: /export const SPACE_FAILURE_WINDOW_MS = ([0-9_]+) \* 60_000;/,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`its line is said at most once every\\s+${counted(v, 'minute')}\\*\\*`),
  },
  {
    what: 'how often a skipped tick is said, in words (user guide, Server Log)',
    source: 'server/src/util/single-flight.ts',
    code: /export const SKIP_WARNING_WINDOW_MS = ([0-9_]+) \* 60_000;/,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`has been running for <n>s\`, at most once every ${counted(v, 'minute')}`),
  },
  {
    what: 'how many records the retention sweep deletes per collection per cycle (user guide, Server Log)',
    source: 'server/src/brain/ttl-sweep.ts',
    code: /export const SWEEP_BATCH = ([0-9_]+);/,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`up to\\s+\\*\\*${v}\\*\\* expired records per collection every`),
  },
  {
    what: 'how often the retention sweep runs (user guide, Server Log)',
    source: 'server/src/brain/ttl-sweep.ts',
    code: /export const SWEEP_INTERVAL_MS = ([0-9_]+) \* 60_000;/,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`per collection every \\*\\*${v} minutes\\*\\*`),
  },
  {
    what: 'how often the retention sweep runs (user guide, Settings)',
    source: 'server/src/brain/ttl-sweep.ts',
    code: /export const SWEEP_INTERVAL_MS = ([0-9_]+) \* 60_000;/,
    doc: 'docs/userguide/04-settings.md',
    text: (v) => new RegExp(`a sweep that runs every ${v} minutes`),
  },
  {
    what: 'how many records the retention sweep deletes per collection per cycle (user guide, Settings)',
    source: 'server/src/brain/ttl-sweep.ts',
    code: /export const SWEEP_BATCH = ([0-9_]+);/,
    doc: 'docs/userguide/04-settings.md',
    text: (v) => new RegExp(`deletes up to\\s+\\*\\*${v}\\*\\* expired records per collection`),
  },
  {
    what: 'how often the unsatisfiable write concern is said in the log (user guide, MongoDB connection)',
    source: 'server/src/brain/store-failure.ts',
    code: /const WRITE_CONCERN_WARNING_WINDOW_MS = ([0-9_]+);/,
    scale: 60_000,
    doc: 'docs/userguide/05-storage-data-and-audit.md',
    text: (v) => new RegExp(`at most once\\s+${counted(v, 'minute')}; change the write concern`),
  },
  {
    what: 'how often the embedding worker\'s stall check runs (user guide, Brain)',
    source: 'server/src/brain/embed-worker.ts',
    code: /const STALL_SWEEP_MS = ([0-9_]+);/,
    scale: 60_000,
    doc: 'docs/userguide/02-brain.md',
    text: (v) => new RegExp(`stall check, which runs \\*\\*once ${v === 1 ? 'a minute' : `every ${counted(v, 'minute')}`}\\*\\*`),
  },
  {
    what: 'how often the reindex watcher looks (user guide, Brain)',
    source: 'server/src/brain/reindex.ts',
    code: /const WATCH_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/userguide/02-brain.md',
    text: (v) => new RegExp(`a watcher that looks every \\*\\*${v} seconds\\*\\*`),
  },
  {
    what: 'how often the reindex watcher looks (integration guide, reindex)',
    source: 'server/src/brain/reindex.ts',
    code: /const WATCH_MS = ([0-9_]+);/,
    scale: 1000,
    doc: 'docs/integration-guide/04d-brain-ops-api.md',
    text: (v) => new RegExp(`a watcher that looks every \\*\\*${v} seconds\\*\\*`),
  },
  {
    what: 'how long before a reindex run whose sweeper died is taken over (integration guide, reindex)',
    source: 'server/src/brain/reindex.ts',
    code: /const SWEEP_LEASE_STALE_MS = ([0-9_]+);/,
    scale: 60_000,
    doc: 'docs/integration-guide/04d-brain-ops-api.md',
    text: (v) => new RegExp(`taken over after \\*\\*${v === 1 ? 'a minute' : counted(v, 'minute')}\\*\\*`),
  },
  {
    what: 'how long before a reindex run whose sweeper died is taken over (user guide, Brain)',
    source: 'server/src/brain/reindex.ts',
    code: /const SWEEP_LEASE_STALE_MS = ([0-9_]+);/,
    scale: 60_000,
    doc: 'docs/userguide/02-brain.md',
    text: (v) => new RegExp(`taken over after \\*\\*${v === 1 ? 'a minute' : counted(v, 'minute')}\\*\\*`),
  },
  // The file-stamp report's reach, said in the two pages an integrator and an operator read: a file whose row lies beyond it is
  // "not checked" on every call, so a changed figure is a changed answer.
  ...['docs/integration-guide/06-spaces-api.md', 'docs/userguide/05-storage-data-and-audit.md'].flatMap(doc => [
    {
      what: `file-stamp report: pages walked per peer (${doc})`,
      source: 'server/src/files/file-stamp-report.ts',
      code: /export const MAX_FEED_PAGES_PER_PEER = ([0-9_]+);/,
      doc,
      text: (v) => new RegExp(`at most ${v}\\s+pages\\s+of\\s+[0-9]+\\s+rows`),
    },
    {
      what: `file-stamp report: rows per feed page (${doc})`,
      source: 'server/src/files/file-stamp-report.ts',
      code: /const FEED_PAGE = ([0-9_]+);/,
      doc,
      text: (v) => new RegExp(`at most\\s+[0-9]+\\s+pages\\s+of\\s+${v}\\s+rows`),
    },
  ]),
];

/**
 * Defaults a NEW SPACE is seeded with, which the docs state separately from the absent-value default.
 *
 * These are the second and third real findings of the audit, and they are the same shape as the first:
 * a documented default that contradicts what the code actually does. `strictLinkage` was documented as
 * `false` when an absent value resolves to `true` AND new spaces are seeded `true` — inverting a
 * safety property, so a reader believes reference validation is off when it is on. `validationMode`
 * was documented as defaulting to `off` without mentioning that every space you create is `strict`.
 *
 * Seeded defaults drift more easily than constants because they live in a route rather than in a
 * named constant, so nothing looks like "the default" when you read the code.
 */
const SEEDED_SPACE_DEFAULTS = [
  {
    what: 'a new space is seeded strictLinkage: true',
    code: /strictLinkage: true/,
    doc: /\*\*Default: `true`\*\* — and an absent value also resolves to `true`/,
  },
  {
    what: 'a new space is seeded validationMode: strict',
    code: /validationMode: 'strict'/,
    doc: /A space you create is `strict`, not `off`/,
  },
];

describe('numbers quoted in the docs match the constants they quote', () => {
  it('every cited constant still exists in its source', () => {
    // Guards the check itself: a renamed constant would otherwise make the pair silently untestable.
    for (const row of CITED) {
      const m = read(row.source).match(row.code);
      assert.ok(m, `${row.what}: no longer found in ${row.source} — rename, or update this pairing`);
    }
  });

  for (const row of CITED) {
    it(`${row.what}`, () => {
      const m = read(row.source).match(row.code);
      assert.ok(m, `constant not found in ${row.source}`);
      const raw = Number(m[1].replace(/_/g, ''));
      const value = row.scale ? raw / row.scale : raw;

      assert.match(read(row.doc), row.text(value),
        `${row.source} says ${raw}${row.scale ? ` (${value}s)` : ''}, but ${row.doc} does not state ` +
        'that value. A quoted number that no longer matches is read as authoritative and planned ' +
        'around — update the doc, or the constant.');
    });
  }
});

describe('the defaults a new space is seeded with are documented as such', () => {
  // The seeding moved to `spaces/space-create.ts` with the rest of the create chain, so both surfaces seed the same
  // posture rather than the route seeding it and a tool not. The pairing is unchanged; only where the code lives is.
  const spacesSrc = read('server/src/spaces/space-create.ts');
  const guide = read('docs/integration-guide.md');

  for (const row of SEEDED_SPACE_DEFAULTS) {
    it(row.what, () => {
      assert.match(spacesSrc, row.code,
        'the seeded default changed in api/spaces.ts — update the doc and this pairing together');
      assert.match(guide, row.doc,
        'the integration guide no longer states this seeded default. A space-creation default that ' +
        'contradicts the docs is how strictLinkage came to be documented as `false` while both an ' +
        'absent value and a new space resolved to `true`.');
    });
  }
});
