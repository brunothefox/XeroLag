'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {version}=require('../package.json');
async function build(){
  const root=path.resolve(__dirname,'..'),source=path.join(root,'website'),output=path.join(root,'.cache/website');const config=JSON.parse(await fs.readFile(path.join(source,'site.config.json'),'utf8'));
  if(!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(config.repository)||new URL(config.siteUrl).protocol!=='https:')throw Error('Invalid website repository configuration.');
  await fs.mkdir(path.join(output,'assets'),{recursive:true});for(const file of ['index.html','style.css','site.js'])await fs.copyFile(path.join(source,file),path.join(output,file));
  for(const[from,to]of [['assets/branding/HeaderLOGO.png','logo.png'],['assets/branding/iconLOGO.ico','icon.ico'],['docs/installer-preview.png','installer-preview.png']])await fs.copyFile(path.join(root,from),path.join(output,'assets',to));
  let html=await fs.readFile(path.join(output,'index.html'),'utf8');html=html.replaceAll('https://github.com/brunothefox/XeroLag','https://github.com/'+config.repository).replaceAll('https://brunothefox.github.io/XeroLag/',config.siteUrl);await fs.writeFile(path.join(output,'index.html'),html);
  await fs.writeFile(path.join(output,'release-config.js'),'window.XERO_SITE=Object.freeze('+JSON.stringify({repository:config.repository,version})+');\n');await fs.writeFile(path.join(output,'.nojekyll'),'');
  console.log('Installation page built: '+output);
}
build().catch(error=>{console.error(error.message);process.exitCode=1;});
