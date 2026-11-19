'use strict';
const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const {createHash}=require('node:crypto');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {version}=require('../package.json');
const root=path.resolve(__dirname,'..');
const cli=path.join(root,'node_modules/electron-builder/out/cli/cli.js');
async function size(folder){let total=0;for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isSymbolicLink())throw Error('Unexpected linked package resource.');if(entry.isDirectory())total+=await size(file);else total+=(await fs.stat(file)).size;}return total;}
async function build(){
  execFileSync(process.execPath,[cli,'--win','nsis','--x64','--publish','never'],{cwd:root,stdio:'inherit',windowsHide:true});
  const hash=createHash('sha256');for await(const part of createReadStream(path.join(root,`.cache/package/XeroLag-Engine-${version}-x64.exe`)))hash.update(part);
  await fs.writeFile(path.join(root,'.cache/payload-manifest.json'),JSON.stringify({version,sha256:hash.digest('hex'),installedBytes:await size(path.join(root,'.cache/package/win-unpacked'))}));
  execFileSync(process.execPath,[cli,'--config','installer/electron-builder.cjs','--win','portable','--x64','--publish','never'],{cwd:root,stdio:'inherit',windowsHide:true});
  execFileSync(process.execPath,[path.join(root,'scripts/checksum.js')],{cwd:root,stdio:'inherit',windowsHide:true});
}
build().catch(error=>{console.error('Installer build failed: '+error.message);process.exitCode=1;});
