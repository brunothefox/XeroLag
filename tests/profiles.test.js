'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createProfiles } = require('../src/main/profiles');
const { createSnapshotStore } = require('../src/main/snapshot-store');
const { sameState, validateState } = require('../src/main/profile-state');
const { createFakeProfileAdapter } = require('./fixtures/profile-system');

async function fixture(t) {
  const testRoot = path.resolve(__dirname, '..', '.cache', 'tests', 'profile-tests');
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'case-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(testRoot + path.sep) || !path.basename(resolved).startsWith('case-')) throw new Error('Invalid test cleanup path.');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const adapter = createFakeProfileAdapter();
  const store = createSnapshotStore(directory);
  const logger = { info: async () => {}, error: async () => {} };
  const service = createProfiles({ directory, administrator: true, adapter, store, logger });
  return { directory, adapter, store, service, logger };
}

test('profiles preserve original settings across switches and restore exact registry types', async t => {
  const { adapter, store, service } = await fixture(t);
  adapter.system.state.registry[0] = { id: 'gameMode', keyExists: false, exists: false, kind: null, value: null };
  const original = structuredClone(adapter.system.state);
  await service.apply('competitive');
  assert.equal(adapter.system.state.registry.find(entry => entry.id === 'mouseSpeed').value, '0');
  const first = await store.load();
  await service.apply('quiet');
  assert.equal(adapter.system.state.registry.find(entry => entry.id === 'mouseSpeed').value, '1');
  assert.equal((await store.load()).backup.id, first.backup.id);
  await service.revert();
  assert.equal(sameState(adapter.system.state, original), true);
  assert.equal((await store.load()).session.phase, 'reverted');
  assert.equal(adapter.system.state.registry[0].exists, false);
});

test('restore point failure blocks every profile write but retains the original JSON backup', async t => {
  const { adapter, store, service } = await fixture(t);
  adapter.controls.failPoint = true;
  await assert.rejects(service.apply('gaming'), /System Protection/);
  assert.equal(adapter.controls.writes, 0);
  const loaded = await store.load();
  assert.equal(loaded.session.phase, 'ready');
  assert.equal(sameState(loaded.backup.original, adapter.system.state), true);
});

test('partial apply failure rolls back to the immediately previous settings', async t => {
  const { adapter, store, service } = await fixture(t);
  await service.apply('gaming');
  const before = structuredClone(adapter.system.state);
  adapter.controls.failWrites = 1;
  await assert.rejects(service.apply('competitive'), /previous settings were restored/);
  assert.equal(sameState(adapter.system.state, before), true);
  assert.equal((await store.load()).session.activeProfile, 'gaming');
});

test('failed rollback exposes recovery and allows reversion without a new restore point', async t => {
  const { adapter, store, service } = await fixture(t);
  const original = structuredClone(adapter.system.state);
  adapter.controls.failWrites = 2;
  await assert.rejects(service.apply('competitive'), /Revert all/);
  assert.equal((await service.status()).recovery, true);
  await assert.rejects(service.apply('quiet'), /interrupted/);
  const pointCount = adapter.controls.points;
  adapter.controls.failPoint = true;
  await service.revert();
  assert.equal(adapter.controls.points, pointCount);
  assert.equal(sameState(adapter.system.state, original), true);
  assert.equal((await store.load()).session.phase, 'reverted');
});

test('interrupted transactions survive restart and keep their original snapshot', async t => {
  const { directory, adapter, store, service, logger } = await fixture(t);
  await service.apply('competitive');
  const loaded = await store.load();
  loaded.session.phase = 'applying';
  await store.saveSession(loaded.session);
  const restarted = createProfiles({ directory, adapter, store, logger, administrator: true });
  assert.equal((await restarted.status()).recovery, true);
  await assert.rejects(restarted.snapshot(), /Restore/);
  await restarted.revert();
  assert.equal((await store.load()).backup.id, loaded.backup.id);
  assert.equal(sameState(adapter.system.state, loaded.backup.original), true);
});

test('corrupted backup data cannot drive elevated writes', async t => {
  const { adapter, store, service } = await fixture(t);
  await service.snapshot();
  const { backup } = await store.load();
  const file = store.snapshotFile(backup.id);
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  envelope.data.original.registry[0].value = 99;
  await fs.writeFile(file, JSON.stringify(envelope), 'utf8');
  await assert.rejects(service.revert(), /integrity/);
  assert.equal(adapter.controls.writes, 0);
});

test('foreign-user backups and mismatched desktop identities are blocked', async t => {
  const { adapter, service } = await fixture(t);
  await service.snapshot();
  adapter.system.identity.sid = 'S-1-5-21-1000';
  await assert.rejects(service.apply('gaming'), /another Windows/);
  adapter.system.identity.desktopMatch = false;
  await assert.rejects(service.revert(), /owns this desktop/);
  assert.equal(adapter.controls.writes, 0);
});

test('unsupported plans and unknown profiles never mutate Windows or create a snapshot', async t => {
  const { adapter, store, service } = await fixture(t);
  adapter.system.plans = adapter.system.plans.slice(0, 1);
  assert.equal((await service.status()).profiles.find(profile => profile.id === 'gaming').available, false);
  await assert.rejects(service.apply('gaming'), /not available/);
  await assert.rejects(service.apply('..\\invalid'), /Unknown/);
  assert.equal(await store.load(), null);
  assert.equal(adapter.controls.writes, 0);
});

test('concurrent mutations are rejected and the durable journal exists before the first write', async t => {
  const { adapter, store, service, directory } = await fixture(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  adapter.controls.beforeWrite = async () => {
    const loaded = await store.load();
    assert.equal(loaded.session.phase, 'applying');
    assert.ok(loaded.session.pendingTransaction);
    assert.ok((await fs.stat(path.join(directory, 'transactions', loaded.session.pendingTransaction + '.json'))).isFile());
    entered();
    await new Promise(resolve => { release = resolve; });
  };
  const operation = service.apply('gaming');
  await started;
  await assert.rejects(service.apply('quiet'), /still running/);
  assert.equal(service.isBusy(), true);
  release();
  await operation;
  assert.equal(service.isBusy(), false);
});

test('registry snapshots preserve typed values and reject unknown IDs and oversize data', async t => {
  const { adapter } = await fixture(t);
  const state = structuredClone(adapter.system.state);
  state.registry[0] = { id: 'gameMode', keyExists: true, exists: true, kind: 'QWord', value: '9223372036854775807' };
  assert.equal(validateState(state).registry[0].value, '9223372036854775807');
  state.registry[0].value = '9223372036854775808';
  assert.throws(() => validateState(state), /cannot be backed up/);
  state.registry[0].id = 'arbitrary-path';
  assert.throws(() => validateState(state), /invalid/);
});

test('backup persistence failure prevents registry and power plan writes', async t => {
  const { adapter, service, store } = await fixture(t);
  store.saveSession = async () => { throw new Error('Disk full'); };
  await assert.rejects(service.apply('gaming'), /Disk full/);
  assert.equal(adapter.controls.writes, 0);
});

test('verification detects silently ignored settings and rolls back', async t => {
  const { adapter, service } = await fixture(t);
  const original = structuredClone(adapter.system.state);
  const write = adapter.write;
  let first = true;
  adapter.write = async (...args) => { if (first) { first = false; return; } await write(...args); };
  await assert.rejects(service.apply('competitive'), /previous settings were restored/);
  assert.equal(sameState(original, adapter.system.state), true);
});

test('a removed original power plan blocks reversion before any partial restore', async t => {
  const { adapter, service, store } = await fixture(t);
  await service.apply('gaming');
  const originalId = (await store.load()).backup.original.powerPlan;
  adapter.system.plans = adapter.system.plans.filter(plan => plan.id !== originalId);
  const writes = adapter.controls.writes;
  await assert.rejects(service.revert(), /no longer installed/);
  assert.equal(adapter.controls.writes, writes);
});

test('standard-user tokens cannot create a baseline or change profiles', async t => {
  const { adapter, service, store } = await fixture(t);
  adapter.system.identity.administrator = false;
  await assert.rejects(service.apply('gaming'), /administrator/);
  await assert.rejects(service.snapshot(), /administrator/);
  assert.equal(await store.load(), null);
  assert.equal(adapter.controls.writes, 0);
});

test('combined backup size is checked before command-line serialization', async t => {
  const { adapter, service, store } = await fixture(t);
  for (const entry of adapter.system.state.registry) { entry.kind = 'String'; entry.value = '\u0000'.repeat(700); }
  await assert.rejects(service.apply('gaming'), /too large/);
  assert.equal(await store.load(), null);
  assert.equal(adapter.controls.writes, 0);
});
