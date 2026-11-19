'use strict';

const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runPowerShell } = require('./command-runner');

function cpuTotals(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) return null;
  return cpus.reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((total, value) => total + value, 0);
    return sum;
  }, { idle: 0, total: 0 });
}

function cpuPercent(previous, current) {
  if (!previous || !current) return null;
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (elapsed <= 0 || idle < 0 || idle > elapsed) return null;
  return Math.round((1 - idle / elapsed) * 1000) / 10;
}

function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function normalizeWindows(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Windows telemetry response.');
  const array = key => Array.isArray(data[key]) ? data[key] : [];
  return {
    operatingSystem: data.operatingSystem ?? null,
    computer: data.computer ?? null,
    processors: array('processors'), graphics: array('graphics'),
    physicalDisks: array('physicalDisks'), volumes: array('volumes'),
    memoryModules: array('memoryModules'), memorySlots: finite(data.memorySlots, 1),
    processCount: finite(data.processCount), powerPlan: data.powerPlan ?? null,
    diskReadBytesPerSecond: finite(data.diskReadBytesPerSecond),
    diskWriteBytesPerSecond: finite(data.diskWriteBytesPerSecond),
    systemDrive: typeof data.systemDrive === 'string' ? data.systemDrive : null,
    gpuPercent: finite(data.gpuPercent, 0, 100),
    dedicatedUsedBytes: finite(data.dedicatedUsedBytes),
    dedicatedTotalBytes: finite(data.dedicatedTotalBytes, 1),
    memoryAdapterCount: finite(data.memoryAdapterCount, 1),
    diskActivePercent: finite(data.diskActivePercent, 0, 100),
    warnings: array('warnings').filter(value => typeof value === 'string')
  };
}

async function readWindowsTelemetry({ includeInventory = true } = {}) {
  try {
    const script = await fs.readFile(path.join(__dirname, '..', 'powershell', 'telemetry.ps1'), 'utf8');
    const { stdout } = await runPowerShell('$includeInventory = $' + (includeInventory ? 'true' : 'false') + '\n' + script, { timeout: 20_000 });
    return normalizeWindows(JSON.parse(stdout.trim().replace(/^\uFEFF/, '')));
  } catch (error) {
    throw new Error('Windows hardware counters could not be read.', { cause: error });
  }
}

function createTelemetry({ readWindows = readWindowsTelemetry, clock = Date.now, system = os } = {}) {
  const initialCpus = system.cpus();
  let previous = cpuTotals(initialCpus);
  let previousCores = initialCpus.map(cpu => cpuTotals([cpu]));
  let corePercents = [];
  let cpu = null;
  let cpuReadAt = 0;
  let windows = null;
  let windowsReadAt = null;
  let attemptAt = null;
  let pending = null;
  let readError = null;
  let inventoryReadAt = null;
  let inventoryWarnings = [];

  function refreshWindows() {
    if (pending) return pending;
    attemptAt = clock();
    const includeInventory = inventoryReadAt === null || clock() - inventoryReadAt >= 300_000;
    pending = Promise.resolve().then(() => readWindows({ includeInventory })).then(data => {
      if (includeInventory) {
        inventoryReadAt = clock();
        inventoryWarnings = data.warnings.filter(message => /information/.test(message));
      } else if (windows) {
        for (const key of ['operatingSystem', 'computer', 'processors', 'graphics', 'physicalDisks', 'memoryModules', 'memorySlots']) data[key] = windows[key];
        data.warnings = [...new Set([...inventoryWarnings, ...data.warnings])];
      }
      if (data.memoryAdapterCount === 1 && data.graphics.length === 1) {
        data.dedicatedTotalBytes = finite(data.graphics[0].dedicatedTotalBytes, 1);
      }
      windows = data;
      windowsReadAt = clock();
      readError = null;
    }).catch(() => {
      readError = 'Some hardware readings are unavailable. They will be retried automatically.';
    }).finally(() => { pending = null; });
    return pending;
  }

  async function getSnapshot() {
    const now = clock();
    if (attemptAt === null || now - attemptAt >= 10_000) void refreshWindows();
    // Initial requests wait for the same query; later samples use the cached result.
    if (windowsReadAt === null && pending) await pending;
    const cpus = system.cpus();
    const sampleTime = clock();
    if (sampleTime - cpuReadAt >= 1000) {
      const current = cpuTotals(cpus);
      cpu = cpuPercent(previous, current);
      previous = current;
      corePercents = cpus.map((core, index) => cpuPercent(previousCores[index], cpuTotals([core])));
      previousCores = cpus.map(core => cpuTotals([core]));
      cpuReadAt = sampleTime;
    }
    const totalBytes = system.totalmem();
    const freeBytes = system.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      sampledAt: clock(), cpuSampledAt: cpuReadAt, cpuPercent: cpu, corePercents,
      processorName: cpus[0]?.model?.trim() || 'Processor information unavailable',
      logicalProcessors: cpus.length,
      memory: { totalBytes, usedBytes, freeBytes, percent: totalBytes > 0 ? usedBytes / totalBytes * 100 : null },
      uptimeSeconds: system.uptime(), windows, windowsReadAt,
      stale: windowsReadAt !== null && clock() - windowsReadAt > 30_000,
      error: readError
    };
  }

  return { getSnapshot, refreshWindows };
}

module.exports = { createTelemetry, cpuTotals, cpuPercent, finite, normalizeWindows, readWindowsTelemetry };
