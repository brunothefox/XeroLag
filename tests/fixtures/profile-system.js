'use strict';

const { settings } = require('../../src/main/profile-catalog.json');

function createFakeProfileAdapter() {
  const system = {
    identity: { machine: 'test-windows-installation', sid: 'S-1-5-21-123-456-789-1001', administrator: true, desktopMatch: true },
    plans: [
      { id: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced' },
      { id: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', name: 'High performance' },
      { id: 'e9a42b02-d5df-448d-aa00-03f14749eb61', name: 'Ultimate Performance' }
    ],
    state: {
      powerPlan: '381b4222-f694-41f0-9685-ff5bb260df2e',
      registry: settings.map(setting => ({ id: setting.id, keyExists: true, exists: true,
        kind: setting.id === 'gameMode' ? 'DWord' : 'String',
        value: ({ gameMode: 0, mouseSpeed: '1', mouseThreshold1: '6', mouseThreshold2: '10', keyboardDelay: '1', keyboardSpeed: '20' })[setting.id] }))
    }
  };
  const controls = { writes: 0, points: 0, failPoint: false, failWrites: 0, beforeWrite: null };
  return {
    system, controls,
    read: async () => structuredClone(system),
    write: async target => {
      controls.writes++;
      if (controls.beforeWrite) await controls.beforeWrite();
      if (controls.failWrites > 0) {
        controls.failWrites--;
        system.state.registry[0] = structuredClone(target.registry[0]);
        throw new Error('Simulated partial Windows failure');
      }
      system.state = structuredClone(target);
    },
    restorePoint: async () => {
      controls.points++;
      if (controls.failPoint) throw new Error('System Protection is unavailable');
      return { sequence: 42, createdAt: new Date().toISOString(), reused: controls.points > 1 };
    }
  };
}

module.exports = { createFakeProfileAdapter };
