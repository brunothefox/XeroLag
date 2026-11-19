'use strict';

const byId = id => document.getElementById(id);
const history = new UsageHistory();
let currentPage = 'dashboard';
let selectedChart = 'cpu';
let lastWindowsReadAt = null;
let refreshing = false;
let stopped = false;
let timer;
const pages = { dashboard:'Summary',hardware:'Hardware',storage:'Storage',profiles:'Profiles',cleaner:'Caches',files:'File finder',gaming:'Performance',devices:'Devices',games:'Library',booster:'Booster',network:'Network',startup:'Startup',services:'Services',debloat:'Apps',shell:'Appearance',repair:'Tools',health:'Disk health',recovery:'Recovery',about:'About',activity:'Activity',registry:'Registry',tools:'More tools',processes:'Processes',settings:'Settings' };
const sections = [
  {title:'Overview',pages:['dashboard','hardware','storage']},
  {title:'Clean',pages:['cleaner','files']},
  {title:'Gaming',pages:['profiles','gaming','devices','games','booster']},
  {title:'Network',pages:['network']},
  {title:'Windows',pages:['startup','services','debloat','shell']},
  {title:'Repair',pages:['repair','health','recovery']}
];

function reportError(error) {
  byId('error').textContent = error instanceof Error ? error.message : String(error);
  byId('error').hidden = false;
}

function showPage(page, focus = true) {
  if (!Object.hasOwn(pages, page)) return;
  currentPage = page;
  for (const key of Object.keys(pages)) byId('page-' + key).hidden = key !== page;
  const section=sections.find(section=>section.pages.includes(page));
  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.closest('.nav-tools')?!section&&button.dataset.page===page:button.dataset.page===(section?.pages[0]||page)) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  byId('page-title').textContent = section?.title||pages[page];
  byId('module-tabs').replaceChildren(...(section&&section.pages.length>1?section.pages.map(route=>{
    const button=element('button',pages[route],'module-tab');button.dataset.page=route;
    if(route===page)button.setAttribute('aria-current','page');
    button.addEventListener('click',()=>{showPage(route);if(['dashboard','hardware','storage'].includes(route))void refresh();});
    return button;
  }):[]));
  byId('module-tabs').hidden=!section||section.pages.length<2;
  byId('refresh').hidden = page === 'about';
  byId('live-state').hidden = !['dashboard','hardware','storage'].includes(page);
  if(!['dashboard','hardware','storage'].includes(page))byId('telemetry-warning').hidden=true;
  document.querySelector('.plan-chip').hidden = !['dashboard','profiles','gaming','booster'].includes(page);
  if (focus) byId('page-title').focus({ preventScroll: true });
  byId('main-content').scrollTop = 0;
  const visible=byId('page-'+page);visible.classList.remove('page-enter');void visible.offsetWidth;visible.classList.add('page-enter');
  document.dispatchEvent(new CustomEvent('xerolag:navigate', { detail: page }));
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function details(target, rows) {
  target.replaceChildren(...rows.map(([label, value]) => {
    const row = element('div', undefined, 'detail-row');
    row.append(element('dt', label), element('dd', value ?? 'Not reported'));
    return row;
  }));
}

function bytes(value, decimals = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1));
  return (value / 1024 ** index).toFixed(index === 0 ? 0 : decimals) + ' ' + units[index];
}

function uptime(seconds) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return (days ? days + 'd ' : '') + hours + 'h ' + minutes % 60 + 'm';
}

function metric(id, value, unit, percentage = null) {
  const target = byId(id + '-value');
  target.replaceChildren(document.createTextNode(value === null ? '—' : String(value)));
  if (value !== null && unit) target.append(element('small', unit));
  const meter = byId(id + '-meter');
  if (meter) {
    meter.hidden = typeof percentage !== 'number' || !Number.isFinite(percentage);
    if (!meter.hidden) meter.value = Math.min(100, Math.max(0, percentage));
  }
}

function renderVolumes(target, volumes, expanded = false) {
  if (!volumes.length) {
    target.replaceChildren(element('p', 'Drive information unavailable.', 'muted'));
    return;
  }
  target.replaceChildren(...volumes.map(volume => {
    const used = Math.max(0, volume.sizeBytes - volume.freeBytes);
    const percent = volume.sizeBytes > 0 ? used / volume.sizeBytes * 100 : 0;
    const row = element('div', undefined, 'volume' + (percent > 85 ? ' volume-low' : ''));
    const heading = element('div', undefined, 'volume-heading');
    const name = element('div', undefined, 'volume-name');
    name.append(icon('disk'), element('span', volume.drive + ' ' + (volume.label || 'Local disk')));
    heading.append(name, element('span', Math.round(percent) + '%', 'volume-percent'));
    const bar = element('progress');
    bar.max = 100;
    bar.value = percent;
    bar.setAttribute('aria-label', volume.drive + ' used capacity');
    const caption = bytes(volume.freeBytes) + ' free' + (expanded ? ' / ' + bytes(volume.sizeBytes) : '');
    row.append(heading, bar, element('p', caption, 'volume-caption'));
    if (expanded) row.append(element('p', volume.fileSystem + ' · ' + bytes(used) + ' used', 'volume-caption'));
    return row;
  }));
}

function hardwareItems(target, items, heading, rows) {
  if (!items.length) { target.replaceChildren(element('p', 'Information not reported by Windows.', 'muted')); return; }
  target.replaceChildren(...items.map(item => {
    const container = element('div', undefined, 'hardware-item');
    const list = element('dl', undefined, 'detail-list');
    details(list, rows(item));
    container.append(element('h3', heading(item)), list);
    return container;
  }));
}

function renderHardware(snapshot) {
  const data = snapshot.windows;
  const os = data?.operatingSystem;
  const osName = os ? os.name.replace(/^Microsoft /, '') : 'Windows';
  details(byId('computer-details'), [
    ['Manufacturer', data?.computer?.manufacturer], ['Model', data?.computer?.model],
    ['Windows', os ? osName + ' · ' + os.build : null], ['Usable RAM', bytes(snapshot.memory.totalBytes)]
  ]);
  hardwareItems(byId('processor-details'), data?.processors || [], item => item.name, item => [
    ['Cores / threads', item.cores + ' / ' + item.threads], ['Maximum clock', item.maxClockMHz ? item.maxClockMHz + ' MHz' : null]
  ]);
  hardwareItems(byId('graphics-details'), data?.graphics || [], item => item.name, item => [
    ['Driver', item.driverVersion], ['Dedicated VRAM', bytes(item.dedicatedTotalBytes)]
  ]);
  hardwareItems(byId('memory-details'), data?.memoryModules || [], item => item.slot || 'Memory module', item => [
    ['Capacity', bytes(item.capacityBytes)], ['Configured clock', item.speedMHz ? item.speedMHz + ' MHz' : null],
    ['Manufacturer', item.manufacturer || null], ['Part', item.partNumber || null]
  ]);
  const disks = data?.physicalDisks || [];
  const diskTarget = byId('disk-details');
  if (disks.length) {
    const table = element('table');
    const head = element('thead');
    const labels = element('tr');
    for (const label of ['Drive', 'Capacity', 'Bus', 'Type', 'Windows health']) {
      const cell = element('th', label); cell.scope = 'col'; labels.append(cell);
    }
    head.append(labels);
    const body = element('tbody');
    for (const disk of disks) {
      const row = element('tr');
      for (const value of [disk.name, bytes(disk.sizeBytes), disk.busType, disk.mediaType, disk.health]) row.append(element('td', value));
      body.append(row);
    }
    table.append(head, body);
    diskTarget.replaceChildren(table);
  } else diskTarget.replaceChildren(element('p', 'Disk information unavailable.', 'muted'));
  const volumes = data?.volumes || [];
  renderVolumes(byId('volumes'), volumes);
  renderVolumes(byId('storage-volumes'), volumes, true);
  const total = volumes.reduce((sum, volume) => sum + volume.sizeBytes, 0);
  const free = volumes.reduce((sum, volume) => sum + volume.freeBytes, 0);
  byId('storage-total').textContent = volumes.length ? bytes(total) : '—';
  byId('storage-free').textContent = volumes.length ? bytes(free) : '—';
  byId('storage-used').textContent = volumes.length ? bytes(total - free) : '—';
  byId('system-os').textContent = os ? osName + ' · ' + os.build : 'Windows information unavailable';
  const cores = (data?.processors || []).reduce((sum, item) => sum + item.cores, 0);
  byId('system-cores').textContent = (cores ? cores + ' cores · ' : '') + snapshot.logicalProcessors + ' threads';
  byId('system-driver').textContent = data?.graphics[0]?.driverVersion ? 'Driver ' + data.graphics[0].driverVersion : 'Driver unavailable';
}

function renderChart() {
  const chart = history.chart(selectedChart);
  byId('history-line').setAttribute('d', chart.line);
  byId('history-area').setAttribute('d', chart.area);
  byId('history-empty').hidden = chart.count >= 2;
  byId('history-empty').textContent = chart.count === 0 ? 'No readings available' : 'Collecting samples';
  byId('history-current').textContent = chart.latest === null ? '—' : Math.round(chart.latest) + '%';
  byId('history-stats').textContent = chart.count >= 2 ? 'Avg ' + Math.round(chart.average) + '% · Peak ' + Math.round(chart.peak) + '%' : '';
  byId('usage-chart').setAttribute('aria-label', selectedChart.toUpperCase() + ' usage over the last 60 seconds; ' + chart.count + ' samples');
  byId('history-dot').toggleAttribute('hidden', !chart.point);
  if (chart.point) {
    byId('history-dot').setAttribute('cx', chart.point.x);
    byId('history-dot').setAttribute('cy', chart.point.y);
  }
  for (const button of document.querySelectorAll('[data-chart]')) button.setAttribute('aria-pressed', String(button.dataset.chart === selectedChart));
}

function renderCores(values) {
  byId('core-usage').replaceChildren(...values.map((value, index) => {
    const container = element('div');
    const row = element('div', undefined, 'core-row');
    row.append(element('span', 'CPU ' + index), element('strong', value === null ? '—' : Math.round(value) + '%'));
    const bar = element('progress');
    bar.max = 100;
    bar.value = value ?? 0;
    bar.hidden = value === null;
    bar.setAttribute('aria-label', 'Logical processor ' + index + ' utilization');
    container.append(row, bar);
    return container;
  }));
}

function renderSnapshot(snapshot) {
  const data = snapshot.windows;
  metric('cpu', snapshot.cpuPercent === null ? null : Math.round(snapshot.cpuPercent), '%', snapshot.cpuPercent);
  byId('cpu-detail').textContent = snapshot.processorName.replace(/\s+\d+-Core Processor$/, '').replace(/\(R\)|\(TM\)/g, '');
  byId('cpu-detail').title = snapshot.processorName;
  const cores = (data?.processors || []).reduce((sum, item) => sum + item.cores, 0);
  byId('cpu-meta').textContent = (cores ? cores + ' cores / ' : '') + snapshot.logicalProcessors + ' threads';
  metric('ram', snapshot.memory.percent === null ? null : Math.round(snapshot.memory.percent), '%', snapshot.memory.percent);
  byId('ram-detail').textContent = bytes(snapshot.memory.usedBytes) + ' / ' + bytes(snapshot.memory.totalBytes);
  const configuredModules = data?.memoryModules || [];
  const configuredSpeeds = [...new Set(configuredModules.map(item => item.speedMHz).filter(value => value > 0))];
  byId('ram-meta').textContent = (configuredModules.length && data?.memorySlots ? configuredModules.length + ' / ' + data.memorySlots + ' slots' : '') +
    (configuredSpeeds.length ? ' · ' + configuredSpeeds.join(' / ') + ' MHz' : '');
  const readable = !snapshot.stale;
  const gpu = readable ? data?.gpuPercent ?? null : null;
  metric('gpu', gpu === null ? null : Math.round(gpu), '%', gpu);
  byId('gpu-value').title = 'Busiest engine across all graphics adapters';
  byId('gpu-detail').textContent = data?.graphics.map(item => item.name.replace(/^NVIDIA /, '')).join(', ') || 'Not reported';
  byId('gpu-detail').title = data?.graphics.map(item => item.name).join(', ') || 'GPU information unavailable';
  const gpuCapacity = data?.graphics.length === 1 ? data.graphics[0].dedicatedTotalBytes : null;
  byId('gpu-meta').textContent = gpuCapacity ? bytes(gpuCapacity, 0) + ' dedicated VRAM' : 'Dedicated memory capacity unavailable';
  const used = readable ? data?.dedicatedUsedBytes ?? null : null;
  metric('vram', used === null ? null : bytes(used), '');
  const disk = readable ? data?.diskActivePercent ?? null : null;
  metric('disk', disk === null ? null : Math.round(disk), '%');
  metric('process', readable ? data?.processCount ?? null : null, '');
  byId('disk-drive').textContent = data?.systemDrive || '';
  byId('disk-read').textContent = readable && data?.diskReadBytesPerSecond !== null && data?.diskReadBytesPerSecond !== undefined ? bytes(data.diskReadBytesPerSecond) + '/s' : '—';
  byId('disk-write').textContent = readable && data?.diskWriteBytesPerSecond !== null && data?.diskWriteBytesPerSecond !== undefined ? bytes(data.diskWriteBytesPerSecond) + '/s' : '—';
  byId('uptime-value').textContent = uptime(snapshot.uptimeSeconds);
  byId('uptime-value').title = 'Booted ' + new Date(snapshot.sampledAt - snapshot.uptimeSeconds * 1000).toLocaleString();
  byId('power-plan').textContent = data?.powerPlan?.name || 'Power plan unavailable';
  byId('power-plan').title = data?.powerPlan?.name || 'Power plan unavailable';
  const percent = snapshot.memory.percent;
  byId('memory-percent').textContent = percent === null ? '—' : Math.round(percent) + '%';
  byId('memory-used').textContent = bytes(snapshot.memory.usedBytes);
  byId('memory-free').textContent = bytes(snapshot.memory.freeBytes);
  byId('memory-distribution').value = percent ?? 0;
  const modules = data?.memoryModules || [];
  const speeds = [...new Set(modules.map(item => item.speedMHz).filter(value => value > 0))];
  details(byId('memory-summary'), [
    ['Usable', bytes(snapshot.memory.totalBytes)],
    ['Slots used', modules.length && data?.memorySlots ? modules.length + ' / ' + data.memorySlots : null],
    ['Configured clock', speeds.length ? speeds.join(' / ') + ' MHz' : null]
  ]);
  const warnings = [...(snapshot.error ? [snapshot.error] : []), ...(data?.warnings || [])];
  if (snapshot.stale) warnings.unshift('Windows readings are out of date. Retrying automatically.');
  byId('telemetry-warning').hidden = warnings.length === 0 || !['dashboard','hardware','storage'].includes(currentPage);
  byId('telemetry-warning').textContent = warnings.length ? warnings[0] + (warnings.length > 1 ? ' (' + (warnings.length - 1) + ' more)' : '') : '';
  byId('telemetry-warning').title = [...new Set(warnings)].join('\n');
  byId('live-state').textContent = warnings.length ? 'Partial' : 'Live';
  byId('live-state').dataset.state = warnings.length ? 'waiting' : 'live';
  byId('status').textContent = 'Updated ' + new Date(snapshot.sampledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  history.push(snapshot);
  renderChart();
  renderCores(snapshot.corePercents || []);
  if (snapshot.windowsReadAt !== lastWindowsReadAt || lastWindowsReadAt === null) {
    renderHardware(snapshot);
    lastWindowsReadAt = snapshot.windowsReadAt;
  }
}

async function refresh() {
  if (refreshing || stopped) return;
  refreshing = true;
  byId('refresh').disabled = true;
  try {
    renderSnapshot(await window.xerolag.system.getSnapshot());
    byId('error').hidden = true;
  } catch (error) {
    reportError(error);
    byId('status').textContent = 'Connection interrupted';
    byId('live-state').textContent = 'Offline';
    byId('live-state').dataset.state = 'waiting';
    for (const id of ['cpu', 'ram', 'gpu', 'vram', 'disk', 'process']) metric(id, null, '');
  } finally {
    refreshing = false;
    byId('refresh').disabled = false;
  }
}

function schedule() {
  clearTimeout(timer);
  if (stopped) return;
  timer = setTimeout(async () => {
    if (!document.hidden && ['dashboard','hardware','storage'].includes(currentPage)) await refresh();
    schedule();
  }, 3000);
}

async function initialize() {
  try {
    if (!window.xerolag) throw new Error('The application bridge is unavailable. Restart XeroLag.');
    document.addEventListener('xerolag:open-page',event=>{showPage(event.detail);if(['dashboard','hardware','storage'].includes(event.detail))void refresh();});
    const controls = window.xerolag.window;
    for (const [id, action] of [
      ['minimize', () => controls.minimize()], ['maximize', () => controls.toggleMaximize()], ['close', () => controls.close()]
    ]) byId(id).addEventListener('click', () => { action().catch(reportError); });
    const updateState = state => byId('maximize').setAttribute('aria-label', state.maximized ? 'Restore window' : 'Maximize');
    const unsubscribe = controls.onStateChanged(updateState);
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); unsubscribe(); }, { once: true });
    for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => {
      showPage(button.dataset.page);
      if (['dashboard','hardware','storage'].includes(currentPage)) void refresh();
    });
    for (const button of document.querySelectorAll('[data-chart]')) button.addEventListener('click', () => {
      selectedChart = button.dataset.chart;
      renderChart();
    });
    byId('refresh').addEventListener('click', () => {
      if (currentPage === 'profiles') document.dispatchEvent(new Event('xerolag:refresh-profiles'));
      else if(['dashboard','hardware','storage'].includes(currentPage))void refresh();
      else document.dispatchEvent(new Event('xerolag:refresh-module'));
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ['dashboard','hardware','storage'].includes(currentPage)) void refresh(); });
    document.addEventListener('xerolag:profiles-updated', () => { if (currentPage !== 'profiles') void refresh(); });
    updateState(await controls.getState());
    const info = await window.xerolag.app.getInfo();
    byId('version').textContent = 'v' + info.version;
    byId('access').textContent = info.administrator ? 'Administrator' : 'Standard user';
    details(byId('app-details'), [
      ['Version', info.version], ['Build', info.packaged ? 'Installed application' : 'Development'],
      ['Electron', info.electron], ['Chromium', info.chrome], ['Node.js', info.node]
    ]);
    showPage('dashboard', false);
    document.body.dataset.ready = 'true';
    await refresh();
    schedule();
  } catch (error) { reportError(error); }
}

void initialize();
