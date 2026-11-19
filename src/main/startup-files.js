'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {verifyPath}=require('./files');
const {ProfileError,assertIdentity}=require('./profile-state');

function createStartupFiles({directory,identity}){
  const roots={user:path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup'),common:path.join(process.env.ProgramData,'Microsoft','Windows','Start Menu','Programs','Startup')};
  function resolve(target){if(!target||!Object.hasOwn(roots,target.root)||typeof target.name!=='string'||path.basename(target.name)!==target.name||target.name==='.'||target.name==='..')throw new ProfileError('Invalid startup file.','UNSAFE_PATH');return{root:roots[target.root],file:path.join(roots[target.root],target.name)};}
  async function discover(){const result=[];for(const[root,folder]of Object.entries(roots)){try{for(const name of await fs.readdir(folder)){const file=path.join(folder,name);const stat=await fs.lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=10*1024*1024)result.push({id:createHash('sha256').update(root+name).digest('hex'),label:name,type:'startup-file',risk:root==='common'?'Advanced':'Moderate',target:{root,name},command:file,enabled:true});}}catch{}}return result;}
  async function run(action,payload){
    if(action==='Inspect')return{items:await discover()};
    const{root,file}=resolve(payload.target);
    if(action==='Capture'){
      await verifyPath(root,file);
      const buffer=await fs.readFile(file);if(buffer.length>10*1024*1024)throw new ProfileError('This startup file is too large to back up.','UNSUPPORTED');
      return{hash:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.toString('base64')};
    }
    const current=await identity();assertIdentity(payload.identity,current);
    if(!current.administrator||!current.desktopMatch)throw new ProfileError('Administrator access is required.','ADMIN_REQUIRED');
    const buffer=Buffer.from(payload.original.bytes,'base64');
    if(buffer.length>10*1024*1024||createHash('sha256').update(buffer).digest('hex')!==payload.original.hash)throw new ProfileError('The startup-file backup failed validation.','INVALID_BACKUP');
    if(action==='Apply'){
      await verifyPath(root,file);const current=await fs.readFile(file);
      if(createHash('sha256').update(current).digest('hex')!==payload.original.hash)throw new ProfileError('This startup item changed. Refresh before disabling it.','CHANGED_FILE');
      try{await fs.unlink(file);}catch(error){throw new ProfileError(error.message,'FILE_FAILED');}
    }else if(action==='Restore'){
      try{const current=await fs.readFile(file);if(createHash('sha256').update(current).digest('hex')===payload.original.hash)return{success:true};throw new ProfileError('Another file now uses this startup name. It was not overwritten.','RESTORE_CONFLICT');}catch(error){if(error.code!=='ENOENT')throw error;}
      const stat=await fs.lstat(root);if(stat.isSymbolicLink()||!stat.isDirectory())throw new ProfileError('The startup folder is unavailable.','UNSAFE_PATH');
      try{await fs.writeFile(file,buffer,{flag:'wx'});}catch(error){throw new ProfileError(error.message,'FILE_FAILED');}
    }else throw new ProfileError('Unknown startup operation.','INVALID_ACTION');
    return{success:true};
  }
  return{discover,run};
}

module.exports={createStartupFiles};
