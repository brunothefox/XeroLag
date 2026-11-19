'use strict';

// Exercise the real sandbox and preload without launching privileged app startup.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { registerIpc } = require('../src/main/ipc');
const { createTelemetry } = require('../src/main/telemetry');
const { version } = require('../package.json');
const { createProfiles } = require('../src/main/profiles');
const { createProfileAdapter } = require('../src/main/profile-adapter');
const { createFakeProfileAdapter } = require('./fixtures/profile-system');
const { sameState } = require('../src/main/profile-state');
const { createWorkbench } = require('../src/main/workbench');
const { createJobs } = require('../src/main/jobs');

app.setName('XeroLag');
app.on('window-all-closed',()=>{});
const testRoot=path.resolve(__dirname,'..','.cache','tests');
const previewRoot=path.resolve(__dirname,'..','.cache','previews');
// Keep the test cache separate from a running administrator instance.
app.setPath('userData', path.join(testRoot,'desktop-test-data'));
if (process.env.XEROLAG_CAPTURE_PREVIEW === '1') app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error('Desktop check timed out.'); app.exit(1); }, 240_000);

app.whenReady().then(async () => {
  let window;let profileDirectory;
  async function cleanProfileFixture(){if(!profileDirectory)return;const target=path.resolve(profileDirectory);if(!target.startsWith(testRoot+path.sep)||!path.basename(target).startsWith('desktop-profiles-'))throw Error('Invalid desktop fixture cleanup.');await fs.rm(target,{recursive:true,force:true});profileDirectory=null;}
  try {
    const root = path.join(__dirname, '..');
    await fs.mkdir(testRoot,{recursive:true});
    if(process.env.XEROLAG_CAPTURE_PREVIEW==='1')await fs.mkdir(previewRoot,{recursive:true});
    const entry = path.join(root, 'src', 'renderer', 'index.html');
    window = new BrowserWindow({
      width: 1200, height: 800, show: false, frame: false, backgroundColor: '#090e19',
      webPreferences: { preload: path.join(root, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
        offscreen: process.env.XEROLAG_CAPTURE_PREVIEW === '1' }
    });
    async function captureWorkflow(filename){
      if(process.env.XEROLAG_CAPTURE_PREVIEW!=='1')return;
      await new Promise(resolve=>setTimeout(resolve,250));
      const [width,height]=window.getSize();
      const frame=await new Promise((resolve,reject)=>{
        const listener=(_event,_dirty,image)=>{if(image.getSize().width!==width||image.getSize().height!==height)return;clearTimeout(timer);window.webContents.removeListener('paint',listener);resolve(image);};
        const timer=setTimeout(()=>{window.webContents.removeListener('paint',listener);reject(Error('Workflow capture timed out'));},5000);
        window.webContents.on('paint',listener);window.webContents.invalidate();
      });
      await fs.writeFile(path.join(previewRoot,filename),frame.toPNG());
    }
    const appInfo = { getName: () => app.getName(), getVersion: () => version, isPackaged: app.isPackaged };
    // Read real settings for realistic rendering. All subsequent profile writes and
    // restore points use an in-memory adapter; no Windows settings are changed.
    const profileAdapter = createFakeProfileAdapter();
    Object.assign(profileAdapter.system, await createProfileAdapter().read());
    profileAdapter.system.identity.administrator = true;
    const originalProfileState = structuredClone(profileAdapter.system.state);
    profileDirectory = await fs.mkdtemp(path.join(testRoot, 'desktop-profiles-'));
    const profiles = createProfiles({ directory: profileDirectory, administrator: true,
      adapter: profileAdapter, logger: { info: async () => {}, error: async message => console.error(message) } });
    const workbench=createWorkbench({directory:path.join(profileDirectory,'modules'),profiles,identity:async()=>profileAdapter.system.identity,getFileIcon:async file=>(await app.getFileIcon(file,{size:'large'})).toDataURL(),
      logger:{info:async()=>{},error:async message=>console.error(message)},trash:async()=>{throw new Error('Real deletion is blocked in desktop tests.');},openUri:async()=>{},
      dialogs:{confirm:async()=>false,folder:async()=>null,executable:async()=>null,preset:async()=>null,openRecovery:async()=>null,systemRestore:async()=>null}});
    const fixtureJobs=createJobs();let cleanerFixture=false;let fixtureScan=null;let reviewedIds=[];
    const readonlyWorkbench={...workbench,call:(method,args)=>{
      if(cleanerFixture){
        if(method==='jobs')return fixtureJobs.list();
        if(method==='job')return fixtureJobs.get(args.id);
        if(method==='cancelJob')return fixtureJobs.cancel(args.id);
        if(method==='scanCaches')return fixtureJobs.start('Fixture cache scan',async context=>{await new Promise(resolve=>setTimeout(resolve,300));context.log('Scanned isolated UI fixture categories.');fixtureScan={scanId:'isolated-ui-scan',categories:args.ids.map(id=>({id,label:id,count:1,bytes:4096})),count:args.ids.length,bytes:args.ids.length*4096};return fixtureScan;});
        if(method==='cleanCaches'){assert.equal(args.scanId,fixtureScan.scanId);assert.ok(args.ids.every(id=>fixtureScan.categories.some(item=>item.id===id)));reviewedIds=args.ids;return fixtureJobs.start('Fixture cache cleanup',async context=>{await new Promise(resolve=>setTimeout(resolve,100));context.log('No Windows files were removed; this is an isolated UI fixture.');return{removed:args.ids.length,bytes:args.ids.length*4096,skippedCount:0,skipped:[],skippedCategories:[]};});}
      }
      if(method==='artwork')return workbench.call(method,{...args,online:false});
      if(!['page','jobs','job','boosterStatus','health','preview','networkInfo','sourceIcon','itemIcon'].includes(method))throw new Error('Desktop tests block Windows changes and external launches.');
      return workbench.call(method,args);
    }};
    const dispose = registerIpc({ ipcMain, window, entryUrl: pathToFileURL(entry).href, app: appInfo,
      administrator: true, logger: { error: async message => console.error(message) }, telemetry: createTelemetry(), profiles,workbench:readonlyWorkbench });
    await window.loadFile(entry);
    const result = await window.webContents.executeJavaScript(`(async () => {
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 25000;
        const check = () => {
          if (document.getElementById('status').textContent.includes('Updated')) return resolve();
          if (Date.now() > deadline) return reject(new Error('Renderer did not initialize'));
          setTimeout(check, 25);
        };
        check();
      });
      return {
        nodeAvailable: typeof require !== 'undefined',
        bridge: Object.keys(window.xerolag).sort(),
        info: await window.xerolag.app.getInfo(),
        state: await window.xerolag.window.getState(),
        errorHidden: document.getElementById('error').hidden,
        genericInvoke: typeof window.xerolag.invoke,
        heading: document.querySelector('h1').textContent,
        ram: document.getElementById('ram-value').textContent,
        logoLoaded: document.querySelector('.header-logo').naturalWidth > 0,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
      };
    })()`);
    assert.equal(result.nodeAvailable, false);
    assert.deepEqual(result.bridge, ['app', 'profiles', 'system', 'tools', 'window']);
    assert.equal(result.info.administrator, true);
    assert.equal(result.info.version, version);
    assert.equal(typeof result.state.maximized, 'boolean');
    assert.equal(result.errorHidden, true);
    assert.equal(result.genericInvoke, 'undefined');
    assert.equal(result.heading, 'Overview');
    assert.match(result.ram, /\d+%/);
    assert.equal(result.logoLoaded, true);
    assert.equal(result.horizontalOverflow, false);
    const navigation = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('.module-tab[data-page="hardware"]').click();
      const hardware = !document.getElementById('page-hardware').hidden && document.getElementById('page-dashboard').hidden;
      document.querySelector('.nav-item[data-page="about"]').click();
      const about = !document.getElementById('page-about').hidden && document.getElementById('refresh').hidden;
      document.querySelector('.nav-item[data-page="dashboard"]').click();
      document.querySelector('.module-tab[data-page="storage"]').click();
      const storage = !document.getElementById('page-storage').hidden && document.getElementById('page-about').hidden;
      document.querySelector('.nav-item[data-page="dashboard"]').click();
      return { hardware, about, storage, dashboard: !document.getElementById('page-dashboard').hidden };
    })()`);
    assert.deepEqual(navigation, { hardware: true, about: true, storage: true, dashboard: true });
    const chart = await window.webContents.executeJavaScript(`(async () => {
      for (let index = 0; index < 3; index++) {
        await new Promise(resolve => setTimeout(resolve, 1100));
        document.getElementById('refresh').click();
        while (document.getElementById('refresh').disabled) await new Promise(resolve => setTimeout(resolve, 20));
      }
      document.querySelector('[data-chart="ram"]').click();
      const ramSelected = document.querySelector('[data-chart="ram"]').getAttribute('aria-pressed') === 'true';
      document.querySelector('[data-chart="cpu"]').click();
      return { ramSelected, line: document.getElementById('history-line').getAttribute('d'),
        available: document.getElementById('memory-free').textContent,
        cores: document.querySelectorAll('#core-usage > div').length,
        errorHidden: document.getElementById('error').hidden };
    })()`);
    assert.equal(chart.ramSelected, true);
    assert.match(chart.line, /^M/);
    assert.notEqual(chart.available, '—');
    assert.ok(chart.cores > 0);
    assert.equal(chart.errorHidden, true);
    const setupFlow=await window.webContents.executeJavaScript(`(async()=>{
      const deadline=Date.now()+25000;
      while(document.getElementById('recovery-setup-start').disabled){if(Date.now()>deadline)throw Error('Recovery setup did not load');await new Promise(resolve=>setTimeout(resolve,25));}
      const visible=!document.getElementById('recovery-setup').hidden;
      document.getElementById('recovery-setup-start').click();
      while(document.getElementById('profile-message').textContent!=='Safety snapshot ready.'||!document.getElementById('profile-progress').hidden){if(Date.now()>deadline)throw Error('Recovery setup timed out');await new Promise(resolve=>setTimeout(resolve,25));}
      return{visible,expanded:document.getElementById('snapshot-fold').open,ready:document.getElementById('recovery-setup').hidden,profileVisible:!document.getElementById('page-profiles').hidden};
    })()`);
    assert.equal(setupFlow.visible,true);assert.equal(setupFlow.expanded,true);assert.equal(setupFlow.ready,true);assert.equal(setupFlow.profileVisible,true);
    console.log('First-launch snapshot flow verified with an isolated adapter.');
    const profileFlow = await window.webContents.executeJavaScript(`(async () => {
      const waitFor = async condition => {
        const deadline = Date.now() + 10000;
        while (!condition()) {
          if (Date.now() > deadline) throw new Error('Profile UI timed out');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      };
      document.querySelector('.nav-item[data-page="profiles"]').click();
      await waitFor(() => document.getElementById('profile-list').getAttribute('aria-busy') === 'false');
      const available = Array.from(document.querySelectorAll('#profile-list [data-apply-profile]')).find(button => !button.disabled);
      if (!available) throw new Error('No test profile is available');
      available.click();
      await waitFor(() => document.getElementById('profile-progress').hidden && document.getElementById('profile-message').textContent === 'Profile applied.');
      const applied = (await window.xerolag.profiles.getStatus()).activeProfile;
      const backup = (await window.xerolag.profiles.getStatus()).backup;
      document.getElementById('revert-snapshot').click();
      await waitFor(() => document.getElementById('profile-progress').hidden && document.getElementById('profile-message').textContent === 'Original settings restored.');
      const restored = (await window.xerolag.profiles.getStatus()).backup.phase;
      let rejected = false;
      try { await window.xerolag.profiles.apply('arbitrary-command'); } catch { rejected = true; }
      document.querySelector('.nav-item[data-page="dashboard"]').click();
      return { applied, backedUp: Boolean(backup.restorePoint), restored, rejected, dashboard: !document.getElementById('page-dashboard').hidden };
    })()`);
    assert.ok(['gaming', 'competitive', 'quiet'].includes(profileFlow.applied));
    assert.equal(profileFlow.backedUp, true);
    assert.equal(profileFlow.restored, 'reverted');
    assert.equal(profileFlow.rejected, true);
    assert.equal(profileFlow.dashboard, true);
    assert.equal(sameState(profileAdapter.system.state, originalProfileState), true);
    assert.ok(profileAdapter.controls.writes >= 2);
    const moduleResults=[];
    for(const route of ['cleaner','files','gaming','devices','games','booster','network','startup','services','debloat','shell','repair','health','recovery','activity','registry','processes','tools','settings']){
      const result=await window.webContents.executeJavaScript(`(async()=>{
        showPage(${JSON.stringify(route)});
        const page=document.getElementById('page-'+${JSON.stringify(route)});const deadline=Date.now()+30000;
        while(page.dataset.loaded!=='true'){if(Date.now()>deadline)throw new Error('Module load timed out: '+${JSON.stringify(route)});await new Promise(resolve=>setTimeout(resolve,30));}
        return{route:${JSON.stringify(route)},error:page.dataset.error,children:page.children.length,overflow:document.documentElement.scrollWidth>window.innerWidth};
      })()`);
      assert.equal(result.error,'',route+': '+result.error);assert.ok(result.children>0);assert.equal(result.overflow,false);moduleResults.push(result.route);
    }
    console.log('Read-only modules verified: '+moduleResults.join(', '));
    const componentFlow=await window.webContents.executeJavaScript(`(async()=>{
      const waitFor=async predicate=>{const deadline=Date.now()+30000;while(!predicate()){if(Date.now()>deadline)throw Error('Component flow timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
      showPage('settings');await waitFor(()=>document.getElementById('page-settings').dataset.loaded==='true');const toggle=document.querySelector('#page-settings [role="switch"][aria-label="Compact layout"]');const original=toggle.getAttribute('aria-checked');toggle.click();const compact=document.documentElement.dataset.density===(original==='true'?'comfortable':'compact');toggle.click();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));const palette=document.querySelector('.command-palette');const input=palette.querySelector('input');input.value='registry';input.dispatchEvent(new Event('input'));palette.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await waitFor(()=>document.getElementById('page-registry').dataset.loaded==='true');const commandNavigation=!document.getElementById('page-registry').hidden;
      showPage('startup');await waitFor(()=>document.getElementById('page-startup').dataset.loaded==='true');const search=document.querySelector('#page-startup input[type="search"]');search.value='no-such-startup-entry-xxxx';search.dispatchEvent(new Event('input'));const filtered=document.getElementById('page-startup').textContent.includes('No matching startup entries');
      showPage('games');await waitFor(()=>document.getElementById('page-games').dataset.loaded==='true');const games=await window.xerolag.tools.page('games');const cards=document.querySelectorAll('#page-games .game-card').length;return{compact,commandNavigation,filtered,cards,expected:games.games.length};
    })()`);
    assert.equal(componentFlow.compact,true);assert.equal(componentFlow.commandNavigation,true);assert.equal(componentFlow.filtered,true);assert.equal(componentFlow.cards,componentFlow.expected);console.log('Preferences, command palette, startup search and game cards verified.');
    const reviewFlow=await window.webContents.executeJavaScript(`(async()=>{
      const waitFor=async predicate=>{const deadline=Date.now()+30000;while(!predicate()){if(Date.now()>deadline)throw Error('Setting review timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
      showPage('shell');await waitFor(()=>document.getElementById('page-shell').dataset.loaded==='true');
      const row=[...document.querySelectorAll('#page-shell .setting-row')].find(row=>row.querySelector('h3').textContent==='Show file extensions');
      const picker=row.querySelector('select');const control=row.querySelector('button');const unchangedDisabled=control.disabled;
      picker.value=[...picker.options].find(option=>option.value&&option.value!==picker.value).value;picker.dispatchEvent(new Event('change'));const changedEnabled=!control.disabled;control.focus();control.click();
      await waitFor(()=>document.querySelector('dialog[open]'));const dialog=document.querySelector('dialog[open]');
      const result={unchangedDisabled,changedEnabled,heading:dialog.querySelector('h2').textContent,hasValues:dialog.querySelectorAll('tbody tr').length>0,recovery:dialog.textContent.includes('Repair > Recovery'),cancelFocused:document.activeElement.textContent==='Cancel'};
      dialog.querySelector('button').click();await waitFor(()=>!document.querySelector('.change-review')&&!control.disabled);result.focusReturned=document.activeElement===control;return result;
    })()`);
    assert.equal(reviewFlow.unchangedDisabled,true);assert.equal(reviewFlow.changedEnabled,true);assert.equal(reviewFlow.heading,'Review changes');assert.equal(reviewFlow.hasValues,true);assert.equal(reviewFlow.recovery,true);assert.equal(reviewFlow.cancelFocused,true);assert.equal(reviewFlow.focusReturned,true);
    console.log('Setting states and read-only review/cancel flow verified.');
    cleanerFixture=true;
    const cleanerFlow=await window.webContents.executeJavaScript(`(async()=>{
      const waitFor=async predicate=>{const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw Error('Cleaner workflow timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
      showPage('cleaner');await waitFor(()=>document.getElementById('page-cleaner').dataset.loaded==='true');const page=document.getElementById('page-cleaner');
      const initial=page.querySelector('[aria-current="step"]').textContent;page.querySelector('[data-cleaner-action="scan"]').click();
      await waitFor(()=>page.querySelector('[data-cleaner-action="scan"]').disabled);
      showPage('activity');await waitFor(()=>document.getElementById('page-activity').dataset.loaded==='true');const tracked=document.getElementById('page-activity').textContent.includes('Fixture cache scan');
      showPage('cleaner');await waitFor(()=>page.querySelector('[aria-current="step"]').textContent==='Review scan');
      const before=page.querySelector('.cleaner-summary-value').textContent;const boxes=[...page.querySelectorAll('.cache-choice input')].filter(input=>input.checked&&!input.disabled);boxes[0].click();const after=page.querySelector('.cleaner-summary-value').textContent;
      return{initial,tracked,selectionChanged:before!==after};
    })()`);
    await captureWorkflow('cleaner-fixture-review.png');
    await window.webContents.executeJavaScript(`(async()=>{
      const page=document.getElementById('page-cleaner');page.querySelector('[data-cleaner-action="clean"]').click();const deadline=Date.now()+15000;while(!page.querySelector('.cleanup-result')){if(Date.now()>deadline)throw Error('Cleanup results timed out');await new Promise(resolve=>setTimeout(resolve,25));}
    })()`);
    await captureWorkflow('cleaner-fixture-results.png');
    const completionFlow=await window.webContents.executeJavaScript(`(async()=>{
      const waitFor=async predicate=>{const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw Error('Activity results timed out');await new Promise(resolve=>setTimeout(resolve,25));}};const page=document.getElementById('page-cleaner');
      showPage('activity');await waitFor(()=>document.getElementById('page-activity').dataset.loaded==='true');const tasks=document.querySelectorAll('#page-activity .activity-row').length;
      document.querySelector('#page-activity [data-activity-job]').click();const log=document.querySelector('#page-activity .terminal-log').textContent;
      showPage('cleaner');await waitFor(()=>page.dataset.loaded==='true');const retained=Boolean(page.querySelector('.cleanup-result'));page.querySelector('.cleanup-result button').click();
      return{tasks,log,retained,reset:page.querySelector('[aria-current="step"]').textContent==='Select caches'};
    })()`);
    assert.equal(cleanerFlow.initial,'Select caches');assert.equal(cleanerFlow.tracked,true);assert.equal(cleanerFlow.selectionChanged,true);assert.ok(reviewedIds.length>0);assert.equal(completionFlow.tasks,2);assert.match(completionFlow.log,/isolated UI fixture/);assert.equal(completionFlow.retained,true);assert.equal(completionFlow.reset,true);
    await captureWorkflow('cleaner-desktop.png');
    console.log('Cleaner selection, scan, review, results and Activity logs verified with isolated fixtures.');
    cleanerFixture=false;
    await window.webContents.executeJavaScript("showPage('dashboard')");
    if (process.env.XEROLAG_CAPTURE_PREVIEW === '1') {
      await new Promise(resolve => setTimeout(resolve, 250));
      const output = path.join(previewRoot, 'dashboard-preview.png');
      await fs.mkdir(path.dirname(output), { recursive: true });
      const preview = await new Promise((resolve, reject) => {
        const listener = (_event, _dirty, frame) => {
          if (frame.getSize().width !== 1200 || frame.getSize().height !== 800) return;
          clearTimeout(timeout);
          window.webContents.removeListener('paint', listener);
          resolve(frame);
        };
        const timeout = setTimeout(() => {
          window.webContents.removeListener('paint', listener);
          reject(new Error('Offscreen rendering did not provide a preview.'));
        }, 5000);
        window.webContents.on('paint', listener);
        window.webContents.invalidate();
      });
      await fs.writeFile(output, preview.toPNG());
      console.log(`Preview: ${output}`);
    }
    window.setSize(900, 620);
    const smallWindow = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 2000;
      while (window.innerWidth !== 900 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const cards = Array.from(document.querySelectorAll('.metric-card')).map(card => card.getBoundingClientRect());
      return { width: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth,
        cardsFit: cards.every(card => card.right <= window.innerWidth) };
    })()`);
    assert.equal(smallWindow.width, 900);
    assert.equal(smallWindow.overflow, false);
    assert.equal(smallWindow.cardsFit, true);
    if (process.env.XEROLAG_CAPTURE_PREVIEW === '1') {
      for (const [page, filename] of [['dashboard', 'dashboard-compact.png'], ['profiles', 'profiles-preview.png'], ['cleaner','cleaner-preview.png'],['gaming','gaming-preview.png'],['network','network-preview.png'],['startup','startup-preview.png'],['repair','repair-preview.png'],['recovery','recovery-preview.png'],['games','games-preview.png'],['tools','tools-preview.png'],['settings','settings-preview.png'],['shell','change-review-preview.png']]) {
        await window.webContents.executeJavaScript('showPage('+JSON.stringify(page)+')');
        if(['cleaner','gaming','network','startup','repair','recovery','games','tools','settings','shell'].includes(page))await window.webContents.executeJavaScript(`(async()=>{const page=document.getElementById('page-'+${JSON.stringify(page)});const deadline=Date.now()+30000;while(page.dataset.loaded!=='true'){if(Date.now()>deadline)throw new Error('Capture module timed out');await new Promise(resolve=>setTimeout(resolve,30));}if(page.dataset.error)throw new Error(page.dataset.error);if(page.scrollWidth>page.clientWidth+1)throw Error('Compact module overflow: '+${JSON.stringify(page)});})()`);
        if(page==='shell')await window.webContents.executeJavaScript(`(async()=>{const row=[...document.querySelectorAll('#page-shell .setting-row')].find(row=>row.querySelector('h3').textContent==='Show file extensions');const picker=row.querySelector('select');picker.value=[...picker.options].find(option=>option.value&&option.value!==picker.value).value;picker.dispatchEvent(new Event('change'));row.querySelector('button').click();const deadline=Date.now()+15000;while(!document.querySelector('dialog[open]')){if(Date.now()>deadline)throw Error('Review preview timed out');await new Promise(resolve=>setTimeout(resolve,25));}const dialog=document.querySelector('.change-review[open]');if(dialog.scrollWidth>dialog.clientWidth+1)throw Error('Review dialog overflows');})()`);
        await new Promise(resolve => setTimeout(resolve, 250));
        const frame = await new Promise((resolve, reject) => {
          const listener = (_event, _dirty, image) => {
            if (image.getSize().width !== 900 || image.getSize().height !== 620) return;
            clearTimeout(timeout); window.webContents.removeListener('paint', listener); resolve(image);
          };
          const timeout = setTimeout(() => { window.webContents.removeListener('paint', listener); reject(new Error('Preview timed out.')); }, 5000);
          window.webContents.on('paint', listener);
          window.webContents.invalidate();
        });
        await fs.writeFile(path.join(previewRoot, filename), frame.toPNG());
      }
    }
    dispose();
    window.destroy();
    await cleanProfileFixture();
    clearTimeout(watchdog);
    console.log('Desktop check passed: sandbox, preload, navigation, charts, and isolated profile apply/revert. No Windows settings were changed.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) window.destroy();
    await cleanProfileFixture().catch(cleanupError=>console.error(cleanupError.message));
    clearTimeout(watchdog);
    app.exit(1);
  }
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
