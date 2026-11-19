'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {runFile,windowsExecutable}=require('./command-runner');
const {ProfileError}=require('./profile-state');

async function secureDirectory(directory){
  try{
    const absolute=path.resolve(directory);
    if(absolute===path.parse(absolute).root)throw new Error('Invalid application state directory.');
    await fs.mkdir(absolute,{recursive:true});
    if((await fs.lstat(absolute)).isSymbolicLink())throw new Error('The application state directory cannot be a link.');
    await runFile(windowsExecutable('icacls.exe'),[absolute,'/setintegritylevel','(OI)(CI)H']);
    await runFile(windowsExecutable('icacls.exe'),[absolute,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F']);
    return absolute;
  }catch(error){throw new ProfileError('The protected recovery folder could not be secured: '+error.message,'BACKUP_PERMISSIONS');}
}

module.exports={secureDirectory};
