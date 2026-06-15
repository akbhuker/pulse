import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, resetEvents, close, track, evt } from './setup';
import * as analytics from '../src/analytics';

describe('analytics aggregations', () => {
  beforeAll(async () => {
    await connect();
  });
  afterAll(async () => {
    await close();
  });

  describe('funnel', () => {
    beforeAll(async () => {
      await resetEvents();
      // 10 users hit page_view; 6 signup; 3 add_to_cart; 1 purchase — strictly in order.
      const steps = ['page_view', 'signup', 'add_to_cart', 'purchase'];
      const counts = [10, 6, 3, 1];
      const batch = [];
      for (let s = 0; s < steps.length; s++) {
        for (let u = 0; u < counts[s]!; u++) {
          batch.push(evt(steps[s]!, `u${u}`, 0, {}, s * 1000));
        }
      }
      await track(batch);
    });

    it('computes per-step users and conversion', async () => {
      const f = await analytics.funnel({ steps: ['page_view', 'signup', 'add_to_cart', 'purchase'] });
      expect(f.map((s) => s.users)).toEqual([10, 6, 3, 1]);
      expect(f[0]!.overall).toBe(1);
      expect(f[1]!.conversion).toBeCloseTo(0.6, 5);
      expect(f[3]!.overall).toBeCloseTo(0.1, 5);
    });

    it('does not count out-of-order steps', async () => {
      await resetEvents();
      // signup happens BEFORE page_view for this user -> only step 1 counts.
      await track([
        evt('signup', 'x', 0, {}, 0),
        evt('page_view', 'x', 0, {}, 1000),
      ]);
      const f = await analytics.funnel({ steps: ['page_view', 'signup'] });
      expect(f[0]!.users).toBe(1); // reached page_view
      expect(f[1]!.users).toBe(0); // signup was before page_view, doesn't count
    });
  });

  describe('top-N', () => {
    beforeAll(async () => {
      await resetEvents();
      await track([
        evt('view', 'a', 0, { country: 'US' }),
        evt('view', 'b', 0, { country: 'US' }),
        evt('view', 'c', 0, { country: 'IN' }),
        evt('click', 'a', 0, { country: 'US' }),
      ]);
    });

    it('ranks events by volume', async () => {
      const top = await analytics.topN({ dimension: 'event' });
      expect(top[0]).toEqual({ key: 'view', count: 3 });
      expect(top[1]).toEqual({ key: 'click', count: 1 });
    });

    it('breaks down by a property', async () => {
      const top = await analytics.topN({ dimension: 'country' });
      expect(top.find((r) => r.key === 'US')?.count).toBe(3);
      expect(top.find((r) => r.key === 'IN')?.count).toBe(1);
    });
  });

  describe('trends', () => {
    it('buckets counts by time unit', async () => {
      await resetEvents();
      await track([
        evt('e', 'a', 0, {}, 0),
        evt('e', 'b', 0, {}, 1000),
        evt('e', 'c', 1 /* yesterday */),
      ]);
      const t = await analytics.trends({ unit: 'day' });
      const total = t.reduce((s, p) => s + p.count, 0);
      expect(total).toBe(3);
      expect(t.length).toBeGreaterThanOrEqual(2); // at least two distinct days
    });
  });

  describe('retention', () => {
    it('computes day-0 at 100% and decay thereafter', async () => {
      await resetEvents();
      // Cohort from 3 days ago: 4 users on day 0; 2 return on day 1; 1 on day 2.
      const batch = [];
      for (let u = 0; u < 4; u++) batch.push(evt('page_view', `r${u}`, 3));
      batch.push(evt('page_view', 'r0', 2)); // r0 returns day 1
      batch.push(evt('page_view', 'r1', 2)); // r1 returns day 1
      batch.push(evt('page_view', 'r0', 1)); // r0 returns day 2
      await track(batch);

      const rows = await analytics.retention({ days: 4 });
      const cohort = rows[0]!;
      expect(cohort.size).toBe(4);
      expect(cohort.retention[0]).toBe(1); // day 0 = 100%
      expect(cohort.retention[1]).toBeCloseTo(0.5, 5); // 2/4
      expect(cohort.retention[2]).toBeCloseTo(0.25, 5); // 1/4
    });
  });

  describe('live', () => {
    it('counts events and unique users in the window', async () => {
      await resetEvents();
      await track([
        evt('e', 'a'),
        evt('e', 'a'),
        evt('e', 'b'),
      ]);
      const l = await analytics.live(5);
      expect(l.events).toBe(3);
      expect(l.users).toBe(2);
    });
  });
});
