# Pulse

A real-time event analytics engine built on MongoDB. Ingests high-volume telemetry and answers product-analytics questions — trends, conversion funnels, retention cohorts, and live activity — entirely through MongoDB aggregation pipelines, with a dashboard that updates live via change streams.

## Contents

- [Overview](#overview)
- [Why MongoDB](#why-mongodb)
- [Architecture](#architecture)
- [Analytics](#analytics)
- [Usage](#usage)
- [API](#api)
- [Testing](#testing)
- [Deployment](#deployment)

## Overview

Most "analytics" side projects stop at counting rows. Pulse implements the queries that actually make analytics useful, and does them where they belong — inside the database:

- **Trends** — event volume bucketed by minute/hour/day.
- **Funnels** — of the users who entered step 1, how many advanced through each subsequent step *in order*, with per-step conversion.
- **Retention cohorts** — group users by first-seen day, then measure the fraction returning on each following day.
- **Top-N breakdowns** — by event or by any property (country, browser, plan).
- **Segmentation** — slice every query above by any property (`country=US`, `plan=pro`, …) via dynamically-built pipelines.
- **Anomaly detection** — rolling z-score on event volume (`$setWindowFields`) flags traffic spikes with no fixed threshold.
- **Sessionization** — group events into sessions by a 30-minute inactivity gap (`$setWindowFields` + `$shift`); reports session count, duration, and events/session.
- **Pre-aggregated rollups** — a background job materialises hourly summaries via `$merge` so dashboards read a small summary collection instead of scanning raw events.
- **Explore** — a self-serve query builder: choose a measure (event count / unique users), events, a breakdown dimension, and granularity; the aggregation pipeline is assembled from that input and returns one series per breakdown value.
- **Geo** — events aggregated by country, rendered as a world choropleth.
- **Alerting** — user-defined rules (threshold or anomaly) evaluated on a schedule that record triggers, push them to the dashboard over SSE, and optionally fire a webhook.
- **Live activity** — events and unique users in a rolling window, streamed to the dashboard in real time.

## Why MongoDB

The project is built around two MongoDB capabilities that fit telemetry well:

- **Aggregation framework** — trends, funnels, retention, and breakdowns are all expressed as aggregation pipelines, so computation happens server-side over indexed data rather than by pulling documents into the app.
- **Change streams** — the dashboard subscribes to inserts through a change stream (built on the oplog, a replica-set feature), giving real-time updates with no polling and reflecting writes from any app instance.

**Storage choice — a deliberate tradeoff.** Events are stored in a *standard* collection with a time-based index, not a time-series collection. Time-series collections are more storage-efficient for raw telemetry, but MongoDB does **not** support collection-level change streams on them — and the live feed depends on a change stream. Change streams are the higher-value capability here, so a regular collection (indexed on `ts` and the metadata fields) keeps both the aggregation queries and the real-time feed working.

## Architecture

```
   POST /track ──▶ ingest ──▶ MongoDB collection (events)
                                   │  doc: { ts, meta: { event, distinctId, props } }
                                   │  indexed on ts + meta fields
                                   ▼
        aggregation pipelines:  trends · funnel · retention · top-N · live
                                   │
   GET /api/* ◀────────────────────┘   (computed in the database)

   inserts ──▶ change stream ──▶ SSE ──▶ dashboard (live events/sec)
```

The funnel pipeline is the most involved: per user it sorts events by time, then uses `$reduce` to walk the sequence carrying a counter of how many funnel steps have matched *in order*, yielding the furthest step each user reached in a single pass. Retention maps each user's active days to integer offsets from their first-seen day with `$dateDiff`, then counts distinct users per (cohort, offset).

## Analytics

| Query | Pipeline highlights |
|---|---|
| Trends | `$dateTrunc` → `$group` count per bucket |
| Top-N | `$group` on event or `meta.props.*` → `$sort` → `$limit` |
| Funnel | per-user `$push` (time-sorted) → `$reduce` for in-order step matching |
| Retention | first-seen + active-day set → `$dateDiff` offsets → cohort × offset counts |
| Anomaly | `$group` per bucket → `$setWindowFields` rolling mean/stddev → z-score |
| Sessions | `$setWindowFields` + `$shift` to detect inactivity gaps → running session id → group |
| Rollups | `$group` to hourly summaries → `$merge` upsert into a summary collection |
| Live | rolling `$match` on time → `$addToSet` for unique users |

Segmentation filters are applied by building the `$match` stage dynamically from query params, so every query above can be sliced by any property without bespoke code.

## Usage

```bash
# 1. Start MongoDB as a single-node replica set (required for change streams)
npm run mongo:up

# 2. Install and run
npm install
npm run dev        # http://localhost:4000
```

Open the dashboard, click **Seed 7 days of data** to populate funnels and retention, then **Start live stream** to watch events flow in real time.

## API

| Method | Route | Purpose |
|---|---|---|
| POST | `/track` | Ingest one event or an array of events |
| GET | `/api/trends?unit=hour&event=` | Event volume over time |
| GET | `/api/funnel?steps=a,b,c` | Ordered conversion funnel |
| GET | `/api/retention?days=7` | Cohort retention matrix |
| GET | `/api/top?dimension=country&limit=10` | Top-N breakdown |
| GET | `/api/live?minutes=5` | Rolling live counts |
| GET | `/api/anomalies?unit=hour&threshold=3` | Volume anomalies (rolling z-score) |
| GET | `/api/sessions?gapMinutes=30` | Sessionization metrics |
| GET | `/api/values?dimension=country` | Distinct values (filter UI) |
| GET | `/api/rollups` · POST `/api/rollups/run` | Rollup stats / manual rebuild |
| GET | `/api/explore?measure=users&breakdown=country&unit=day` | Self-serve query builder |
| GET | `/api/geo` | Events by country (for the choropleth) |
| GET/POST/DELETE | `/api/alerts` · `/api/alerts/:id` · `/api/alerts/events` | Alert rule CRUD + trigger history |
| GET | `/api/stream` | SSE feed of inserts + alerts (change stream) |
| POST | `/api/seed` · `/api/simulate` · `/api/reset` | Demo data helpers |

Any query param that isn't a reserved keyword is treated as a segmentation filter, e.g. `GET /api/funnel?country=US&plan=pro`. Trends also accept `?source=rollup` to serve from the pre-aggregated collection.

Event shape:

```json
{ "event": "purchase", "distinctId": "user_42", "properties": { "country": "US", "plan": "pro" } }
```

## Testing

```bash
npm test
```

Tests run against a live MongoDB and cover ingestion validation, each aggregation against known fixtures (funnel out-of-order handling, retention decay, anomaly z-score spike detection, session gap splitting, idempotent rollups, segmentation), and a concurrent-ingestion test asserting every event is persisted exactly once under parallel writes.

## Deployment

A [`render.yaml`](render.yaml) blueprint deploys the service on Render. MongoDB runs on a free **Atlas M0** cluster (a replica set, so change streams are supported); set its connection string as `MONGODB_URI` in the Render dashboard. A `Dockerfile` is included for any container platform.

## Stack

Node.js, TypeScript, Express, MongoDB (aggregation framework, change streams), Chart.js, Vitest, Docker.

## License

MIT
