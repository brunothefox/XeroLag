'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpuPercent, normalizeWindows, createTelemetry } = require('../src/main/telemetry');

test('CPU utilization uses elapsed processor time and rejects reset counters', () => {
  assert.equal(cpuPercent({ total: 100, idle: 50 }, { total: 200, idle: 75 }), 75);
  assert.equal(cpuPercent(null, { total: 100, idle: 50 }), null);
  assert.equal(cpuPercent({ total: 100, idle: 50 }, { total: 100, idle: 50 }), null);
  assert.equal(cpuPercent({ total: 200, idle: 75 }, { total: 100, idle: 50 }), null);
});

test('missing and invalid GPU counters never become a fabricated zero', () => {
  const data = normalizeWindows({ gpuPercent: null, dedicatedUsedBytes: -1, diskActivePercent: 101 });
  assert.equal(data.gpuPercent, null);
  assert.equal(data.dedicatedUsedBytes, null);
  assert.equal(data.diskActivePercent, null);
  assert.deepEqual(data.graphics, []);
  assert.equal(normalizeWindows({ gpuPercent: 0 }).gpuPercent, 0);
  assert.throws(() => normalizeWindows([]), /Invalid/);
});

function fakeSystem() {
  let time = 100;
  return {
    cpus: () => [{ model: 'Test CPU', times: { idle: time += 50, user: time, sys: 0, nice: 0, irq: 0 } }],
    totalmem: () => 1024, freemem: () => 256, uptime: () => 600
  };
}

test('concurrent requests share one Windows query and obey the cache interval', async () => {
  let reads = 0;
  let now = 100_000;
  let finish;
  const telemetry = createTelemetry({
    system: fakeSystem(), clock: () => now,
    readWindows: () => { reads++; return new Promise(resolve => { finish = resolve; }); }
  });
  const first = telemetry.getSnapshot();
  const second = telemetry.getSnapshot();
  await Promise.resolve();
  assert.equal(reads, 1);
  finish(normalizeWindows({ gpuPercent: 14 }));
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.windows.gpuPercent, 14);
  assert.equal(two.memory.percent, 75);
  await telemetry.getSnapshot();
  assert.equal(reads, 1);
  now += 10_001;
  await telemetry.getSnapshot();
  assert.equal(reads, 2);
  finish(normalizeWindows({ gpuPercent: 20 }));
});

test('failed hardware reads retain basic telemetry and expose stale state', async () => {
  let now = 100_000;
  let fail = false;
  const telemetry = createTelemetry({ system: fakeSystem(), clock: () => now,
    readWindows: async () => { if (fail) throw new Error('Unavailable'); return normalizeWindows({ gpuPercent: 25 }); }
  });
  await telemetry.getSnapshot();
  fail = true;
  now += 31_000;
  await telemetry.getSnapshot();
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = await telemetry.getSnapshot();
  assert.equal(snapshot.stale, true);
  assert.match(snapshot.error, /unavailable/);
  assert.equal(snapshot.memory.usedBytes, 768);
});
