import { events } from './db';
import type { StoredEvent, TrackEvent } from './types';

/** Normalise an API event into its stored shape. */
export function toStored(e: TrackEvent): StoredEvent {
  if (!e || typeof e.event !== 'string' || e.event.length === 0) {
    throw new Error('event is required');
  }
  if (typeof e.distinctId !== 'string' || e.distinctId.length === 0) {
    throw new Error('distinctId is required');
  }
  const ts = e.ts ? new Date(e.ts) : new Date();
  if (Number.isNaN(ts.getTime())) {
    throw new Error('ts is not a valid date');
  }
  return {
    ts,
    meta: {
      event: e.event,
      distinctId: e.distinctId,
      props: e.properties ?? {},
    },
  };
}

/**
 * Ingest one or many events. Uses an unordered bulk insert so a single bad
 * document doesn't abort the whole batch — important for high-volume telemetry
 * where you favour throughput and partial success over strictness.
 */
export async function track(input: TrackEvent | TrackEvent[]): Promise<number> {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) return 0;
  const docs = list.map(toStored);
  const res = await events().insertMany(docs, { ordered: false });
  return res.insertedCount;
}
