'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {createJobs}=require('./jobs');
const {createWindowsScript}=require('./windows-script');
const {createOperations}=require('./operations');
const {createCleaner}=require('./cleaner');
const {createFileFinder}=require('./files');
const {createGames}=require('./games');
const {createRepair}=require('./repair');
const {createBooster}=require('./booster');
const {createStartupFiles}=require('./startup-files');
const {parseMarkC}=require('./markc');
const {ProfileError}=require('./profile-state');
const {matchesSetting}=require('./action-review');
const {createMedia}=require('./media');
const {createNativeTools}=require('./native-tools');
const catalog=require('./action-catalog.json');

function createWorkbench({directory,profiles,identity,logger,dialogs,openUri,trash,getFileIcon,windowsScripts}){
  const jobs=createJobs();const scripts=windowsScripts||createWindowsScript(directory);
  const managed=new Map();let operations,booster;let startupWarnings=[];
  const games=createGames({directory,scripts,openUri,profiles,chooseExecutable:()=>dialogs.executable()});
  const media=createMedia({directory:path.join(directory,'artwork'),getFileIcon,chooseArtwork:()=>dialogs.artwork?.()});
  const nativeTools=createNativeTools(openUri);const pageCache=new Map();const pagePending=new Map();let latestProcesses=[];
  const repair=createRepair({directory,jobs,scripts,identity,profiles,confirm:dialogs.confirm,blocked:id=>operations.isBusy()||profiles.isBusy()||id!=='standby'&&booster.isRunning()||booster.isBusy()});
  operations=createOperations({directory,scripts,profiles,identity,logger,requireReview:true});
  booster=createBooster({directory,scripts,identity,games,profiles});
  const startupFiles=createStartupFiles({directory,identity});
  operations.register('managed','managed-actions.ps1',[]);
  operations.registerRunner('startup-files',startupFiles.run,[]);
  const cleaner=createCleaner({jobs,runningProcesses:()=>scripts.run('discovery.ps1','Processes'),confirm:dialogs.confirm,updateServices:repair.updateServices,extraSteamRoots:async()=>{if(!games.roots().length)await games.scan();return games.roots();}});
  const files=createFileFinder({jobs,chooseFolder:()=>dialogs.folder(),trash,confirm:dialogs.confirm});
  function ensureIdle(){if(startupWarnings.length)throw new ProfileError('An earlier background session needs recovery. Open Repair → Recovery.','RECOVERY_REQUIRED');if(operations.isBusy()||profiles.isBusy()||jobs.isBusy('system')||jobs.isBusy('clean')||booster.isRunning()||booster.isBusy())throw new ProfileError('Stop the booster or finish the current Windows operation first.','BUSY');}
  function publish(items){for(const item of items)managed.set(item.id,item);operations.register('managed','managed-actions.ps1',[...managed.values()]);return items.filter(item=>!item.hidden).map(({target,...item})=>item);}
  const key=target=>createHash('sha256').update(JSON.stringify(target)).digest('hex').slice(0,24);
  function managedItem(target,label,group,risk='Moderate',extra={}){return{id:target.type+'-'+key(target),label,group,risk,target,...extra};}
  async function readPage(page){
    if(page==='registry'){const data=await operations.inspect('system');return{entries:catalog.filter(item=>item.type==='registry'&&!item.hidden).flatMap(definition=>definition.entries.map((entry,index)=>({id:definition.id,label:definition.label,group:definition.group,hive:entry.hive,key:entry.key,name:entry.name,...data.items.find(item=>item.id===definition.id)?.state?.values?.[index]})))};}
    if(page==='tools')return{tools:await nativeTools.list()};
    if(page==='processes'){latestProcesses=await scripts.run('experience.ps1','Processes',{parentPid:process.pid});return{processes:latestProcesses.map(({executable,...item})=>item)};}
    if(['gaming','shell','services'].includes(page)){const data=await operations.inspect('system');return{...data,definitions:data.definitions.filter(item=>item.group===page&&!item.hidden),items:data.items.filter(item=>data.definitions.some(def=>def.id===item.id&&def.group===page&&!def.hidden))};}
    if(page==='devices'){
      const devices=await scripts.run('discovery.ps1','Devices');
      const definitions=publish(devices.flatMap(device=>{
        const scope='msi-'+key({device:device.device});
        const items=[['high',true,true,'MSI · high priority'],['driver',true,false,'MSI · driver priority'],['legacy',false,false,'Legacy interrupts']].map(([mode,msi,highPriority,label],index)=>managedItem({type:'msi',device:device.device,msi,highPriority},device.name,'devices','Advanced',{scope,reapply:true,hidden:index!==0,supported:device.supported,description:({Net:'Network',Display:'Graphics',USB:'USB'})[device.class]+' controller',restart:true,current:device.msi?(device.priority===3?'high':'driver'):'legacy',choiceMode:mode,choiceLabel:label}));
        items[0].choices=items.map(item=>({id:item.id,label:item.choiceLabel,value:item.choiceMode}));items[0].choiceMatches=Object.fromEntries(items.map(item=>[item.id,device.supported&&device.msi===item.target.msi&&(item.target.highPriority?device.priority===3:device.priority===null)]));return items;
      }));
      return{definitions,devices,records:await operations.history()};
    }
    if(page==='network'){
      const adapters=await scripts.run('discovery.ps1','Adapters');const list=[];
      for(const adapter of adapters){
        try{const state=await scripts.run('managed-actions.ps1','Preview',{target:{type:'mtu',guid:adapter.guid}});const variants=[1280,1400,1472,1492,1500].map((value,index)=>managedItem({type:'mtu',guid:adapter.guid,value},'IPv4 MTU','network','Advanced',{adapter:adapter.guid,scope:'mtu-'+adapter.guid,reapply:true,hidden:index!==0,current:state.active,description:'Lower MTU only for a known tunnel or ISP requirement. Original active and persistent values are saved.'}));variants[0].choices=variants.map(item=>({id:item.id,label:String(item.target.value)+' bytes',value:item.target.value}));variants[0].choiceMatches=Object.fromEntries(variants.map(item=>[item.id,matchesSetting(item,state)]));list.push(...variants);}catch{}
        const dnsState=await scripts.run('managed-actions.ps1','Preview',{target:{type:'dns',guid:adapter.guid}});
        for(const provider of ['cloudflare','google','quad9','default']){const item=managedItem({type:'dns',guid:adapter.guid,provider},adapter.name+' · '+({cloudflare:'Cloudflare',google:'Google',quad9:'Quad9',default:'Automatic DNS'})[provider],'network','Moderate',{adapter:adapter.guid,provider,scope:'dns-'+adapter.guid,reapply:true});item.matches=matchesSetting(item,dnsState);list.push(item);}
        const before=await scripts.run('managed-actions.ps1','Capture',{target:{type:'nagle',guid:adapter.guid}});
        const off=managedItem({type:'nagle',guid:adapter.guid,disabled:true},'Nagle’s algorithm','network','Advanced',{adapter:adapter.guid,restart:true,reapply:true,scope:'nagle-'+adapter.guid,current:before.values[1].exists&&before.values[1].value===1?'off':'on',description:'TCP only; applications can override socket options.'});
        const on=managedItem({type:'nagle',guid:adapter.guid,disabled:false},off.label,'network','Advanced',{adapter:adapter.guid,restart:true,reapply:true,scope:off.scope,hidden:true});off.choices=[{id:off.id,label:'Off',value:'off'},{id:on.id,label:'On',value:'on'}];off.choiceMatches={[off.id]:matchesSetting(off,before),[on.id]:matchesSetting(on,before)};off.current=off.choiceMatches[off.id]?'off':off.choiceMatches[on.id]?'on':null;off.currentLabel=before.values.every(value=>!value.exists)?'Windows default':off.current?'': 'Custom';list.push(off,on);
      }
      const fixed=await operations.inspect('system');return{adapters,definitions:publish(list),system:fixed.definitions.filter(item=>item.group==='network'&&!item.hidden),items:fixed.items,records:await operations.history()};
    }
    if(page==='startup'){
      const entries=await scripts.run('discovery.ps1','Startup');const definitions=publish(entries.map(entry=>{
        const item=managedItem({...entry,enable:!entry.enabled},entry.label,'startup',entry.risk,{description:entry.command,source:entry.type==='startup-task'?'Scheduled task':entry.hive==='HKLM'?'All users':'This user',enabled:entry.enabled,actionLabel:entry.enabled?'Disable':'Enable'});
        item.id=entry.type+'-'+key({type:entry.type,hive:entry.hive,key:entry.key,name:entry.name,taskName:entry.taskName,taskPath:entry.taskPath});return item;
      }));
      const folders=await startupFiles.discover();operations.registerRunner('startup-files',startupFiles.run,folders);
      const disabled=[];for(const saved of await operations.activeDetails(['managed:startup-','startup-files:'])){
        if(definitions.some(item=>item.id===saved.data.action)||folders.some(item=>item.id===saved.data.action))continue;
        disabled.push({id:saved.data.action,label:saved.data.label,group:'startup',enabled:false,risk:'Moderate',restoreId:saved.record.id,source:saved.data.provider==='startup-files'?'Startup folder':saved.data.target?.hive==='HKLM'?'All users':'This user',description:saved.data.original.value?.value||saved.data.target?.name||'Saved startup entry',provider:saved.data.provider});
      }
      const boot=await scripts.run('experience.ps1','Boot').catch(()=>({supported:false,applications:[]}));return{definitions:[...definitions,...disabled],folders:folders.map(({target,...item})=>item),records:await operations.history(),boot};
    }
    if(page==='debloat'){
      const packages=await scripts.run('discovery.ps1','Packages');return{definitions:publish(packages.map(item=>managedItem(item,item.label,'debloat',item.risk,{description:item.type==='appx'?'Remove this account’s package registration; reinstall may be required':item.type==='onedrive'?'Uninstall OneDrive and stop syncing; local files are retained':'Disable the Windows Recall optional feature',restart:item.type==='recall',timeout:600_000}))),records:await operations.history()};
    }
    if(page==='games'){return{games:await games.scan()};}
    if(page==='booster'){return{status:await booster.status(),games:games.list().length?games.list():await games.scan(),power:(await repair.capabilities()).power};}
    if(page==='cleaner')return{categories:await cleaner.list()};
    if(page==='files')return{};
    if(page==='repair')return{tools:repair.tools,capabilities:await repair.capabilities(),jobs:jobs.list()};
    if(page==='recovery')return{records:await operations.history(),profiles:await profiles.status(),warnings:startupWarnings};
    throw new ProfileError('Unknown module.','INVALID_PAGE');
  }
  async function getPage(page,force=false){
    const saved=pageCache.get(page);if(!force&&saved&&Date.now()-saved.time<15_000)return saved.data;
    if(pagePending.has(page))return pagePending.get(page);
    const pending=readPage(page).then(data=>{pageCache.set(page,{data,time:Date.now()});return data;}).finally(()=>pagePending.delete(page));pagePending.set(page,pending);return pending;
  }
  const methods={
    page:args=>getPage(args.page,args.force===true),
    artwork:args=>media.artwork(games.get(args.id),args.online!==false),
    importArtwork:args=>media.importArtwork(games.get(args.id)),
    itemIcon:async args=>{const item=managed.get(args.id);if(!item||item.group!=='startup')return null;const command=item.description||'';const match=command.match(/^\s*(?:"([^"\r\n]+\.exe)"|([^"\r\n]+?\.exe))(?:\s|$)/i);return match?media.icon(match[1]||match[2]):null;},
    sourceIcon:async args=>{
      const pf=process.env.ProgramFiles||'C:\\Program Files';const sources={nvidia:[path.join(pf,'NVIDIA Corporation','NVIDIA app','CEF','NVIDIA app.exe'),path.join(pf,'NVIDIA Corporation','NvContainer','nvcontainer.exe')],amd:[path.join(pf,'AMD','CNext','CNext','RadeonSoftware.exe')],steam:games.roots().map(root=>path.join(root,'steam.exe')),windows:[path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe')]};
      for(const file of sources[args.id]||[]){const icon=await media.icon(file);if(icon)return icon;}return null;
    },
    nativeTool:args=>nativeTools.open(args.id),
    permissions:async()=>{ensureIdle();const folder=await dialogs.folder();if(!folder)return{cancelled:true};return repair.start('permissions',null,folder);},
    networkInfo:args=>scripts.run('experience.ps1','Network',{guid:args.guid}),
    networkProbe:()=>scripts.run('experience.ps1','Probe',{}, {timeout:15_000}),
    restartAdapter:async args=>{ensureIdle();if(!await dialogs.confirm('Restart this network adapter? Active downloads and calls may disconnect briefly.'))return{cancelled:true};return jobs.start('Restart network adapter',async context=>{context.onCancel(false);return scripts.run('experience.ps1','Restart',{guid:args.guid,identity:await identity()});},'system');},
    closeApp:async args=>{ensureIdle();const item=latestProcesses.find(item=>item.pid===args.pid&&item.ticks===args.ticks&&item.canClose);if(!item)throw new ProfileError('Refresh the process list before closing this app.','INVALID_ACTION');if(!await dialogs.confirm('Ask '+item.name+' to close? Save any open work first.'))return{cancelled:true};return scripts.run('experience.ps1','Close',{pid:item.pid,ticks:item.ticks,parentPid:process.pid,identity:await identity()});},
    preview:args=>operations.preview(args.provider,args.id),
    apply:async args=>{ensureIdle();return operations.apply(args.provider,args.id,args.token);},
    restore:async args=>{ensureIdle();return operations.restore(args.id);},
    restoreAll:async()=>{ensureIdle();if(!await dialogs.confirm('Restore all saved XeroLag settings in reverse order? Deleted caches and repair operations are not included.'))return{cancelled:true};return operations.restoreAll();},
    scanCaches:args=>cleaner.scan(args.ids),
    cleanCaches:args=>{ensureIdle();return cleaner.clean(args.scanId,args.ids);},
    chooseFolder:()=>files.choose(),
    scanFiles:args=>files.scan(args.rootId,args.mode),
    removeFiles:args=>files.remove(args.scanId,args.ids),
    job:args=>jobs.get(args.id),jobs:()=>jobs.list(),cancelJob:args=>jobs.cancel(args.id),
    addGame:()=>games.add(),launchGame:args=>{if(args.profile)ensureIdle();return games.launch(args.id,args.profile||null);},
    booster:async args=>{if(operations.isBusy()||profiles.isBusy()||jobs.isBusy('system'))throw new ProfileError('Finish the current Windows operation first.','BUSY');return booster.configure(args);},
    stopBooster:()=>booster.stop(),boosterStatus:()=>booster.status(),
    ping:()=>scripts.run('managed-actions.ps1','Ping',{}, {timeout:30_000}),
    flushDns:()=>scripts.run('managed-actions.ps1','Flush'),
    repair:args=>repair.start(args.id,args.drive),
    health:()=>repair.health(),
    importMarkC:async()=>{
      const file=await dialogs.preset();if(!file)return null;
      const values=parseMarkC(await fs.readFile(file));const target={type:'markc',values};const definition=managedItem(target,'MarkC · '+path.basename(file),'gaming','Advanced',{signOut:true,description:'Imported mouse curves. Use a preset that matches Windows display scaling.'});publish([definition]);return{id:definition.id,label:definition.label};
    },
    markcSource:()=>openUri('https://donewmouseaccel.blogspot.com/2010/03/markc-windows-7-mouse-acceleration-fix.html'),
    openStore:async args=>{
      const target=managed.get(args.id)?.target||(await operations.record(args.id)).target;if(target?.type!=='appx'||!/^[a-z0-9_.-]+_[a-z0-9]+$/i.test(target.family))throw new ProfileError('Select an application from the package list.','INVALID_SELECTION');
      return openUri('ms-windows-store://pdp/?PFN='+encodeURIComponent(target.family));
    },
    openRecovery:()=>dialogs.openRecovery(),
    systemRestore:()=>dialogs.systemRestore()
    ,recoverWorker:async()=>{const errors=[];for(const recover of[repair.recoverUpdateServices,booster.recover]){try{await recover();}catch(error){errors.push(error.message);}}startupWarnings=errors;if(errors.length)throw new ProfileError(errors.join('; '),'RECOVERY_REQUIRED');return{success:true};}
  };
  async function call(method,args={}){
    if(!Object.hasOwn(methods,method)||!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(JSON.stringify(args),'utf8')>256*1024)throw new ProfileError('Invalid module request.','INVALID_REQUEST');
    try{return await methods[method](args);}catch(error){if(error instanceof ProfileError)throw error;throw new ProfileError(error.message||'The operation failed.','OPERATION_FAILED');}finally{if(['apply','restore','restoreAll','addGame','closeApp','restartAdapter'].includes(method))pageCache.clear();}
  }
  return{call,isBusy:()=>operations.isBusy()||booster.isBusy()||jobs.isBusy('system')||jobs.isBusy('clean')||jobs.isBusy('files'),isBoosterRunning:booster.isRunning,
    stop:booster.stop,initialize:async()=>{for(const recover of[repair.recoverUpdateServices,booster.recover]){try{await recover();}catch(error){startupWarnings.push(error.message);await logger.error('Background recovery: '+error.message);}}},operations,jobs};
}

module.exports={createWorkbench};
