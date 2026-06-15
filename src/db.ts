import { MongoClient, type Db, type Collection } from 'mongodb';
import { config } from './config';
import type { StoredEvent } from './types';

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Connect to MongoDB and ensure the events collection exists with the indexes
 * our queries rely on.
 *
 * NOTE on storage choice: we use a *standard* collection (not a time-series
 * collection). Time-series collections are more storage-efficient for raw
 * telemetry, but MongoDB does not support collection-level change streams on
 * them — and the live dashboard depends on a change stream. Change streams are
 * the higher-value capability here, so we store events in a regular collection
 * with a time-based index, which keeps both the aggregation queries and the
 * real-time feed working.
 */
export async function connect(url = config.mongoUrl): Promise<Db> {
  if (db) return db;
  client = new MongoClient(url);
  await client.connect();
  db = client.db(config.dbName);
  await ensureSchema(db);
  return db;
}

async function ensureSchema(database: Db): Promise<void> {
  const existing = await database
    .listCollections({ name: config.collection })
    .toArray();

  // Auto-migrate: earlier versions created this as a time-series collection,
  // which breaks change streams. If we find one, drop and recreate as standard.
  if (existing.length > 0 && existing[0]?.type === 'timeseries') {
    await database.collection(config.collection).drop().catch(() => undefined);
  }
  const present = await database.listCollections({ name: config.collection }).toArray();
  if (present.length === 0) {
    await database.createCollection(config.collection);
  }

  // Indexes: `ts` for time-ranged trends/live; compound indexes accelerate the
  // funnel/retention scans that filter by user/event over a time range.
  const coll = database.collection(config.collection);
  await coll.createIndex({ ts: 1 });
  await coll.createIndex({ 'meta.distinctId': 1, ts: 1 });
  await coll.createIndex({ 'meta.event': 1, ts: 1 });
}

export function events(): Collection<StoredEvent> {
  if (!db) throw new Error('DB not connected — call connect() first');
  return db.collection<StoredEvent>(config.collection);
}

export function getDb(): Db {
  if (!db) throw new Error('DB not connected — call connect() first');
  return db;
}

export function getClient(): MongoClient {
  if (!client) throw new Error('DB not connected — call connect() first');
  return client;
}

/** Drop and recreate the events collection (used by the demo reset + tests). */
export async function resetEvents(): Promise<void> {
  const database = getDb();
  await database.collection(config.collection).drop().catch(() => undefined);
  await ensureSchema(database);
}

export async function close(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}
