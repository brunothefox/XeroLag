'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createController,validateDirectory,engineRequest}=require('../installer/controller');
test('installer rejects system folders, roots, remote shares and malformed paths',()=>{for(const value of ['C:\\','C:\\Windows\\XeroLag','C:\\Windows\\System32\\XeroLag','\\\\server\\XeroLag','C:\\Apps\\Other','C:\\Apps\\XeroLag" /S'])assert.throws(()=>validateDirectory(value));assert.equal(validateDirectory('F:\\Apps\\XeroLag'),'F:\\Apps\\XeroLag');});
async function fixture(t,{exitCode=0,corrupt=false}={}){
  const base=path.resolve(__dirname,'../.cache/tests');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'setup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const payload=path.join(root,'payload');await fs.mkdir(payload);await fs.writeFile(path.join(payload,'setup.exe'),corrupt?'changed':'fixture');await fs.writeFile(path.join(payload,'manifest.json'),JSON.stringify({version:'test',installedBytes:1,sha256:createHash('sha256').update('fixture').digest('hex')}));
  await fs.mkdir(path.join(root,'XeroLag'));await fs.writeFile(path.join(root,'XeroLag/XeroLag.exe'),'fixture');const calls=[];const states=[];
  const controller=createController({resources:root,version:'test',chooseFolder:async()=>root,onChange:state=>states.push(state.phase),query:async file=>{if(file.endsWith('reg.exe'))throw Error('No prior install');return{stdout:''};},launch:(file,args,options)=>{calls.push({file,args,options});const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',exitCode));return child;}});await controller.initialize();await controller.directory();return{controller,calls,states,root};
}
test('installer verifies payload, uses literal arguments and preserves shortcut choice',async t=>{const {controller,calls,states,root}=await fixture(t);const result=await controller.install(false);assert.equal(result.phase,'complete');assert.deepEqual(calls[0].args,['/S','/no-desktop-shortcut','/D='+path.join(root,'XeroLag')]);assert.equal(calls[0].options.shell,false);assert.deepEqual(states.slice(-3),['verifying','installing','complete']);assert.equal(controller.busy(),false);await assert.rejects(controller.install(true),/complete/);});
test('installer refuses a corrupt embedded payload before launching setup',async t=>{const {controller,calls}=await fixture(t,{corrupt:true});const result=await controller.install(true);assert.equal(result.phase,'error');assert.match(result.error,/verification failed/);assert.equal(calls.length,0);assert.equal(controller.busy(),false);});
test('installer reports native failure and restart-required results accurately',async t=>{const failure=await fixture(t,{exitCode:7});assert.match((await failure.controller.install(true)).error,/code 7/);await assert.rejects(failure.controller.open(),/Finish installation/);const restart=await fixture(t,{exitCode:3010});assert.equal((await restart.controller.install(true)).restart,true);});
test('installer resolves the existing install location before exposing ready metadata',async t=>{const {root}=await fixture(t);let release;const registry=new Promise(resolve=>{release=resolve;});const published=[];const controller=createController({resources:root,version:'test',chooseFolder:async()=>null,query:async()=>registry,onChange:value=>published.push(value)});const initialization=controller.initialize();assert.equal(controller.state().installedBytes,null);release({stdout:'InstallLocation    REG_SZ    F:\\Existing\\XeroLag'});await initialization;assert.equal(published.length,1);assert.equal(published[0].directory,'F:\\Existing\\XeroLag');assert.equal(published[0].installedBytes,1);});
test('native NSIS receives a spaced destination literally without installing anything',{skip:process.platform!=='win32'},async t=>{
  const compiler=path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');try{await fs.access(compiler);}catch{t.skip('NSIS compiler not cached yet');return;}
  const base=path.resolve(__dirname,'../.cache/tests');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'nsis-args-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'setup with spaces.exe'),output=path.join(root,'observed.txt'),source=path.join(root,'probe.nsi');
  const literal=value=>value.replaceAll('$','$$');
  await fs.writeFile(source,['Unicode true','RequestExecutionLevel user','SilentInstall silent','OutFile "'+literal(executable)+'"','Section','FileOpen $0 "'+literal(output)+'" w','FileWrite $0 "$INSTDIR"','FileClose $0','SectionEnd'].join('\n'));
  const execFile=require('node:util').promisify(require('node:child_process').execFile);await execFile(compiler,['/V2',source],{windowsHide:true,timeout:15000});
  const target=path.join(root,'Selected Folder With Spaces','XeroLag'),request=engineRequest(executable,target,false);
  await execFile(executable,request.args,{...request.options,timeout:10000});assert.equal(await fs.readFile(output,'utf8'),target);assert.equal(request.options.shell,false);
});
