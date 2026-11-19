'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { scriptFile } = require('./windows-script');
const { windowsExecutable, runFile } = require('./command-runner');
const { atomicJson } = require('./snapshot-store');
const { ProfileError } = require('./profile-state');

const tools=[
  {id:'recommended',label:'Component and system file repair',description:'Run DISM first, then System File Checker',risk:'Moderate'},
  {id:'sfc',label:'System File Checker',description:'Scan and repair protected Windows files',risk:'Moderate'},
  {id:'dism',label:'Windows component repair',description:'Repair the online Windows image',risk:'Moderate'},
  {id:'trim',label:'SSD TRIM',description:'ReTrim a selected local volume',risk:'Safe'},
  {id:'winget',label:'Update installed applications',description:'winget upgrade --all; apps may close',risk:'Moderate'},
  {id:'winsock',label:'Reset Winsock',description:'Reset the socket catalogue; restart required',risk:'Advanced',restart:true},
  {id:'tcp-reset',label:'Reset TCP/IP',description:'Reset network configuration; static settings may need reconfiguration',risk:'Advanced',restart:true},
  {id:'standby',label:'Clear standby memory',description:'Purge the standby list using Windows memory APIs',risk:'Moderate'},
  {id:'delivery-cache',label:'Delivery Optimization cache',description:'Remove unpinned update-sharing cache through Windows',risk:'Moderate'},
  {id:'permissions',label:'Check folder permissions',description:'Verify access-control lists in a selected folder; no permissions are changed',risk:'Safe'}
];

function createRepair({directory,jobs,scripts,identity,profiles,confirm,blocked=()=>false,launchGuard=spawn,guardTimeout=45_000}) {
  let healthCache=null;let healthPending=null;
  async function health(){if(healthCache&&Date.now()-healthCache.time<15_000)return healthCache.data;if(healthPending)return healthPending;healthPending=scripts.run('discovery.ps1','Health').then(data=>{healthCache={data,time:Date.now()};return data;}).finally(()=>{healthPending=null;});return healthPending;}
  function start(id,drive,folder) {
    const tool=tools.find(tool=>tool.id===id);
    if(!tool)throw new ProfileError('Unknown repair tool.','INVALID_ACTION');
    if(id==='trim'&&!/^[a-z]$/i.test(drive||''))throw new ProfileError('Select a local volume.','INVALID_SELECTION');
    if(id==='permissions'&&(!folder||!path.isAbsolute(folder)||path.resolve(folder)===path.parse(folder).root))throw new ProfileError('Choose a folder rather than an entire drive.','INVALID_SELECTION');
    if(blocked(id))throw new ProfileError('Finish the current Windows operation first.','BUSY');
    return jobs.start(tool.label,async context=>{
      const current=await identity();
      if(!current.administrator||!current.desktopMatch)throw new ProfileError('Administrator access under the desktop account is required.','ADMIN_REQUIRED');
      if(!await confirm(tool.label+'? '+tool.description+(tool.restart?' Use Windows System Restore if you need to undo this repair.':'')))return {cancelled:true};
      if(['winsock','tcp-reset','winget','dism','sfc','recommended'].includes(id))await profiles.snapshot();
      context.check();
      const payload=await scripts.request({identity:current,drive:drive?.toUpperCase(),folder,dataRoot:directory});
      try {
        return await new Promise((resolve,reject)=>{
          let child;
          try {
            child=spawn(windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptFile('repair-tools.ps1'),'-Action',id,'-PayloadPath',payload],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
          }catch(error){reject(error);return;}
          const decoder=new StringDecoder('utf8');
          child.stdout.on('data',chunk=>context.log(decoder.write(chunk)));
          child.stderr.on('data',chunk=>context.log(chunk.toString('utf8')));
          child.on('error',reject);
          context.onCancel(['sfc','dism','recommended'].includes(id)?false:async()=>{
            if(child.exitCode===null&&child.pid)await runFile(windowsExecutable('taskkill.exe'),['/PID',String(child.pid),'/T','/F']).catch(()=>{});
          });
          child.on('close',code=>{context.log(decoder.end());if(code===0||code===3010)resolve({exitCode:code,restart:tool.restart||code===3010});else reject(new ProfileError('The tool exited with code '+code+'. Review its log.','TOOL_FAILED'));});
        });
      } finally {await fs.unlink(payload).catch(()=>{});}
    },'system');
  }
  const guards=new Map();
  async function waitForGuard(guard){
    let timer;
    try{await Promise.race([guard.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ProfileError('Update-service recovery is still running. Open Repair > Recovery after it finishes.','RECOVERY_REQUIRED')),guardTimeout);})]);}
    finally{clearTimeout(timer);}
  }
  async function finishGuard(id){
    const guard=guards.get(id);if(!guard)return;
    await fs.writeFile(guard.stop,'stop','utf8');
    try{await waitForGuard(guard);}catch(error){if(!guard.finished)throw error;}
    try{await fs.access(guard.done);guards.delete(id);return;}catch(error){if(error.code!=='ENOENT')throw error;}
    try{await fs.access(guard.journal);}catch(error){if(error.code==='ENOENT'&&guard.finished){guards.delete(id);return;}throw error;}
    try{
      await scripts.run('repair-tools.ps1','updateRecovery',{identity:await identity(),journal:guard.journal},{text:true});
      await fs.writeFile(guard.done,'recovered','utf8');guards.delete(id);
    }catch(error){throw new ProfileError('Windows Update services could not be restored. Open Repair > Recovery. '+error.message,'RECOVERY_REQUIRED');}
  }
  async function updateServices(action,state) {
    if(action==='resume'){
      await finishGuard(state.id);return;
    }
    if(guards.size)throw new ProfileError('An earlier Windows Update cleanup needs recovery. Open Repair > Recovery.','RECOVERY_REQUIRED');
    const context=await identity();
    const id=randomUUID();const root=path.join(directory,'update-guards',id);
    await fs.mkdir(root,{recursive:true});
    const config={identity:context,parentPid:process.pid,journal:path.join(root,'services.json'),ready:path.join(root,'ready'),done:path.join(root,'done'),stop:path.join(root,'stop')};
    const file=path.join(root,'config.json');await atomicJson(file,config);
    const child=launchGuard(windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptFile('maintenance-guard.ps1'),'-PayloadPath',file],{windowsHide:true,shell:false,detached:true,stdio:['ignore','ignore','pipe']});
    child.unref();
    const guard={...config,child,finished:false,stderr:''};
    child.stderr?.on('data',chunk=>{guard.stderr=(guard.stderr+chunk.toString('utf8')).slice(-8192);});child.stderr?.unref?.();
    guard.exited=new Promise((resolve,reject)=>{child.once('error',error=>{guard.finished=true;guard.stderr=error.message;reject(error);});child.once('close',code=>{guard.finished=true;resolve(code);});});
    guard.exited.catch(()=>{});guards.set(id,guard);
    const deadline=Date.now()+guardTimeout;
    let reason='Windows Update services did not stop in time.';
    try{
      while(Date.now()<deadline){
        let ready=null;
        try{ready=(await fs.readFile(config.ready,'utf8')).replace(/^\uFEFF/,'');}catch(error){if(error.code!=='ENOENT')throw error;}
        if(ready==='ready'&&!guard.finished)return{id};
        if(ready?.startsWith('error:')){reason=ready.slice(6).trim();break;}
        if(guard.finished){reason=guard.stderr.trim()||'The Windows Update service helper exited before it was ready.';break;}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch(error){reason=error.message;}
    await finishGuard(id);
    const error=new ProfileError(reason,'SERVICE_FAILED');error.safeToContinue=true;throw error;
  }
  async function recoverUpdateServices(){
    for(const id of [...guards.keys()])await finishGuard(id);
    const root=path.join(directory,'update-guards');
    let names;try{names=await fs.readdir(root);}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const name of names){if(!/^[a-f0-9-]{36}$/i.test(name))continue;const folder=path.join(root,name);try{await fs.access(path.join(folder,'done'));continue;}catch{}const journal=path.join(folder,'services.json');try{await fs.access(journal);}catch{continue;}await scripts.run('repair-tools.ps1','updateRecovery',{identity:await identity(),journal},{text:true});await fs.writeFile(path.join(folder,'done'),'recovered','utf8');}
  }
  return {tools,start,updateServices,recoverUpdateServices,health,capabilities:()=>scripts.run('discovery.ps1','Capabilities')};
}

module.exports={createRepair,tools};
