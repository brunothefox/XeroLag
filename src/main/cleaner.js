'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { walk, verifyPath } = require('./files');
const { ProfileError } = require('./profile-state');

function cacheDefinitions(environment = process.env) {
  const local = environment.LOCALAPPDATA;
  const roaming = environment.APPDATA;
  const windows = environment.SystemRoot;
  if (!local || !roaming || !windows) throw new ProfileError('Windows cache locations are unavailable.', 'UNSUPPORTED');
  const root = (base, ...parts) => path.join(base, ...parts);
  return [
    { id:'temp', label:'User temporary files', risk:'Safe', age:86_400_000, roots:[root(local,'Temp')] },
    { id:'windows-temp', label:'Windows temporary files', risk:'Moderate', age:86_400_000, roots:[root(windows,'Temp')] },
    { id:'prefetch', label:'Prefetch', risk:'Advanced', age:86_400_000, roots:[root(windows,'Prefetch')], pattern:'\\.pf$' },
    { id:'windows-update', label:'Windows Update downloads', risk:'Advanced', roots:[root(windows,'SoftwareDistribution','Download')], guard:['TiWorker','TrustedInstaller','MoUsoCoreWorker'], update:true },
    { id:'explorer-cache', label:'Thumbnail and icon caches', risk:'Safe', roots:[root(local,'Microsoft','Windows','Explorer')], files:[root(local,'IconCache.db')], pattern:'^(thumbcache_|iconcache_).*\\.db$' },
    { id:'directx', label:'DirectX shaders', risk:'Safe', roots:[root(local,'D3DSCache')] },
    { id:'nvidia', label:'NVIDIA shaders', risk:'Safe', roots:[root(local,'NVIDIA','DXCache'),root(local,'NVIDIA','GLCache'),root(local,'..','LocalLow','NVIDIA','PerDriverVersion','DXCache')] },
    { id:'amd', label:'AMD shaders', risk:'Safe', roots:['DxCache','DxcCache','GLCache','VkCache'].map(name=>root(local,'AMD',name)) },
    { id:'discord', label:'Discord caches', risk:'Safe', roots:['discord','discordcanary','discordptb'].flatMap(app=>['Cache','Code Cache','GPUCache'].map(name=>root(roaming,app,name))), guard:['Discord','DiscordCanary','DiscordPTB'] },
    { id:'chrome',label:'Chrome caches',risk:'Safe',roots:[],discoverBrowser:root(local,'Google','Chrome','User Data'),guard:['chrome'] },
    { id:'edge',label:'Microsoft Edge caches',risk:'Safe',roots:[],discoverBrowser:root(local,'Microsoft','Edge','User Data'),guard:['msedge'] },
    { id:'firefox',label:'Firefox caches',risk:'Safe',roots:[],discoverBrowser:root(local,'Mozilla','Firefox','Profiles'),firefox:true,guard:['firefox'] },
    { id:'steam-web', label:'Steam web cache', risk:'Safe', roots:[root(local,'Steam','htmlcache','Cache'),root(local,'Steam','htmlcache','Code Cache'),root(local,'Steam','htmlcache','GPUCache')], guard:['steam','steamwebhelper'] },
    { id:'epic', label:'Epic Games web caches', risk:'Safe', roots:[], discoverEpic:root(local,'EpicGamesLauncher','Saved'), guard:['EpicGamesLauncher','EpicWebHelper'] },
    { id:'riot', label:'Riot and VALORANT logs', risk:'Safe', roots:[root(local,'Riot Games','Riot Client','Logs'),root(local,'VALORANT','Saved','Logs')], guard:['RiotClientServices','VALORANT-Win64-Shipping'] },
    { id:'roblox', label:'Roblox logs and HTTP cache', risk:'Safe', roots:[root(local,'Roblox','logs'),root(local,'Temp','Roblox','http')], guard:['RobloxPlayerBeta','RobloxStudioBeta'] }
  ];
}

function createCleaner({ jobs, runningProcesses, confirm, updateServices, environment, extraSteamRoots = async () => [] }) {
  const scans = new Map();
  const definitions = cacheDefinitions(environment);
  async function targets() {
    const result = structuredClone(definitions);
    const steamRoots = await extraSteamRoots();
    result.push({ id:'steam-downloads',label:'Steam partial downloads',risk:'Advanced',roots:steamRoots.flatMap(root=>[path.join(root,'depotcache'),path.join(root,'steamapps','downloading')]),guard:['steam','steamwebhelper'] });
    for (const target of result.filter(item=>item.discoverEpic)) {
      try { for (const name of await fs.readdir(target.discoverEpic)) if (/^webcache(?:_\d+)?$/.test(name)) for (const part of ['Cache','Code Cache','GPUCache']) target.roots.push(path.join(target.discoverEpic,name,part)); } catch {}
    }
    for(const target of result.filter(item=>item.discoverBrowser)){
      try{for(const name of(await fs.readdir(target.discoverBrowser)).slice(0,100)){if(target.firefox){target.roots.push(path.join(target.discoverBrowser,name,'cache2'));}else if(name==='Default'||/^Profile \d+$/.test(name)){for(const directory of['Cache','Code Cache','GPUCache'])target.roots.push(path.join(target.discoverBrowser,name,directory));}}}catch{}
    }
    return result.filter(item=>!item.discoverBrowser||item.roots.length);
  }
  function scan(ids) {
    if (!Array.isArray(ids) || ids.length > 30 || ids.some(id=>typeof id!=='string')) throw new ProfileError('Invalid cache selection.', 'INVALID_SELECTION');
    return jobs.start('Scan caches', async context => {
      const available = await targets();
      if (ids.some(id=>!available.some(item=>item.id===id))) throw new ProfileError('Unknown cache category.', 'INVALID_SELECTION');
      const processes = await runningProcesses();
      const manifest = [];
      const categories = [];
      const visited = new Set();
      for (const target of available.filter(item=>ids.includes(item.id))) {
        context.check();
        const blocked = target.guard?.filter(name=>processes.some(process=>process.toLowerCase()===name.toLowerCase())) || [];
        if (blocked.length) { categories.push({ id:target.id,label:target.label,bytes:0,count:0,blocked:'Close '+blocked.join(', ') }); continue; }
        let bytes=0,count=0,skipped=0;
        const filter = target.pattern ? new RegExp(target.pattern,'i') : null;
        for(const file of target.files||[]){
          try{
            const stat=await fs.lstat(file);const root=path.dirname(file);
            if(!stat.isFile()||stat.isSymbolicLink())continue;
            await verifyPath(root,file,{ino:stat.ino,dev:stat.dev,size:stat.size,mtimeMs:stat.mtimeMs});
            const canonical=path.resolve(file).toLowerCase();if(visited.has(canonical))continue;visited.add(canonical);
            manifest.push({category:target.id,root,file,stamp:{ino:stat.ino,dev:stat.dev,size:stat.size,mtimeMs:stat.mtimeMs},update:false});count++;bytes+=stat.size;
          }catch(error){if(error.code!=='ENOENT')skipped++;}
        }
        for (const candidate of target.roots) {
          try {
            const stat = await fs.lstat(candidate);
            if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
            const root = path.resolve(candidate);
            if (root === path.parse(root).root) throw new Error('A cache root cannot be a drive root.');
            const result = await walk(root,context,async(file,stat,empty)=>{
              if (empty || !stat.isFile() || filter&&!filter.test(path.basename(file)) || target.age&&Date.now()-stat.mtimeMs<target.age || /(?:cookies?|login|credential|tokens?|auth|local[ _-]?storage|session[ _-]?storage|leveldb)/i.test(path.relative(root,file))) return;
              const canonical=path.resolve(file).toLowerCase();
              if(visited.has(canonical))return;
              visited.add(canonical);
              manifest.push({ category:target.id,root,file,stamp:{ino:stat.ino,dev:stat.dev,size:stat.size,mtimeMs:stat.mtimeMs},update:Boolean(target.update) });
              count++;bytes+=stat.size;
            },100_000);
            skipped+=result.skipped;
          } catch(error) { if(error.code==='CANCELLED')throw error; skipped++; }
        }
        categories.push({id:target.id,label:target.label,bytes,count,skipped,risk:target.risk});
        context.log(target.label+': '+count+' files');
      }
      const id=randomUUID();
      if(scans.size>=4)scans.delete(scans.keys().next().value);
      scans.set(id,{manifest,createdAt:Date.now(),categories});
      return {scanId:id,categories,bytes:categories.reduce((sum,item)=>sum+item.bytes,0),count:manifest.length};
    });
  }
  async function clean(scanId,ids) {
    const scan=scans.get(scanId);
    if(!scan||Date.now()-scan.createdAt>15*60_000||!Array.isArray(ids)||ids.some(id=>!scan.categories.some(item=>item.id===id)))throw new ProfileError('The scan expired. Scan again before cleaning.', 'INVALID_SCAN');
    const selected=scan.manifest.filter(item=>ids.includes(item.category));
    if(!selected.length)throw new ProfileError('No cache files were selected.', 'EMPTY_SELECTION');
    if(!await confirm('Permanently remove '+selected.length+' scanned cache files? Caches regenerate and cannot be undeleted by XeroLag.'))return {cancelled:true};
    return jobs.start('Clean caches',async context=>{
      let serviceState=null,removed=0,bytes=0;
      const skipped=[];const skippedCategories=[];const blockedCategories=new Set();let skippedCategoryFiles=0;
      const skipCategory=(id,reason)=>{if(blockedCategories.has(id))return;blockedCategories.add(id);const count=selected.filter(item=>item.category===id).length;skippedCategoryFiles+=count;const label=scan.categories.find(item=>item.id===id)?.label||id;skippedCategories.push({id,label,reason,count});context.log('Skipped '+label+': '+reason);};
      try {
        const current=await runningProcesses();const definitions=await targets();
        for(const target of definitions.filter(target=>ids.includes(target.id))){const running=target.guard?.filter(name=>current.some(process=>process.toLowerCase()===name.toLowerCase()))||[];if(running.length)skipCategory(target.id,'Close '+running.join(', ')+' and scan again.');}
        if(selected.some(item=>item.update&&!blockedCategories.has(item.category))){
          try{serviceState=await updateServices('pause');}
          catch(error){if(!error.safeToContinue)throw error;skipCategory('windows-update',error.message+' Try again when Windows Update is idle.');}
        }
        for(const item of selected) {
          context.check();
          if(blockedCategories.has(item.category))continue;
          try { await verifyPath(item.root,item.file,item.stamp);await fs.unlink(item.file);removed++;bytes+=item.stamp.size; }
          catch(error){skipped.push({path:item.file,error:error.message});}
          if(removed%100===0)context.update({removed,bytes,skipped:skipped.length});
        }
      } finally { if(serviceState)await updateServices('resume',serviceState); }
      scans.delete(scanId);
      return {removed,bytes,skipped:skipped.slice(0,500),skippedCount:skipped.length+skippedCategoryFiles,skippedCategories};
    },'clean');
  }
  return {list:async()=> (await targets()).map(({id,label,risk})=>({id,label,risk})),scan,clean};
}

module.exports={cacheDefinitions,createCleaner};
