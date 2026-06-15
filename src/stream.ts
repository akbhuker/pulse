import type { Request, Response } from 'express';
import type { ChangeStream } from 'mongodb';
import { events } from './db';
import type { StoredEvent } from './types';

/**
 * Server-Sent Events fan-out backed by a MongoDB change stream.
 *
 * A single change stream watches the events collection for inserts; every
 * inserted document is pushed to all connected dashboard clients in real time.
 * Change streams are a replica-set feature built on the oplog, so this needs no
 * polling and reflects writes from *any* app instance — not just this process.
 */
const clients = new Set<Response>();
let stream: ChangeStream<StoredEvent> | null = null;

export function sseHandler(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: ready\ndata: {}\n\n`);
  clients.add(res);

  // Heartbeat keeps proxies from closing an idle SSE connection.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function broadcast(payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(frame);
}

/** Start watching inserts and relaying them to SSE clients. Self-healing. */
export function startChangeStream(): void {
  if (stream) return;
  try {
    stream = events().watch([{ $match: { operationType: 'insert' } }], {
      fullDocument: 'updateLookup',
    });
  } catch {
    // Collection may not exist yet; retry shortly.
    setTimeout(startChangeStream, 1000);
    return;
  }
  stream.on('change', (change) => {
    // Dropping the collection (e.g. /api/reset) emits an `invalidate` event and
    // closes the stream — re-arm so the live feed keeps working afterwards.
    if (change.operationType === 'invalidate') {
      restart();
      return;
    }
    if (change.operationType !== 'insert') return;
    const doc = change.fullDocument as StoredEvent | undefined;
    if (!doc) return;
    broadcast({
      type: 'event',
      event: doc.meta.event,
      distinctId: doc.meta.distinctId,
      ts: doc.ts,
    });
  });
  // A transient error (failover, dropped collection) shouldn't crash the
  // process — tear down and re-establish the watch.
  stream.on('error', restart);
}

function restart(): void {
  void stream?.close().catch(() => undefined);
  stream = null;
  setTimeout(startChangeStream, 500);
}

/** Force a re-watch (call after dropping/recreating the collection). */
export function restartChangeStream(): void {
  restart();
}

export async function stopChangeStream(): Promise<void> {
  await stream?.close().catch(() => undefined);
  stream = null;
  clients.clear();
}

export function clientCount(): number {
  return clients.size;
}
