import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, resetEvents, close, track } from './setup';
import * as analytics from '../src/analytics';
import { ensureRollupSchema, runRollup, trendsFromRollups, rollupStats, resetRollups } from '../src/rollups';

const HOUR = 3_600_000;

describe('advanced analytics', () => {
  beforeAll(async () => {
    await connect();
  });
  afterAll(async () => {
    await close();
  });

  describe('segmentation filters', () => {
    beforeAll(async () => {
      await resetEvents();
      await track([
        { event: 'view', distinctId: 'a', properties: { country: 'US' } },
        { event: 'view', distinctId: 'b', properties: { country: 'US' } },
        { event: 'view', distinctId: 'c', properties: { country: 'US' } },
        { event: 'view', distinctId: 'd', properties: { country: 'IN' } },
        { event: 'view', distinctId: 'e', properties: { country: 'IN' } },
      ]);
    });

    it('filters top-N by a property', async () => {
      const all = await analytics.topN({ dimension: 'event' });
      expect(all[0]).toEqual({ key: 'view', count: 5 });
      const us = await analytics.topN({ dimension: 'event', filters: { country: 'US' } });
      expect(us[0]).toEqual({ key: 'view', count: 3 });
    });

    it('exposes distinct values for the filter UI', async () => {
      const countries = await analytics.distinctValues('country');
      expect(countries).toEqual(['IN', 'US']);
    });

    it('filters live counts', async () => {
      const us = await analytics.live({ minutes: 60, filters: { country: 'US' } });
      expect(us.events).toBe(3);
    });
  });

  describe('anomaly detection', () => {
    it('flags a volume spike with a high z-score', async () => {
      await resetEvents();
      const now = Date.now();
      const batch = [];
      // 25 baseline hours with varying low volume (1-4/hr) so stddev > 0.
      const pattern = [2, 3, 1, 4, 2, 1, 3, 2];
      for (let h = 27; h >= 3; h--) {
        const n = pattern[h % pattern.length]!;
        for (let i = 0; i < n; i++) {
          batch.push({ event: 'hit', distinctId: `b${h}_${i}`, ts: now - h * HOUR + i * 1000 });
        }
      }
      // A spike 2 hours ago: 60 events.
      for (let i = 0; i < 60; i++) {
        batch.push({ event: 'hit', distinctId: `spk_${i}`, ts: now - 2 * HOUR + i * 1000 });
      }
      await track(batch);

      const anomalies = await analytics.anomalies({ unit: 'hour', window: 24, threshold: 3 });
      const flagged = anomalies.filter((a) => a.isAnomaly);
      expect(flagged.length).toBeGreaterThanOrEqual(1);
      const spike = flagged.find((a) => a.count === 60);
      expect(spike).toBeDefined();
      expect(spike!.z).toBeGreaterThan(3);
    });
  });

  describe('sessionization', () => {
    it('splits a user into sessions by the inactivity gap', async () => {
      await resetEvents();
      const now = Date.now();
      await track([
        // Session 1: two events 5 min apart.
        { event: 'a', distinctId: 'u', ts: now - 90 * 60_000 },
        { event: 'b', distinctId: 'u', ts: now - 85 * 60_000 },
        // Session 2: 60 min later (> 30 min gap).
        { event: 'c', distinctId: 'u', ts: now - 20 * 60_000 },
      ]);
      const s = await analytics.sessions({ gapMinutes: 30 });
      expect(s.sessions).toBe(2);
      expect(s.avgEventsPerSession).toBeCloseTo(1.5, 5);
    });

    it('keeps close events in one session', async () => {
      await resetEvents();
      const now = Date.now();
      await track([
        { event: 'a', distinctId: 'u', ts: now - 2000 },
        { event: 'b', distinctId: 'u', ts: now - 1000 },
        { event: 'c', distinctId: 'u', ts: now },
      ]);
      const s = await analytics.sessions({ gapMinutes: 30 });
      expect(s.sessions).toBe(1);
      expect(s.avgEventsPerSession).toBe(3);
    });
  });

  describe('rollups', () => {
    beforeAll(async () => {
      await resetEvents();
      await resetRollups();
      await ensureRollupSchema();
      const now = Date.now();
      // 10 events one hour ago, 5 events two hours ago.
      const batch = [];
      for (let i = 0; i < 10; i++) batch.push({ event: 'x', distinctId: `u${i}`, ts: now - HOUR + i * 1000 });
      for (let i = 0; i < 5; i++) batch.push({ event: 'x', distinctId: `v${i}`, ts: now - 2 * HOUR + i * 1000 });
      await track(batch);
    });

    it('materialises hourly buckets via $merge and matches raw trends', async () => {
      await runRollup();
      const stats = await rollupStats();
      expect(stats.buckets).toBeGreaterThanOrEqual(2);
      expect(stats.totalEvents).toBe(15);

      const fromRollup = await trendsFromRollups({ from: new Date(Date.now() - 3 * HOUR) });
      const total = fromRollup.reduce((s, p) => s + p.count, 0);
      expect(total).toBe(15);

      const raw = await analytics.trends({ unit: 'hour', from: new Date(Date.now() - 3 * HOUR) });
      const rawTotal = raw.reduce((s, p) => s + p.count, 0);
      expect(rawTotal).toBe(15);
    });

    it('is idempotent — re-running does not double-count', async () => {
      await runRollup();
      await runRollup();
      const stats = await rollupStats();
      expect(stats.totalEvents).toBe(15);
    });
  });
});
