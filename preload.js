'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || result.ok !== true) {
    const error = new Error(result?.error || 'The application did not return a valid response.');
    error.code = result?.code || 'REQUEST_FAILED';
    throw error;
  }
  return result.data;
}

contextBridge.exposeInMainWorld('xerolag', {
  app: { getInfo: () => invoke('app:info') },
  system: { getSnapshot: () => invoke('system:snapshot') },
  tools: {
    page:(page,force=false)=>invoke('workbench:call','page',{page,force}),
    artwork:(id,online=true)=>invoke('workbench:call','artwork',{id,online}),
    importArtwork:id=>invoke('workbench:call','importArtwork',{id}),
    itemIcon:id=>invoke('workbench:call','itemIcon',{id}),
    sourceIcon:id=>invoke('workbench:call','sourceIcon',{id}),
    nativeTool:id=>invoke('workbench:call','nativeTool',{id}),
    checkPermissions:()=>invoke('workbench:call','permissions',{}),
    networkInfo:guid=>invoke('workbench:call','networkInfo',{guid}),
    networkProbe:()=>invoke('workbench:call','networkProbe',{}),
    restartAdapter:guid=>invoke('workbench:call','restartAdapter',{guid}),
    closeApp:(pid,ticks)=>invoke('workbench:call','closeApp',{pid,ticks}),
    preview:(provider,id)=>invoke('workbench:call','preview',{provider,id}),
    apply:(provider,id,token)=>invoke('workbench:call','apply',{provider,id,token}),
    restore:id=>invoke('workbench:call','restore',{id}),
    restoreAll:()=>invoke('workbench:call','restoreAll',{}),
    scanCaches:ids=>invoke('workbench:call','scanCaches',{ids}),
    cleanCaches:(scanId,ids)=>invoke('workbench:call','cleanCaches',{scanId,ids}),
    chooseFolder:()=>invoke('workbench:call','chooseFolder',{}),
    scanFiles:(rootId,mode)=>invoke('workbench:call','scanFiles',{rootId,mode}),
    removeFiles:(scanId,ids)=>invoke('workbench:call','removeFiles',{scanId,ids}),
    job:id=>invoke('workbench:call','job',{id}),
    jobs:()=>invoke('workbench:call','jobs',{}),
    cancelJob:id=>invoke('workbench:call','cancelJob',{id}),
    addGame:()=>invoke('workbench:call','addGame',{}),
    launchGame:(id,profile)=>invoke('workbench:call','launchGame',{id,profile}),
    configureBooster:options=>invoke('workbench:call','booster',options),
    stopBooster:()=>invoke('workbench:call','stopBooster',{}),
    boosterStatus:()=>invoke('workbench:call','boosterStatus',{}),
    ping:()=>invoke('workbench:call','ping',{}),
    flushDns:()=>invoke('workbench:call','flushDns',{}),
    repair:(id,drive)=>invoke('workbench:call','repair',{id,drive}),
    health:()=>invoke('workbench:call','health',{}),
    importMarkC:()=>invoke('workbench:call','importMarkC',{}),
    markcSource:()=>invoke('workbench:call','markcSource',{}),
    openStore:id=>invoke('workbench:call','openStore',{id}),
    openRecovery:()=>invoke('workbench:call','openRecovery',{}),
    systemRestore:()=>invoke('workbench:call','systemRestore',{})
    ,recoverWorker:()=>invoke('workbench:call','recoverWorker',{})
  },
  profiles: {
    getStatus: () => invoke('profiles:status'),
    createSnapshot: () => invoke('profiles:snapshot'),
    apply: id => {
      if (!['gaming', 'competitive', 'quiet'].includes(id)) return Promise.reject(new TypeError('Unknown profile.'));
      return invoke('profiles:apply', id);
    },
    revertAll: () => invoke('profiles:revert'),
    openBackups: () => invoke('profiles:open-backups'),
    openSystemProtection: () => invoke('profiles:open-protection')
  },
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    close: () => invoke('window:close'),
    getState: () => invoke('window:state'),
    onStateChanged: callback => {
      if (typeof callback !== 'function') throw new TypeError('A callback function is required.');
      const listener = (_event, state) => {
        if (state && typeof state.maximized === 'boolean') callback({ maximized: state.maximized });
      };
      ipcRenderer.on('window:state-changed', listener);
      return () => ipcRenderer.removeListener('window:state-changed', listener);
    }
  }
});
