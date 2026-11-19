'use strict';

const path = require('node:path');
const { runFile, windowsExecutable } = require('./command-runner');
const { validateState, ProfileError, GUID } = require('./profile-state');

function createProfileAdapter() {
  const script = path.join(__dirname, '..', 'powershell', 'profile-operations.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  async function execute(action, payload = {}, timeout = 30_000) {
    try {
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json, 'utf8') > 6000) throw new ProfileError('This backup is too large to restore safely.', 'INVALID_BACKUP');
      const result = await runFile(windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Action', action, '-PayloadBase64', Buffer.from(json, 'utf8').toString('base64')
      ], { timeout });
      return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      const detail = error.stderr?.trim() || error.message;
      throw new ProfileError(action === 'RestorePoint' ?
        'Windows could not create a restore point. Enable System Protection, or wait if Windows recently created another point. No profile changes were applied.' :
        'Windows could not complete the profile operation: ' + detail,
      action === 'RestorePoint' ? 'RESTORE_POINT_FAILED' : 'WINDOWS_OPERATION_FAILED');
    }
  }
  return {
    async read() {
      const system = await execute('Read');
      if (!GUID.test(system.identity?.machine) || typeof system.identity?.sid !== 'string' || system.identity.sid.length > 192 ||
          !/^S-\d+(?:-\d+)+$/.test(system.identity.sid) || typeof system.identity.administrator !== 'boolean' ||
          typeof system.identity.desktopMatch !== 'boolean' || !Array.isArray(system.plans) ||
          system.plans.some(plan => !GUID.test(plan.id) || typeof plan.name !== 'string')) {
        throw new ProfileError('Windows returned invalid profile information.', 'INVALID_SYSTEM_STATE');
      }
      system.state = validateState(system.state);
      return system;
    },
    async write(state, identity) { await execute('Write', { state: validateState(state), identity }); },
    async restorePoint(snapshotId, identity) {
      if (!GUID.test(snapshotId)) throw new ProfileError('Invalid backup identifier.', 'INVALID_BACKUP');
      const point = await execute('RestorePoint', { snapshotId, identity }, 180_000);
      if (!Number.isInteger(point.sequence) || !Number.isFinite(Date.parse(point.createdAt))) {
        throw new ProfileError('Windows did not confirm the restore point. No profile changes were applied.', 'RESTORE_POINT_FAILED');
      }
      return point;
    }
  };
}

module.exports = { createProfileAdapter };
