/**
 * Where the database URI comes from: ONE rule, and the one way a URI is written where a person can read it (bundle-157, R4.4, R5.5;
 * Q-553).
 *
 * ## What it prevents
 *
 * The loader read `MONGO_URI ?? config.mongo.uri`, and `??` keeps an EMPTY string: `MONGO_URI=''` (what `docker-compose.yml` writes when
 * the operator sets nothing) was found, was falsy, and the process connected to the BUNDLED default with the config's own URI ignored.
 * The admin route read the same variable by truthiness and told the operator the URI came from the config file. Two spellings of one
 * rule, each defensible, and the operator was told one URI while the process connected to another. Here an empty `MONGO_URI` is UNSET,
 * for the loader (`getMongoUri`), the admin route and the migrate refusal alike, because all three ask {@link effectiveMongoUri}.
 *
 * `redactUri` was two copies (the route and the dump); every place that names a URI now asks this one.
 *
 * ## Why the config is handed in rather than imported
 *
 * The loader asks this module for its `getMongoUri`, so this module cannot import the loader back (`no-runtime-import-cycles`). The
 * loader hands over how to read the configured URI when it loads ({@link readConfiguredMongoUriFrom}); asking before it did THROWS, so
 * a caller can never be told "default" because the config was not there to read.
 */

/** Where the URI the process connects to came from. */
export type MongoUriSource = 'env' | 'config' | 'default';

let configuredUri: (() => string | undefined) | null = null;

/** The loader hands over its reader of `config.mongo.uri`, once, when it loads. */
export function readConfiguredMongoUriFrom(read: () => string | undefined): void {
  configuredUri = read;
}

/** The bundled `ythril-mongo` container, authenticated when the operator supplied credentials for it. */
function bundledMongoUri(): string {
  // The bundled database is unauthenticated by default, so anything that can reach port 27017 could read and rewrite every space
  // (S7). Credentials stay optional so existing installs keep working: Mongo cannot switch auth on in place.
  const user = process.env['MONGO_USERNAME'];
  const pass = process.env['MONGO_PASSWORD'];
  if (user && pass) {
    // Percent-encoded: a password may hold `@`, `:` or `/`, which would otherwise be read as URI delimiters.
    const creds = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
    return `mongodb://${creds}@ythril-mongo:27017/ythril?directConnection=true&authSource=admin`;
  }
  return 'mongodb://ythril-mongo:27017/ythril?directConnection=true';
}

/**
 * The URI the process connects to and where it came from: a NON-EMPTY `MONGO_URI` (the infrastructure's, which always wins), else the
 * config's `mongo.uri`, else the bundled default. An empty `MONGO_URI` is unset. THROWS when the loader has not handed over its reader.
 */
export function effectiveMongoUri(): { uri: string; source: MongoUriSource } {
  const env = process.env['MONGO_URI'];
  if (env) return { uri: env, source: 'env' };
  if (!configuredUri) throw new Error('effectiveMongoUri: the config loader has not loaded, so the configured URI cannot be read');
  const fromConfig = configuredUri();
  if (fromConfig) return { uri: fromConfig, source: 'config' };
  return { uri: bundledMongoUri(), source: 'default' };
}

/** `uri` with its credentials replaced, for an answer or a log line. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@]+@/, '//[credentials]@');
}
