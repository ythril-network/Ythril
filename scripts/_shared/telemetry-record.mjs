/**
 * Declare, check and upsert-by-key ONE telemetry record of a code-declared chrono type (Q-590).
 *
 * `Test-Run` (`scripts/test-times.mjs`) and `Trade` (`scripts/trade.mjs`) are records of this kind: a typed chrono entry in
 * `y-proj-ythril`, found by date and filter and never by meaning, identified by `properties.recordKey`, kept a stated number of
 * days. The module answers one question about them and leaves everything about WHERE a record comes from, which exit code a
 * failure earns and what a line says to the caller.
 *
 * ## What it prevents
 *
 * Each of these was either already a defect of the first recorder or the way a second one would repeat it, and each is closed
 * INSIDE the module so no caller can leave it out:
 *
 * - **A record found by key alone.** A key is a short string (`trade:130`) and another type's entry may carry the same text.
 *   {@link upsertTelemetryRecord} finds by type AND key, and refuses to treat a row of another type as a hit.
 * - **A replace that keeps a stale field.** `update_chrono` MERGES `properties`, so a field the new payload leaves out keeps its
 *   old value and the record then says two things about two moments. The payload is written whole, every time: it must carry
 *   every required field ({@link checkTelemetryProperties}), an update names them all, and an OPTIONAL field the payload lacks is
 *   deleted by the same update (`deleteFields`), so nothing of the replaced record survives that the new one did not say.
 * - **A second record for one key.** Duplicates of a key collapse to the newest.
 * - **A type that cannot be declared, or that disagrees with the writer.** The declaration is generated from the same spec the
 *   writer is checked against ({@link telemetryTypeDeclaration}); a field with a type the server has no word for (an array, a
 *   date: the chrono property types are string, number and boolean) is refused when the spec is read.
 * - **A failure that is a throw in the middle of a batch.** {@link upsertTelemetryRecords} returns one outcome per record
 *   (`inserted`, `replaced`, `kept`, `failed`); the caller chooses the exit code and the words.
 *
 * ## What it does not decide
 *
 * Whether to REPLACE a stored record is the caller's rule, handed in as `replaceWhen(stored, next)`: trade keeps a record that
 * holds runs the listing no longer shows, test-times always replaces. Keep-on-disk and draining stay with test-times (trade
 * regenerates its figures from `gh`; a drained old payload would overwrite a newer record). The destination and the CI refusal
 * are `record-destination.mjs`, the one-writer lock is `record-lock.mjs`.
 *
 * Imports: Node built-ins, `ythril-api.mjs` and the two no-package test modules the recorder already uses (the advisory CI job
 * runs without `npm ci`).
 */
import { YthrilApiError } from './ythril-api.mjs';
import { newestBy } from './newest-by.mjs';
import { TIMING_SCOPES } from '../../testing/_shared/timing-reporter.mjs';

export const TELEMETRY_SPACE = 'y-proj-ythril';

/** The chrono types a space has before it declares its own; declaring one without them closes the space to them. */
const DEFAULT_CHRONO_TYPES = Object.freeze(['event', 'deadline', 'plan', 'prediction', 'milestone']);

/** What a chrono property can be (`PropertySchemaZ`, schema/src/space-meta.ts): no array, no date. */
const PROPERTY_TYPES = new Set(['string', 'number', 'boolean']);

/** `maxChars` asked of `filter`: a record's own bulky fields are excluded, the rest is small. */
const PAGE_MAX_CHARS = 1_000_000;

/**
 * The properties of one `Test-Run` entry: the ONE description of a record. `ms` is the sum of the files' own durations;
 * `wallMs` is the clock time of the run or job (a node suite's span from its results' sentinel, the client's from its report:
 * its start to the end of its last file); the two differ whenever files overlap. A node file's duration has its module load
 * inside it; a CLIENT file's is vitest's own, from its start to its end, and leaves out collection and setup, so a client
 * figure is not comparable with a node one.
 */
export const TEST_RUN_SCHEMA = Object.freeze({
  recordKey: { type: 'string', required: true, doc: '`source:runId:attempt:job:suite`, `:` and `%` escaped inside a part. The identity: a second recording finds this one.' },
  formatVersion: { type: 'number', required: true, doc: 'The version of this list; a reader skips a record of a version it does not know.' },
  source: { type: 'string', required: true, values: ['ci', 'local'], doc: 'Where the run happened.' },
  commit: { type: 'string', required: true, doc: 'The full commit sha the run tested.' },
  branch: { type: 'string', required: true, doc: 'The branch: the run object\'s for CI, git\'s for a local run.' },
  runId: { type: 'string', required: true, doc: 'The Actions run id as text, or `local-<start>-<commit7>`.' },
  attempt: { type: 'number', required: true, doc: 'The run attempt (1 for a local run).' },
  job: { type: 'string', required: true, doc: 'The CI job that produced the results (the id its artifact name carries), or `local`.' },
  suite: { type: 'string', required: true, doc: 'The suite the results belong to: a node suite\'s name, or `client` for the client\'s vitest run.' },
  ms: { type: 'number', required: true, doc: 'The sum of the files\' own durations, in milliseconds. A node file\'s includes its module load; a client file\'s is vitest\'s own run time for it and excludes collection and setup.' },
  wallMs: { type: 'number', required: false, doc: 'The clock time of the run or job, in milliseconds, when its own results say it: a node suite\'s sentinel span, the client report\'s start to the end of its last file. Absent when they do not.' },
  files: { type: 'number', required: true, doc: 'Test files that reported.' },
  tests: { type: 'number', required: true, doc: 'Tests, skipped suites and failures attributed to a hook or a file (for the client, a file that failed without a failed test, and a test that never reached a verdict, count here).' },
  passed: { type: 'number', required: true, doc: 'Tests that passed.' },
  failed: { type: 'number', required: true, doc: 'Failures, each counted once.' },
  cancelled: { type: 'number', required: true, doc: 'Tests cancelled by their parent.' },
  skipped: { type: 'number', required: true, doc: 'Tests and suites skipped.' },
  todo: { type: 'number', required: true, doc: 'Tests marked todo.' },
  outcome: { type: 'string', required: true, values: ['passed', 'failed', 'cancelled', 'incomplete'], doc: '`incomplete` when the results cannot be vouched for (no sentinel, wrong count, cut line; for the client a test that never reached a verdict, or a runner that failed with no failure counted).' },
  scope: { type: 'string', required: true, values: [...TIMING_SCOPES], doc: 'What the runner covered. Baselines are drawn from `full` only.' },
  layout: { type: 'string', required: true, values: ['local', 'ci-serial-v1', 'ci-parallel-v2'], doc: 'A label for the shape of the workflow or machine: `ci-parallel-v2` when the run left results of more than one test job, `ci-serial-v1` when it left one. Not a key to compare records by: records written before the label was derived this way all say `ci-serial-v1`.' },
  dirty: { type: 'boolean', required: true, doc: 'The working tree had uncommitted changes (always false for CI).' },
  measurements: { type: 'string', required: true, doc: 'JSON: every file\'s ms, tests, skips and failures, and the slowest tests; `none` when the run had no usable artifact.' },
  measurementsChars: { type: 'number', required: false, doc: 'The length of `measurements`, so a reader can ask for it whole.' },
});

/** How long a `Test-Run` entry is kept on the instance, in days. */
export const TEST_RUN_RETENTION_DAYS = 365;

/** Bumped when the list below changes; a reader skips a record of a version it does not know. */
export const TRADE_FORMAT_VERSION = 1;

const count = (doc) => ({ type: 'number', required: true, doc });
const minutes = (doc) => ({ type: 'number', required: true, doc: `${doc} In minutes, rounded to two decimals.` });
const text = (doc) => ({ type: 'string', required: true, doc });

/**
 * The properties of one `Trade` entry: what local preflight skipping the database test files saves and costs for ONE bundle
 * (scripts/trade.mjs; the counting rules are in its docblock). Every figure is a number, so a trend can sum it; the two lists
 * of ids are text.
 */
export const TRADE_SCHEMA = Object.freeze({
  recordKey: text('`trade:<bundle number>`, the number without leading zeros. The identity: a second recording finds this one.'),
  formatVersion: count('The version of this list; a reader skips a record of a version it does not know.'),
  bundle: text('The bundle number as text.'),
  refs: text('The refs the bundle\'s runs were pushed to (`full-run/bundle-<n>`, `full-run/bundle-<n>-a`, ...), sorted, comma-joined.'),
  runIds: text('The ids of every run of the bundle the listing held, counted or left out, sorted, comma-joined. A re-record that lacks one the stored record holds is kept out.'),
  cutoverSha: text('The commit that is the cut-over: the first commit on origin/main that holds scripts/trade.mjs. Runs whose head descends from it are "after".'),
  afterCounted: count('Runs counted after the cut-over.'),
  afterFailures: count('Counted runs after the cut-over whose database step failed in any attempt.'),
  afterTimeouts: count('How many of those failures were timeouts (a step cancelled with no newer push to explain it).'),
  afterUnresolved: count('How many failures have no green database step after them, so their waiting is not in calendarMinutes.'),
  savedMinutes: minutes('CI time of the database step in each counted run\'s first attempt that ran it: a proxy for what local preflight did not run.'),
  costMinutes: minutes('CI time of the database step in the repeats a failure caused.'),
  netMinutes: minutes('savedMinutes minus costMinutes.'),
  calendarMinutes: minutes('Waiting from a failing database step to the next green one. Never inside netMinutes.'),
  supersededCount: count('Runs of the bundle left out because a newer push to the same ref cancelled them.'),
  neverStartedCount: count('Runs of the bundle left out because the database step never started in any attempt.'),
  beforeCounted: count('Runs of the bundle counted before the cut-over: the old regime, reported apart.'),
  beforeFailures: count('Database-step failures among them.'),
});

/**
 * A spec: the ONE description of a record type. `bulkyFields` are paths a find leaves out of every row it reads (a `Test-Run`'s
 * `measurements` is up to 100 KB and no find needs it).
 *
 * @typedef {{ space: string, type: string, description: string, schema: Record<string, { type: string, required?: boolean, values?: string[], doc: string }>,
 *   retention: { days: number }, bulkyFields?: string[] }} TelemetrySpec
 */

function checkedSpec(spec) {
  for (const [key, field] of Object.entries(spec.schema)) {
    if (!PROPERTY_TYPES.has(field.type)) throw new Error(`${spec.type}.${key}: ${field.type} is no chrono property type (string, number or boolean)`);
  }
  if (spec.schema.recordKey?.type !== 'string' || spec.schema.recordKey.required !== true) throw new Error(`${spec.type}: recordKey must be a required string: it is the identity`);
  if (!Number.isInteger(spec.retention?.days) || spec.retention.days < 1) throw new Error(`${spec.type}: a retention of nothing is no bound`);
  return Object.freeze(spec);
}

export const TEST_RUN_SPEC = checkedSpec({
  space: TELEMETRY_SPACE,
  type: 'Test-Run',
  description: 'One suite of one test run (local or CI), written by scripts/test-times.mjs. Found by date and filter, never by meaning: embeddings are suppressed. A passed date means nothing here. Kept one year.',
  schema: TEST_RUN_SCHEMA,
  retention: { days: TEST_RUN_RETENTION_DAYS },
  bulkyFields: ['properties.measurements'],
});

export const TRADE_SPEC = checkedSpec({
  space: TELEMETRY_SPACE,
  type: 'Trade',
  description: 'What local preflight skipping the database test files saves and costs for one bundle (CI time of the database step: saved, cost, net, calendar), written by scripts/trade.mjs --record. Found by date and filter, never by meaning: embeddings are suppressed. A passed date means nothing here. Kept one year.',
  schema: TRADE_SCHEMA,
  retention: { days: 365 },
});

/** Every record type this repository declares. A gate derives its subjects from this list, so a type added here is held at once. */
export const TELEMETRY_SPECS = Object.freeze([TEST_RUN_SPEC, TRADE_SPEC]);

/**
 * The arguments of the `schema_update` call that declares the type on the spec's space, generated from the spec: the writer and
 * the declaration cannot disagree about a field. The server's default chrono types are in the payload (merge mode keeps the
 * space's others, but a space with no chrono types of its own would otherwise be closed to the defaults by declaring one).
 *
 * @param {TelemetrySpec} spec
 */
export function telemetryTypeDeclaration(spec) {
  const propertySchemas = {};
  for (const [key, f] of Object.entries(spec.schema)) {
    propertySchemas[key] = { type: f.type, ...(f.values ? { enum: [...f.values] } : {}), ...(f.required ? { required: true } : {}), description: f.doc };
  }
  const chrono = Object.fromEntries(DEFAULT_CHRONO_TYPES.map(t => [t, {}]));
  chrono[spec.type] = {
    description: spec.description,
    suppressEmbeddings: true,
    whenDuePasses: 'nothing',
    retention: { days: spec.retention.days },
    propertySchemas,
  };
  return { space: spec.space, typeSchemas: { chrono }, typeSchemasMode: 'merge' };
}

/**
 * The properties, returned, when they are exactly what the spec says: no key outside it, every value of its type and enum, every
 * required key present. Throws an `Error` naming the key otherwise.
 *
 * @param {TelemetrySpec} spec
 * @param {Record<string, string|number|boolean>} properties
 */
export function checkTelemetryProperties(spec, properties) {
  for (const [key, value] of Object.entries(properties)) {
    const field = spec.schema[key];
    if (!field) throw new Error(`${key} is not a ${spec.type} property`);
    if (typeof value !== field.type || (field.type === 'number' && !Number.isFinite(value))) throw new Error(`${key} must be a ${field.type}`);
    if (field.values && !field.values.includes(value)) throw new Error(`${key} must be one of ${field.values.join(', ')}`);
  }
  for (const [key, field] of Object.entries(spec.schema)) {
    if (field.required && properties[key] === undefined) throw new Error(`${key} is required`);
  }
  return properties;
}

/** The entries of the spec's type holding `key`, newest first. The server's predicate is not trusted: a row that lacks the key, or is of another type, is not one. */
export async function findTelemetryRecords(api, spec, key) {
  const projection = Object.fromEntries((spec.bulkyFields ?? []).map(path => [path, 0]));
  const answer = await api.call('filter', {
    space: spec.space, collection: 'chrono', filter: { type: spec.type, 'properties.recordKey': key },
    ...(Object.keys(projection).length ? { projection } : {}), sort: 'createdAt', dir: 'desc', limit: 100, maxChars: PAGE_MAX_CHARS,
  });
  const rows = answer?.data?.results;
  if (!Array.isArray(rows)) throw new YthrilApiError('filter: the answer carried no results', { tool: 'filter' });
  return rows.filter(r => r?.type === spec.type && r?.properties?.recordKey === key && typeof r._id === 'string')
    .sort(newestBy('createdAt'));
}

/**
 * Write one record: find by type and key, collapse duplicates to the newest, update it by id; insert when there is none.
 * Embedding is suppressed on the write itself as well as by the type: a record is found by date and filter, never by meaning,
 * and a 100 KB string is never sent to the embedder even before the type is declared. THROWS what the api throws, so a caller
 * can tell a refusing instance from a missing one.
 *
 * @param {{ call(tool: string, args?: object): Promise<any> }} api
 * @param {TelemetrySpec} spec
 * @param {{ title: string, startsAt?: string, endsAt?: string, status?: string, properties: Record<string, string|number|boolean> }} payload
 *   `properties.recordKey` is the key; `space` and `type`, when present, are the spec's
 * @param {{ replaceWhen?: (stored: object, next: object) => boolean }} [options]  `replaceWhen` is the caller's rule for a record
 *   that exists; false leaves it untouched (outcome `kept`). Default: always replace.
 * @returns {Promise<'inserted'|'replaced'|'kept'>}
 */
export async function upsertTelemetryRecord(api, spec, payload, { replaceWhen = () => true } = {}) {
  const rows = await findTelemetryRecords(api, spec, payload.properties.recordKey);
  const { space: _space, type: _type, ...rest } = payload;
  if (!rows.length) {
    await api.call('save_chrono', { space: spec.space, type: spec.type, ...rest, suppressEmbeddings: true, checkDuplicates: false });
    return 'inserted';
  }
  const [keep, ...duplicates] = rows;
  if (!replaceWhen(keep.properties ?? {}, payload.properties)) return 'kept';
  for (const d of duplicates) await api.call('delete_chrono', { space: spec.space, id: d._id });
  // `update_chrono` merges `properties`: an OPTIONAL field this payload lacks would keep the value of the record it replaces, so it
  // is named in `deleteFields`. A field the payload carries is written; every required one is carried ({@link checkTelemetryProperties}).
  const absent = Object.keys(spec.schema).filter(k => !spec.schema[k].required && payload.properties[k] === undefined).map(k => `properties.${k}`);
  await api.call('update_chrono', { space: spec.space, id: keep._id, ...rest, ...(absent.length ? { deleteFields: absent } : {}), suppressEmbeddings: true });
  return 'replaced';
}

/**
 * {@link upsertTelemetryRecord} for each payload in order, as one outcome per payload: `{ key, outcome, error? }` with `outcome`
 * `inserted`, `replaced`, `kept` or `failed`. A failure is that record's outcome and the batch goes on, EXCEPT when the instance
 * is not answering or refuses the token (no HTTP status, 401, 403): every later call would repeat it, so the rest are `failed`
 * with the same reason, without being sent.
 */
export async function upsertTelemetryRecords(api, spec, payloads, options) {
  const outcomes = [];
  let stopped = null;
  for (const payload of payloads) {
    const key = payload.properties.recordKey;
    if (stopped) { outcomes.push({ key, outcome: 'failed', error: stopped }); continue; }
    try {
      outcomes.push({ key, outcome: await upsertTelemetryRecord(api, spec, payload, options) });
    } catch (err) {
      const error = String(err?.message ?? err).split('\n')[0];
      outcomes.push({ key, outcome: 'failed', error });
      if (!(err instanceof YthrilApiError) || err.status === undefined || err.status === 401 || err.status === 403) stopped = error;
    }
  }
  return outcomes;
}
