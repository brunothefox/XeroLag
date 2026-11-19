'use strict';

const { randomUUID } = require('node:crypto');
const { ProfileError } = require('./profile-state');

function createJobs() {
  const jobs = new Map();
  function start(label, runner, group = 'read') {
    if ([...jobs.values()].some(job => job.group === group && ['queued','running'].includes(job.status)) && group !== 'read') {
      throw new ProfileError('Another task in this category is running.', 'BUSY');
    }
    const job = { id: randomUUID(), label, group, status: 'queued', createdAt: new Date().toISOString(), log: [], progress: null, cancelled: false, cancel: null, result: null };
    jobs.set(job.id, job);
    for (const [id, old] of jobs) if (jobs.size > 40 && !['queued','running'].includes(old.status)) jobs.delete(id);
    const context = {
      log: value => { const lines = String(value).replace(/\r\n/g, '\n').split('\n'); job.log.push(...lines.map(line => line.slice(0, 2000))); if (job.log.length > 1500) job.log.splice(0, job.log.length - 1500); },
      update: value => { job.progress = value; },
      check: () => { if (job.cancelled) throw new ProfileError('Task cancelled.', 'CANCELLED'); },
      onCancel: callback => { job.cancel = callback; },
      get cancelled() { return job.cancelled; }
    };
    setImmediate(async () => {
      job.status = 'running';
      try { context.check(); job.result = await runner(context); job.status = job.cancelled ? 'cancelled' : 'completed'; }
      catch (error) { job.error = error.message; job.status = job.cancelled || error.code === 'CANCELLED' ? 'cancelled' : 'failed'; context.log(error.message); }
      finally { job.finishedAt = new Date().toISOString(); job.cancel = null; }
    });
    return { id: job.id };
  }
  function get(id) {
    const job = jobs.get(id);
    if (!job) throw new ProfileError('Task not found.', 'NOT_FOUND');
    const { cancel, cancelled, ...publicJob } = job;
    return structuredClone({...publicJob,cancellable:cancel!==false&&['queued','running'].includes(job.status)});
  }
  async function cancel(id) {
    const job = jobs.get(id);
    if (!job || !['queued','running'].includes(job.status)) throw new ProfileError('This task is not running.', 'NOT_FOUND');
    if(job.cancel===false)throw new ProfileError('This Windows repair must finish before the app can stop it.','NOT_CANCELLABLE');
    job.cancelled = true;
    if (job.cancel) await job.cancel();
    return { success: true };
  }
  return { start, get, cancel, list: () => [...jobs.values()].map(job => get(job.id)),
    isBusy: group => [...jobs.values()].some(job => ['queued','running'].includes(job.status) && (!group || job.group === group)) };
}

module.exports = { createJobs };
