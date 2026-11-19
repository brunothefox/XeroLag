'use strict';

class UsageHistory {
  constructor() {
    this.samples = { cpu: [], ram: [], gpu: [] };
    this.now = 0;
  }

  push(snapshot) {
    this.now = snapshot.sampledAt;
    const values = {
      cpu: [snapshot.cpuSampledAt, snapshot.cpuPercent],
      ram: [snapshot.cpuSampledAt, snapshot.memory.percent],
      gpu: [snapshot.windowsReadAt, snapshot.stale ? null : snapshot.windows?.gpuPercent]
    };
    for (const [key, [at, value]] of Object.entries(values)) {
      const samples = this.samples[key];
      if (Number.isFinite(at) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 &&
          (!samples.length || at > samples[samples.length - 1].at)) samples.push({ at, value });
      this.samples[key] = samples.filter(sample => sample.at >= this.now - 60_000 && sample.at <= this.now);
    }
  }

  chart(key) {
    const samples = this.samples[key] || [];
    const segments = [];
    const gap = key === 'gpu' ? 25_000 : 7000;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      if (!index || sample.at - samples[index - 1].at > gap) segments.push([]);
      segments[segments.length - 1].push({
        x: Math.max(0, Math.min(600, 600 * (1 - (this.now - sample.at) / 60_000))),
        y: 116 - sample.value / 100 * 104
      });
    }
    const point = item => item.x.toFixed(2) + ' ' + item.y.toFixed(2);
    const line = segments.map(segment => segment.map((item, index) => (index ? 'L' : 'M') + point(item)).join(' ')).join(' ');
    const area = segments.filter(segment => segment.length > 1).map(segment =>
      'M' + segment[0].x.toFixed(2) + ' 116 ' + segment.map(item => 'L' + point(item)).join(' ') +
      ' L' + segment[segment.length - 1].x.toFixed(2) + ' 116 Z').join(' ');
    return {
      count: samples.length, line, area, point: segments.at(-1)?.at(-1) || null,
      latest: samples.at(-1)?.value ?? null,
      average: samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length : null,
      peak: samples.length ? Math.max(...samples.map(sample => sample.value)) : null
    };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { UsageHistory };
