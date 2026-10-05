import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../app';
import { TwinStore } from '../../domain/store';
import { TelemetryService } from '../../services/telemetry-service';

const ingest = (app: any, observedAt: number, value: number, assetId = 'pump-1') =>
  app.inject({ method: 'POST', url: '/telemetry', payload: { assetId, metric: 'temp', value, unit: 'C', observedAt, quality: 'good' } });

const replay = (app: any, query: string) => app.inject({ method: 'GET', url: `/telemetry/replay?${query}` });

const timestamps = (events: any[]) => events.map((e) => e.timestamp);
const values = (events: any[]) => events.map((e) => e.payload.value);

test('closed interval: events exactly at from and to are included', async () => {
  const app = buildApp();
  await ingest(app, 1000, 10);
  await ingest(app, 1500, 15);
  await ingest(app, 2000, 20);

  const res = await replay(app, 'from=1000&to=2000');
  assert.equal(res.statusCode, 200);
  const events = res.json();
  assert.deepEqual(timestamps(events), [1000, 1500, 2000]);
  assert.deepEqual(values(events), [10, 15, 20]);
});

test('adjacent milliseconds: exact bounds, no range widening', async () => {
  const app = buildApp();
  const t = 1696521600000;
  await ingest(app, t - 1, 99); // just outside, must never leak in
  await ingest(app, t, 1);
  await ingest(app, t + 1, 2);
  await ingest(app, t + 2, 98); // just outside, must never leak in

  const both = (await replay(app, `from=${t}&to=${t + 1}`)).json();
  assert.deepEqual(timestamps(both), [t, t + 1]);
  assert.deepEqual(values(both), [1, 2]);

  const pointAtT = (await replay(app, `from=${t}&to=${t}`)).json();
  assert.deepEqual(values(pointAtT), [1]);

  const pointAtT1 = (await replay(app, `from=${t + 1}&to=${t + 1}`)).json();
  assert.deepEqual(values(pointAtT1), [2]);

  const emptyGap = (await replay(app, `from=${t + 3}&to=${t + 4}`)).json();
  assert.deepEqual(emptyGap, []);
});

test('cross-second ranges: only events inside the second boundary window', async () => {
  const app = buildApp();
  await ingest(app, 1696521599998, 1);
  await ingest(app, 1696521599999, 2);
  await ingest(app, 1696521600000, 3);
  await ingest(app, 1696521600001, 4);

  const across = (await replay(app, 'from=1696521599999&to=1696521600000')).json();
  assert.deepEqual(values(across), [2, 3]);

  const full = (await replay(app, 'from=1696521599998&to=1696521600001')).json();
  assert.deepEqual(values(full), [1, 2, 3, 4]);
});

test('out-of-order writes replay in business order; same timestamp keeps insertion order', async () => {
  const app = buildApp();
  await ingest(app, 3000, 30);
  await ingest(app, 1000, 10);
  await ingest(app, 2000, 21); // first write at t=2000
  await ingest(app, 2000, 22); // second write at t=2000

  const res = await replay(app, 'from=1000&to=3000');
  assert.equal(res.statusCode, 200);
  const events = res.json();
  assert.deepEqual(timestamps(events), [1000, 2000, 2000, 3000]);
  assert.deepEqual(values(events), [10, 21, 22, 30]);
  const seqAt2000 = events.filter((e: any) => e.timestamp === 2000).map((e: any) => e.sequence);
  assert.ok(seqAt2000[0] < seqAt2000[1], 'same-timestamp events keep insertion (sequence) order');
});

test('repeated replay is deterministic and reflects later out-of-order writes in sorted position', async () => {
  const app = buildApp();
  await ingest(app, 2000, 20);
  await ingest(app, 1000, 10);

  const first = (await replay(app, 'from=1000&to=2000')).json();
  const second = (await replay(app, 'from=1000&to=2000')).json();
  const third = (await replay(app, 'from=1000&to=2000')).json();
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(values(first), [10, 20]);

  await ingest(app, 1500, 15); // late, out-of-order write inside the range
  const afterLateWrite = (await replay(app, 'from=1000&to=2000')).json();
  assert.deepEqual(values(afterLateWrite), [10, 15, 20]);
});

test('reversed range returns a clear 400 error', async () => {
  const app = buildApp();
  await ingest(app, 1000, 10);
  const res = await replay(app, 'from=3000&to=1000');
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.code, 'INVALID_TIME_RANGE');
  assert.equal(typeof body.message, 'string');
});

test('malformed timestamps return a clear 400 error', async () => {
  const app = buildApp();
  for (const bad of ['abc', 'NaN', 'Infinity', encodeURIComponent('2026-10-05T00:00:00Z')]) {
    const res = await replay(app, `from=${bad}&to=2000`);
    assert.equal(res.statusCode, 400, `from=${bad}`);
    assert.equal(res.json().code, 'INVALID_TIMESTAMP');
  }
  const badTo = await replay(app, 'from=1000&to=soon');
  assert.equal(badTo.statusCode, 400);
  assert.equal(badTo.json().code, 'INVALID_TIMESTAMP');
});

test('missing parameters return a clear 400 error', async () => {
  const app = buildApp();
  for (const query of ['', 'from=1000', 'to=2000', 'from=&to=2000', 'from=%20&to=2000']) {
    const res = await replay(app, query);
    assert.equal(res.statusCode, 400, `query="${query}"`);
    const body = res.json();
    assert.equal(body.code, 'MISSING_TIME_RANGE');
    assert.equal(typeof body.message, 'string');
  }
});

test('error shape stays compatible with the rest of the API ({code, message})', async () => {
  const app = buildApp();
  const replayError = (await replay(app, 'from=5000&to=1000')).json();
  assert.deepEqual(Object.keys(replayError).sort(), ['code', 'message']);

  const domainError = (await app.inject({ method: 'POST', url: '/work-orders/wo_missing/transition', payload: { state: 'approved' } })).json();
  assert.ok('message' in domainError);
  assert.equal(typeof replayError.code, 'string');
  assert.equal(typeof replayError.message, 'string');
});

test('service enforces the closed-interval contract for direct callers', () => {
  const service = new TelemetryService(new TwinStore());
  assert.throws(() => service.replay(Number.NaN, 1000), /finite/);
  assert.throws(() => service.replay(1000, Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => service.replay(2000, 1000), /less than or equal/);
  assert.deepEqual(service.replay(1000, 1000), []);
});
