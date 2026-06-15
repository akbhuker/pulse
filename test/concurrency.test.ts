import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, resetEvents, close, track, events } from './setup';
import * as analytics from '../src/analytics';

/**
 * Ingestion must not lose or double-count events under concurrent load — the
 * scenario a telemetry pipeline lives in. We fire many batches in parallel and
 * assert the stored count and the aggregated count both match exactly.
 */
describe('concurrent ingestion', () => {
  beforeAll(async () => {
    await connect();
    await resetEvents();
  });
  afterAll(async () => {
    await close();
  });

  it('persists every event exactly once under parallel writes', async () => {
    const batches = 50;
    const perBatch = 100;
    const expected = batches * perBatch;

    await Promise.all(
      Array.from({ length: batches }, (_, b) =>
        track(
          Array.from({ length: perBatch }, (_, i) => ({
            event: 'hit',
            distinctId: `u${(b * perBatch + i) % 500}`,
          })),
        ),
      ),
    );

    const stored = await events().countDocuments({ 'meta.event': 'hit' });
    expect(stored).toBe(expected);

    const live = await analytics.live(10);
    expect(live.events).toBe(expected);
    expect(live.users).toBe(500);
  });
});
