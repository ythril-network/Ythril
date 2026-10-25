/**
 * The rollback tool's entry: `node server/dist/tools/positions-rollback.js` (in the image: `node dist/tools/positions-rollback.js`, WORKDIR `/app`).
 *
 * Run it with the 6.0 instance STOPPED and before 5.6 starts, as a one-off container on the same compose file (`docker compose run --rm --no-deps ythril node
 * dist/tools/positions-rollback.js`), while the file still names the 6.0 image. What it does and why it must come first is `sync/positions-rollback.ts`.
 *
 * It reads `config.json` ITSELF, for the one thing it needs from it (`mongo.uri`, when `MONGO_URI` is not set), and never goes through the config loader: that
 * runs the boot migrations and WRITES the file, and this tool runs against whatever 5.6 left, with nothing started. The rule for which URI is used is the server's
 * (`config/mongo-uri.ts`: a non-empty `MONGO_URI`, else the config's, else the bundled database). The URI, and so its password, is never printed. Exits 0 when every
 * step finished and 1 when one failed (naming the failure, never the address); the tool is idempotent, so a failed run is run again.
 */
import fs from 'node:fs';
import { MongoClient } from 'mongodb';
import { effectiveMongoUri, readConfiguredMongoUriFrom } from '../config/mongo-uri.js';
import { dbNameFromUri } from '../db/db-name.js';
import { mongoClientOptions } from '../db/client-options.js';
import { decryptEnvelope, isEnvelope, resolveMasterSecret } from '../config/secretbox.js';
import { rollBackPositions } from '../sync/positions-rollback.js';
import { log } from '../util/log.js';

/** The `mongo.uri` of the config file, or `undefined` when there is no file, it names none, or it cannot be read (the tool then uses the environment or the bundled database). */
function configuredUri(path: string): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(path, 'utf8'); } catch { return undefined; }
  try {
    const secret = resolveMasterSecret();
    if (isEnvelope(raw) && !secret) return undefined;   // encrypted at rest and no master secret given: the environment or the bundled database
    const text = isEnvelope(raw) && secret ? decryptEnvelope(raw, secret) : raw;
    const uri = (JSON.parse(text) as { mongo?: { uri?: unknown } }).mongo?.uri;
    return typeof uri === 'string' && uri !== '' ? uri : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const configPath = process.env['CONFIG_PATH'] ?? '/config/config.json';
  const fromFile = configuredUri(configPath);
  readConfiguredMongoUriFrom(() => fromFile);
  const { uri, source } = effectiveMongoUri();
  const client = new MongoClient(uri, mongoClientOptions(uri));
  try {
    await client.connect();
    console.log(`positions rollback: database '${dbNameFromUri(uri)}' (address from ${source})`);
    await rollBackPositions(client.db(dbNameFromUri(uri)), { log: (line) => console.log(line) });
  } finally {
    await client.close().catch(() => { /* nothing left to say */ });
  }
}

main().then(() => { process.exitCode = 0; }, (err: unknown) => {
  // The store's message can carry the address (a refused connection names it): the driver's class and code only.
  const e = err as { name?: unknown; code?: unknown };
  log.error(`positions rollback FAILED: ${typeof e?.name === 'string' ? e.name : 'Error'}${e?.code !== undefined ? ` ${String(e.code)}` : ''}; nothing was lost, run it again.`);
  process.exitCode = 1;
});
