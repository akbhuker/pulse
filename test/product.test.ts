import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, resetEvents, close, track } from './setup';
import * as analytics from '../src/analytics';
import {
  createRule,
  evaluateAlerts,
  listRules,
  recentEvents,
  resetAlertEvents,
  toggleRule,
  deleteRule,
} from '../src/alerts';
import { getDb } from '../src/db';

describe('explore / geo / alerts', () => {
  beforeAll(async () => {
    await connect();
  });
  afterAll(async () => {
    await close();
  });

  describe('explore query builder', () => {
    beforeAll(async () => {
      await resetEvents();
      const now = Date.now();
      await track([
        { event: 'view', distinctId: 'a', ts: now, properties: { country: 'US' } },
        { event: 'view', distinctId: 'a', ts: now, properties: { country: 'US' } },
        { event: 'view', distinctId: 'b', ts: now, properties: { country: 'IN' } },
        { event: 'click', distinctId: 'a', ts: now, properties: { country: 'US' } },
      ]);
    });

    it('counts events with no breakdown', async () => {
      const s = await analytics.explore({ measure: 'events', unit: 'day' });
      expect(s).toHaveLength(1);
      expect(s[0]!.key).toBe('events');
      expect(s[0]!.points.reduce((t, p) => t + p.value, 0)).toBe(4);
    });

    it('breaks down by a property into multiple series', async () => {
      const s = await analytics.explore({ measure: 'events', breakdown: 'country', unit: 'day' });
      const byKey = Object.fromEntries(
        s.map((x) => [x.key, x.points.reduce((t, p) => t + p.value, 0)]),
      );
      expect(byKey.US).toBe(3);
      expect(byKey.IN).toBe(1);
    });

    it('supports the unique-users measure', async () => {
      const s = await analytics.explore({ measure: 'users', unit: 'day' });
      expect(s[0]!.points.reduce((t, p) => t + p.value, 0)).toBe(2); // a, b
    });

    it('restricts to selected events', async () => {
      const s = await analytics.explore({ measure: 'events', events: ['click'], unit: 'day' });
      expect(s[0]!.points.reduce((t, p) => t + p.value, 0)).toBe(1);
    });
  });

  describe('geo', () => {
    it('aggregates events by country', async () => {
      const g = await analytics.geo();
      expect(g[0]).toEqual({ country: 'US', count: 3 });
      expect(g.find((r) => r.country === 'IN')?.count).toBe(1);
    });
  });

  describe('alerting', () => {
    beforeAll(async () => {
      // Clean rules + events for a deterministic run.
      await getDb().collection('alert_rules').deleteMany({});
      await resetAlertEvents();
      await resetEvents();
    });

    it('triggers a threshold rule when the count is breached', async () => {
      const rule = await createRule({
        name: 'many views',
        type: 'threshold',
        event: 'view',
        windowMinutes: 60,
        comparator: 'gt',
        value: 2,
      });
      // 3 views in the window -> > 2 -> should fire.
      const now = Date.now();
      await track([
        { event: 'view', distinctId: 'x', ts: now },
        { event: 'view', distinctId: 'y', ts: now },
        { event: 'view', distinctId: 'z', ts: now },
      ]);
      const triggered = await evaluateAlerts();
      expect(triggered.some((e) => e.ruleId === rule.id)).toBe(true);

      const events = await recentEvents();
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('debounces — does not re-fire within the cooldown', async () => {
      const before = (await recentEvents()).length;
      const again = await evaluateAlerts();
      expect(again.length).toBe(0);
      expect((await recentEvents()).length).toBe(before);
    });

    it('does not fire a disabled rule', async () => {
      const rules = await listRules();
      const rule = rules.find((r) => r.name === 'many views')!;
      await toggleRule(rule.id); // disable
      await resetAlertEvents();
      const triggered = await evaluateAlerts();
      expect(triggered.some((e) => e.ruleId === rule.id)).toBe(false);
      await deleteRule(rule.id);
    });
  });
});
