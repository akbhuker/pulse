import { connect, events, resetEvents, close } from '../src/db';
import type { TrackEvent } from '../src/types';
import { track } from '../src/ingest';

export { connect, events, resetEvents, close, track };
export type { TrackEvent };

/** Build an event with a relative-day timestamp for deterministic fixtures. */
export function evt(
  event: string,
  distinctId: string,
  daysAgo = 0,
  props: Record<string, unknown> = {},
  extraMs = 0,
): TrackEvent {
  const ts = new Date(Date.now() - daysAgo * 86_400_000 + extraMs);
  return { event, distinctId, ts, properties: props };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
