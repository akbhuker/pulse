import express, { type Request, type Response } from 'express';
import { join } from 'node:path';
import { config } from './config';
import { connect, resetEvents } from './db';
import { track } from './ingest';
import * as analytics from './analytics';
import { sseHandler, startChangeStream, restartChangeStream } from './stream';
import { simulateLive, simulateBackfill, FUNNEL_STEPS } from './simulator';
import {
  ensureRollupSchema,
  runRollup,
  trendsFromRollups,
  rollupStats,
  resetRollups,
} from './rollups';
import type { Filters, TimeUnit } from './types';

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Query params that are NOT segmentation filters. Everything else (country,
// plan, browser, ...) is treated as a `meta.props.<key>` filter, so the API
// segments by any dimension without code changes.
const RESERVED = new Set([
  'unit', 'from', 'to', 'event', 'steps', 'days', 'limit',
  'dimension', 'minutes', 'source', 'threshold', 'window', 'gapMinutes',
]);

function parseFilters(q: Request['query']): Filters {
  const f: Filters = {};
  for (const [k, v] of Object.entries(q)) {
    if (!RESERVED.has(k) && typeof v === 'string' && v.length > 0) f[k] = v;
  }
  return f;
}

// Wrap async handlers so rejections become 500s instead of unhandled rejections.
type Handler = (req: Request, res: Response) => Promise<void> | void;
const wrap = (fn: Handler) => (req: Request, res: Response) => {
  Promise.resolve(fn(req, res)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'internal error';
    if (!res.headersSent) res.status(400).json({ error: message });
  });
};

async function main(): Promise<void> {
  await connect();
  startChangeStream();

  // Pre-aggregation: build rollups on boot, then refresh on a schedule. In
  // production this would be a separate worker; here a timer keeps it simple.
  await ensureRollupSchema();
  await runRollup().catch(() => undefined);
  const ROLLUP_INTERVAL_MS = 30_000;
  setInterval(() => void runRollup().catch(() => undefined), ROLLUP_INTERVAL_MS);

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.static(join(__dirname, '..', 'public')));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // --- Ingestion ---
  app.post(
    '/track',
    wrap(async (req, res) => {
      const inserted = await track(req.body);
      res.json({ inserted });
    }),
  );

  // --- Analytics ---
  app.get(
    '/api/trends',
    wrap(async (req, res) => {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const event = typeof req.query.event === 'string' ? req.query.event : undefined;
      // `source=rollup` serves from the pre-aggregated rollups (no raw scan).
      // Rollups aren't segmented, so fall back to raw when filters are present.
      const filters = parseFilters(req.query);
      if (req.query.source === 'rollup' && Object.keys(filters).length === 0) {
        res.json(await trendsFromRollups({ from, to, event }));
        return;
      }
      res.json(
        await analytics.trends({
          unit: (req.query.unit as TimeUnit) ?? 'hour',
          from,
          to,
          event,
          filters,
        }),
      );
    }),
  );

  app.get(
    '/api/top',
    wrap(async (req, res) => {
      const data = await analytics.topN({
        dimension: typeof req.query.dimension === 'string' ? req.query.dimension : 'event',
        limit: req.query.limit ? Number(req.query.limit) : 10,
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
        filters: parseFilters(req.query),
      });
      res.json(data);
    }),
  );

  app.get(
    '/api/funnel',
    wrap(async (req, res) => {
      const steps =
        typeof req.query.steps === 'string' && req.query.steps.length > 0
          ? req.query.steps.split(',')
          : FUNNEL_STEPS;
      const data = await analytics.funnel({
        steps,
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
        filters: parseFilters(req.query),
      });
      res.json(data);
    }),
  );

  app.get(
    '/api/retention',
    wrap(async (req, res) => {
      const data = await analytics.retention({
        days: req.query.days ? Number(req.query.days) : 7,
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
        filters: parseFilters(req.query),
      });
      res.json(data);
    }),
  );

  app.get(
    '/api/live',
    wrap(async (req, res) => {
      const minutes = req.query.minutes ? Number(req.query.minutes) : 5;
      res.json(await analytics.live({ minutes, filters: parseFilters(req.query) }));
    }),
  );

  // Distinct values for a dimension — powers the segmentation filter dropdowns.
  app.get(
    '/api/values',
    wrap(async (req, res) => {
      const dimension = typeof req.query.dimension === 'string' ? req.query.dimension : 'event';
      res.json(await analytics.distinctValues(dimension));
    }),
  );

  // Anomaly detection over event volume (rolling z-score).
  app.get(
    '/api/anomalies',
    wrap(async (req, res) => {
      const data = await analytics.anomalies({
        unit: (req.query.unit as TimeUnit) ?? 'hour',
        window: req.query.window ? Number(req.query.window) : 24,
        threshold: req.query.threshold ? Number(req.query.threshold) : 3,
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
        filters: parseFilters(req.query),
      });
      res.json(data);
    }),
  );

  // Sessionization metrics.
  app.get(
    '/api/sessions',
    wrap(async (req, res) => {
      const data = await analytics.sessions({
        gapMinutes: req.query.gapMinutes ? Number(req.query.gapMinutes) : 30,
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
        filters: parseFilters(req.query),
      });
      res.json(data);
    }),
  );

  // Rollup status + manual trigger.
  app.get(
    '/api/rollups',
    wrap(async (_req, res) => {
      res.json(await rollupStats());
    }),
  );
  app.post(
    '/api/rollups/run',
    wrap(async (_req, res) => {
      await runRollup();
      res.json(await rollupStats());
    }),
  );

  // --- Real-time stream ---
  app.get('/api/stream', sseHandler);

  // --- Demo helpers ---
  app.post(
    '/api/simulate',
    wrap(async (req, res) => {
      const count = Number(req.body?.count ?? 200);
      const inserted = await simulateLive(count);
      res.json({ inserted });
    }),
  );

  app.post(
    '/api/seed',
    wrap(async (req, res) => {
      const days = Number(req.body?.days ?? 7);
      const inserted = await simulateBackfill({ days });
      res.json({ inserted, days });
    }),
  );

  app.post(
    '/api/reset',
    wrap(async (_req, res) => {
      await resetEvents();
      await resetRollups();
      restartChangeStream(); // dropping the collection killed the old watch
      res.json({ ok: true });
    }),
  );

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`\n  Pulse → http://localhost:${config.port}\n`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
