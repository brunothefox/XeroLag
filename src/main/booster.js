'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {atomicJson}=require('./snapshot-store');
const {scriptFile}=require('./windows-script');
const {windowsExecutable}=require('./command-runner');
const {ProfileError,GUID}=require('./profile-state');

function createBooster({directory,scripts,identity,games,profiles}){
  let child=null;let exited=null;let working=false;
  const configFile=path.join(directory,'booster.json');
  const statusFile=path.join(directory,'booster-status.json');
  const journal=path.join(directory,'booster-recovery.json');
  const stopFile=path.join(directory,'booster-stop');
  async function status(){let state={running:false};let options={};try{state=JSON.parse((await fs.readFile(statusFile,'utf8')).replace(/^\uFEFF/,''));}catch{}try{const saved=JSON.parse(await fs.readFile(configFile,'utf8'));options={timer:saved.timer,booster:saved.booster,games:saved.games||[],backgrounds:saved.backgrounds||[],powerPlan:saved.powerPlan};}catch{}return{...state,options,running:Boolean(child&&child.exitCode===null),working};}
  async function recover(){
    try{await fs.access(configFile);await fs.access(journal);}catch{return;}
    const saved=JSON.parse(await fs.readFile(journal,'utf8'));
    if(saved.restored)return;
    const config=JSON.parse(await fs.readFile(configFile,'utf8'));
    await scripts.run('game-worker.ps1','Recover',config,{text:true});
  }
  async function stop(){
    if(!child)return status();
    await fs.writeFile(stopFile,'stop','utf8');
    await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new ProfileError('The booster is still restoring its changes.','BUSY')),20_000))]);
    child=null;
    try{const saved=JSON.parse((await fs.readFile(journal,'utf8')).replace(/^\uFEFF/,''));if(!saved.restored)throw new ProfileError('Some booster changes still need recovery. Open Repair > Recovery.','RECOVERY_REQUIRED');}catch(error){if(error.code!=='ENOENT')throw error;}
    return status();
  }
  async function configure(options){
    if(working)throw new ProfileError('The booster is already changing state.','BUSY');
    if(!options||typeof options.timer!=='boolean'||typeof options.booster!=='boolean'||!Array.isArray(options.games)||options.games.length>100||!Array.isArray(options.backgrounds)||options.backgrounds.some(name=>!['chrome','msedge','firefox','Discord','steam','EpicGamesLauncher','RiotClientServices'].includes(name))||options.booster&&!GUID.test(options.powerPlan))throw new ProfileError('Invalid booster configuration.','INVALID_SELECTION');
    const roots=games.boosterRoots(options.games);
    if(options.booster&&!roots.length)throw new ProfileError('Select at least one detected game.','INVALID_SELECTION');
    working=true;
    try{
      await stop();await recover();
      if(!options.booster&&!options.timer)return status();
      await profiles.snapshot();
      const config={identity:await identity(),parentPid:process.pid,parentStartedAt:Math.round(Date.now()-process.uptime()*1000),timer:options.timer,booster:options.booster,powerPlan:options.powerPlan,gameRoots:roots,games:options.games,backgrounds:options.backgrounds,journal,status:statusFile,stop:stopFile};
      await fs.mkdir(directory,{recursive:true});await fs.unlink(stopFile).catch(()=>{});await atomicJson(configFile,config);
      child=spawn(windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptFile('game-worker.ps1'),'-Action','Run','-PayloadPath',configFile],{windowsHide:true,shell:false,detached:true,stdio:'ignore'});
      child.unref();
      const launched=child;
      exited=new Promise((resolve,reject)=>{launched.once('error',error=>{if(child===launched)child=null;reject(error);});launched.once('close',resolve);});exited.catch(()=>{});
      return status();
    }finally{working=false;}
  }
  return{status,configure,stop,recover,isRunning:()=>Boolean(child&&child.exitCode===null),isBusy:()=>working};
}

module.exports={createBooster};
