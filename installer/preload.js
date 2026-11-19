'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const call=(method,value)=>ipcRenderer.invoke('setup:call',method,value);
contextBridge.exposeInMainWorld('setup',Object.freeze({state:()=>call('state'),directory:()=>call('directory'),install:desktop=>call('install',desktop),open:()=>call('open'),close:()=>call('close'),minimize:()=>call('minimize'),onState:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('setup:state',listener);return()=>ipcRenderer.removeListener('setup:state',listener);}}));
