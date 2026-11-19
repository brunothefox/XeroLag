'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const https=require('node:https');
const {createHash}=require('node:crypto');
const {ProfileError}=require('./profile-state');

const HOSTS=new Set(['shared.fastly.steamstatic.com','cdn.akamai.steamstatic.com']);
function imageMime(buffer){
  if(buffer.length<16)return null;
  if(buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return'image/jpeg';
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
  if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return'image/webp';
  return null;
}
function downloadImage(url,redirects=0){
  return new Promise((resolve,reject)=>{
    const address=new URL(url);
    if(address.protocol!=='https:'||!HOSTS.has(address.hostname)||address.port&&address.port!=='443'||address.username||address.password){reject(new Error('Unsupported artwork source'));return;}
    const request=https.get(address,{headers:{'User-Agent':'XeroLag/0.3','Accept':'image/jpeg,image/png,image/webp'}},response=>{
      if(response.statusCode>=300&&response.statusCode<400&&response.headers.location&&redirects<2){response.resume();resolve(downloadImage(new URL(response.headers.location,address).href,redirects+1));return;}
      if(response.statusCode!==200){response.resume();reject(new Error('Artwork unavailable'));return;}
      if(Number(response.headers['content-length'])>2*1024*1024){response.destroy();reject(new Error('Artwork exceeds size limit'));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){response.destroy(new Error('Artwork exceeds size limit'));return;}chunks.push(chunk);});
      response.on('end',()=>{const buffer=Buffer.concat(chunks);imageMime(buffer)?resolve(buffer):reject(new Error('Unsupported image data'));});response.on('error',reject);
    });
    request.setTimeout(4000,()=>request.destroy(new Error('Artwork request timed out')));request.on('error',reject);
  });
}
function createMedia({directory,getFileIcon=async()=>null,chooseArtwork=async()=>null,fetchImage=downloadImage}){
  const memory=new Map();const pending=new Map();const negative=new Map();const revisions=new Map();const icons=new Map();let active=0;const waiters=[];
  const key=id=>createHash('sha256').update(id).digest('hex');
  async function localImage(file){try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)return null;const buffer=await fs.readFile(file);const mime=imageMime(buffer);return mime?'data:'+mime+';base64,'+buffer.toString('base64'):null;}catch{return null;}}
  async function icon(file){if(typeof file!=='string'||!path.isAbsolute(file)||!['.exe','.lnk'].includes(path.extname(file).toLowerCase()))return null;if(icons.has(file))return icons.get(file);try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())return null;const result=await getFileIcon(file);icons.set(file,result);if(icons.size>100)icons.delete(icons.keys().next().value);return result;}catch{return null;}}
  async function artwork(game,online=true){
    if(!game||typeof game.id!=='string')throw new ProfileError('Refresh the library before loading artwork.','INVALID_GAME');
    const id=game.id;const cacheKey=id+':'+online+':'+(revisions.get(id)||0);if(memory.has(cacheKey))return memory.get(cacheKey);if(pending.has(cacheKey))return pending.get(cacheKey);
    const promise=(async()=>{
      const custom=await localImage(path.join(directory,key(id)+'.custom'));if(custom)return{image:custom,source:'Custom artwork'};
      const stored=await localImage(path.join(directory,key(id)+'.image'));if(stored)return{image:stored,source:'Steam artwork cache'};
      if(/^steam-\d{1,12}$/.test(id)){
        const appid=id.slice(6);
        for(const root of game.artRoots||[]){
          for(const name of[appid+'_library_600x900.jpg',appid+'_library_600x900.png',appid+'_header.jpg']){const image=await localImage(path.join(root,name));if(image)return{image,source:'Installed Steam library'};}
          try{const folder=path.join(root,appid);for(const name of(await fs.readdir(folder)).slice(0,100).filter(name=>/library_600x900.*\.(jpg|png)$/i.test(name))){const image=await localImage(path.join(folder,name));if(image)return{image,source:'Installed Steam library'};}}catch{}
        }
        if(online&&Date.now()-(negative.get(id)||0)>300_000){
          if(active>=3)await new Promise(resolve=>waiters.push(resolve));else active++;
          try{for(const asset of['library_600x900.jpg','header.jpg']){try{const buffer=await fetchImage('https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/'+appid+'/'+asset);const mime=imageMime(buffer);if(!mime)continue;await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,key(id)+'.image'),buffer);return{image:'data:'+mime+';base64,'+buffer.toString('base64'),source:'Steam official artwork'};}catch{}}negative.set(id,Date.now());}
          finally{if(waiters.length)waiters.shift()();else active--;}
        }
      }
      return{image:null,icon:await icon(game.executable),source:null};
    })().then(result=>{if(result.image){memory.set(cacheKey,result);if(memory.size>48)memory.delete(memory.keys().next().value);}return result;}).finally(()=>pending.delete(cacheKey));pending.set(cacheKey,promise);return promise;
  }
  async function importArtwork(game){const file=await chooseArtwork();if(!file)return{cancelled:true};const image=await localImage(file);if(!image)throw new ProfileError('Choose a PNG, JPEG or WebP image smaller than 2 MiB.','INVALID_IMAGE');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,key(game.id)+'.custom'),Buffer.from(image.split(',')[1],'base64'));revisions.set(game.id,(revisions.get(game.id)||0)+1);return{success:true};}
  return{artwork,importArtwork,icon};
}
module.exports={createMedia,imageMime,downloadImage};
