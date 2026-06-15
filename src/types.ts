/** A raw event as accepted by the ingestion API. */
export interface TrackEvent {
  /** Event name, e.g. "page_view", "signup", "purchase". */
  event: string;
  /** Stable id for the actor (user id, anonymous id, device id). */
  distinctId: string;
  /** ISO string or epoch ms; defaults to now if omitted. */
  ts?: string | number | Date;
  /** Arbitrary dimensions used for breakdowns (country, browser, plan...). */
  properties?: Record<string, unknown>;
}

/**
 * On-disk shape inside the MongoDB events collection.
 *
 * `ts` is the event time; `meta` holds the indexed dimensions. Grouping by
 * `meta.event` / `meta.props.*` over a `ts` range drives every analytics query.
 */
export interface StoredEvent {
  ts: Date;
  meta: {
    event: string;
    distinctId: string;
    props: Record<string, unknown>;
  };
}

export type TimeUnit = 'minute' | 'hour' | 'day';

export interface TrendPoint {
  t: string; // ISO bucket start
  count: number;
}

export interface TopRow {
  key: string;
  count: number;
}

export interface FunnelStep {
  step: string;
  users: number;
  /** Conversion from the previous step (1 for the first step). */
  conversion: number;
  /** Conversion from the top of the funnel. */
  overall: number;
}

export interface RetentionRow {
  cohort: string; // ISO day
  size: number;
  /** retention[d] = fraction (0..1) of the cohort active d days after first seen. */
  retention: number[];
}

/** Segmentation: property name -> required value (matched on meta.props.<k>). */
export type Filters = Record<string, string | undefined>;

export interface AnomalyPoint {
  t: string; // ISO bucket start
  count: number;
  /** Rolling mean over the preceding window. */
  mean: number;
  /** Rolling sample stddev over the preceding window. */
  std: number;
  /** (count - mean) / std. */
  z: number;
  isAnomaly: boolean;
}

export interface SessionStats {
  sessions: number;
  avgDurationSec: number;
  medianDurationSec: number;
  avgEventsPerSession: number;
}

export interface RollupStats {
  buckets: number;
  totalEvents: number;
  lastRunAt: string | null;
}
