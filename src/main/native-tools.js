'use strict';
const fs=require('node:fs/promises');
const {spawn}=require('node:child_process');
const {windowsExecutable}=require('./command-runner');
const {ProfileError}=require('./profile-state');
const catalog=[
  {id:'task-manager',label:'Task Manager',icon:'activity',file:'Taskmgr.exe',group:'Diagnostics'},
  {id:'system-information',label:'System Information',icon:'cpu',file:'msinfo32.exe',group:'Diagnostics'},
  {id:'event-viewer',label:'Event Viewer',icon:'layers',file:'eventvwr.exe',group:'Diagnostics'},
  {id:'performance-monitor',label:'Performance Monitor',icon:'activity',file:'perfmon.exe',group:'Diagnostics'},
  {id:'registry-editor',label:'Registry Editor',icon:'layers',file:'regedt32.exe',group:'Windows',description:'Windows editor; external changes are outside XeroLag recovery.'},
  {id:'disk-cleanup',label:'Windows Disk Cleanup',icon:'disk',file:'cleanmgr.exe',group:'Maintenance'},
  {id:'memory-diagnostic',label:'Memory Diagnostic',icon:'ram',file:'mdsched.exe',group:'Diagnostics',description:'Windows will ask when to restart and test memory.'},
  {id:'system-image',label:'System image backup',icon:'layers',file:'control.exe',args:['/name','Microsoft.BackupAndRestore'],group:'Recovery',description:'Choose a backup destination in Windows Backup and Restore.'},
  {id:'startup-repair',label:'Startup recovery',icon:'power',uri:'ms-settings:recovery',group:'Recovery',description:'Open Windows Recovery to access Advanced startup and Startup Repair.'},
  {id:'network-settings',label:'Advanced network settings',icon:'network',uri:'ms-settings:network-advancedsettings',group:'Windows'},
  {id:'windows-update',label:'Windows Update',icon:'refresh',uri:'ms-settings:windowsupdate',group:'Maintenance'}
];
function createNativeTools(openUri){
  async function list(){return Promise.all(catalog.map(async({file,args,uri,...tool})=>{let supported=true;if(file)try{await fs.access(windowsExecutable(file));}catch{supported=false;}return{...tool,supported};}));}
  async function open(id){const tool=catalog.find(tool=>tool.id===id);if(!tool)throw new ProfileError('Unknown Windows tool.','INVALID_ACTION');if(tool.uri)return openUri(tool.uri);const file=windowsExecutable(tool.file);await fs.access(file);await new Promise((resolve,reject)=>{const child=spawn(file,tool.args||[],{detached:true,windowsHide:false,shell:false,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return{success:true};}
  return{list,open};
}
module.exports={createNativeTools};
