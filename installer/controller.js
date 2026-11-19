'use strict';
const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const exec=require('node:util').promisify(execFile);
function engineRequest(engine,destination,desktop){return{args:['/S',...(desktop?[]:['/no-desktop-shortcut']),'/D='+validateDirectory(destination)],options:{argv0:'"'+engine+'"',windowsVerbatimArguments:true,windowsHide:true,shell:false,stdio:'ignore'}};}
function validateDirectory(value){
  if(typeof value!=='string'||value.length>200||!/^\w:\\/.test(value)||/[<>"|?*\x00-\x1f]/.test(value)||value.slice(2).includes(':'))throw Error('Choose a local Windows folder.');
  const resolved=path.win32.resolve(value),lower=resolved.toLowerCase(),system=(process.env.SystemRoot||'C:\\Windows').toLowerCase();
  if(resolved===path.win32.parse(resolved).root||lower===system||lower.startsWith(system+'\\')||path.win32.basename(resolved).toLowerCase()!=='xerolag')throw Error('Choose an XeroLag application folder outside Windows.');
  return resolved;
}
function createController({resources,chooseFolder,version,onChange=()=>{},launch=spawn,query=exec}){
  let state={phase:'ready',directory:path.join(process.env.ProgramW6432||process.env.ProgramFiles||'C:\\Program Files','XeroLag'),desktop:true,version,installedBytes:null,error:null,restart:false},running=false;
  const publish=values=>{state={...state,...values};onChange({...state});};
  async function initialize(){
    const initial={};
    try{const manifest=JSON.parse(await fs.readFile(path.join(resources,'payload/manifest.json'),'utf8'));if(manifest.version!==version||!Number.isSafeInteger(manifest.installedBytes)||manifest.installedBytes<1||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw Error('Invalid installer payload.');initial.installedBytes=manifest.installedBytes;}catch(error){publish({phase:'error',error:'Installer files could not be read. Download a fresh copy. '+error.message});return {...state};}
    try{const {stdout}=await query(path.join(process.env.SystemRoot,'System32/reg.exe'),['query','HKLM\\Software\\154b9435-2bd2-5b4c-891d-47bfad9491ed','/v','InstallLocation','/reg:64'],{windowsHide:true,timeout:5000});const value=stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/i)?.[1]?.trim();if(value)initial.directory=validateDirectory(value);}catch{}
    publish(initial);
    return {...state};
  }
  async function directory(){if(running||state.phase==='complete')throw Error('Installation is already in progress or complete.');const selected=await chooseFolder(state.directory);if(selected){const target=path.win32.basename(selected).toLowerCase()==='xerolag'?selected:path.win32.join(selected,'XeroLag');publish({directory:validateDirectory(target),error:null});}return {...state};}
  async function install(desktop){
    if(running||state.phase==='complete')throw Error('Installation is already in progress or complete.');if(typeof desktop!=='boolean')throw Error('Invalid shortcut choice.');running=true;publish({phase:'verifying',desktop,error:null});
    try{
      const destination=validateDirectory(state.directory);let parent=destination;
      while(true){try{const stat=await fs.lstat(parent);if(stat.isSymbolicLink())throw Error('Choose a folder without linked directories.');if(!stat.isDirectory())throw Error('The install location must be a folder.');}catch(error){if(error.code!=='ENOENT')throw error;}const next=path.dirname(parent);if(parent===next)break;parent=next;}
      const {stdout}=await query(path.join(process.env.SystemRoot,'System32/tasklist.exe'),['/FI','IMAGENAME eq XeroLag.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:10000});if(/^"XeroLag\.exe"/im.test(stdout))throw Error('Close XeroLag, then try installing again.');
      const manifest=JSON.parse(await fs.readFile(path.join(resources,'payload/manifest.json'),'utf8')),engine=path.join(resources,'payload/setup.exe'),digest=createHash('sha256');for await(const part of createReadStream(engine))digest.update(part);if(manifest.version!==version||digest.digest('hex')!==manifest.sha256)throw Error('Installer verification failed. Download a fresh copy.');
      for(const location of [path.parse(destination).root,os.tmpdir()]){let stat;try{stat=await fs.statfs(location);}catch(error){if(error.code==='ENOSYS'||error.code==='ENOTSUP')continue;throw error;}if(stat.bavail*stat.bsize<manifest.installedBytes*2+64*1024*1024)throw Error('Not enough free space. Free disk space and try again.');}
      publish({phase:'installing'});
      const request=engineRequest(engine,destination,desktop);
      const code=await new Promise((resolve,reject)=>{const child=launch(engine,request.args,request.options);child.once('error',reject);child.once('exit',value=>resolve(value));});
      if(![0,3010].includes(code))throw Error('Windows setup exited with code '+code+'. Close XeroLag and retry.');
      await fs.access(path.join(destination,'XeroLag.exe'));publish({phase:'complete',restart:code===3010});
    }catch(error){publish({phase:'error',error:error.message});}finally{running=false;}return {...state};
  }
  async function open(){if(state.phase!=='complete')throw Error('Finish installation before opening XeroLag.');const executable=path.join(validateDirectory(state.directory),'XeroLag.exe');await fs.access(executable);await new Promise((resolve,reject)=>{const child=launch(executable,[],{detached:true,windowsHide:false,shell:false,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return{success:true};}
  return{initialize,directory,install,open,state:()=>({...state}),busy:()=>running};
}
module.exports={createController,validateDirectory,engineRequest};
