/**
 * Database dump utility.
 *
 * Streams all collections from the `ythril` MongoDB database to a directory
 * as NDJSON files (one JSON document per line). Writes a manifest.json
 * describing the dump.
 *
 * Designed to be reusable by both the DB migration flow and the manual backup
 * feature (issue #82). Accepts any valid MongoDB URI — does not reuse the
 * server's live connection singleton so it can dump from any instance.
 *
 * Output layout:
 *   <destDir>/manifest.json          — metadata
 *   <destDir>/<collection>.ndjson    — one per collection
 *
 * Note: Only MongoDB data is dumped. Files stored in /data/files are NOT
 * included. A complete backup requires a separate copy of the /data/files
 * directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { log } from '../util/log.js';

const DB_NAME = 'ythril';
const MANIFEST_VERSION = 1 as const;
const CURSOR_BATCH_SIZE = 500;

export interface DumpManifest {
  version: typeof MANIFEST_VERSION;
  ythrilVersion: string;
  createdAt: string;
  sourceUriRedacted: string;
  collections: Array<{ name: string; count: number }>;
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@]+@/, '//[credentials]@');
}

/**
 * Dump all collections from the given MongoDB URI into destDir.
 * Creates destDir if it does not exist.
 * Returns the manifest describing the dump.
 */
export async function dumpDatabase(uri: string, destDir: string): Promise<DumpManifest> {
  fs.mkdirSync(destDir, { recursive: true });

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });

  try {
    await client.connect();
    const db = client.db(DB_NAME);

    const collectionInfos = await db.listCollections().toArray();
    const collectionNames = collectionInfos
      .map(c => c.name)
      .filter(n => !n.startsWith('system.'))
      .sort();

    const manifestCollections: DumpManifest['collections'] = [];

    for (const name of collectionNames) {
      const col = db.collection(name);
      const destFile = path.join(destDir, `${name}.ndjson`);
      const stream = fs.createWriteStream(destFile, { encoding: 'utf8' });

      let count = 0;
      const cursor = col.find({}).batchSize(CURSOR_BATCH_SIZE);

      try {
        for await (const doc of cursor) {
          stream.write(JSON.stringify(doc) + '\n');
          count++;
        }
      } finally {
        await cursor.close().catch(() => {});
      }

      // Flush the write stream
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });

      manifestCollections.push({ name, count });
      log.debug(`dump: ${name} → ${count} docs`);
    }

    const ythrilVersion = process.env['npm_package_version'] ?? 'unknown';

    const manifest: DumpManifest = {
      version: MANIFEST_VERSION,
      ythrilVersion,
      createdAt: new Date().toISOString(),
      sourceUriRedacted: redactUri(uri),
      collections: manifestCollections,
    };

    fs.writeFileSync(
      path.join(destDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    log.info(`dump: complete — ${manifestCollections.length} collections in ${destDir}`);
    return manifest;
  } finally {
    await client.close().catch(() => {});
  }
}
