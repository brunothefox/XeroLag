'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runFile, runPowerShell } = require('../src/main/command-runner');
const { quoteWindowsArgument, powerShellLiteral, isAdministrator } = require('../src/main/elevation');
const { assertTrustedSender, registerIpc } = require('../src/main/ipc');

test('commands preserve literal arguments instead of invoking a shell', async () => {
  const literal = 'a & echo injected; $(Get-Process) "quoted"';
  const { stdout } = await runFile(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(stdout, literal);
});

test('commands reject relative executables and invalid input', async () => {
  await assert.rejects(runFile('powershell.exe'), /absolute path/);
  await assert.rejects(runFile(process.execPath, ['\0']), /null characters/);
  await assert.rejects(runFile(process.execPath, [], { timeout: 0 }), /timeout/);
});

test('failed commands retain diagnostics', async () => {
  await assert.rejects(runFile(process.execPath, ['-e', 'process.stderr.write("failed");process.exit(7)']),
    error => error.code === 7 && error.stderr === 'failed');
});

test('commands enforce timeouts and output bounds', async () => {
  await assert.rejects(runFile(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 100 }),
    error => error.killed === true);
  await assert.rejects(runFile(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192))'], { maxBuffer: 1024 }),
    error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});

test('elevation quotes apostrophes, embedded quotes, and trailing backslashes', () => {
  assert.equal(powerShellLiteral("F:\\O'Brien\\app"), "'F:\\O''Brien\\app'");
  assert.equal(quoteWindowsArgument('F:\\my app\\'), '"F:\\my app\\\\"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
});

test('IPC requires the exact window, main frame, and document URL', () => {
  const frame = { url: 'file:///F:/XeroLag/src/renderer/index.html' };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => assertTrustedSender(event, window, frame.url));
  assert.throws(() => assertTrustedSender({ ...event, sender: {} }, window, frame.url), /Untrusted/);
  assert.throws(() => assertTrustedSender({ ...event, senderFrame: { ...frame } }, window, frame.url), /Untrusted/);
  assert.throws(() => assertTrustedSender(event, window, 'https://example.com/'), /Untrusted/);
});

test('IPC rejects unexpected arguments and unregisters handlers', async () => {
  const handlers = new Map();
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  const dispose = registerIpc({
    ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key) },
    window, entryUrl: frame.url, app: { getName: () => 'XeroLag', getVersion: () => '0.1.0', isPackaged: false },
    administrator: true, logger: { error: async () => {} }
  });
  const event = { sender: contents, senderFrame: frame };
  assert.equal((await handlers.get('app:info')(event)).data.administrator, true);
  assert.equal((await handlers.get('app:info')(event, 'unexpected')).ok, false);
  dispose();
  assert.equal(handlers.size, 0);
});

test('PowerShell returns UTF-8 and converts errors to failed commands', { skip: process.platform !== 'win32' }, async () => {
  const { stdout } = await runPowerShell("[Console]::Write('caf' + [char]0xE9)");
  assert.equal(stdout, 'café');
  await assert.rejects(runPowerShell("throw 'test error'"), error => error.stderr.includes('test error'));
});

test('administrator check returns a boolean without requesting elevation', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(typeof await isAdministrator(), 'boolean');
});

test('profile IPC accepts only named profiles and blocks closing during a transaction', async () => {
  const handlers = new Map();
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  let calls = 0;
  const dispose = registerIpc({
    ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key) },
    window, entryUrl: frame.url, app: { getName: () => 'XeroLag', getVersion: () => '0.1.0', isPackaged: false },
    administrator: true, logger: { error: async () => {} }, profiles: {
      status: async () => ({}), snapshot: async () => ({}), revert: async () => ({}),
      apply: async id => { calls++; return id; }, isBusy: () => true
    }
  });
  const event = { sender: contents, senderFrame: frame };
  assert.equal((await handlers.get('profiles:apply')(event, 'gaming')).data, 'gaming');
  assert.equal((await handlers.get('profiles:apply')(event, 'powershell.exe')).code, 'INVALID_PROFILE');
  assert.equal((await handlers.get('profiles:apply')(event, 'quiet', 'extra')).ok, false);
  assert.equal((await handlers.get('profiles:revert')(event, 'path')).ok, false);
  assert.equal((await handlers.get('profiles:apply')({ ...event, senderFrame: {} }, 'quiet')).ok, false);
  assert.equal((await handlers.get('window:close')(event)).code, 'BUSY');
  assert.equal(calls, 1);
  dispose();
});
