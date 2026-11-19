'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {within}=require('./files');
const {atomicJson}=require('./snapshot-store');
const {ProfileError}=require('./profile-state');

function parseVdf(text){
  if(typeof text!=='string'||text.length>4*1024*1024)throw new Error('Invalid VDF size.');
  const tokens=[];const expression=/\/\/[^\r\n]*|"((?:\\.|[^"\\])*)"|([{}])|([^\s{}"]+)/g;let match;
  while((match=expression.exec(text))){if(match[0].startsWith('//'))continue;tokens.push(match[2]||((match[1]??match[3]).replace(/\\(["\\])/g,'$1')));}
  let cursor=0;
  function object(depth=0){if(depth>32)throw new Error('VDF nesting limit.');const result=Object.create(null);while(cursor<tokens.length){const key=tokens[cursor++];if(key==='}')return result;if(key==='{')throw new Error('Invalid VDF key.');const value=tokens[cursor++];if(value===undefined||value==='}')throw new Error('Invalid VDF value.');result[key]=value==='{'?object(depth+1):value;}return result;}
  return object();
}

function createGames({directory,scripts,openUri,chooseExecutable,profiles}){
  const items=new Map();let libraries=[];
  const file=path.join(directory,'games.json');
  async function validDirectory(root){try{const stat=await fs.lstat(root);return stat.isDirectory()&&!stat.isSymbolicLink();}catch{return false;}}
  async function scan(){
    const found=[];const roots=await scripts.run('discovery.ps1','Roots');const clients=roots.steam||[];const all=new Set(clients);
    for(const root of clients){try{const data=parseVdf(await fs.readFile(path.join(root,'steamapps','libraryfolders.vdf'),'utf8'));for(const value of Object.values(data.libraryfolders||{})){const folder=typeof value==='string'?value:value.path;if(folder&&path.isAbsolute(folder))all.add(folder);}}catch{}}
    libraries=[...all].filter(root=>path.isAbsolute(root));
    for(const root of libraries){
      let manifests;try{manifests=await fs.readdir(path.join(root,'steamapps'));}catch{continue;}
      for(const name of manifests.filter(name=>/^appmanifest_\d+\.acf$/i.test(name))){
        try{const data=parseVdf(await fs.readFile(path.join(root,'steamapps',name),'utf8')).AppState;if(!data||!/^\d{1,12}$/.test(data.appid))continue;const common=path.join(root,'steamapps','common');const install=path.resolve(common,data.installdir||'');if(!within(common,install)||!await validDirectory(install))continue;found.push({id:'steam-'+data.appid,name:data.name||data.appid,launcher:'Steam',root:install,uri:'steam://rungameid/'+data.appid});}catch{}
      }
    }
    const epic=path.join(process.env.ProgramData||'C:\\ProgramData','Epic','EpicGamesLauncher','Data','Manifests');
    try{for(const name of (await fs.readdir(epic)).filter(name=>name.endsWith('.item'))){try{const data=JSON.parse(await fs.readFile(path.join(epic,name),'utf8'));if(typeof data.AppName!=='string'||data.AppName.length>300||!path.isAbsolute(data.InstallLocation)||!await validDirectory(data.InstallLocation))continue;const executable=data.LaunchExecutable?path.resolve(data.InstallLocation,data.LaunchExecutable):null;found.push({id:'epic-'+data.AppName,name:data.DisplayName||data.AppName,launcher:'Epic',root:data.InstallLocation,executable:executable&&within(data.InstallLocation,executable)?executable:null,uri:'com.epicgames.launcher://apps/'+encodeURIComponent(data.AppName)+'?action=launch&silent=true'});}catch{}}}catch{}
    const riotFile=path.join(process.env.ProgramData||'C:\\ProgramData','Riot Games','RiotClientInstalls.json');
    try{const data=JSON.parse(await fs.readFile(riotFile,'utf8'));const client=[data.rc_default,data.rc_live,...Object.values(data.associated_client||{})].find(value=>typeof value==='string'&&/RiotClientServices\.exe$/i.test(value));if(client){const locations=Object.keys(data.associated_client||{});for(const [product,label,marker]of [['valorant','VALORANT','VALORANT'],['league_of_legends','League of Legends','League']]){const location=locations.find(value=>value.toLowerCase().includes(marker.toLowerCase()));if(location){const root=path.extname(location)?path.dirname(location):location;if(await validDirectory(root))found.push({id:'riot-'+product,name:label,launcher:'Riot',root,executable:client,args:['--launch-product='+product,'--launch-patchline=live']});}}}}catch{}
    const versions=path.join(process.env.LOCALAPPDATA||'','Roblox','Versions');
    try{const versionsFound=[];for(const name of(await fs.readdir(versions)).filter(name=>/^version-[a-f0-9]+$/i.test(name))){const executable=path.join(versions,name,'RobloxPlayerBeta.exe');try{const stat=await fs.lstat(executable);if(stat.isFile()&&!stat.isSymbolicLink())versionsFound.push({executable,mtime:stat.mtimeMs});}catch{}}versionsFound.sort((a,b)=>b.mtime-a.mtime);if(versionsFound[0])found.push({id:'roblox-player',name:'Roblox',launcher:'Roblox',root:path.dirname(versionsFound[0].executable),executable:versionsFound[0].executable,args:['-app']});}catch{}
    try{const manual=JSON.parse(await fs.readFile(file,'utf8'));for(const game of manual){if(typeof game.id==='string'&&game.launcher==='Manual'&&typeof game.executable==='string'&&await validDirectory(game.root))found.push(game);}}catch{}
    items.clear();for(const game of found){if(game.launcher==='Steam')game.artRoots=clients.map(root=>path.join(root,'appcache','librarycache'));if(!items.has(game.id))items.set(game.id,game);}
    return list();
  }
  function list(){return[...items.values()].map(({args,uri,artRoots,...game})=>game).sort((a,b)=>a.name.localeCompare(b.name));}
  async function add(){
    const executable=await chooseExecutable();if(!executable)return null;
    if(!/\.exe$/i.test(executable)||/^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|msiexec|reg|taskkill)\.exe$/i.test(path.basename(executable))||process.env.SystemRoot&&within(process.env.SystemRoot,executable,true))throw new ProfileError('Select a game executable. Windows command tools are excluded.','INVALID_GAME');
    const stat=await fs.lstat(executable);if(!stat.isFile()||stat.isSymbolicLink())throw new ProfileError('Select an executable directly, not a link.','INVALID_GAME');
    const canonical=await fs.realpath(executable);const game={id:'manual-'+randomUUID(),name:path.basename(canonical,'.exe'),launcher:'Manual',root:path.dirname(canonical),executable:canonical,args:[]};items.set(game.id,game);
    await atomicJson(file,[...items.values()].filter(item=>item.launcher==='Manual'));return game;
  }
  async function launch(id,profileId=null){
    const game=items.get(id);if(!game)throw new ProfileError('Refresh the game library before launching.','INVALID_GAME');
    if(profileId!==null&&!['gaming','competitive','quiet'].includes(profileId))throw new ProfileError('Invalid launch profile.','INVALID_PROFILE');
    const previous=profileId?await profiles.status():null;
    if(profileId)await profiles.apply(profileId);
    try{
      if(game.uri){if(!/^(steam:\/\/rungameid\/\d+|com\.epicgames\.launcher:\/\/apps\/[^\s]+)$/.test(game.uri))throw new Error('Invalid launcher URI.');await openUri(game.uri);}
      else{await fs.access(game.executable);await new Promise((resolve,reject)=>{const child=spawn(game.executable,game.args||[],{shell:false,detached:true,windowsHide:false,stdio:'ignore',cwd:game.root});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});}
      return{success:true};
    }catch(error){if(profileId){try{if(previous.activeProfile)await profiles.apply(previous.activeProfile);else await profiles.revert();}catch{throw new ProfileError('Launch failed and the selected profile could not be reverted. Open Recovery.','RECOVERY_REQUIRED');}}throw new ProfileError('The launcher could not open this game: '+error.message,'LAUNCH_FAILED');}
  }
  return{scan,list,add,launch,get:id=>{const game=items.get(id);if(!game)throw new ProfileError('Refresh the game library.','INVALID_GAME');return game;},roots:()=>libraries,boosterRoots:ids=>ids.map(id=>items.get(id)).filter(Boolean).map(game=>game.executable&&within(game.root,game.executable)?game.executable:game.root).filter(root=>path.resolve(root)!==path.parse(root).root)};
}

module.exports={createGames,parseVdf};
