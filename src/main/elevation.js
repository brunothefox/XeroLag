'use strict';

const { runPowerShell } = require('./command-runner');

function powerShellLiteral(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Invalid PowerShell literal.');
  return "'" + value.replace(/'/g, "''") + "'";
}

function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Invalid process argument.');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

async function isAdministrator() {
  try {
    const { stdout } = await runPowerShell([
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '$principal = New-Object Security.Principal.WindowsPrincipal($identity)',
      '$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ].join('\n'));
    const result = stdout.trim().toLowerCase();
    if (result !== 'true' && result !== 'false') throw new Error('Unexpected administrator check result.');
    return result === 'true';
  } catch (error) {
    throw new Error('Unable to verify Windows administrator privileges.', { cause: error });
  }
}

async function requestElevation(app) {
  try {
    const args = app.isPackaged ? ['--xerolag-elevated'] : [app.getAppPath(), '--xerolag-elevated'];
    const argumentLine = args.map(quoteWindowsArgument).join(' ');
    await runPowerShell([
      `Start-Process -FilePath ${powerShellLiteral(process.execPath)} ` +
        `-ArgumentList ${powerShellLiteral(argumentLine)} ` +
        `-WorkingDirectory ${powerShellLiteral(app.getAppPath())} -WindowStyle Hidden -Verb RunAs -ErrorAction Stop | Out-Null`
    ].join('\n'), { timeout: 120_000 });
  } catch (error) {
    throw new Error('Administrator access was cancelled or Windows could not start the elevated app.', { cause: error });
  }
}

module.exports = { isAdministrator, requestElevation, powerShellLiteral, quoteWindowsArgument };
