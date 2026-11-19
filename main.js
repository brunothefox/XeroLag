'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAdministrator, requestElevation } = require('./src/main/elevation');
const { createLogger } = require('./src/main/logger');
const { registerIpc } = require('./src/main/ipc');
const { createTelemetry } = require('./src/main/telemetry');
const { createProfiles } = require('./src/main/profiles');
const { ProfileError } = require('./src/main/profile-state');
const { windowsExecutable } = require('./src/main/command-runner');
const { createProfileAdapter } = require('./src/main/profile-adapter');
const { createWorkbench } = require('./src/main/workbench');
const { secureDirectory } = require('./src/main/secure-directory');

app.setName('XeroLag');
app.setAppUserModelId('app.xerolag.desktop');

let mainWindow;
let logger;
let handlingFatalError = false;
const entryPath = path.join(__dirname, 'src', 'renderer', 'index.html');
const entryUrl = pathToFileURL(entryPath).href;

async function fatal(error) {
  if (handlingFatalError) return;
  handlingFatalError = true;
  try {
    const message = error instanceof Error ? error.message : String(error);
    if (logger) await logger.error(message);
    dialog.showErrorBox('XeroLag could not continue', message);
  } catch (reportError) {
    console.error(reportError);
  } finally {
    app.exit(1);
  }
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

async function createWindow(administrator) {
  const window = new BrowserWindow({
    title: 'XeroLag', width: 1200, height: 800, minWidth: 900, minHeight: 620,
    show: false, frame: false, roundedCorners: true, backgroundColor: '#101319',
    icon: path.join(__dirname, 'assets', 'generated', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: !app.isPackaged, spellcheck: false
    }
  });
  mainWindow = window;
  window.setMenu(null);
  const telemetry = createTelemetry();
  const profiles = createProfiles({ directory: path.join(app.getPath('userData'), 'safety'), administrator, logger,
    onChange: () => telemetry.refreshWindows() });
  const openBackups = async () => {
    try {
      await fs.mkdir(profiles.backupDirectory, { recursive: true });
      const error = await shell.openPath(profiles.backupDirectory);
      if (error) throw new Error(error);
      return null;
    } catch { throw new ProfileError('The backup folder could not be opened.', 'OPEN_FAILED'); }
  };
  const openProtection = async () => {
    try {
      const error = await shell.openPath(windowsExecutable('SystemPropertiesProtection.exe'));
      if (error) throw new Error(error);
      return null;
    } catch { throw new ProfileError('Windows System Protection could not be opened.', 'OPEN_FAILED'); }
  };
  const protectedRoot=await secureDirectory(path.join(app.getPath('userData'),'protected'));
  await secureDirectory(path.join(app.getPath('userData'),'safety'));
  const choose=async options=>{const result=await dialog.showOpenDialog(window,options);return result.canceled?null:result.filePaths[0];};
  const confirm=async message=>(await dialog.showMessageBox(window,{type:'warning',title:'XeroLag',message,buttons:['Cancel','Continue'],defaultId:0,cancelId:0,noLink:true})).response===1;
  const profileAdapter=createProfileAdapter();
  const workbench=createWorkbench({directory:protectedRoot,profiles,identity:async()=>(await profileAdapter.read()).identity,logger,trash:file=>shell.trashItem(file),getFileIcon:async file=>(await app.getFileIcon(file,{size:'large'})).toDataURL(),openUri:uri=>shell.openExternal(uri),dialogs:{
    confirm,folder:()=>choose({title:'Choose a folder to scan',properties:['openDirectory']}),
    executable:()=>choose({title:'Select a game executable',properties:['openFile'],filters:[{name:'Windows executable',extensions:['exe']}]}),
    preset:()=>choose({title:'Select a MarkC mouse preset for your display scale',properties:['openFile'],filters:[{name:'Registry preset',extensions:['reg']}]}),
    artwork:()=>choose({title:'Choose game artwork',properties:['openFile'],filters:[{name:'Game artwork',extensions:['jpg','jpeg','png','webp']}]}),
    openRecovery:async()=>{const error=await shell.openPath(protectedRoot);if(error)throw new ProfileError(error,'OPEN_FAILED');return null;},
    systemRestore:async()=>{const error=await shell.openPath(windowsExecutable('rstrui.exe'));if(error)throw new ProfileError(error,'OPEN_FAILED');return null;}
  }});
  await workbench.initialize();
  const unregister = registerIpc({ ipcMain, window, entryUrl, app, administrator, logger, telemetry, profiles, openBackups, openProtection,workbench });
  let closingNotice = false;
  window.on('close', event => {
    if(!profiles.isBusy()&&!workbench.isBusy()&&workbench.isBoosterRunning()){
      event.preventDefault();void workbench.stop().then(()=>window.close()).catch(error=>dialog.showErrorBox('XeroLag recovery',error.message));return;
    }
    if (!profiles.isBusy()&&!workbench.isBusy()) return;
    event.preventDefault();
    if (!closingNotice) {
      closingNotice = true;
      void dialog.showMessageBox(window, { type: 'info', title: 'Windows operation in progress',
        message: 'Finish or stop the running task before closing XeroLag.', buttons: ['OK'] })
        .catch(error => logger.error(error.message)).finally(() => { closingNotice = false; });
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') void fatal(new Error(`The application view stopped (${details.reason}). Please restart XeroLag.`));
  });
  window.webContents.on('preload-error', (_event, _file, error) => { void fatal(error); });
  window.on('unresponsive', () => { void logger.error('The application window is not responding.'); });
  const notifyState = () => {
    if (!window.isDestroyed()) window.webContents.send('window:state-changed', { maximized: window.isMaximized() });
  };
  window.on('maximize', notifyState);
  window.on('unmaximize', notifyState);
  window.once('ready-to-show', () => { window.show(); notifyState(); });
  window.on('closed', () => { unregister(); mainWindow = null; });
  return window.loadFile(entryPath);
}

async function start() {
  try {
    if (process.platform !== 'win32') throw new Error('XeroLag requires Windows 10 or Windows 11.');
    logger = createLogger(path.join(app.getPath('userData'), 'logs'));
    const administrator = await isAdministrator();
    if (!administrator) {
      if (process.argv.includes('--xerolag-elevated')) throw new Error('Windows did not grant administrator access.');
      const { response } = await dialog.showMessageBox({
        type: 'info', title: 'Administrator access',
        message: 'XeroLag needs administrator access.',
        detail: 'Continue to the Windows permission prompt to restart XeroLag as administrator.',
        buttons: ['Continue', 'Exit'], defaultId: 0, cancelId: 1, noLink: true
      });
      if (response === 0) await requestElevation(app);
      app.quit();
      return;
    }
    // Acquire the lock after elevation so the relaunch cannot collide with its parent.
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    app.on('second-instance', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    await logger.info(`Starting XeroLag ${app.getVersion()}; administrator verified.`);
    await createWindow(administrator);
  } catch (error) {
    await fatal(error);
  }
}

app.on('window-all-closed', () => app.quit());
app.whenReady().then(start).catch(fatal);
