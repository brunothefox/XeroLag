'use strict';

const { settings, profiles } = require('./profile-catalog.json');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['ready', 'active', 'applying', 'restoring', 'reverted', 'recovery-required']);

class ProfileError extends Error {
  constructor(message, code = 'PROFILE_ERROR') { super(message); this.name = 'ProfileError'; this.code = code; }
}

function validateRegistry(entry) {
  if (!entry || !settings.some(setting => setting.id === entry.id) || typeof entry.keyExists !== 'boolean' || typeof entry.exists !== 'boolean') {
    throw new ProfileError('The saved registry state is invalid. No changes were made.', 'INVALID_BACKUP');
  }
  if (!entry.exists) return { id: entry.id, keyExists: entry.keyExists, exists: false, kind: null, value: null };
  const value = entry.value;
  const valid = {
    String: () => typeof value === 'string' && value.length <= 1024,
    ExpandString: () => typeof value === 'string' && value.length <= 1024,
    DWord: () => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647,
    QWord: () => typeof value === 'string' && /^-?\d{1,19}$/.test(value) && BigInt(value) >= -(2n ** 63n) && BigInt(value) < 2n ** 63n,
    Binary: () => typeof value === 'string' && value.length <= 1024 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    None: () => typeof value === 'string' && value.length <= 1024 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    MultiString: () => Array.isArray(value) && value.length <= 16 && value.every(item => typeof item === 'string' && item.length <= 128)
  };
  if (!Object.hasOwn(valid, entry.kind) || !valid[entry.kind]()) throw new ProfileError('An original registry value cannot be backed up safely. No changes were made.', 'INVALID_BACKUP');
  return { id: entry.id, keyExists: entry.keyExists, exists: true, kind: entry.kind, value: structuredClone(value) };
}

function validateState(state) {
  if (!state || !GUID.test(state.powerPlan) || !Array.isArray(state.registry) || state.registry.length !== settings.length) {
    throw new ProfileError('The saved system state is invalid. No changes were made.', 'INVALID_BACKUP');
  }
  const registry = state.registry.map(validateRegistry);
  if (new Set(registry.map(entry => entry.id)).size !== settings.length) throw new ProfileError('The backup has duplicate or missing settings.', 'INVALID_BACKUP');
  const normalized = { powerPlan: state.powerPlan.toLowerCase(), registry: settings.map(setting => registry.find(entry => entry.id === setting.id)) };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 4500) {
    throw new ProfileError('The original settings are too large to back up and restore safely. No changes were made.', 'INVALID_BACKUP');
  }
  return normalized;
}

function sameState(actual, expected) {
  const one = validateState(actual);
  const two = validateState(expected);
  return one.powerPlan === two.powerPlan && one.registry.every((entry, index) => {
    const other = two.registry[index];
    return entry.exists === other.exists && (!entry.exists || entry.kind === other.kind && JSON.stringify(entry.value) === JSON.stringify(other.value));
  });
}

function assertIdentity(one, two) {
  if (!one || !two || one.machine !== two.machine || one.sid !== two.sid) {
    throw new ProfileError('This backup belongs to another Windows installation or user. No settings were changed.', 'IDENTITY_MISMATCH');
  }
}

function resolveProfile(id, system, original) {
  const profile = profiles.find(item => item.id === id);
  if (!profile) throw new ProfileError('Unknown profile.', 'INVALID_PROFILE');
  const plan = profile.powerPlans.map(id => system.plans.find(plan => plan.id.toLowerCase() === id)).find(Boolean);
  if (!plan) throw new ProfileError('This profile needs a power plan that is not available on this PC.', 'UNSUPPORTED_PROFILE');
  const target = validateState(original);
  target.powerPlan = plan.id.toLowerCase();
  target.registry = target.registry.map(entry => Object.hasOwn(profile.settings, entry.id) ?
    { id: entry.id, keyExists: true, exists: true, ...profile.settings[entry.id] } : entry);
  return { profile, plan, target };
}

module.exports = { GUID, STATES, ProfileError, validateRegistry, validateState, sameState, assertIdentity, resolveProfile };
