import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, resetEvents, close, events, track } from './setup';
import { toStored } from '../src/ingest';

describe('ingestion', () => {
  beforeAll(async () => {
    await connect();
    await resetEvents();
  });
  afterAll(async () => {
    await close();
  });

  it('stores an event in time-series shape', async () => {
    await track({ event: 'page_view', distinctId: 'u1', properties: { country: 'US' } });
    const doc = await events().findOne({ 'meta.distinctId': 'u1' });
    expect(doc?.meta.event).toBe('page_view');
    expect(doc?.meta.props.country).toBe('US');
    expect(doc?.ts).toBeInstanceOf(Date);
  });

  it('accepts a batch and returns the inserted count', async () => {
    const n = await track([
      { event: 'a', distinctId: 'u2' },
      { event: 'b', distinctId: 'u2' },
      { event: 'c', distinctId: 'u3' },
    ]);
    expect(n).toBe(3);
  });

  it('rejects events missing required fields', () => {
    expect(() => toStored({ event: '', distinctId: 'u' } as never)).toThrow();
    expect(() => toStored({ event: 'x', distinctId: '' } as never)).toThrow();
  });

  it('defaults ts to now when omitted', () => {
    const before = Date.now();
    const stored = toStored({ event: 'x', distinctId: 'u' });
    expect(stored.ts.getTime()).toBeGreaterThanOrEqual(before);
  });
});
