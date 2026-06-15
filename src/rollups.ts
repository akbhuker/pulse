import { getDb } from './db';
import { config } from './config';
import type { RollupStats, TrendPoint } from './types';

const ROLLUP = 'rollups';
let lastRunAt: Date | null = null;

/**
 * Pre-aggregation ("rollups") — the standard way analytics systems scale.
 *
 * Instead of scanning every raw event on each dashboard load, a background job
 * folds events into hourly per-event summaries in a separate `rollups`
 * collection. Dashboards then read the small summary collection. Here we
 * materialise rollups with MongoDB's `$merge` stage, which upserts the pipeline
 * output into the target collection keyed by (bucket, event) — so the job is
 * idempotent and can run on a schedule or be triggered manually.
 */
export async function ensureRollupSchema(): Promise<void> {
  // Unique key enables `$merge ... on: ['bucket','event']` to replace in place.
  await getDb().collection(ROLLUP).createIndex({ bucket: 1, event: 1 }, { unique: true });
}

/**
 * Roll up the last `sinceDays` of raw events into hourly summaries.
 * Returns the total number of rollup buckets after the run.
 *
 * (Production would track a watermark and only roll up new buckets; we re-roll
 * a recent window for simplicity — `$merge` makes that safe and idempotent.)
 */
export async function runRollup(sinceDays = 30): Promise<number> {
  const db = getDb();
  const from = new Date(Date.now() - sinceDays * 86_400_000);

  await db
    .collection(config.collection)
    .aggregate([
      { $match: { ts: { $gte: from } } },
      {
        $group: {
          _id: { bucket: { $dateTrunc: { date: '$ts', unit: 'hour' } }, event: '$meta.event' },
          count: { $sum: 1 },
          users: { $addToSet: '$meta.distinctId' },
        },
      },
      {
        $project: {
          _id: 0,
          bucket: '$_id.bucket',
          event: '$_id.event',
          count: 1,
          uniqueUsers: { $size: '$users' },
        },
      },
      {
        $merge: {
          into: ROLLUP,
          on: ['bucket', 'event'],
          whenMatched: 'replace',
          whenNotMatched: 'insert',
        },
      },
    ])
    .toArray(); // drives the $merge to completion

  lastRunAt = new Date();
  return db.collection(ROLLUP).countDocuments();
}

/** Trends served from the pre-aggregated rollups — no raw-event scan. */
export async function trendsFromRollups(
  opts: { from?: Date; to?: Date; event?: string } = {},
): Promise<TrendPoint[]> {
  const match: Record<string, unknown> = {};
  if (opts.from || opts.to) {
    const b: Record<string, Date> = {};
    if (opts.from) b.$gte = opts.from;
    if (opts.to) b.$lte = opts.to;
    match.bucket = b;
  }
  if (opts.event) match.event = opts.event;

  const rows = await getDb()
    .collection(ROLLUP)
    .aggregate<{ _id: Date; count: number }>([
      { $match: match },
      { $group: { _id: '$bucket', count: { $sum: '$count' } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return rows.map((r) => ({ t: r._id.toISOString(), count: r.count }));
}

export async function rollupStats(): Promise<RollupStats> {
  const db = getDb();
  const buckets = await db.collection(ROLLUP).countDocuments();
  const agg = await db
    .collection(ROLLUP)
    .aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$count' } } }])
    .toArray();
  return {
    buckets,
    totalEvents: agg[0]?.total ?? 0,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
  };
}

export async function resetRollups(): Promise<void> {
  await getDb().collection(ROLLUP).drop().catch(() => undefined);
  await ensureRollupSchema();
  lastRunAt = null;
}
