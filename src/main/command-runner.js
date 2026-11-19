'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

class CommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CommandError';
    Object.assign(this, details);
  }
}

// Main-process utility only. Never expose executable names or scripts through IPC.
function runFile(executable, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    try {
      if (!path.isAbsolute(executable)) throw new TypeError('Executable must have an absolute path.');
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
        throw new TypeError('Arguments must be strings without null characters.');
      }
      const timeout = options.timeout ?? 30_000;
      const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 7_200_000) {
        throw new RangeError('Command timeout must be between 1 ms and two hours.');
      }
      if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 64 * 1024 * 1024) {
        throw new RangeError('Invalid command output limit.');
      }
      execFile(executable, args, {
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        timeout,
        maxBuffer,
        cwd: options.cwd,
        env: options.env ?? process.env
      }, (error, stdout, stderr) => {
        try {
          if (error) {
            reject(new CommandError(error.killed ? 'Command timed out or exceeded its output limit.' : 'Command failed.', {
              code: error.code, killed: Boolean(error.killed), stdout, stderr
            }));
            return;
          }
          resolve({ stdout, stderr });
        } catch (callbackError) {
          reject(callbackError);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function windowsExecutable(relativePath) {
  if (process.platform !== 'win32') throw new Error('This operation requires Windows.');
  const root = process.env.SystemRoot;
  if (!root || !path.isAbsolute(root)) throw new Error('Windows system directory is unavailable.');
  return path.join(root, 'System32', relativePath);
}

async function runPowerShell(script, options = {}) {
  try {
    if (typeof script !== 'string' || !script.trim()) throw new TypeError('A PowerShell script is required.');
    const wrapped = [
      "$ErrorActionPreference = 'Stop'",
      '$ProgressPreference = \'SilentlyContinue\'',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      'try {', script,
      '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
    ].join('\n');
    return await runFile(windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(wrapped, 'utf16le').toString('base64')
    ], options);
  } catch (error) {
    throw error;
  }
}

module.exports = { CommandError, runFile, runPowerShell, windowsExecutable };
