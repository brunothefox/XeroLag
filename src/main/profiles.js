'use strict';

const { settings, profiles } = require('./profile-catalog.json');
const { createSnapshotStore } = require('./snapshot-store');
const { createProfileAdapter } = require('./profile-adapter');
const { ProfileError, validateState, sameState, assertIdentity, resolveProfile } = require('./profile-state');

function displayValue(entry) {
  if (!entry.exists) return 'Not set';
  if (entry.kind === 'Binary' || entry.kind === 'None') return 'Binary value';
  if (Array.isArray(entry.value)) return entry.value.join(', ');
  return String(entry.value);
}

function createProfiles({ directory, administrator, logger, adapter = createProfileAdapter(), store = createSnapshotStore(directory), onChange = async () => {} }) {
  let busy = false;
  let cachedStatus = null;
  let pendingStatus = null;

  function assertCanMutate(system) {
    if (!administrator || !system.identity.administrator) throw new ProfileError('Restart XeroLag as administrator before changing profiles.', 'ADMIN_REQUIRED');
    if (!system.identity.desktopMatch) throw new ProfileError('Run XeroLag as the Windows user who owns this desktop. Per-user settings cannot be applied to another account.', 'DESKTOP_USER_MISMATCH');
  }

  async function exclusive(action) {
    if (busy) throw new ProfileError('Another profile operation is still running. Wait for it to finish.', 'BUSY');
    busy = true;
    try {
      if (pendingStatus) await pendingStatus.catch(() => {});
      return await action();
    }
    finally { busy = false; cachedStatus = null; }
  }

  async function ensureBackup(system, loaded) {
    if (loaded && loaded.session.phase !== 'reverted') {
      assertIdentity(loaded.backup.identity, system.identity);
      return loaded;
    }
    return store.create(system);
  }

  async function ensureRestorePoint(loaded, system) {
    const point = await adapter.restorePoint(loaded.backup.id, system.identity);
    loaded.session.restorePoint = point;
    await store.saveSession(loaded.session);
  }

  async function status() {
    if (busy && cachedStatus) return { ...cachedStatus, busy: true };
    if (pendingStatus) return pendingStatus;
    if (busy) throw new ProfileError('A profile operation is still running.', 'BUSY');
    pendingStatus = (async () => {
      const [system, loaded] = await Promise.all([adapter.read(), store.load()]);
      if (loaded) assertIdentity(loaded.backup.identity, system.identity);
      const current = validateState(system.state);
      const session = loaded?.session;
      const recovery = Boolean(session && ['applying', 'restoring', 'recovery-required'].includes(session.phase));
      const active = session && session.phase !== 'reverted' ? session.activeProfile : null;
      const baseline = loaded && session.phase !== 'reverted' ? loaded.backup.original : current;
      const blocked = !administrator || !system.identity.administrator ? 'Administrator access required' :
        !system.identity.desktopMatch ? 'Desktop user does not match this account' : recovery ? 'Restore your backup before applying another profile' : null;
      const choices = profiles.map(profile => {
        try {
          const { plan, target } = resolveProfile(profile.id, system, baseline);
          return {
            id: profile.id, name: profile.name, icon: profile.icon, available: !blocked, reason: blocked,
            powerPlan: plan.name,
            changes: [{ label: 'Power plan', before: system.plans.find(plan => plan.id === current.powerPlan)?.name || current.powerPlan, after: plan.name },
              ...settings.map((setting, index) => ({ label: setting.label, before: displayValue(current.registry[index]), after: displayValue(target.registry[index]) }))]
          };
        } catch (error) {
          if (!(error instanceof ProfileError)) throw error;
          return { id: profile.id, name: profile.name, icon: profile.icon, available: false, reason: error.message, powerPlan: null, changes: [] };
        }
      });
      let drifted = false;
      if (active && !recovery) {
        try { drifted = !sameState(current, resolveProfile(active, system, baseline).target); }
        catch { drifted = true; }
      }
      cachedStatus = {
        busy, recovery, blocked, drifted, activeProfile: active,
        canRevert: Boolean(administrator && system.identity.administrator && system.identity.desktopMatch && loaded && session.phase !== 'reverted'),
        currentPlan: system.plans.find(plan => plan.id === current.powerPlan)?.name || current.powerPlan,
        profiles: choices,
        backup: loaded ? {
          id: loaded.backup.id, createdAt: loaded.backup.createdAt, phase: session.phase,
          restorePoint: session.restorePoint, lastError: session.lastError,
          file: store.snapshotFile(loaded.backup.id),
          originalPlan: system.plans.find(plan => plan.id === loaded.backup.original.powerPlan)?.name || loaded.backup.original.powerPlan,
          settings: settings.map((setting, index) => ({ label: setting.label, original: displayValue(loaded.backup.original.registry[index]),
            current: displayValue(current.registry[index]), kind: loaded.backup.original.registry[index].kind || 'Absent' }))
        } : null
      };
      return cachedStatus;
    })().finally(() => { pendingStatus = null; });
    return pendingStatus;
  }

  async function snapshot() {
    await exclusive(async () => {
      const system = await adapter.read();
      assertCanMutate(system);
      const existing = await store.load();
      if (existing && ['applying', 'restoring', 'recovery-required'].includes(existing.session.phase)) {
        throw new ProfileError('Restore the saved settings before creating another snapshot.', 'RECOVERY_REQUIRED');
      }
      const loaded = await ensureBackup(system, existing);
      await ensureRestorePoint(loaded, system);
      await logger.info('Safety snapshot ready: ' + loaded.backup.id);
    });
    return status();
  }

  async function transact(profileId, restoring) {
    await exclusive(async () => {
      const system = await adapter.read();
      assertCanMutate(system);
      let loaded = await store.load();
      if (restoring) {
        if (!loaded || loaded.session.phase === 'reverted') throw new ProfileError('There are no saved profile changes to revert.', 'NO_BACKUP');
        assertIdentity(loaded.backup.identity, system.identity);
      } else {
        if (!profiles.some(profile => profile.id === profileId)) throw new ProfileError('Unknown profile.', 'INVALID_PROFILE');
        if (loaded && ['applying', 'restoring', 'recovery-required'].includes(loaded.session.phase)) {
          throw new ProfileError('An earlier operation was interrupted. Restore your backup before applying another profile.', 'RECOVERY_REQUIRED');
        }
        // Validate availability before creating a backup or restore point.
        resolveProfile(profileId, system, loaded && loaded.session.phase !== 'reverted' ? loaded.backup.original : system.state);
        loaded = await ensureBackup(system, loaded);
        await ensureRestorePoint(loaded, system);
      }
      const target = restoring ? validateState(loaded.backup.original) : resolveProfile(profileId, system, loaded.backup.original).target;
      if (!system.plans.some(plan => plan.id.toLowerCase() === target.powerPlan)) {
        throw new ProfileError('The saved power plan is no longer installed. Restore that plan before reverting.', 'MISSING_POWER_PLAN');
      }
      const immediatelyBefore = await adapter.read();
      assertIdentity(system.identity, immediatelyBefore.identity);
      assertCanMutate(immediatelyBefore);
      const before = validateState(immediatelyBefore.state);
      const previousSession = structuredClone(loaded.session);
      const transaction = await store.journal({ snapshotId: loaded.backup.id, identity: system.identity,
        action: restoring ? 'revert' : profileId, before, target });
      loaded.session.phase = restoring ? 'restoring' : 'applying';
      loaded.session.pendingTransaction = transaction;
      loaded.session.lastError = null;
      await store.saveSession(loaded.session);
      try {
        await adapter.write(target, system.identity);
        const verified = await adapter.read();
        assertIdentity(system.identity, verified.identity);
        if (!sameState(verified.state, target)) throw new ProfileError('Windows did not keep all requested settings.', 'VERIFICATION_FAILED');
        loaded.session.phase = restoring ? 'reverted' : 'active';
        loaded.session.activeProfile = restoring ? null : profileId;
        loaded.session.pendingTransaction = null;
        loaded.session.lastTransaction = transaction;
        loaded.session.lastError = null;
        await store.saveSession(loaded.session);
        await logger.info((restoring ? 'Restored original settings' : 'Applied profile ' + profileId) + '; snapshot ' + loaded.backup.id);
      } catch (error) {
        await logger.error('Profile operation failed: ' + error.message);
        let rolledBack = false;
        try {
          await adapter.write(before, system.identity);
          const verified = await adapter.read();
          assertIdentity(system.identity, verified.identity);
          if (!sameState(verified.state, before)) throw new Error('Rollback verification failed.');
          rolledBack = true;
        } catch (rollbackError) {
          await logger.error('Profile rollback failed: ' + rollbackError.message);
        }
        const message = rolledBack ? 'The operation failed. Your previous settings were restored.' :
          'Some changes could not be reverted automatically. Use Revert all to restore the original backup.';
        const recoverySession = rolledBack ? previousSession : loaded.session;
        if (!rolledBack) recoverySession.phase = 'recovery-required';
        recoverySession.pendingTransaction = rolledBack ? null : transaction;
        recoverySession.lastError = message;
        try { await store.saveSession(recoverySession); }
        catch (saveError) { await logger.error(saveError.message); }
        throw new ProfileError(message, rolledBack ? 'ROLLED_BACK' : 'RECOVERY_REQUIRED');
      }
      try { await onChange(); } catch (error) { await logger.error('Profile applied; telemetry refresh failed: ' + error.message); }
    });
    return status();
  }

  return { status, snapshot, apply: id => transact(id, false), revert: () => transact(null, true),
    isBusy: () => busy, backupDirectory: store.directory };
}

module.exports = { createProfiles };
