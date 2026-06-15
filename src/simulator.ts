import { track } from './ingest';
import type { TrackEvent } from './types';

const COUNTRIES = ['US', 'IN', 'UK', 'DE', 'BR', 'CA', 'AU'];
const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge'];
const PLANS = ['free', 'pro', 'enterprise'];

/** Ordered funnel the simulated users move through, with drop-off at each step. */
export const FUNNEL_STEPS = ['page_view', 'signup', 'add_to_cart', 'purchase'];
const STEP_CONTINUE_PROB = [1, 0.55, 0.45, 0.35];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function userProps(): Record<string, unknown> {
  return { country: pick(COUNTRIES), browser: pick(BROWSERS), plan: pick(PLANS) };
}

/**
 * Emit a realistic burst of *live* events (timestamped now). Each user starts a
 * funnel journey and drops off probabilistically, so funnel/top-N charts get
 * believable shapes.
 */
export async function simulateLive(count: number): Promise<number> {
  const batch: TrackEvent[] = [];
  const now = Date.now();

  while (batch.length < count) {
    const distinctId = `user_${Math.floor(Math.random() * 5000)}`;
    const props = userProps();
    // Each journey starts within the last second; steps are ordered in time so
    // the funnel's time-sorted, in-order step matching works on live data too.
    const start = now - Math.floor(Math.random() * 1000);
    for (let step = 0; step < FUNNEL_STEPS.length && batch.length < count; step++) {
      if (Math.random() > STEP_CONTINUE_PROB[step]!) break;
      batch.push({
        event: FUNNEL_STEPS[step]!,
        distinctId,
        ts: start + step * 10,
        properties: props,
      });
    }
  }
  return track(batch);
}

/**
 * Backfill several days of history so retention cohorts and multi-day trends
 * have data immediately. Spreads users' first-seen across the window and adds
 * return visits on later days.
 */
export async function simulateBackfill(opts: { days?: number; usersPerDay?: number } = {}): Promise<number> {
  const days = opts.days ?? 7;
  const usersPerDay = opts.usersPerDay ?? 120;
  const now = Date.now();
  const batch: TrackEvent[] = [];

  for (let d = days - 1; d >= 0; d--) {
    const dayStart = now - d * 86_400_000;
    for (let u = 0; u < usersPerDay; u++) {
      const distinctId = `bf_${days - d}_${u}`;
      const props = userProps();
      const firstTs = dayStart + Math.floor(Math.random() * 86_400_000);

      // First-day funnel journey.
      for (let step = 0; step < FUNNEL_STEPS.length; step++) {
        if (Math.random() > STEP_CONTINUE_PROB[step]!) break;
        batch.push({
          event: FUNNEL_STEPS[step]!,
          distinctId,
          ts: firstTs + step * 1000,
          properties: props,
        });
      }

      // Return visits on subsequent days (decaying retention).
      for (let back = 1; d - back >= 0; back++) {
        if (Math.random() > 0.5 / back) continue;
        const returnTs = now - (d - back) * 86_400_000 + Math.floor(Math.random() * 86_400_000);
        batch.push({ event: 'page_view', distinctId, ts: returnTs, properties: props });
      }
    }
  }

  // Insert in chunks to keep individual ops modest.
  let inserted = 0;
  for (let i = 0; i < batch.length; i += 1000) {
    inserted += await track(batch.slice(i, i + 1000));
  }
  return inserted;
}
