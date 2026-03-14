import { MongoClient, type Db, type Collection } from 'mongodb';
import { getMongoUri } from '../config/loader.js';
import { log } from '../util/log.js';

let _client: MongoClient | null = null;
const DB_NAME = 'ytrai';

export async function connectMongo(): Promise<MongoClient> {
  const uri = getMongoUri();
  log.info(`Connecting to MongoDB at ${uri.replace(/\/\/.*@/, '//[credentials]@')}`);
  _client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
  });
  await _client.connect();
  log.info('MongoDB connected');
  return _client;
}

export function getMongo(): MongoClient {
  if (!_client) throw new Error('MongoDB not connected — call connectMongo() first');
  return _client;
}

export function getDb(): Db {
  return getMongo().db(DB_NAME);
}

export function col<T extends object>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}

// Graceful shutdown
export async function closeMongo(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}
