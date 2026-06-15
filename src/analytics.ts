import { events } from './db';
import type {
  AnomalyPoint,
  ExploreSeries,
  Filters,
  FunnelStep,
  GeoRow,
  RetentionRow,
  SessionStats,
  TimeUnit,
  TopRow,
  TrendPoint,
} from './types';

interface Range {
  from?: Date;
  to?: Date;
  /** Segmentation: each entry adds a `meta.props.<key> = value` match. */
  filters?: Filters;
}

function rangeMatch(r: Range, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const m: Record<string, unknown> = { ...extra };
  if (r.from || r.to) {
    const ts: Record<string, Date> = {};
    if (r.from) ts.$gte = r.from;
    if (r.to) ts.$lte = r.to;
    m.ts = ts;
  }
  // Segmentation filters: build the match dynamically so any property can slice
  // every query (country=US, plan=pro, browser=Chrome, ...).
  for (const [k, v] of Object.entries(r.filters ?? {})) {
    if (v !== undefined && v !== '') m[`meta.props.${k}`] = v;
  }
  return m;
}

/**
 * Trend: event volume bucketed over time.
 * `$dateTrunc` snaps each timestamp to the start of its minute/hour/day bucket,
 * then `$group` counts per bucket — a single pass over the events.
 */
export async function trends(opts: Range & { unit?: TimeUnit; event?: string }): Promise<TrendPoint[]> {
  const unit: TimeUnit = opts.unit ?? 'hour';
  const match = rangeMatch(opts, opts.event ? { 'meta.event': opts.event } : {});
  const rows = await events()
    .aggregate<{ _id: Date; count: number }>([
      { $match: match },
      {
        $group: {
          _id: { $dateTrunc: { date: '$ts', unit } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return rows.map((r) => ({ t: r._id.toISOString(), count: r.count }));
}

/**
 * Top-N breakdown by event name or by an arbitrary property
 * (e.g. dimension="country" groups on meta.props.country).
 */
export async function topN(
  opts: Range & { dimension: string; limit?: number; event?: string },
): Promise<TopRow[]> {
  const limit = opts.limit ?? 10;
  const groupKey =
    opts.dimension === 'event' ? '$meta.event' : `$meta.props.${opts.dimension}`;
  const match = rangeMatch(opts, opts.event ? { 'meta.event': opts.event } : {});
  const rows = await events()
    .aggregate<{ _id: unknown; count: number }>([
      { $match: match },
      { $group: { _id: groupKey, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ])
    .toArray();
  return rows.map((r) => ({ key: r._id == null ? '(none)' : String(r._id), count: r.count }));
}

/**
 * Funnel: of the users who entered step 1, how many advanced through each
 * subsequent step *in order*.
 *
 * The clever bit runs server-side: per user we sort their events by time, then
 * `$reduce` walks the sequence carrying "how many funnel steps matched so far".
 * A step only counts if it appears after the previous step matched, so we get
 * the furthest in-order step each user reached in one pipeline. We then count
 * users per furthest-step and turn that into cumulative conversion in JS.
 */
export async function funnel(opts: Range & { steps: string[] }): Promise<FunnelStep[]> {
  const { steps } = opts;
  if (steps.length === 0) return [];

  const match = rangeMatch(opts, { 'meta.event': { $in: steps } });

  const rows = await events()
    .aggregate<{ _id: number; users: number }>([
      { $match: match },
      { $sort: { 'meta.distinctId': 1, ts: 1 } },
      { $group: { _id: '$meta.distinctId', evs: { $push: '$meta.event' } } },
      {
        $project: {
          reached: {
            $reduce: {
              input: '$evs',
              initialValue: 0,
              in: {
                $cond: [
                  {
                    $and: [
                      { $lt: ['$$value', steps.length] },
                      { $eq: [{ $arrayElemAt: [steps, '$$value'] }, '$$this'] },
                    ],
                  },
                  { $add: ['$$value', 1] },
                  '$$value',
                ],
              },
            },
          },
        },
      },
      { $group: { _id: '$reached', users: { $sum: 1 } } },
    ])
    .toArray();

  // rows: how many users reached *exactly* N steps. Convert to cumulative
  // (users who reached AT LEAST step i) and compute conversion rates.
  const exact = new Map<number, number>();
  for (const r of rows) exact.set(r._id, r.users);

  const atLeast: number[] = new Array(steps.length).fill(0);
  for (let i = 0; i < steps.length; i++) {
    let sum = 0;
    for (const [reached, users] of exact) {
      if (reached >= i + 1) sum += users;
    }
    atLeast[i] = sum;
  }

  const top = atLeast[0] || 0;
  return steps.map((step, i) => {
    const users = atLeast[i] ?? 0;
    const prev = i === 0 ? users : atLeast[i - 1] ?? 0;
    return {
      step,
      users,
      conversion: prev > 0 ? users / prev : 0,
      overall: top > 0 ? users / top : 0,
    };
  });
}

/**
 * Retention cohorts: group users by the day they were first seen, then for each
 * day-offset compute the fraction of that cohort still active.
 *
 * Pipeline: per user → first-seen + the set of distinct active days → map each
 * active day to an integer "days since first seen" offset → unwind → count
 * distinct users per (cohort day, offset). JS assembles the cohort × offset
 * matrix and divides by each cohort's size (offset 0).
 */
export async function retention(opts: Range & { days?: number }): Promise<RetentionRow[]> {
  const days = opts.days ?? 7;
  const match = rangeMatch(opts);

  const rows = await events()
    .aggregate<{ _id: { cohort: Date; offset: number }; users: number }>([
      { $match: match },
      {
        $group: {
          _id: '$meta.distinctId',
          firstSeen: { $min: '$ts' },
          activeDays: { $addToSet: { $dateTrunc: { date: '$ts', unit: 'day' } } },
        },
      },
      {
        $project: {
          cohort: { $dateTrunc: { date: '$firstSeen', unit: 'day' } },
          offsets: {
            $map: {
              input: '$activeDays',
              as: 'd',
              in: {
                $dateDiff: {
                  startDate: { $dateTrunc: { date: '$firstSeen', unit: 'day' } },
                  endDate: '$$d',
                  unit: 'day',
                },
              },
            },
          },
        },
      },
      { $unwind: '$offsets' },
      { $match: { offsets: { $gte: 0, $lt: days } } },
      {
        $group: {
          _id: { cohort: '$cohort', offset: '$offsets' },
          users: { $sum: 1 },
        },
      },
    ])
    .toArray();

  // Assemble cohort -> offset -> count.
  const byCohort = new Map<string, number[]>();
  for (const r of rows) {
    const key = r._id.cohort.toISOString();
    if (!byCohort.has(key)) byCohort.set(key, new Array(days).fill(0));
    const arr = byCohort.get(key)!;
    if (r._id.offset >= 0 && r._id.offset < days) arr[r._id.offset] = r.users;
  }

  return [...byCohort.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, counts]) => {
      const size = counts[0] || 0;
      return {
        cohort,
        size,
        retention: counts.map((c) => (size > 0 ? c / size : 0)),
      };
    });
}

/** Distinct values for a dimension (event name or a property) — powers the filter UI. */
export async function distinctValues(dimension: string, limit = 50): Promise<string[]> {
  const field = dimension === 'event' ? 'meta.event' : `meta.props.${dimension}`;
  const vals = await events().distinct(field);
  return vals
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(String)
    .sort()
    .slice(0, limit);
}

/**
 * Anomaly detection on event volume.
 *
 * Buckets volume over time, then uses `$setWindowFields` to compute a *rolling*
 * mean and sample stddev over the preceding `window` buckets, and flags buckets
 * whose z-score exceeds `threshold`. This is a spike detector — a sudden jump in
 * traffic (abuse, a bug, a campaign) lights up without any fixed threshold.
 */
export async function anomalies(
  opts: Range & { unit?: TimeUnit; window?: number; threshold?: number; event?: string } = {},
): Promise<AnomalyPoint[]> {
  const unit: TimeUnit = opts.unit ?? 'hour';
  const window = opts.window ?? 24;
  const threshold = opts.threshold ?? 3;
  const match = rangeMatch(opts, opts.event ? { 'meta.event': opts.event } : {});

  const rows = await events()
    .aggregate<{ t: Date; count: number; mean: number; std: number; z: number }>([
      { $match: match },
      { $group: { _id: { $dateTrunc: { date: '$ts', unit } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      {
        $setWindowFields: {
          sortBy: { _id: 1 },
          output: {
            mean: { $avg: '$count', window: { documents: [-window, -1] } },
            std: { $stdDevSamp: '$count', window: { documents: [-window, -1] } },
          },
        },
      },
      {
        $project: {
          _id: 0,
          t: '$_id',
          count: 1,
          mean: { $ifNull: ['$mean', '$count'] },
          std: { $ifNull: ['$std', 0] },
          z: {
            $cond: [
              { $gt: ['$std', 0] },
              { $divide: [{ $subtract: ['$count', '$mean'] }, '$std'] },
              0,
            ],
          },
        },
      },
    ])
    .toArray();

  return rows.map((r) => ({
    t: r.t.toISOString(),
    count: r.count,
    mean: Math.round(r.mean * 10) / 10,
    std: Math.round(r.std * 10) / 10,
    z: Math.round(r.z * 100) / 100,
    isAnomaly: r.z >= threshold,
  }));
}

/**
 * Sessionization: group each user's events into sessions split by a `gapMinutes`
 * inactivity gap, then report session-level metrics.
 *
 * Two `$setWindowFields` passes per user (partitioned by distinctId, sorted by
 * time): the first uses `$shift` to look at the previous event's timestamp and
 * mark where a new session begins (gap too large); the second does a running
 * sum of those markers to assign a session sequence number. We then group by
 * (user, session) to get each session's bounds and event count.
 */
export async function sessions(
  opts: Range & { gapMinutes?: number } = {},
): Promise<SessionStats> {
  const gapMs = (opts.gapMinutes ?? 30) * 60_000;
  const match = rangeMatch(opts);

  const rows = await events()
    .aggregate<{ durationMs: number; events: number }>([
      { $match: match },
      {
        $setWindowFields: {
          partitionBy: '$meta.distinctId',
          sortBy: { ts: 1 },
          output: { prevTs: { $shift: { output: '$ts', by: -1, default: null } } },
        },
      },
      {
        $set: {
          isNew: {
            $cond: [
              {
                $or: [
                  { $eq: ['$prevTs', null] },
                  { $gt: [{ $subtract: ['$ts', '$prevTs'] }, gapMs] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
      {
        $setWindowFields: {
          partitionBy: '$meta.distinctId',
          sortBy: { ts: 1 },
          output: {
            sessionSeq: { $sum: '$isNew', window: { documents: ['unbounded', 'current'] } },
          },
        },
      },
      {
        $group: {
          _id: { u: '$meta.distinctId', s: '$sessionSeq' },
          start: { $min: '$ts' },
          end: { $max: '$ts' },
          events: { $sum: 1 },
        },
      },
      { $project: { _id: 0, durationMs: { $subtract: ['$end', '$start'] }, events: 1 } },
    ])
    .toArray();

  if (rows.length === 0) {
    return { sessions: 0, avgDurationSec: 0, medianDurationSec: 0, avgEventsPerSession: 0 };
  }
  const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
  const totalEvents = rows.reduce((s, r) => s + r.events, 0);
  const avgDur = durations.reduce((s, d) => s + d, 0) / durations.length;
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  return {
    sessions: rows.length,
    avgDurationSec: Math.round(avgDur / 1000),
    medianDurationSec: Math.round(median / 1000),
    avgEventsPerSession: Math.round((totalEvents / rows.length) * 10) / 10,
  };
}

/** Live snapshot: events and unique users in the last `minutes` (filterable). */
export async function live(
  opts: { minutes?: number; filters?: Filters } = {},
): Promise<{ events: number; users: number; windowMinutes: number }> {
  const minutes = opts.minutes ?? 5;
  const since = new Date(Date.now() - minutes * 60_000);
  const match = rangeMatch({ from: since, filters: opts.filters });
  const rows = await events()
    .aggregate<{ events: number; users: number }>([
      { $match: match },
      { $group: { _id: null, events: { $sum: 1 }, users: { $addToSet: '$meta.distinctId' } } },
      { $project: { _id: 0, events: 1, users: { $size: '$users' } } },
    ])
    .toArray();
  return { events: rows[0]?.events ?? 0, users: rows[0]?.users ?? 0, windowMinutes: minutes };
}

/**
 * Explore — a self-serve query builder. Given a measure (event count or unique
 * users), an optional set of events, an optional breakdown dimension, a time
 * granularity, a range and filters, it builds the aggregation dynamically and
 * returns one time-series per breakdown value (top 8 by volume).
 *
 * This is the engine behind a Mixpanel/Amplitude-style "Explore" screen: the
 * pipeline shape is assembled from user input rather than hard-coded.
 */
export async function explore(
  opts: Range & {
    events?: string[];
    breakdown?: string;
    measure?: 'events' | 'users';
    unit?: TimeUnit;
  },
): Promise<ExploreSeries[]> {
  const unit: TimeUnit = opts.unit ?? 'day';
  const measure = opts.measure ?? 'events';
  const extra: Record<string, unknown> =
    opts.events && opts.events.length > 0 ? { 'meta.event': { $in: opts.events } } : {};
  const match = rangeMatch(opts, extra);

  const breakdownField =
    !opts.breakdown || opts.breakdown === 'none'
      ? null
      : opts.breakdown === 'event'
        ? '$meta.event'
        : `$meta.props.${opts.breakdown}`;

  const groupId: Record<string, unknown> = { t: { $dateTrunc: { date: '$ts', unit } } };
  if (breakdownField) groupId.key = breakdownField;

  const pipeline: Record<string, unknown>[] = [
    { $match: match },
    {
      $group: {
        _id: groupId,
        v: measure === 'users' ? { $addToSet: '$meta.distinctId' } : { $sum: 1 },
      },
    },
  ];
  if (measure === 'users') pipeline.push({ $project: { _id: 1, v: { $size: '$v' } } });
  pipeline.push({ $sort: { '_id.t': 1 } });

  const rows = await events()
    .aggregate<{ _id: { t: Date; key?: unknown }; v: number }>(pipeline)
    .toArray();

  const seriesMap = new Map<string, { t: string; value: number }[]>();
  const totals = new Map<string, number>();
  const defaultKey = measure === 'users' ? 'unique users' : 'events';
  for (const r of rows) {
    const key = breakdownField ? String(r._id.key ?? '(none)') : defaultKey;
    if (!seriesMap.has(key)) seriesMap.set(key, []);
    seriesMap.get(key)!.push({ t: r._id.t.toISOString(), value: r.v });
    totals.set(key, (totals.get(key) ?? 0) + r.v);
  }

  // Keep the top 8 series by total volume so the chart stays readable.
  const topKeys = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k);
  return topKeys.map((key) => ({ key, points: seriesMap.get(key) ?? [] }));
}

/** Events grouped by country — powers the geo map. */
export async function geo(opts: Range = {}): Promise<GeoRow[]> {
  const match = rangeMatch(opts, { 'meta.props.country': { $exists: true, $ne: null } });
  const rows = await events()
    .aggregate<{ _id: unknown; count: number }>([
      { $match: match },
      { $group: { _id: '$meta.props.country', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  return rows
    .filter((r) => r._id != null && r._id !== '')
    .map((r) => ({ country: String(r._id), count: r.count }));
}
