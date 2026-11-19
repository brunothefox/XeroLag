'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { UsageHistory } = require('../src/renderer/usage-history');

function reading(at, cpu, gpuAt = at, gpu = 20) {
  return { sampledAt: at, cpuSampledAt: at, cpuPercent: cpu,
    windowsReadAt: gpuAt, windows: { gpuPercent: gpu }, memory: { percent: 40 }, stale: false };
}

test('history starts empty, uses measured values, and deduplicates cached GPU samples', () => {
  const history = new UsageHistory();
  assert.equal(history.chart('cpu').count, 0);
  history.push(reading(100_000, 10));
  history.push(reading(103_000, 30, 100_000));
  assert.equal(history.chart('cpu').count, 2);
  assert.equal(history.chart('cpu').average, 20);
  assert.equal(history.chart('cpu').peak, 30);
  assert.equal(history.chart('gpu').count, 1);
  assert.equal(history.chart('cpu').point.x, 600);
});

test('history expires old samples and breaks paths across monitoring gaps', () => {
  const history = new UsageHistory();
  history.push(reading(100_000, 10));
  history.push(reading(103_000, 20));
  history.push(reading(120_000, 50));
  assert.equal((history.chart('cpu').line.match(/M/g) || []).length, 2);
  history.push(reading(170_000, null, null, null));
  assert.equal(history.chart('cpu').count, 1);
  assert.equal(history.chart('cpu').latest, 50);
  history.push(reading(190_000, null, null, null));
  assert.equal(history.chart('cpu').count, 0);
  assert.equal(history.chart('cpu').latest, null);
});
