'use strict';
const {version}=require('../package.json');
module.exports={
  appId:'app.xerolag.setup',productName:'XeroLag Setup',asar:true,npmRebuild:false,
  extraMetadata:{name:'xerolag-setup',main:'installer/main.js'},
  directories:{output:'.cache/package',buildResources:'assets/branding'},
  files:['installer/main.js','installer/controller.js','installer/preload.js','installer/renderer/**/*','assets/branding/HeaderLOGO.png','assets/branding/xerolag.png','assets/generated/icon.ico','package.json'],
  extraResources:[{from:`.cache/package/XeroLag-Engine-${version}-x64.exe`,to:'payload/setup.exe'},{from:'.cache/payload-manifest.json',to:'payload/manifest.json'}],
  win:{icon:'assets/generated/icon.ico',target:[{target:'portable',arch:['x64']}],requestedExecutionLevel:'requireAdministrator',artifactName:'XeroLag-Setup-${version}-${arch}.${ext}'},portable:{requestExecutionLevel:'admin'}
};
