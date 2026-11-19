'use strict';
(()=>{
  const config=window.XERO_SITE||{repository:'brunothefox/XeroLag',version:'0.3.1'};
  const base='https://github.com/'+config.repository,byId=id=>document.getElementById(id);
  function releaseUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&url.pathname.startsWith('/'+config.repository+'/releases/')?url.href:null;}catch{return null;}}
  function setLink(id,url){if(url)byId(id).href=url;}
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
  fetch('https://api.github.com/repos/'+config.repository+'/releases/latest',{signal:controller.signal,headers:{Accept:'application/vnd.github+json'}}).then(async response=>{
    if(response.status===404){byId('release-status').textContent='No public release yet. Check GitHub for availability.';byId('download').querySelector('span').textContent='View GitHub releases';return;}
    if(!response.ok)throw Error('GitHub release unavailable');const release=await response.json();if(release.draft||release.prerelease||!Array.isArray(release.assets))throw Error('No stable release');
    const asset=release.assets.find(item=>/^XeroLag-Setup-\d+\.\d+\.\d+-x64\.exe$/.test(item.name)&&releaseUrl(item.browser_download_url));if(!asset)throw Error('Windows installer unavailable');
    const checksum=release.assets.find(item=>item.name===asset.name+'.sha256');setLink('download',releaseUrl(asset.browser_download_url));document.querySelectorAll('.secondary-download').forEach(link=>link.href=releaseUrl(asset.browser_download_url));
    setLink('release-notes',releaseUrl(release.html_url));setLink('checksum',releaseUrl(checksum?.browser_download_url));setLink('verify-checksum',releaseUrl(checksum?.browser_download_url));
    const version=asset.name.match(/^XeroLag-Setup-(.+)-x64\.exe$/)[1];byId('release-status').textContent='v'+version+' · '+(asset.size/1024/1024).toFixed(0)+' MB · Windows 10/11 x64';byId('hash-command').textContent='Get-FileHash .\\'+asset.name+' -Algorithm SHA256';
  }).catch(()=>{byId('release-status').textContent='Windows 10/11 x64 · Download and checksums on GitHub';}).finally(()=>clearTimeout(timeout));
  byId('copy-command').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(byId('hash-command').textContent);byId('copy-status').textContent='Command copied.';}catch{const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(byId('hash-command'));selection.removeAllRanges();selection.addRange(range);byId('copy-status').textContent='Command selected. Press Ctrl+C to copy.';}});
})();
