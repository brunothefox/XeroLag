'use strict';

const { ProfileError } = require('./profile-state');

function assertTrustedSender(event, window, entryUrl) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      !event.senderFrame || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== entryUrl) {
    throw new Error('Untrusted application request.');
  }
}

function registerIpc({ ipcMain, window, entryUrl, app, administrator, logger, telemetry, profiles, openBackups, openProtection, workbench }) {
  const channels = [];
  function handle(channel, action, validate = args => {
    if (args.length !== 0) throw new Error('This operation does not accept arguments.');
    return [];
  }) {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        assertTrustedSender(event, window, entryUrl);
        const checked = validate(args);
        return { ok: true, data: await action(...checked) };
      } catch (error) {
        await logger.error(`${channel}: ${error.message}`);
        return { ok: false, error: error instanceof ProfileError ? error.message : 'The application request could not be completed.',
          code: error instanceof ProfileError ? error.code : 'REQUEST_FAILED' };
      }
    });
  }
  handle('app:info', () => ({
    name: app.getName(), version: app.getVersion(), administrator,
    packaged: app.isPackaged, platform: process.platform,
    electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node
  }));
  if (telemetry) handle('system:snapshot', () => telemetry.getSnapshot());
  if (profiles) {
    handle('profiles:status', () => profiles.status());
    const guard=()=>{if(workbench&&(workbench.isBusy()||workbench.isBoosterRunning()))throw new ProfileError('Finish the current task or stop the booster before changing profiles.','BUSY');};
    handle('profiles:snapshot', () => {guard();return profiles.snapshot();});
    handle('profiles:revert', () => {guard();return profiles.revert();});
    handle('profiles:apply', id => {guard();return profiles.apply(id);}, args => {
      if (args.length !== 1 || !['gaming', 'competitive', 'quiet'].includes(args[0])) throw new ProfileError('Unknown profile.', 'INVALID_PROFILE');
      return args;
    });
    if (openBackups) handle('profiles:open-backups', openBackups);
    if (openProtection) handle('profiles:open-protection', openProtection);
  }
  if(workbench)handle('workbench:call',(method,args)=>workbench.call(method,args),args=>{
    if(args.length!==2||typeof args[0]!=='string'||!args[1]||typeof args[1]!=='object'||Array.isArray(args[1]))throw new ProfileError('Invalid module request.','INVALID_REQUEST');
    return args;
  });
  handle('window:minimize', () => { window.minimize(); return null; });
  handle('window:toggle-maximize', () => {
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
    return { maximized: window.isMaximized() };
  });
  handle('window:state', () => ({ maximized: window.isMaximized() }));
  handle('window:close', () => {
    if (profiles?.isBusy()||workbench?.isBusy()) throw new ProfileError('Wait for the Windows operation to finish before closing XeroLag.', 'BUSY');
    setImmediate(() => { if (!window.isDestroyed()) window.close(); }); return null;
  });
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}

module.exports = { assertTrustedSender, registerIpc };
