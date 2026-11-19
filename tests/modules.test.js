'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createJobs}=require('../src/main/jobs');
const {within,verifyPath,createFileFinder}=require('../src/main/files');
const {createCleaner}=require('../src/main/cleaner');
const {createOperations}=require('../src/main/operations');
const {parseVdf}=require('../src/main/games');
const {parseMarkC}=require('../src/main/markc');
const {describeSetting,matchesSetting,buildReview}=require('../src/main/action-review');
const actionCatalog=require('../src/main/action-catalog.json');
const {EventEmitter}=require('node:events');
const {createRepair}=require('../src/main/repair');
const {ProfileError}=require('../src/main/profile-state');
const {runFile,windowsExecutable}=require('../src/main/command-runner');
const {createMedia,imageMime,downloadImage}=require('../src/main/media');
const {createWorkbench}=require('../src/main/workbench');

async function folder(t){const root=path.resolve(__dirname,'..','.cache','tests','module-tests');await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'case-'));t.after(async()=>{const resolved=path.resolve(directory);if(!resolved.startsWith(root+path.sep)||!path.basename(resolved).startsWith('case-'))throw new Error('Invalid fixture cleanup.');await fs.rm(resolved,{recursive:true,force:true});});return directory;}
async function finished(jobs,reference){const deadline=Date.now()+5000;while(Date.now()<deadline){const job=jobs.get(reference.id);if(!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Fixture job timed out.');}

test('path capabilities reject parents, drive roots, and changed file identities',async t=>{
  const root=await folder(t);const file=path.join(root,'data.txt');await fs.writeFile(file,'one');const stat=await fs.stat(file);
  assert.equal(within(root,root),false);assert.equal(within(root,path.resolve(root,'..','outside')),false);
  await verifyPath(root,file,stat);await fs.writeFile(file,'changed');await assert.rejects(verifyPath(root,file,stat),/changed/);
});

test('junction traversal cannot reach files outside an approved root',async t=>{
  const root=await folder(t);const approved=path.join(root,'approved'),outside=path.join(root,'outside');await fs.mkdir(approved);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'private.txt'),'keep');
  const link=path.join(approved,'link');try{await fs.symlink(outside,link,'junction');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Junction creation is unavailable in this sandbox.');return;}throw error;}
  await assert.rejects(verifyPath(approved,path.join(link,'private.txt')),/Linked/);assert.equal(await fs.readFile(path.join(outside,'private.txt'),'utf8'),'keep');
});

test('duplicate removal keeps an unchanged copy and never accepts unknown file IDs',async t=>{
  const root=await folder(t);await fs.writeFile(path.join(root,'a.bin'),Buffer.alloc(2048,1));await fs.writeFile(path.join(root,'b.bin'),Buffer.alloc(2048,1));
  const jobs=createJobs();const removed=[];const finder=createFileFinder({jobs,chooseFolder:async()=>root,trash:async file=>{removed.push(file);await fs.unlink(file);},confirm:async()=>true});
  const capability=await finder.choose();const scan=await finished(jobs,finder.scan(capability.id,'duplicates'));assert.equal(scan.status,'completed');assert.equal(scan.result.total,2);
  await assert.rejects(finder.remove(scan.result.scanId,scan.result.items.map(item=>item.id)),/Keep/);
  await assert.rejects(finder.remove(scan.result.scanId,['unknown']),/not part/);
  const output=await finished(jobs,await finder.remove(scan.result.scanId,[scan.result.items[1].id]));assert.equal(output.result.removed,1);assert.equal(removed.length,1);assert.ok((await fs.readdir(root)).includes('a.bin'));
});

test('missing kept duplicate blocks deletion of the remaining copy',async t=>{
  const root=await folder(t);await fs.writeFile(path.join(root,'a.bin'),Buffer.alloc(2048,1));await fs.writeFile(path.join(root,'b.bin'),Buffer.alloc(2048,1));
  const jobs=createJobs();let removed=0;const finder=createFileFinder({jobs,chooseFolder:async()=>root,trash:async()=>{removed++;},confirm:async()=>true});
  const chosen=await finder.choose();const result=(await finished(jobs,finder.scan(chosen.id,'duplicates'))).result;await fs.unlink(result.items[0].path);
  await assert.rejects(finder.remove(result.scanId,[result.items[1].id]),/unchanged copy/);assert.equal(removed,0);
});

test('cache cleanup respects age, identity, and login exclusions',async t=>{
  const directory=await folder(t);const environment={LOCALAPPDATA:path.join(directory,'local'),APPDATA:path.join(directory,'roaming'),SystemRoot:path.join(directory,'windows')};const temp=path.join(environment.LOCALAPPDATA,'Temp');await fs.mkdir(temp,{recursive:true});
  const old=path.join(temp,'old.tmp'),recent=path.join(temp,'recent.tmp'),login=path.join(temp,'cookies.sqlite');await fs.writeFile(old,'cache');await fs.writeFile(recent,'new');await fs.writeFile(login,'login');const ago=new Date(Date.now()-2*86_400_000);await fs.utimes(old,ago,ago);await fs.utimes(login,ago,ago);
  const jobs=createJobs();const cleaner=createCleaner({jobs,environment,runningProcesses:async()=>[],confirm:async()=>true,updateServices:async()=>{throw new Error('Update service guard must not run.');}});
  const scan=(await finished(jobs,cleaner.scan(['temp']))).result;assert.equal(scan.count,1);
  const cleaned=await finished(jobs,await cleaner.clean(scan.scanId,['temp']));assert.equal(cleaned.result.removed,1);assert.equal(await fs.readFile(recent,'utf8'),'new');assert.equal(await fs.readFile(login,'utf8'),'login');
});

test('active launcher prevents cache removal and unknown categories are rejected',async t=>{
  const directory=await folder(t);const environment={LOCALAPPDATA:path.join(directory,'local'),APPDATA:path.join(directory,'roaming'),SystemRoot:path.join(directory,'windows')};const jobs=createJobs();const cleaner=createCleaner({jobs,environment,runningProcesses:async()=>['Discord'],confirm:async()=>true,updateServices:async()=>null});
  const scan=(await finished(jobs,cleaner.scan(['discord']))).result;assert.match(scan.categories[0].blocked,/Close Discord/);assert.equal(scan.count,0);
  const invalid=await finished(jobs,cleaner.scan(['arbitrary-folder']));assert.equal(invalid.status,'failed');
});

test('job cancellation is cooperative and non-cancellable repairs cannot be killed',async()=>{
  const jobs=createJobs();const reference=jobs.start('fixture',async context=>{while(true){context.check();await new Promise(resolve=>setTimeout(resolve,10));}});
  await jobs.cancel(reference.id);assert.equal((await finished(jobs,reference)).status,'cancelled');
  let done;const second=jobs.start('servicing',async context=>{context.onCancel(false);await new Promise(resolve=>{done=resolve;});});
  while(!done)await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(jobs.cancel(second.id),/must finish/);done();assert.equal((await finished(jobs,second)).status,'completed');
});

test('VDF parser supports escaped library paths without prototype pollution',()=>{
  const data=parseVdf(String.raw`"libraryfolders" { "0" { "path" "C:\\Steam" "apps" { "123" "1" } } } // comment`);
  assert.equal(data.libraryfolders['0'].path,'C:\\Steam');assert.equal(data.libraryfolders['0'].apps['123'],'1');
  const poisoned=parseVdf('"__proto__" { "polluted" "yes" }');assert.equal({}.polluted,undefined);assert.equal(poisoned.__proto__.polluted,'yes');
});

test('MarkC import only accepts mouse curves and bounded preferences',()=>{
  const curve=Array(40).fill('00').join(',');const text='Windows Registry Editor Version 5.00\n[HKEY_CURRENT_USER\\Control Panel\\Mouse]\n"SmoothMouseXCurve"=hex:'+curve+'\n"SmoothMouseYCurve"=hex:'+curve+'\n"MouseSensitivity"="10"';
  assert.equal(parseMarkC(Buffer.from(text)).length,3);
  assert.throws(()=>parseMarkC(Buffer.from(text+'\n[HKEY_LOCAL_MACHINE\\Software\\Bad]\n"Run"="1"')),/outside/);
  assert.throws(()=>parseMarkC(Buffer.from(text.replace('"10"','"99"'))),/outside/);
});

async function operationFixture(t,options={}){
  const directory=await folder(t);let current={value:7};let fail=false;const calls=[];let snapshots=0;
  const scripts={run:async(script,action,payload)=>{calls.push(action);if(action==='Inspect')return{items:[]};if(action==='Capture')return structuredClone(current);if(action==='Apply'){current={value:0};if(fail)throw new Error('fixture write failed');return{success:true};}if(action==='Restore'){current=structuredClone(payload.original);return{success:true};}throw new Error('Unknown fixture action');}};
  const context={machine:'fixture',sid:'S-1-5-21-1000',administrator:true,desktopMatch:true};
  const profiles={isBusy:()=>false,snapshot:async()=>{snapshots++;if(options.onSnapshot)current=options.onSnapshot(current);},status:async()=>({canRevert:false}),revert:async()=>{}};
  const operations=createOperations({directory,scripts,profiles,identity:async()=>context,logger:{info:async()=>{},error:async()=>{}},confirm:async()=>true,requireReview:Boolean(options.requireReview)});
  return{directory,operations,context,calls,current:()=>current,set:value=>{current=value;},fail:()=>{fail=true;},snapshots:()=>snapshots};
}

test('system mutations persist originals and restore in reverse order',async t=>{
  const fixture=await operationFixture(t);await fixture.operations.apply('system','extensions');assert.equal(fixture.current().value,0);assert.equal(fixture.snapshots(),1);
  await fixture.operations.apply('system','extensions-hide');
  const result=await fixture.operations.restoreAll();assert.equal(result[0].success,true);assert.equal(fixture.current().value,7);
});

test('failed system writes roll back and corrupt records never execute restoration',async t=>{
  const fixture=await operationFixture(t);fixture.fail();await assert.rejects(fixture.operations.apply('system','extensions'),/Previous settings were restored/);assert.equal(fixture.current().value,7);
  const second=await operationFixture(t);await second.operations.apply('system','extensions');const record=(await second.operations.history())[0];const file=path.join(second.directory,'records',record.id+'.json');const data=JSON.parse(await fs.readFile(file,'utf8'));data.data.original.value=999;await fs.writeFile(file,JSON.stringify(data));const before=second.calls.length;await assert.rejects(second.operations.restore(record.id),/integrity/);assert.equal(second.calls.length,before);
});

test('failed replacement retains the first baseline and rolls back to the previous choice',async t=>{
  const fixture=await operationFixture(t);await fixture.operations.apply('system','extensions');fixture.fail();
  await assert.rejects(fixture.operations.apply('system','extensions-hide'),/Previous settings were restored/);
  assert.equal(fixture.current().value,0);
  const active=(await fixture.operations.history()).filter(record=>record.phase==='active');assert.equal(active.length,1);
  await fixture.operations.restore(active[0].id);assert.equal(fixture.current().value,7);
});

test('legacy icon cleanup accepts only the scanned file and preserves adjacent user files',async t=>{
  const directory=await folder(t);const environment={LOCALAPPDATA:path.join(directory,'local'),APPDATA:path.join(directory,'roaming'),SystemRoot:path.join(directory,'windows')};
  await fs.mkdir(environment.LOCALAPPDATA,{recursive:true});const icon=path.join(environment.LOCALAPPDATA,'IconCache.db');const keep=path.join(environment.LOCALAPPDATA,'personal.db');await fs.writeFile(icon,'icons');await fs.writeFile(keep,'keep');
  const jobs=createJobs();const cleaner=createCleaner({jobs,environment,runningProcesses:async()=>[],confirm:async()=>true,updateServices:async()=>null});
  const scan=(await finished(jobs,cleaner.scan(['explorer-cache']))).result;assert.equal(scan.count,1);
  const result=await finished(jobs,await cleaner.clean(scan.scanId,['explorer-cache']));assert.equal(result.result.removed,1);assert.equal(await fs.readFile(keep,'utf8'),'keep');
});

test('review tokens require the same action, are single-use, and preview does not mutate',async t=>{
  const fixture=await operationFixture(t,{requireReview:true});
  const preview=await fixture.operations.preview('system','extensions');assert.equal(preview.label,'Show file extensions');assert.ok(preview.changes.length);assert.equal(fixture.snapshots(),0);assert.deepEqual(await fixture.operations.history(),[]);assert.equal(fixture.calls.includes('Apply'),false);
  await assert.rejects(fixture.operations.apply('system','extensions'),{code:'REVIEW_REQUIRED'});
  await assert.rejects(fixture.operations.apply('system','extensions-hide',preview.token),{code:'REVIEW_REQUIRED'});
  const fresh=await fixture.operations.preview('system','extensions');await fixture.operations.apply('system','extensions',fresh.token);
  await assert.rejects(fixture.operations.apply('system','extensions',fresh.token),{code:'REVIEW_REQUIRED'});
});

test('changed preview state blocks writes before and after restore-point preparation',async t=>{
  const fixture=await operationFixture(t,{requireReview:true});const preview=await fixture.operations.preview('system','extensions');fixture.set({value:9});
  await assert.rejects(fixture.operations.apply('system','extensions',preview.token),{code:'STALE_REVIEW'});assert.equal(fixture.snapshots(),0);assert.equal(fixture.calls.includes('Apply'),false);
  const second=await operationFixture(t,{requireReview:true,onSnapshot:()=>({value:11})});const another=await second.operations.preview('system','extensions');
  await assert.rejects(second.operations.apply('system','extensions',another.token),{code:'STALE_REVIEW'});assert.equal(second.calls.includes('Apply'),false);assert.deepEqual(await second.operations.history(),[]);
});

test('setting states distinguish absent values, types, partial composite settings and stopped services',()=>{
  const hags=actionCatalog.find(item=>item.id==='hags');assert.equal(describeSetting(hags,{values:[{exists:false}]}).label,'Windows default');assert.equal(describeSetting(hags,null,false).label,'Unavailable');
  assert.equal(describeSetting(hags,{values:[{exists:true,kind:'DWord',value:2}]}).label,'On');assert.equal(matchesSetting(hags,{values:[{exists:true,kind:'String',value:'2'}]}),false);
  const mouse=actionCatalog.find(item=>item.id==='mouse-acceleration');const values=mouse.entries.map(entry=>({exists:true,kind:entry.kind,value:entry.value}));assert.equal(matchesSetting(mouse,{values}),true);values[2].value='10';assert.equal(matchesSetting(mouse,{values}),false);
  const service=actionCatalog.find(item=>item.id==='service-sysmain-enable');assert.ok(service);assert.equal(matchesSetting(service,{mode:'Auto',running:false}),false);
});

test('DNS previews show exact IPv4/IPv6 requests and distinguish DHCP from manual provider addresses',()=>{
  const definition={label:'DNS',target:{type:'dns',provider:'cloudflare'}};const state={families:[{family:'IPv4',enabled:true,manual:true,addresses:['1.1.1.1','1.0.0.1']},{family:'IPv6',enabled:false,manual:true,addresses:['::1']}]};
  assert.equal(matchesSetting(definition,state),true);const preview=buildReview(definition,state);assert.equal(preview.changes[0].requested,'1.1.1.1, 1.0.0.1');assert.match(preview.changes[1].requested,/Unchanged/);
  state.families[0].manual=false;assert.equal(matchesSetting(definition,state),false);definition.target.provider='default';assert.equal(matchesSetting(definition,state),true);
});

test('already-matching reviewed settings do not create snapshots, writes or recovery records',async t=>{
  const fixture=await operationFixture(t,{requireReview:true});fixture.set({values:[{exists:true,kind:'DWord',value:0}]});
  const preview=await fixture.operations.preview('system','extensions');assert.equal(preview.matches,true);assert.equal(preview.changes[0].current,'Show');assert.equal(preview.changes[0].requested,'Show');assert.ok(preview.technicalChanges.length);
  const result=await fixture.operations.apply('system','extensions',preview.token);assert.equal(result.unchanged,true);assert.equal(fixture.snapshots(),0);assert.equal(fixture.calls.includes('Apply'),false);assert.deepEqual(await fixture.operations.history(),[]);
});

test('expired reviews block application before any snapshot or write',async t=>{
  const fixture=await operationFixture(t,{requireReview:true});const preview=await fixture.operations.preview('system','extensions');const later=Date.now()+300_001;t.mock.method(Date,'now',()=>later);
  await assert.rejects(fixture.operations.apply('system','extensions',preview.token),{code:'REVIEW_REQUIRED'});assert.equal(fixture.snapshots(),0);assert.equal(fixture.calls.includes('Apply'),false);
});

async function updateGuardFixture(t,{journal=true,done=false,ready=false,recoveryFails=false,spawnFails=false}={}){
  const directory=await folder(t);const recovery=[];
  const launchGuard=(_executable,args)=>{
    const child=new EventEmitter();child.stderr=new EventEmitter();child.unref=()=>{};child.exitCode=null;
    setImmediate(async()=>{
      try{
        const config=JSON.parse(await fs.readFile(args[args.indexOf('-PayloadPath')+1],'utf8'));
        if(spawnFails){child.emit('error',new Error('Helper executable unavailable'));return;}
        if(journal)await fs.writeFile(config.journal,JSON.stringify([{name:'wuauserv',running:true},{name:'BITS',running:false}]));
        if(ready){
          await fs.writeFile(config.ready,'ready');
          const check=async()=>{try{await fs.access(config.stop);if(done)await fs.writeFile(config.done,'done');child.exitCode=0;child.emit('close',0);}catch{setTimeout(check,5);}};
          void check();return;
        }
        if(done)await fs.writeFile(config.done,'done');
        child.stderr.emit('data',Buffer.from('Could not pause wuauserv: access denied'));
        child.exitCode=1;child.emit('close',1);
      }catch(error){child.emit('error',error);}
    });return child;
  };
  const repair=createRepair({directory,jobs:createJobs(),identity:async()=>({administrator:true,desktopMatch:true}),profiles:{},confirm:async()=>true,launchGuard,guardTimeout:1500,scripts:{run:async(script,action,payload)=>{recovery.push({script,action,payload});if(recoveryFails)throw new Error('Service restart was refused');return{};}}});
  return{repair,recovery};
}

test('early helper exit preserves the service error and only permits skipping after restoration',async t=>{
  const fixture=await updateGuardFixture(t,{done:true});
  await assert.rejects(fixture.repair.updateServices('pause'),error=>error.code==='SERVICE_FAILED'&&error.safeToContinue===true&&/wuauserv: access denied/.test(error.message));
  assert.equal(fixture.recovery.length,0);
});

test('partially paused services are recovered before cleanup can continue',async t=>{
  const fixture=await updateGuardFixture(t);
  await assert.rejects(fixture.repair.updateServices('pause'),error=>error.code==='SERVICE_FAILED'&&error.safeToContinue===true);
  assert.equal(fixture.recovery.length,1);assert.equal(fixture.recovery[0].action,'updateRecovery');
  const failed=await updateGuardFixture(t,{recoveryFails:true});await assert.rejects(failed.repair.updateServices('pause'),error=>error.code==='RECOVERY_REQUIRED'&&!error.safeToContinue);
});

test('missing service helper is safely reported without attempting service restoration',async t=>{
  const fixture=await updateGuardFixture(t,{spawnFails:true});
  await assert.rejects(fixture.repair.updateServices('pause'),error=>error.code==='SERVICE_FAILED'&&error.safeToContinue===true&&/unavailable/.test(error.message));assert.equal(fixture.recovery.length,0);
});

test('successful service guard remains active until resume and then verifies completion',async t=>{
  const fixture=await updateGuardFixture(t,{ready:true,done:true});const paused=await fixture.repair.updateServices('pause');assert.ok(paused.id);await fixture.repair.updateServices('resume',paused);assert.equal(fixture.recovery.length,0);
});

async function mixedCacheFixture(t,updateServices,runningProcesses=async()=>[]){
  const directory=await folder(t);const environment={LOCALAPPDATA:path.join(directory,'local'),APPDATA:path.join(directory,'roaming'),SystemRoot:path.join(directory,'windows')};
  const temp=path.join(environment.LOCALAPPDATA,'Temp','old.tmp');const update=path.join(environment.SystemRoot,'SoftwareDistribution','Download','update.cache');const discord=path.join(environment.APPDATA,'discord','Cache','cache.bin');
  for(const file of[temp,update,discord]){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'cache');const ago=new Date(Date.now()-2*86_400_000);await fs.utimes(file,ago,ago);}
  const jobs=createJobs();const cleaner=createCleaner({jobs,environment,runningProcesses,confirm:async()=>true,updateServices});return{temp,update,discord,jobs,cleaner};
}

test('busy update services skip only update downloads and still clean other selected caches',async t=>{
  const fixture=await mixedCacheFixture(t,async()=>{const error=new ProfileError('Windows Update is busy','SERVICE_FAILED');error.safeToContinue=true;throw error;});
  const scan=(await finished(fixture.jobs,fixture.cleaner.scan(['temp','windows-update']))).result;const job=await finished(fixture.jobs,await fixture.cleaner.clean(scan.scanId,['temp','windows-update']));
  assert.equal(job.status,'completed');assert.equal(job.result.removed,1);assert.equal(job.result.skippedCount,1);assert.equal(job.result.skippedCategories[0].id,'windows-update');assert.equal(await fs.readFile(fixture.update,'utf8'),'cache');await assert.rejects(fs.access(fixture.temp),{code:'ENOENT'});assert.match(job.log.join('\n'),/Skipped Windows Update/);
});

test('unresolved service recovery blocks deletion instead of silently continuing',async t=>{
  const fixture=await mixedCacheFixture(t,async()=>{throw new ProfileError('Recovery required','RECOVERY_REQUIRED');});const scan=(await finished(fixture.jobs,fixture.cleaner.scan(['temp','windows-update']))).result;
  const job=await finished(fixture.jobs,await fixture.cleaner.clean(scan.scanId,['temp','windows-update']));assert.equal(job.status,'failed');assert.equal(await fs.readFile(fixture.temp,'utf8'),'cache');assert.equal(await fs.readFile(fixture.update,'utf8'),'cache');
});

test('launcher starting after scan skips its cache without aborting unrelated cleanup',async t=>{
  let calls=0;const fixture=await mixedCacheFixture(t,async()=>{throw Error('No update guard expected');},async()=>calls++?['Discord']:[]);const scan=(await finished(fixture.jobs,fixture.cleaner.scan(['temp','discord']))).result;
  const job=await finished(fixture.jobs,await fixture.cleaner.clean(scan.scanId,['temp','discord']));assert.equal(job.status,'completed');assert.equal(job.result.removed,1);assert.equal(job.result.skippedCategories[0].id,'discord');assert.equal(await fs.readFile(fixture.discord,'utf8'),'cache');
});

test('cancelling cleanup after pausing services still resumes them',async t=>{
  const calls=[];let fixture,reference;
  fixture=await mixedCacheFixture(t,async action=>{calls.push(action);if(action==='pause'){await fixture.jobs.cancel(reference.id);return{id:'fixture'};}});
  const scan=(await finished(fixture.jobs,fixture.cleaner.scan(['windows-update']))).result;reference=await fixture.cleaner.clean(scan.scanId,['windows-update']);const job=await finished(fixture.jobs,reference);assert.equal(job.status,'cancelled');assert.deepEqual(calls,['pause','resume']);assert.equal(await fs.readFile(fixture.update,'utf8'),'cache');
});

test('PowerShell recovery enumerates both journal entries without invoking real services',{skip:process.platform!=='win32'},async t=>{
  const directory=await folder(t);const script=path.join(directory,'repair-tools.ps1');const journal=path.join(directory,'services.json');const payload=path.join(directory,'payload.json');const log=path.join(directory,'calls.txt');
  await fs.copyFile(path.resolve(__dirname,'..','src','powershell','repair-tools.ps1'),script);
  await fs.writeFile(journal,JSON.stringify([{name:'wuauserv',running:true},{name:'BITS',running:true}]));await fs.writeFile(payload,JSON.stringify({journal,log,identity:{}}));
  await fs.writeFile(path.join(directory,'common.ps1'),[
    "$ErrorActionPreference='Stop'",
    'function Read-Payload([string]$Path){$data=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json;$script:testLog=$data.log;return $data}',
    'function Assert-Context($Expected){return $null}',
    'function Get-Service { [CmdletBinding()] param([string]$Name)',
    "if($Name -notin @('wuauserv','BITS')){throw 'Unexpected fixture service'}",
    '[IO.File]::AppendAllText($script:testLog,$Name+[Environment]::NewLine)',
    "$service=[pscustomobject]@{Status='Running'}",
    "Add-Member -InputObject $service -MemberType ScriptMethod -Name Refresh -Value {}",
    'return $service',
    '}'
  ].join('\n'));
  await runFile(windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Action','updateRecovery','-PayloadPath',payload]);
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split(/\r?\n/),['wuauserv','BITS']);
});

const artworkPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
test('artwork accepts raster formats and rejects scripts and unapproved network hosts',async()=>{
  assert.equal(imageMime(artworkPng),'image/png');assert.equal(imageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),null);
  await assert.rejects(downloadImage('http://shared.fastly.steamstatic.com/test'),/Unsupported artwork source/);await assert.rejects(downloadImage('https://example.com/image.png'),/Unsupported artwork source/);
});

test('Steam artwork requests coalesce, persist locally and never expose arbitrary URLs',async t=>{
  const directory=await folder(t);let calls=0;const media=createMedia({directory,fetchImage:async url=>{calls++;assert.match(url,/^https:\/\/shared\.fastly\.steamstatic\.com\/store_item_assets\/steam\/apps\/730\/library_600x900\.jpg$/);await new Promise(resolve=>setTimeout(resolve,20));return artworkPng;}});
  const result=await Promise.all(Array.from({length:6},()=>media.artwork({id:'steam-730'})));assert.equal(calls,1);assert.ok(result.every(item=>item.image.startsWith('data:image/png;')));
  const offline=createMedia({directory,fetchImage:async()=>{throw Error('Network must not run for cached art');}});assert.equal((await offline.artwork({id:'steam-730'},false)).source,'Steam artwork cache');
});

test('local Steam posters load without network and custom artwork supersedes in-flight downloads',async t=>{
  const directory=await folder(t);const library=path.join(directory,'library');await fs.mkdir(library);await fs.writeFile(path.join(library,'730_library_600x900.jpg'),artworkPng);let network=0;
  const local=createMedia({directory:path.join(directory,'cache'),fetchImage:async()=>{network++;return artworkPng;}});assert.equal((await local.artwork({id:'steam-730',artRoots:[library]},false)).source,'Installed Steam library');assert.equal(network,0);
  let release;let started;const ready=new Promise(resolve=>{started=resolve;});const custom=path.join(directory,'custom.png');const customBytes=Buffer.concat([artworkPng,Buffer.from('custom')]);await fs.writeFile(custom,customBytes);
  const media=createMedia({directory:path.join(directory,'other'),chooseArtwork:async()=>custom,fetchImage:async()=>{started();return new Promise(resolve=>{release=()=>resolve(artworkPng);});}});const old=media.artwork({id:'steam-123'});await ready;await media.importArtwork({id:'steam-123'});const current=await media.artwork({id:'steam-123'});assert.equal(current.source,'Custom artwork');release();await old;assert.equal((await media.artwork({id:'steam-123'})).image,current.image);
});

test('artwork import rejects oversized or executable content and non-Steam IDs never trigger downloads',async t=>{
  const directory=await folder(t);const bad=path.join(directory,'image.svg');await fs.writeFile(bad,'<svg>bad</svg>');let network=0;const media=createMedia({directory:path.join(directory,'cache'),chooseArtwork:async()=>bad,fetchImage:async()=>{network++;return artworkPng;}});
  await assert.rejects(media.importArtwork({id:'manual-one'}),{code:'INVALID_IMAGE'});await media.artwork({id:'steam-../../outside'});assert.equal(network,0);
  await fs.writeFile(bad,Buffer.concat([artworkPng,Buffer.alloc(2*1024*1024)]));await assert.rejects(media.importArtwork({id:'manual-one'}),{code:'INVALID_IMAGE'});
});

test('MTU matching and previews preserve separate active and persistent states',()=>{
  const definition={label:'MTU',target:{type:'mtu',value:1400}};const state={active:1500,persistent:1492};assert.equal(matchesSetting(definition,state),false);const preview=buildReview(definition,state);assert.equal(preview.changes[0].current,'1500');assert.equal(preview.changes[1].current,'1492');assert.equal(matchesSetting(definition,{active:1400,persistent:1400}),true);assert.equal(matchesSetting(definition,{active:1400,persistent:1492}),false);
});

test('module reads coalesce, respect explicit refresh and reject protected process actions',async t=>{
  const directory=await folder(t);let inspections=0;let closeCalls=0;
  const workbench=createWorkbench({directory,profiles:{isBusy:()=>false},identity:async()=>({}),logger:{info:async()=>{},error:async()=>{}},dialogs:{confirm:async()=>true},openUri:async()=>{},trash:async()=>{},windowsScripts:{run:async(_script,action)=>{if(action==='Inspect'){inspections++;await new Promise(resolve=>setTimeout(resolve,10));return{items:[]};}if(action==='Processes')return[{pid:123,ticks:'456',name:'explorer',canClose:false}];if(action==='Close')closeCalls++;return{};}}});
  await Promise.all([workbench.call('page',{page:'services'}),workbench.call('page',{page:'services'})]);assert.equal(inspections,1);await workbench.call('page',{page:'services',force:true});assert.equal(inspections,2);
  await workbench.call('page',{page:'processes'});await assert.rejects(workbench.call('closeApp',{pid:123,ticks:'456'}),{code:'INVALID_ACTION'});assert.equal(closeCalls,0);await assert.rejects(workbench.call('nativeTool',{id:'arbitrary-command'}),{code:'INVALID_ACTION'});await assert.rejects(workbench.call('__proto__',{}),{code:'INVALID_REQUEST'});
});

test('PowerShell MTU apply and restore preserve different policy-store values',{skip:process.platform!=='win32'},async t=>{
  const directory=await folder(t);const script=path.join(directory,'managed-actions.ps1');const stateFile=path.join(directory,'state.json');const payload=path.join(directory,'payload.json');const guid='11111111-1111-4111-8111-111111111111';
  await fs.copyFile(path.resolve(__dirname,'..','src','powershell','managed-actions.ps1'),script);await fs.writeFile(stateFile,JSON.stringify({ActiveStore:1500,PersistentStore:1492}));
  await fs.writeFile(path.join(directory,'common.ps1'),[
    "$ErrorActionPreference='Stop'",
    'function Read-Payload([string]$Path){$data=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json;$script:stateFile=$data.stateFile;return $data}',
    'function Assert-Context($Expected){return $null}',
    'function Get-NetAdapter { [CmdletBinding()] param() return [pscustomobject]@{InterfaceGuid=[guid]"'+guid+'";ifIndex=7} }',
    'function Get-NetIPInterface { [CmdletBinding()] param($InterfaceIndex,$AddressFamily,$PolicyStore) $state=Get-Content -LiteralPath $script:stateFile -Raw|ConvertFrom-Json;return [pscustomobject]@{NlMtu=$state.$PolicyStore} }',
    'function Set-NetIPInterface { [CmdletBinding()] param($InterfaceIndex,$AddressFamily,$PolicyStore,$NlMtuBytes) if($InterfaceIndex -ne 7){throw "Unexpected adapter"};$state=Get-Content -LiteralPath $script:stateFile -Raw|ConvertFrom-Json;$state.$PolicyStore=$NlMtuBytes;[IO.File]::WriteAllText($script:stateFile,($state|ConvertTo-Json -Compress)) }'
  ].join('\n'));
  await fs.writeFile(payload,JSON.stringify({stateFile,target:{type:'mtu',guid,value:1400},identity:{},original:{active:1500,persistent:1492}}));
  const args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-PayloadPath',payload,'-Action'];const powershell=windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe');
  await runFile(powershell,[...args,'Apply']);assert.deepEqual(JSON.parse(await fs.readFile(stateFile,'utf8')),{ActiveStore:1400,PersistentStore:1400});await runFile(powershell,[...args,'Restore']);assert.deepEqual(JSON.parse(await fs.readFile(stateFile,'utf8')),{ActiveStore:1500,PersistentStore:1492});
});
