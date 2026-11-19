'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { GUID, STATES, ProfileError, validateState } = require('./profile-state');

async function atomicJson(file, data) {
  const temporary = file + '.tmp-' + randomUUID();
  let handle;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    const failure = new ProfileError('The safety backup could not be saved. Check available space and folder permissions.', 'BACKUP_WRITE_FAILED');
    failure.cause = error;
    throw failure;
  }
}

function digest(data) { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }

function createSnapshotStore(directory) {
  const currentFile = path.join(directory, 'current.json');
  async function read(file, optional = false) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid file.');
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw new ProfileError('The safety backup is missing or damaged. Restore the original backup files before continuing.', 'INVALID_BACKUP');
    }
  }
  async function load() {
    const session = await read(currentFile, true);
    if (!session) return null;
    if (session.schema !== 1 || !GUID.test(session.snapshotId) || !STATES.has(session.phase) ||
        (session.activeProfile !== null && !['gaming', 'competitive', 'quiet'].includes(session.activeProfile))) {
      throw new ProfileError('The recovery record is invalid. No changes were made.', 'INVALID_BACKUP');
    }
    const envelope = await read(path.join(directory, 'snapshots', session.snapshotId + '.json'));
    const backup = envelope?.data;
    if (!backup || envelope.sha256 !== digest(backup) || backup.schema !== 1 || backup.id !== session.snapshotId ||
        typeof backup.identity?.machine !== 'string' || typeof backup.identity?.sid !== 'string' || !Number.isFinite(Date.parse(backup.createdAt))) {
      throw new ProfileError('The original backup failed its integrity check. No changes were made.', 'INVALID_BACKUP');
    }
    backup.original = validateState(backup.original);
    return { session, backup };
  }
  async function create(system) {
    const backup = { schema: 1, id: randomUUID(), createdAt: new Date().toISOString(), identity: system.identity, original: validateState(system.state), services: [] };
    await atomicJson(path.join(directory, 'snapshots', backup.id + '.json'), { data: backup, sha256: digest(backup) });
    const session = { schema: 1, snapshotId: backup.id, phase: 'ready', activeProfile: null, restorePoint: null, pendingTransaction: null, updatedAt: backup.createdAt, lastError: null };
    await atomicJson(currentFile, session);
    return { backup, session };
  }
  async function saveSession(session) { await atomicJson(currentFile, { ...session, updatedAt: new Date().toISOString() }); }
  async function journal(data) {
    const id = randomUUID();
    await atomicJson(path.join(directory, 'transactions', id + '.json'), { schema: 1, id, createdAt: new Date().toISOString(), ...data });
    return id;
  }
  return { load, create, saveSession, journal, directory, snapshotFile: id => {
    if (!GUID.test(id)) throw new ProfileError('Invalid backup identifier.', 'INVALID_BACKUP');
    return path.join(directory, 'snapshots', id + '.json');
  } };
}

module.exports = { createSnapshotStore, atomicJson };
