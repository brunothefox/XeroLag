'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicJson } = require('./snapshot-store');
const { runFile, windowsExecutable } = require('./command-runner');
const { ProfileError } = require('./profile-state');

function scriptFile(name) {
  if (!/^[a-z][a-z-]*\.ps1$/.test(name)) throw new TypeError('Invalid internal script name.');
  return path.join(__dirname, '..', 'powershell', name).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function createWindowsScript(directory) {
  async function request(payload) {
    const file = path.join(directory, 'requests', randomUUID() + '.json');
    await atomicJson(file, payload);
    return file;
  }
  async function run(name, action, payload = {}, options = {}) {
    let file;
    try {
      if (!/^[a-zA-Z]+$/.test(action)) throw new TypeError('Invalid internal operation.');
      file = await request(payload);
      const result = await runFile(windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile(name),
        '-Action', action, '-PayloadPath', file
      ], { timeout: options.timeout ?? 60_000, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024 });
      if (options.text) return result.stdout;
      return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      throw new ProfileError(error.stderr?.trim() || error.message || 'Windows could not complete the operation.', 'WINDOWS_OPERATION_FAILED');
    } finally {
      if (file) await fs.unlink(file).catch(() => {});
    }
  }
  return { run, request, scriptFile };
}

module.exports = { createWindowsScript, scriptFile };
