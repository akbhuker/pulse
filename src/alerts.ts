import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { events } from './db';
import { anomalies } from './analytics';
import { emit } from './stream';
import type { AlertEvent, AlertRule } from './types';

const RULES = 'alert_rules';
const EVENTS = 'alert_events';
// Don't re-fire the same rule more than once per minute.
const DEBOUNCE_MS = 60_000;

function rules() {
  return getDb().collection<AlertRule>(RULES);
}
function alertEvents() {
  return getDb().collection<AlertEvent>(EVENTS);
}

export async function listRules(): Promise<AlertRule[]> {
  return rules().find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
}

export async function createRule(input: Partial<AlertRule>): Promise<AlertRule> {
  const rule: AlertRule = {
    id: randomUUID(),
    name: input.name?.trim() || 'Untitled alert',
    type: input.type === 'anomaly' ? 'anomaly' : 'threshold',
    event: input.event || undefined,
    windowMinutes: input.windowMinutes ?? 5,
    comparator: input.comparator === 'lt' ? 'lt' : 'gt',
    value: input.value ?? 100,
    zThreshold: input.zThreshold ?? 3,
    webhookUrl: input.webhookUrl || undefined,
    enabled: input.enabled ?? true,
    lastTriggeredAt: null,
  };
  await rules().insertOne({ ...rule });
  return rule;
}

export async function deleteRule(id: string): Promise<void> {
  await rules().deleteOne({ id });
}

export async function toggleRule(id: string): Promise<void> {
  const r = await rules().findOne({ id });
  if (r) await rules().updateOne({ id }, { $set: { enabled: !r.enabled } });
}

export async function recentEvents(limit = 20): Promise<AlertEvent[]> {
  return alertEvents().find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
}

/** Seed a couple of sensible default rules on a fresh deploy. */
export async function seedDefaultAlerts(): Promise<void> {
  if ((await rules().countDocuments()) > 0) return;
  await createRule({
    name: 'Purchase surge',
    type: 'threshold',
    event: 'purchase',
    windowMinutes: 1,
    comparator: 'gt',
    value: 5,
  });
  await createRule({ name: 'Traffic anomaly', type: 'anomaly', zThreshold: 3 });
}

async function thresholdValue(rule: AlertRule): Promise<number> {
  const since = new Date(Date.now() - (rule.windowMinutes ?? 5) * 60_000);
  const match: Record<string, unknown> = { ts: { $gte: since } };
  if (rule.event) match['meta.event'] = rule.event;
  return events().countDocuments(match);
}

function breached(rule: AlertRule, observed: number): boolean {
  const target = rule.value ?? 0;
  return rule.comparator === 'lt' ? observed < target : observed > target;
}

/**
 * Evaluate every enabled rule. Triggered rules record an AlertEvent, fire an
 * optional webhook, push a live SSE frame, and are debounced for a minute.
 * Run on a schedule from the server.
 */
export async function evaluateAlerts(): Promise<AlertEvent[]> {
  const enabled = await rules().find({ enabled: true }).toArray();
  const triggered: AlertEvent[] = [];
  const now = Date.now();

  for (const rule of enabled) {
    if (rule.lastTriggeredAt && now - new Date(rule.lastTriggeredAt).getTime() < DEBOUNCE_MS) {
      continue;
    }

    let fire = false;
    let message = '';
    let observed: number | undefined;

    if (rule.type === 'threshold') {
      observed = await thresholdValue(rule);
      if (breached(rule, observed)) {
        fire = true;
        const dir = rule.comparator === 'lt' ? 'below' : 'above';
        message = `${rule.event ?? 'events'} = ${observed} in ${rule.windowMinutes}m (${dir} ${rule.value})`;
      }
    } else {
      const points = await anomalies({
        unit: 'hour',
        threshold: rule.zThreshold ?? 3,
        event: rule.event,
      });
      const last = points[points.length - 1];
      if (last?.isAnomaly) {
        fire = true;
        observed = last.count;
        message = `volume spike on ${rule.event ?? 'all events'}: ${last.count} (z=${last.z})`;
      }
    }

    if (!fire) continue;

    const evt: AlertEvent = {
      ruleId: rule.id,
      ruleName: rule.name,
      message,
      value: observed,
      at: new Date(now).toISOString(),
    };
    await alertEvents().insertOne({ ...evt });
    await rules().updateOne({ id: rule.id }, { $set: { lastTriggeredAt: evt.at } });
    emit({ type: 'alert', ...evt });
    if (rule.webhookUrl) void fireWebhook(rule.webhookUrl, evt);
    triggered.push(evt);
  }

  return triggered;
}

async function fireWebhook(url: string, evt: AlertEvent): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(evt),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort; a failing webhook must not break evaluation.
  }
}

export async function resetAlertEvents(): Promise<void> {
  await alertEvents().deleteMany({});
  await rules().updateMany({}, { $set: { lastTriggeredAt: null } });
}
