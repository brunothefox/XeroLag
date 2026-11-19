'use strict';

(() => {
  const api=window.xerolag.tools;
  const routes=['cleaner','files','gaming','devices','games','booster','network','startup','services','debloat','shell','repair','health','recovery','activity','registry','tools','processes','settings'];
  const cache=new Map();const local=new Map();const taskRoutes=new Map();let active=null;let epoch=0;let boosterPoll;let activityTimer;let activityFingerprint='';let lastActivity=[];
  const byId=id=>document.getElementById(id);
  for(const route of routes){const page=document.createElement('div');page.id='page-'+route;page.className='page workbench-page';page.hidden=true;byId('main-content').append(page);local.set(route,{});}
  function make(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
  function icon(name){const node=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-'+name);node.setAttribute('aria-hidden','true');node.append(use);return node;}
  function button(label,action,primary=false){const node=make('button',label,primary?'button-primary':'button-secondary');node.type='button';node.addEventListener('click',()=>{void action(node);});return node;}
  function bytes(value){if(typeof value!=='number'||!Number.isFinite(value))return'—';if(value===0)return'0 B';const units=['B','KiB','MiB','GiB','TiB'];const index=Math.max(0,Math.min(4,Math.floor(Math.log(value)/Math.log(1024))));return(value/1024**index).toFixed(index?1:0)+' '+units[index];}
  function risk(value){const node=make('span',value,'risk-badge');node.dataset.risk=value;return node;}
  function toolbar(...nodes){const row=make('div',undefined,'module-toolbar');row.append(...nodes);return row;}
  function panel(title,iconName='layers'){const section=make('section',undefined,'panel rounded-2xl module-panel');const header=make('div',undefined,'panel-header');const heading=make('h2',title);heading.prepend(icon(iconName));header.append(heading);section.append(header);return section;}
  function fold(title,...nodes){const container=make('details',undefined,'section-fold');container.append(make('summary',title),...nodes);return container;}
  function empty(text){return make('p',text,'module-empty');}
  function field(label,control){const wrapper=make('label',undefined,'module-field');wrapper.append(make('span',label),control);return wrapper;}
  function select(options,value){const node=make('select');for(const item of options){const option=make('option',item.label);option.value=item.value;node.append(option);}if(value!==undefined)node.value=value;return node;}
  function check(label,checked=false){const wrapper=make('label',undefined,'check-label');const input=make('input');input.type='checkbox';input.checked=checked;wrapper.append(input,make('span',label));return{wrapper,input};}
  function searchField(label,onInput){const wrapper=make('label',undefined,'search-field');const input=make('input');input.type='search';input.placeholder=label;input.setAttribute('aria-label',label);input.autocomplete='off';input.addEventListener('input',()=>onInput(input.value));wrapper.append(icon('search'),input);return wrapper;}
  function support(title,iconName,rows=[],actions=[]){const section=make('section',undefined,'support-panel');const heading=make('h2',title);heading.prepend(icon(iconName));section.append(heading);for(const[label,value]of rows){const row=make('div',undefined,'stat-pair');row.append(make('span',label),make('strong',value??'—'));section.append(row);}section.append(...actions);return section;}
  function shortcuts(items){const row=make('div',undefined,'tool-shortcuts');for(const[title,iconName,route]of items){const control=button(title,()=>window.XeroUI.navigate(route));control.className='tool-shortcut';control.prepend(icon(iconName));row.append(control);}return row;}
  function notice(page,text,error=false){let node=page.querySelector('.module-notice');if(!error){if(node)node.hidden=true;window.XeroUI.toast(text);return;}if(!node){node=make('p',undefined,'notice notice-error module-notice');node.setAttribute('role','alert');page.prepend(node);}node.textContent=text;node.hidden=!text;}
  async function reviewApply(provider,id){
    const preview=await api.preview(provider,id);
    if(preview.matches)return{unchanged:true};
    if(!await reviewChanges(preview))return{cancelled:true};
    return api.apply(provider,id,preview.token);
  }
  function reviewChanges(preview){
    return new Promise(resolve=>{
      const previous=document.activeElement;const dialog=make('dialog',undefined,'change-review');dialog.setAttribute('aria-labelledby','review-title');
      const header=make('div',undefined,'review-header');const heading=make('h2','Review changes');heading.id='review-title';header.append(heading,risk(preview.risk));
      const title=make('h3',preview.label,'review-setting');dialog.append(header,title);
      if(preview.description)dialog.append(make('p',preview.description,'setting-description'));
      const table=make('table');const head=make('thead');const labels=make('tr');for(const value of['Setting','Current','Requested']){const cell=make('th',value);cell.scope='col';labels.append(cell);}head.append(labels);const body=make('tbody');
      for(const change of preview.changes){const row=make('tr');row.append(make('td',change.label),make('td',change.current),make('td',change.requested));body.append(row);}table.append(head,body);const wrapper=make('div',undefined,'review-values');wrapper.tabIndex=0;wrapper.append(table);dialog.append(wrapper);
      if(preview.technicalChanges){const technical=make('dl',undefined,'detail-list');for(const change of preview.technicalChanges){const row=make('div',undefined,'detail-row');row.append(make('dt',change.label),make('dd',change.current+' → '+change.requested));technical.append(row);}dialog.append(fold('Technical details',technical));}
      const recovery=make('p',preview.recovery,'review-recovery');recovery.prepend(icon('layers'));dialog.append(recovery);
      if(preview.restart||preview.signOut){const requirement=make('p',preview.restart?'Restart required after applying':'Sign out after applying','review-requirement');requirement.prepend(icon('info'));dialog.append(requirement);}
      const actions=make('div',undefined,'review-actions');const cancel=button('Cancel',()=>dialog.close('cancel'));cancel.autofocus=true;const apply=button('Apply changes',()=>dialog.close('apply'),true);actions.append(cancel,apply);dialog.append(actions);
      dialog.addEventListener('close',()=>{const accepted=dialog.returnValue==='apply';dialog.remove();if(previous?.isConnected)previous.focus();resolve(accepted);},{once:true});document.body.append(dialog);dialog.showModal();
    });
  }
  async function action(task,{refresh=true,message='Done.'}={}){
    const route=active;const page=byId('page-'+route);if(local.get(route).working)return;
    const focused=document.activeElement;
    local.get(route).working=true;const buttons=[...page.querySelectorAll('button')].map(button=>({button,disabled:button.disabled}));for(const {button} of buttons)button.disabled=true;
    page.setAttribute('aria-busy','true');if(focused?.tagName==='BUTTON')focused.dataset.busy='true';notice(page,'');
    try{const result=await task();if(result?.cancelled){notice(page,'');return result;}if(result?.id){taskRoutes.set(result.id,route);if(taskRoutes.size>100)taskRoutes.delete(taskRoutes.keys().next().value);}if(refresh&&active===route)await load(route);if(active===route)notice(byId('page-'+route),result?.unchanged?'Already set. No changes were needed.':message);return result;}
    catch(error){if(active===route)notice(byId('page-'+route),error.message,true);return null;}
    finally{local.get(route).working=false;page.setAttribute('aria-busy','false');if(focused?.dataset)delete focused.dataset.busy;for(const {button,disabled} of buttons)if(button.isConnected)button.disabled=disabled;if(active===route&&focused?.isConnected&&!focused.disabled)focused.focus({preventScroll:true});}
  }
  async function load(route,force=false){
    if(force&&route==='network')local.get('network').infoGuid=null;
    const version=++epoch;const page=byId('page-'+route);page.dataset.loaded='false';page.dataset.error='';if(!cache.has(route)){const skeleton=make('div',undefined,'module-loading');skeleton.setAttribute('aria-label','Reading Windows settings');skeleton.setAttribute('role','status');for(let index=0;index<4;index++){const row=make('div');row.append(make('span'),make('span'));skeleton.append(row);}page.replaceChildren(skeleton);}
    if(cache.has(route))render(route,cache.get(route));
    try{const data=route==='settings'?{}:route==='health'?await api.health():route==='activity'?{jobs:await api.jobs()}:await api.page(route,force);cache.set(route,data);if(active===route&&version===epoch){render(route,data);page.dataset.loaded='true';}}
    catch(error){if(active===route){page.dataset.loaded='true';page.dataset.error=error.message;page.replaceChildren(empty(error.message),button('Try again',()=>load(route),true));if(route==='recovery')page.append(button('Backup files',()=>api.openRecovery()),button('Windows System Restore',()=>api.systemRestore()));}}
  }
  async function watch(reference,done){
    if(!reference||!reference.id)return;
    const route=taskRoutes.get(reference.id)||active;local.get(route).job=reference.id;
    if(active===route)showJob(route,{id:reference.id,status:'queued',label:'Preparing task',log:[]});
    while(true){
      let job;try{job=await api.job(reference.id);}catch(error){if(active===route)notice(byId('page-'+route),error.message,true);break;}
      local.get(route).lastJob=job;if(active===route)showJob(route,job);
      if(!['queued','running'].includes(job.status)){
        local.get(route).job=null;
        if(job.status==='completed'){if(done)await done(job.result);}
        else if(active===route)notice(byId('page-'+route),job.error||'Task cancelled.',job.status==='failed');
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,750));
    }
  }
  function showJob(route,job){
    const page=byId('page-'+route);let box=page.querySelector('.job-box');
    if(!box){box=make('section',undefined,'job-box');const top=make('div',undefined,'job-header');const status=make('span',undefined,'job-status');const cancel=button('Stop',()=>action(()=>api.cancelJob(box.dataset.jobId),{refresh:false,message:'Stopping task…'}));cancel.classList.add('job-stop');top.append(status,cancel);const log=make('pre',undefined,'terminal-log');log.tabIndex=0;box.append(top,fold('Task log',log));page.append(box);}box.dataset.jobId=job.id;
    box.querySelector('.job-status').textContent=job.label+' · '+job.status+(job.progress?' · '+Object.entries(job.progress).filter(([,value])=>typeof value==='number').map(([key,value])=>key+' '+value).join(' / '):'');
    const stop=box.querySelector('.job-stop');stop.hidden=!['queued','running'].includes(job.status);stop.disabled=job.cancellable===false;
    const log=box.querySelector('pre');const bottom=log.scrollHeight-log.scrollTop-log.clientHeight<40;log.textContent=(job.log||[]).join('\n');if(bottom)log.scrollTop=log.scrollHeight;
  }
  function activeRecord(data,provider,id){return(data.records||[]).find(record=>record.key===provider+':'+id&&record.phase!=='restored');}
  function actionRows(data,definitions,provider='system'){
    const list=make('div',undefined,'setting-list');
    for(const definition of definitions){
      const record=activeRecord(data,provider,definition.scope||definition.id);const inspected=data.items?.find(item=>item.id===definition.id);const supported=definition.supported!==false&&inspected?.supported!==false;
      const row=make('div',undefined,'setting-row');const copy=make('div',undefined,'setting-copy');const title=make('div',undefined,'setting-title');title.append(make('h3',definition.label),risk(definition.risk||'Moderate'));copy.append(title);
      const status=inspected?.status;const currentChoice=definition.choices?.find(choice=>choice.value===definition.current);const currentLabel=!supported?'Unavailable':status?.label||definition.currentLabel||currentChoice?.label||(typeof definition.enabled==='boolean'?definition.enabled?'On':'Off':null);
      if(currentLabel){const current=make('span',currentLabel,'setting-current');current.title='Current setting: '+currentLabel;current.dataset.unavailable=String(!supported);title.append(current);}
      const description=definition.description||(!supported?inspected?.reason:null);
      if(description||definition.restart||definition.signOut||definition.risk!=='Safe'){
        const detail=fold('');detail.className='setting-detail';const summary=detail.querySelector('summary');summary.setAttribute('aria-label','About '+definition.label);summary.append(icon('info'),make('span',definition.group==='startup'?'Command · '+(definition.source||'Startup'):'Details','sr-only'));
        if(description)detail.append(make('p',description,'setting-description'));
        if(definition.risk&&definition.risk!=='Safe')detail.append(make('p',definition.risk+' setting','setting-risk'));
        if(definition.restart||definition.signOut)detail.append(make('span',definition.restart?'Restart required':'Sign-out required','setting-requirement'));
        copy.append(detail);
      }
      if(definition.choices){
        const current=definition.current??(definition.type==='service'?inspected?.state?.mode:definition.type==='special'?inspected?.state?.value:inspected?.state?.values?.[0]?.value);
        const selected=definition.choices.find(item=>item.id===status?.choiceId)||definition.choices.find(item=>item.value===current);const options=definition.choices.map(item=>({value:item.id,label:item.label}));if(!selected)options.unshift({value:'',label:'Windows default / custom'});const picker=select(options,selected?.id||'');picker.setAttribute('aria-label',definition.label);
        const controls=make('div',undefined,'setting-controls');const apply=button('Review',()=>action(()=>reviewApply(provider,picker.value),{message:'Setting saved.'}));const update=()=>{const matches=status?.choiceMatches||definition.choiceMatches;const same=matches?matches[picker.value]:Boolean(selected&&picker.value===selected.id);apply.disabled=!supported||!picker.value||same;apply.title=same?'Already set to this value':'';};picker.disabled=!supported;picker.addEventListener('change',update);update();controls.append(picker,apply);
        if(record)controls.append(button('Restore',()=>action(()=>api.restore(record.id),{message:'Original setting restored.'})));
        row.append(copy,controls);list.append(row);continue;
      }
      const control=button(record?'Restore':status?.matches?'Already set':definition.actionLabel||'Review',()=>action(()=>record?api.restore(record.id):reviewApply(provider,definition.id),{message:record?'Saved setting restored.':'Setting applied.'}));
      control.disabled=(!supported||status?.matches)&&!record;control.title=!supported?(inspected?.reason||'Not supported by the installed device or driver'):status?.matches?'Already set to this value':'';
      if(record)control.classList.add('restore-control');row.append(copy,control);list.append(row);
    }
    return list;
  }
  function splitSettings(data,definitions,provider='system'){
    const normal=definitions.filter(item=>item.risk!=='Advanced');const advanced=definitions.filter(item=>item.risk==='Advanced');const nodes=[];
    if(normal.length)nodes.push(actionRows(data,normal,provider));if(advanced.length)nodes.push(fold('Advanced settings · '+advanced.length,actionRows(data,advanced,provider)));
    if(!definitions.length)nodes.push(empty('No supported items were found.'));return nodes;
  }
  function renderCaches(page,data){
    const state=local.get('cleaner');
    const selected=state.selected||(state.selected=new Set(data.categories.filter(item=>item.risk==='Safe').map(item=>item.id)));
    const stage=state.outcome?'results':state.result?'review':'select';
    const steps=make('ol',undefined,'workflow-steps');steps.setAttribute('aria-label','Cleanup progress');
    for(const [id,label]of[['select','Select caches'],['review','Review scan'],['results','Results']]){const step=make('li',label);if(id===stage)step.setAttribute('aria-current','step');steps.append(step);}page.append(steps);
    if(state.outcome){
      const result=state.outcome;const container=make('section',undefined,'cleanup-result');container.append(icon('check'),make('h2',result.skippedCount?'Cleanup finished with skipped items':'Cleanup complete'),make('p','Your results are kept here until the next scan.'));
      const stats=make('div',undefined,'cleanup-result-stats');
      for(const [value,label]of[[bytes(result.bytes),'Space recovered'],[String(result.removed),'Files removed'],[String(result.skippedCount),'Files skipped']]){const item=make('div');item.append(make('strong',value),make('span',label));stats.append(item);}container.append(stats);
      if(result.skippedCategories?.length){const skipped=make('div');for(const item of result.skippedCategories){const row=make('div',undefined,'cleanup-skip');row.append(make('strong',item.label),make('p',item.reason));skipped.append(row);}container.append(fold('Skipped categories · '+result.skippedCategories.length,skipped));}
      container.append(toolbar(button('Start a new scan',()=>{state.outcome=null;state.result=null;render('cleaner',data);},true)));page.append(container);return;
    }
    const layout=make('div',undefined,'cleaner-layout');const categories=make('div');const summary=make('aside',undefined,'cleaner-summary');summary.setAttribute('aria-label','Cleanup summary');
    const heading=make('h2',state.job?'Working':state.result?'Ready to clean':'Choose what to scan');const amount=make('strong',state.result?'':state.job?'Scanning…':'','cleaner-summary-value');const caption=make('p');const breakdown=make('div',undefined,'cache-breakdown');summary.append(heading,amount,caption,breakdown);
    const controls=[];
    const reviewItems=()=>state.result?.categories.filter(item=>selected.has(item.id)&&item.count>0&&!item.blocked)||[];
    const updateSummary=()=>{
      if(state.result){const items=reviewItems();const count=items.reduce((sum,item)=>sum+item.count,0);const total=items.reduce((sum,item)=>sum+item.bytes,0);amount.textContent=bytes(total);caption.textContent=count.toLocaleString()+(count===1?' file across ':' files across ')+items.length+(items.length===1?' category':' categories');if(!state.job)heading.textContent=items.length?'Ready to clean':state.result.count?'Choose categories to clean':'No cache files found';controls[0].disabled=Boolean(state.job)||!items.length;breakdown.replaceChildren();for(const item of items.slice().sort((a,b)=>b.bytes-a.bytes).slice(0,5)){const row=make('div',undefined,'breakdown-item');const meter=make('progress');meter.max=100;meter.value=total?item.bytes/total*100:0;meter.setAttribute('aria-label',item.label+' share of selected cache bytes');row.append(make('span',item.label),make('span',bytes(item.bytes)),meter);breakdown.append(row);}}
      else{amount.hidden=!state.job;caption.textContent=selected.size+(selected.size===1?' category selected':' categories selected');if(controls[0])controls[0].disabled=Boolean(state.job)||!selected.size;}
    };
    const run=async(cleaning)=>{
      const reference=await action(()=>cleaning?api.cleanCaches(state.result.scanId,reviewItems().map(item=>item.id)):api.scanCaches([...selected]),{refresh:false,message:''});
      if(!reference?.id)return;
      state.job=reference.id;state.operation=cleaning?'clean':'scan';render('cleaner',data);
      await watch(reference,result=>{if(cleaning){state.outcome=result;state.result=null;}else{state.result=result;state.outcome=null;}});
      state.job=null;state.operation=null;if(active==='cleaner')render('cleaner',data);
    };
    const primary=button(state.job?(state.operation==='clean'?'Cleaning…':'Scanning…'):state.result?'Clean selected':'Scan selected',()=>run(Boolean(state.result)),true);primary.dataset.cleanerAction=state.result?'clean':'scan';controls.push(primary);summary.append(primary);
    if(state.result){const edit=button('Edit selection',()=>{state.result=null;render('cleaner',data);});edit.disabled=Boolean(state.job);summary.append(edit);}
    summary.append(make('p',state.result?'Cache files are removed permanently.':'Scanning does not remove files.','cleaner-summary-note'));
    if(!state.result){const actions=make('div',undefined,'selection-actions');actions.append(make('span','Cache categories'),button('Recommended',()=>{state.selected=new Set(data.categories.filter(item=>item.risk==='Safe').map(item=>item.id));render('cleaner',data);}),button('Clear',()=>{selected.clear();render('cleaner',data);}));for(const control of actions.querySelectorAll('button'))control.disabled=Boolean(state.job);categories.append(actions);}
    const draw=(title,iconName,items)=>{
      if(!items.length)return null;
      const section=make('section',undefined,'cache-group');const heading=make('h2',title,'cache-group-heading');heading.prepend(icon(iconName));section.append(heading);
      for(const item of items){
        const found=state.result?.categories.find(category=>category.id===item.id);if(state.result&&!found)continue;
        const row=make('div',undefined,'cache-choice');const choice=check(item.label,selected.has(item.id));choice.input.disabled=Boolean(state.job)||Boolean(found&&(found.blocked||!found.count));if(choice.input.disabled&&found)choice.input.checked=false;
        const sourceIcon=item.id==='nvidia'?'nvidia':item.id==='amd'?'amd':item.id.startsWith('steam')?'steam':['temp','windows-temp','explorer-cache','windows-update','prefetch'].includes(item.id)?'windows':null;const cacheIcon=icon(['directx','nvidia','amd'].includes(item.id)?'gpu':['chrome','edge','firefox'].includes(item.id)?'network':sourceIcon==='windows'?'windows':'layers');cacheIcon.classList.add('cache-icon');choice.wrapper.insertBefore(cacheIcon,choice.wrapper.querySelector('span'));if(sourceIcon)void api.sourceIcon(sourceIcon).then(source=>{if(!source?.startsWith('data:image/')||!cacheIcon.isConnected)return;const image=make('img');image.src=source;image.alt='';image.className='brand-icon';cacheIcon.replaceWith(image);}).catch(()=>{});
        choice.input.addEventListener('change',()=>{if(choice.input.checked)selected.add(item.id);else selected.delete(item.id);updateSummary();});
        const info=make('div',undefined,'cache-choice-info');if(found){if(found.blocked){info.textContent=found.blocked;row.dataset.blocked='true';}else{info.append(make('strong',bytes(found.bytes)),make('span',found.count.toLocaleString()+(found.count===1?' file':' files')));}}else if(item.risk!=='Safe')info.textContent=item.risk;
        row.append(choice.wrapper,info);section.append(row);
      }
      return section.childElementCount>1?section:null;
    };
    const groups=[['Windows','windows',['temp','windows-temp','explorer-cache']],['Shader caches','gpu',['directx','nvidia','amd']],['Apps and launchers','layers',['discord','chrome','edge','firefox','steam-web','epic','riot','roblox']]];
    for(const [title,iconName,ids]of groups){const section=draw(title,iconName,data.categories.filter(item=>ids.includes(item.id)));if(section)categories.append(section);}
    const advanced=draw('System and download caches','disk',data.categories.filter(item=>item.risk==='Advanced'));if(advanced){const details=fold('Advanced caches',advanced);details.open=Boolean(state.result);categories.append(details);}
    if(state.job){heading.textContent=state.operation==='clean'?'Cleaning selected caches':'Scanning selected caches';amount.textContent=state.result?bytes(reviewItems().reduce((sum,item)=>sum+item.bytes,0)):'Please wait';}
    layout.append(categories,summary);page.append(layout);updateSummary();
  }
  function renderFiles(page){
    const state=local.get('files');
    const mode=select([{value:'large',label:'Large files · 100 MiB+'},{value:'duplicates',label:'Duplicates · SHA-256'},{value:'empty',label:'Empty folders'}],state.mode||'large');mode.addEventListener('change',()=>{state.mode=mode.value;state.result=null;render('files',{});});
    const choose=button('Choose folder',async()=>{const root=await action(()=>api.chooseFolder(),{refresh:false,message:'Folder selected.'});if(root){state.root=root;state.result=null;render('files',{});}});
    const scan=button('Scan',async()=>{const job=await action(()=>api.scanFiles(state.root.id,mode.value),{refresh:false,message:'Scan started.'});if(job)await watch(job,result=>{state.result=result;if(active==='files')render('files',{});});},true);scan.disabled=!state.root;
    page.append(toolbar(field('Find',mode),choose,scan));if(state.root)page.append(make('p',state.root.path,'selected-path'));
    if(!state.result){page.append(empty('Choose a folder, then scan.'));return;}
    const selected=new Set();const result=state.result;
    const remove=button(result.mode==='empty'?'Remove selected folders':'Move selected to Recycle Bin',async()=>{const ids=[...selected];const job=await action(()=>api.removeFiles(result.scanId,ids),{refresh:false,message:'Removal started.'});if(job)await watch(job,output=>{state.result.items=state.result.items.filter(item=>!ids.includes(item.id));if(active==='files'){render('files',{});notice(page,output.removed+' items removed · '+output.skipped.length+' skipped');}});},true);remove.disabled=true;
    page.append(toolbar(make('span',result.total+' matches'+(result.limited?' · scan limit reached':'')+(result.items.length<result.total?' · showing first '+result.items.length:''),'toolbar-status'),remove));
    const list=make('div',undefined,'file-results');
    for(const item of result.items){const row=make('div',undefined,'file-row');const choice=check(item.path);choice.input.addEventListener('change',()=>{if(choice.input.checked)selected.add(item.id);else selected.delete(item.id);remove.disabled=!selected.size;});choice.wrapper.title=item.path;row.append(choice.wrapper,make('span',item.directory?'Folder':bytes(item.size),'file-size'));if(item.group)row.append(make('span',item.group.slice(0,8),'duplicate-group'));list.append(row);}page.append(list);
    if(!result.items.length)page.append(empty('No matching items.'));
  }
  function renderSettings(page,data,route){
    const definitions=data.definitions||[];
    if(route==='services'||route==='devices'){
      const isServices=route==='services';const items=data.items||[];page.append(window.XeroUI.summary(isServices?[{label:'Managed services',value:items.filter(item=>item.supported).length,icon:'settings'},{label:'Running',value:items.filter(item=>item.state?.running).length,icon:'activity'}]:[{label:'PCI controllers',value:data.devices?.length||0,icon:'cpu'},{label:'Driver MSI support',value:(data.devices||[]).filter(item=>item.supported).length,icon:'shield'}]));
      const container=make('div');const draw=needle=>{const filtered=definitions.filter(item=>item.label.toLowerCase().includes(needle.toLowerCase()));container.replaceChildren(isServices?actionRows(data,filtered,'system'):actionRows(data,filtered,'managed'));if(!filtered.length)container.append(empty('No matching items.'));};page.append(toolbar(searchField(isServices?'Search services':'Search device controllers',draw)),container);draw('');return;
    }
    const groups=route==='gaming'?[
      {title:'Graphics and processor',icon:'cpu',ids:['game-mode','hags','ultimate-plan','unpark']},
      {title:'Mouse, keyboard and USB',icon:'monitor',ids:['mouse-acceleration','keyboard-repeat','usb-suspend']},
      {title:'System tuning',icon:'activity',ids:['responsiveness','network-throttling','paging-executive','default-timer','dynamic-tick']}
    ]:route==='shell'?[
      {title:'File Explorer',icon:'layers',ids:['classic-menu','shortcut-suffix','extensions','hidden-files']},
      {title:'Windows preferences',icon:'windows',ids:['sticky-keys','privacy','animations']}
    ]:null;
    if(groups){for(const group of groups){const section=make('section',undefined,'settings-section');const heading=make('h2',group.title,'settings-heading');heading.prepend(icon(group.icon));section.append(heading,...splitSettings(data,definitions.filter(item=>group.ids.includes(item.id))));page.append(section);}}
    else page.append(...splitSettings(data,definitions,route==='devices'?'managed':'system'));
    if(route==='gaming'){
      const tools=panel('Memory and input','ram');tools.append(toolbar(button('Clear standby memory',async()=>{const job=await action(()=>api.repair('standby'),{refresh:false,message:'Memory purge started.'});if(job)await watch(job);}),button('Import MarkC preset',async()=>{const preset=await action(()=>api.importMarkC(),{refresh:false,message:'Preset loaded.'});if(preset)await action(()=>reviewApply('managed',preset.id),{message:'Mouse preset applied. Sign out to finish.'});}),button('MarkC source',()=>action(()=>api.markcSource(),{refresh:false,message:'Opened the author’s download page.'}))));page.append(fold('Additional tools',tools));
    }
  }
  function renderGames(page,data){
    const state=local.get('games');state.artObserver?.disconnect();const profile=select([{value:'',label:'Keep current settings'},{value:'gaming',label:'Gaming Mode'},{value:'competitive',label:'Competitive / Low-Latency'},{value:'quiet',label:'Work / Quiet'}],state.profile||'');profile.setAttribute('aria-label','Game launch profile');profile.addEventListener('change',()=>{state.profile=profile.value;});
    let needle='';const launcher=select([{value:'',label:'All launchers'},...[...new Set(data.games.map(game=>game.launcher))].map(value=>({value,label:value}))]);launcher.setAttribute('aria-label','Filter launcher');const grid=make('div',undefined,'game-grid');let observer;
    const draw=()=>{
      observer?.disconnect();grid.replaceChildren();const games=data.games.filter(game=>(!launcher.value||game.launcher===launcher.value)&&game.name.toLowerCase().includes(needle));
      const images=new Map();
      observer=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;observer.unobserve(entry.target);const game=images.get(entry.target);void api.artwork(game.id,window.XeroUI.preferences().onlineArtwork).then(art=>{
        if(!entry.target.isConnected)return;const source=art.image||art.icon;if(!source?.startsWith('data:image/'))return;const image=make('img');image.alt='';image.decoding='async';image.className=art.image?'':'game-exe-icon';image.addEventListener('load',()=>{image.dataset.loaded='true';entry.target.querySelector('svg')?.remove();});image.src=source;image.title=art.source||'Installed app icon';entry.target.append(image);
      }).catch(()=>{});}}, {root:byId('main-content'),rootMargin:'200px'});
      state.artObserver=observer;
      for(const game of games){const card=make('article',undefined,'game-card');const cover=make('div',undefined,'game-cover');cover.append(icon('game'));images.set(cover,game);const copy=make('div',undefined,'game-meta');copy.append(make('h3',game.name),make('span',game.launcher,'game-launcher'));const controls=make('div',undefined,'game-actions');const launch=button('Launch',()=>action(()=>api.launchGame(game.id,state.profile||null),{refresh:false,message:'Launch requested.'}),true);launch.prepend(icon('game'));controls.append(launch);copy.append(controls);const details=fold('Game details',make('p',game.root),button('Choose artwork',()=>action(()=>api.importArtwork(game.id),{message:'Artwork updated.'})));details.className='game-details';card.append(cover,copy,details);grid.append(card);observer.observe(cover);}
      if(!games.length){const blank=make('section',undefined,'activity-empty');blank.append(icon('game'),make('h2',data.games.length?'No matching games':'Your game library'),make('p',data.games.length?'Try another title or launcher.':'Installed Steam, Epic, Riot and Roblox games appear here. Add a game to include another executable.'));grid.append(blank);}
    };
    const search=searchField('Search games',value=>{needle=value.trim().toLowerCase();draw();});launcher.addEventListener('change',draw);
    const launchOptions=field('Launch profile',profile);launchOptions.classList.add('game-profile');const controls=toolbar(search,launcher,button('Add game',()=>action(()=>api.addGame(),{message:'Game added.'})));controls.classList.add('library-toolbar');page.append(controls,launchOptions,grid);draw();
  }
  function renderSettingsPage(page){
    const preferences=window.XeroUI.preferences();const section=panel('App preferences','settings');
    const rows=[['Compact layout','Use smaller rows for long lists.',preferences.density==='compact',value=>window.XeroUI.save({density:value?'compact':'comfortable'})],['Reduce motion','Use instant transitions and still indicators.',preferences.motion==='reduced',value=>window.XeroUI.save({motion:value?'reduced':'system'})],['Online Steam artwork','Fetch official covers when installed artwork is unavailable.',preferences.onlineArtwork,value=>window.XeroUI.save({onlineArtwork:value})]];
    for(const[label,description,checked,change]of rows){const row=make('div',undefined,'preference-row');const copy=make('div');copy.append(make('h3',label),make('p',description));row.append(copy,window.XeroUI.toggle(label,checked,change));section.append(row);}page.append(section,shortcuts([['Task history','clock','activity'],['Recovery','shield','recovery'],['About XeroLag','info','about']]));
  }
  function renderRegistry(page,data){
    const container=make('div');const draw=needle=>{container.replaceChildren();for(const entry of data.entries.filter(item=>(item.label+' '+item.name+' '+item.key).toLowerCase().includes(needle.toLowerCase()))){const row=make('div',undefined,'setting-row');const copy=make('div');copy.className='repair-tool-copy';copy.append(make('h3',entry.name),make('p',entry.hive+'\\'+entry.key,'registry-key'));const value=entry.exists?(Array.isArray(entry.value)?entry.value.join(', '):String(entry.value)):'Not set';copy.append(make('p',(entry.kind||'Default')+' · '+value,'setting-description'));row.append(copy,button('Open setting',()=>window.XeroUI.navigate(entry.group==='gaming'?'gaming':entry.group==='network'?'network':'shell')));container.append(row);}if(!container.children.length)container.append(empty('No matching managed registry settings.'));};page.append(toolbar(searchField('Search managed registry settings',draw),button('Windows Registry Editor',()=>action(()=>api.nativeTool('registry-editor'),{refresh:false,message:'Windows Registry Editor opened.'}))),container);draw('');
  }
  function renderTools(page,data){
    for(const group of [...new Set(data.tools.map(tool=>tool.group))]){const section=make('section',undefined,'settings-section');section.append(make('h2',group,'section-heading'));for(const tool of data.tools.filter(tool=>tool.group===group)){const row=make('div',undefined,'repair-tool');row.append(icon(tool.icon));const copy=make('div',undefined,'repair-tool-copy');copy.append(make('h3',tool.label));if(tool.description)copy.append(make('p',tool.description));const open=button('Open',()=>action(()=>api.nativeTool(tool.id),{refresh:false,message:tool.label+' opened.'}));open.disabled=!tool.supported;row.append(copy,open);section.append(row);}page.append(section);}
    page.append(shortcuts([['Permissions check','shield','repair'],['Process manager','activity','processes'],['Registry settings','registry','registry']]));
  }
  function renderProcesses(page,data){
    const table=make('table',undefined,'data-table');const header=make('thead');const labels=make('tr');for(const label of['Process','Memory','CPU time','Priority',''])labels.append(make('th',label));header.append(labels);const body=make('tbody');table.append(header,body);const container=make('div',undefined,'table-surface');container.append(table);
    const draw=needle=>{body.replaceChildren();for(const process of data.processes.filter(item=>item.name.toLowerCase().includes(needle.toLowerCase()))){const row=make('tr');const name=make('td');name.append(make('strong',process.name),make('span',' · '+process.pid,'muted'));row.append(name,make('td',bytes(process.memory)),make('td',Math.round(process.cpuSeconds)+' s'),make('td',process.priority));const actions=make('td');if(process.canClose)actions.append(button('Close app',()=>action(()=>api.closeApp(process.pid,process.ticks),{message:'Close request sent.'})));row.append(actions);body.append(row);}};page.append(window.XeroUI.summary([{label:'Processes in your session',value:data.processes.length,icon:'activity'},{label:'Listed working memory',value:bytes(data.processes.reduce((sum,item)=>sum+item.memory,0)),icon:'ram'}]),toolbar(searchField('Search processes',draw),button('Task Manager',()=>action(()=>api.nativeTool('task-manager'),{refresh:false,message:'Task Manager opened.'}))),container);draw('');
  }
  function renderBooster(page,data){
    const state=data.status;const options=state.options||{};const timer=check('Request 1 ms timer resolution',Boolean(state.running&&options.timer));const auto=check('Automatically boost selected games',Boolean(state.running&&options.booster));
    const plan=select((data.power?.plans||[]).map(item=>({value:item.id,label:item.name})),options.powerPlan||data.power?.active);
    const gameChecks=data.games.map(game=>({id:game.id,...check(game.name,(options.games||[]).includes(game.id))}));
    const backgroundNames=['chrome','msedge','firefox','Discord','steam','EpicGamesLauncher','RiotClientServices'];const backgrounds=backgroundNames.map(name=>({name,...check(name,(options.backgrounds||[]).includes(name))}));
    const save=button(state.running?'Update':'Start',()=>action(()=>api.configureBooster({timer:timer.input.checked,booster:auto.input.checked,powerPlan:plan.value,games:gameChecks.filter(item=>item.input.checked).map(item=>item.id),backgrounds:backgrounds.filter(item=>item.input.checked).map(item=>item.name)}),{message:'Booster configuration saved.'}),true);
    const stop=button('Stop and restore',()=>action(()=>api.stopBooster(),{message:'Background changes restored.'}));stop.disabled=!state.running;
    page.append(toolbar(make('span',state.running?'Running':'Stopped','toolbar-status'),save,stop));
    const settings=panel('Session controls','activity');settings.append(auto.wrapper,timer.wrapper,field('Game power plan',plan));
    const games=make('div',undefined,'check-grid');games.append(...gameChecks.map(item=>item.wrapper));settings.append(fold('Selected games',games));
    const apps=make('div',undefined,'check-grid');apps.append(...backgrounds.map(item=>item.wrapper));settings.append(fold('Suspend background apps · optional',make('p','Downloads, audio, and other activity in these apps will pause.','setting-description'),apps));page.append(settings);
    const status=make('p',undefined,'worker-status');status.id='booster-live-status';page.append(status);
    const update=value=>{status.textContent=value.error||((value.activeGames||[]).length?'Playing: '+value.activeGames.join(', ')+' · '+value.suspended+' background processes suspended':value.running?'Waiting for a selected game':'Stopped')+(value.timer?' · timer '+Number(value.resolutionMs).toFixed(2)+' ms':'');};update(state);
    clearInterval(boosterPoll);boosterPoll=setInterval(()=>{if(active==='booster')api.boosterStatus().then(update).catch(error=>{status.textContent=error.message;});},1500);
  }
  function renderNetwork(page,data){
    const state=local.get('network');const adapters=data.adapters||[];if(!adapters.length){page.append(empty('No network adapters found.'));return;}
    const adapter=adapters.find(item=>item.guid===state.adapter)||adapters.find(item=>item.status==='Up')||adapters[0];state.adapter=adapter.guid;
    const picker=select(adapters.map(item=>({value:item.guid,label:item.name+' · '+item.status})),adapter.guid);picker.setAttribute('aria-label','Network adapter');picker.addEventListener('change',()=>{state.adapter=picker.value;state.provider=null;render('network',data);});
    if(state.infoGuid!==adapter.guid){state.infoGuid=adapter.guid;state.info=null;void api.networkInfo(adapter.guid).then(info=>{if(state.infoGuid!==adapter.guid)return;state.info=info;if(active==='network'&&!state.working)render('network',data);}).catch(()=>{});}
    page.append(window.XeroUI.summary([{label:'Adapter',value:adapter.name,icon:'network',detail:adapter.status==='Up'?'Link active':adapter.status},{label:'IP configuration',value:state.info?(state.info.mode==='Enabled'?'DHCP':'Manual'):'—',icon:'monitor',detail:state.info?.linkSpeed},{label:'Current DNS',value:adapter.dns.slice(0,2).join(', ')||'Automatic',icon:'layers'}]));
    const dnsMatches=provider=>data.definitions.find(item=>item.adapter===state.adapter&&item.provider===provider)?.matches;
    if(!state.provider)state.provider=data.definitions.find(item=>item.adapter===state.adapter&&item.provider&&item.matches)?.provider||null;
    const apply=button('Review DNS',()=>{const target=data.definitions.find(item=>item.adapter===state.adapter&&item.provider===state.provider);return action(()=>reviewApply('managed',target.id),{message:'DNS settings applied.'});},true);apply.disabled=!state.provider||dnsMatches(state.provider);
    const test=button('Test providers',async()=>{const results=await action(()=>api.ping(),{refresh:false,message:'DNS lookup and ICMP tests completed.'});if(results){state.pings=results;if(active==='network')render('network',data);}});
    page.append(toolbar(picker,test,apply));const layout=make('div',undefined,'workspace-grid');const providers=panel('DNS providers','network');const list=make('div',undefined,'dns-list');
    const available=(state.pings||[]).filter(item=>Number.isFinite(item.lookupMs)).sort((a,b)=>a.lookupMs-b.lookupMs);const fastest=available[0];
    for(const option of[{id:'cloudflare',name:'Cloudflare',address:'1.1.1.1 · 1.0.0.1',mark:'C'},{id:'google',name:'Google',address:'8.8.8.8 · 8.8.4.4',mark:'G'},{id:'quad9',name:'Quad9',address:'9.9.9.9 · 149.112.112.112',mark:'Q'},{id:'default',name:'Automatic',address:'Use adapter defaults',mark:'A'}]){const label=make('label',undefined,'dns-option');const radio=make('input');radio.type='radio';radio.name='dns-provider';radio.value=option.id;radio.checked=state.provider===option.id;radio.addEventListener('change',()=>{state.provider=option.id;apply.disabled=dnsMatches(option.id);});const copy=make('div');copy.append(make('strong',option.name+(dnsMatches(option.id)?' · Current':'')),make('span',option.address));const result=state.pings?.find(item=>item.id===option.id);const latency=result?(result.lookupMs===null?'Lookup unavailable':result.lookupMs+' ms DNS'):'Not tested';label.append(radio,make('span',option.mark,'provider-mark'),copy,make('span',latency,'dns-latency'));list.append(label);}providers.append(list);if(fastest)providers.append(toolbar(button('Select fastest tested provider',()=>{state.provider=fastest.id;render('network',data);})));layout.append(providers);
    const history=state.samples||(state.samples=[]);const latest=history.at(-1);const diagnostics=support('Route diagnostics','activity');const results=make('div',undefined,'network-results');for(const[label,value]of[['Latency',latest?.latency===null||!latest?'—':latest.latency+' ms'],['Packet loss',latest?latest.loss+'%':'—'],['Jitter',latest?.jitter===null||!latest?'—':latest.jitter+' ms']]){const item=make('div');item.append(make('span',label),make('strong',value));results.append(item);}diagnostics.append(results);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('network-chart');svg.setAttribute('viewBox','0 0 360 110');svg.setAttribute('role','img');svg.setAttribute('aria-label','Measured latency samples to 1.1.1.1');const pathNode=document.createElementNS(svg.namespaceURI,'path');pathNode.setAttribute('class','graph-grid');pathNode.setAttribute('d','M0 15H360M0 55H360M0 95H360');svg.append(pathNode);const maximum=Math.max(1,...history.filter(item=>item.latency!==null).map(item=>item.latency));let path='',gap=true;history.forEach((item,index)=>{if(item.latency===null){gap=true;return;}const x=history.length===1?180:index*360/(history.length-1),y=95-item.latency/maximum*80;path+=(gap?'M':'L')+x.toFixed(1)+' '+y.toFixed(1)+' ';gap=false;});const line=document.createElementNS(svg.namespaceURI,'path');line.setAttribute('class','graph-line');line.setAttribute('d',path);svg.append(line);diagnostics.append(svg);
    const sample=async()=>{if(state.probing)return;state.probing=true;state.probeError=null;if(active==='network')render('network',data);try{const result=await api.networkProbe();history.push(result);if(history.length>30)history.shift();}catch(error){state.probeError=error.message;}finally{state.probing=false;if(active==='network')render('network',data);if(state.monitor&&active==='network')state.timer=setTimeout(sample,8000);}};
    const probe=button(state.probing?'Testing…':'Test route',sample);probe.disabled=Boolean(state.probing);const monitor=button(state.monitor?'Stop monitoring':'Monitor',()=>{state.monitor=!state.monitor;clearTimeout(state.timer);if(state.monitor)void sample();else render('network',data);});diagnostics.append(toolbar(probe,monitor),make('p',latest?latest.received+'/'+latest.sent+' ICMP replies · system route to 1.1.1.1':'Run a test to measure your system route.'));layout.append(make('aside'));layout.lastChild.className='workspace-aside';layout.lastChild.append(diagnostics);page.append(layout);
    const advanced=make('div');
    advanced.append(...splitSettings(data,data.definitions.filter(item=>!item.provider&&item.adapter===state.adapter),'managed'),actionRows(data,data.system||[],'system'));
    const repairs=['winsock','tcp-reset'].map(id=>button(id==='winsock'?'Reset Winsock':'Reset TCP/IP',async()=>{
      const job=await action(()=>api.repair(id),{refresh:false,message:'Network repair started.'});if(job)await watch(job);
    }));
    advanced.append(toolbar(button('Flush DNS',()=>action(()=>api.flushDns(),{refresh:false,message:'DNS cache cleared.'})),button('Restart adapter',async()=>{const job=await action(()=>api.restartAdapter(state.adapter),{refresh:false,message:''});if(job?.id)await watch(job);}),...repairs));
    page.append(fold('Advanced network settings',advanced));if(state.probeError)notice(page,state.probeError,true);
  }
  function renderStartup(page,data){
    const entries=[...(data.definitions||[]),...(data.folders||[]).map(item=>({...item,enabled:true,provider:'startup-files',source:'Startup folder'}))];const state=local.get('startup');const selected=new Set();let needle='';const filter=select([{value:'all',label:'All entries'},{value:'on',label:'Enabled'},{value:'off',label:'Disabled'}]);filter.setAttribute('aria-label','Startup status filter');
    const enabled=entries.filter(item=>item.enabled!==false).length;page.append(window.XeroUI.summary([{label:'Startup entries',value:enabled+' enabled / '+entries.length,icon:'power'},{label:'Last recorded boot',value:data.boot?.supported?(data.boot.milliseconds/1000).toFixed(1)+' s':'Not recorded',icon:'clock',detail:data.boot?.createdAt?new Date(data.boot.createdAt).toLocaleString():null}]));
    const table=make('table',undefined,'data-table');const head=make('thead');const headings=make('tr');for(const label of['','App','Status','Recorded boot time',''])headings.append(make('th',label));head.append(headings);const body=make('tbody');table.append(head,body);const container=make('div',undefined,'table-surface');container.append(table);
    const applyEntry=entry=>{const record=entry.restoreId||(data.records||[]).find(record=>record.key===(entry.provider||'managed')+':'+entry.id&&record.phase!=='restored')?.id;return record?api.restore(record):reviewApply(entry.provider||'managed',entry.id);};
    const applySelected=button('Review selected',async()=>{await action(async()=>{const previews=[];for(const entry of entries.filter(item=>selected.has(item.id))){const record=entry.restoreId||(data.records||[]).find(record=>record.key===(entry.provider||'managed')+':'+entry.id&&record.phase!=='restored')?.id;previews.push({entry,record,preview:record?{label:entry.label,changes:[{label:'Startup',current:entry.enabled===false?'Off':'On',requested:'Restore saved state'}]}:await api.preview(entry.provider||'managed',entry.id)});}if(!await reviewChanges({label:previews.length+' startup entries',risk:'Moderate',changes:previews.flatMap(item=>item.preview.changes.map(change=>({...change,label:item.entry.label+' · '+change.label}))),recovery:'Restore original entries from Repair > Recovery.'}))return{cancelled:true};for(const item of previews){if(item.record)await api.restore(item.record);else await api.apply(item.entry.provider||'managed',item.entry.id,item.preview.token);}return{success:true};},{message:'Startup entries updated.'});},true);applySelected.disabled=true;
    const draw=()=>{selected.clear();applySelected.disabled=true;applySelected.textContent='Review selected';body.replaceChildren();for(const entry of entries.filter(item=>(item.label+' '+(item.description||'')).toLowerCase().includes(needle)&& (filter.value==='all'||(filter.value==='off')===(item.enabled===false)))){const row=make('tr');const checkbox=check('Select '+entry.label);checkbox.wrapper.querySelector('span').className='sr-only';checkbox.input.addEventListener('change',()=>{if(checkbox.input.checked)selected.add(entry.id);else selected.delete(entry.id);applySelected.disabled=!selected.size;applySelected.textContent=selected.size?'Review '+selected.size+' selected':'Review selected';});const selection=make('td');selection.append(checkbox.wrapper);const name=make('td');const app=make('div',undefined,'app-name');app.append(icon('windows'),make('strong',entry.label));name.append(app);const details=fold(entry.source||'Startup',make('p',entry.description||entry.command||entry.label,'registry-key'));name.append(details);if((entry.provider||'managed')==='managed')void api.itemIcon(entry.id).then(source=>{if(!source?.startsWith('data:image/')||!app.isConnected)return;const image=make('img');image.src=source;image.alt='';app.firstChild.replaceWith(image);}).catch(()=>{});
      const status=make('td');const badge=make('span',entry.enabled===false?'Off':'On','state-tag');badge.dataset.on=String(entry.enabled!==false);status.append(badge);const event=(data.boot?.applications||[]).find(item=>item.name&&String(entry.description||'').toLowerCase().includes(String(item.name).split(/[\\/]/).at(-1).toLowerCase()));const recorded=make('td',event?(event.milliseconds/1000).toFixed(2)+' s':'Not recorded');const actions=make('td');actions.append(button(entry.restoreId?'Restore':entry.enabled===false?'Enable':'Disable',()=>action(()=>applyEntry(entry),{message:'Startup entry updated.'})));row.append(selection,name,status,recorded,actions);body.append(row);}if(!body.children.length){const row=make('tr');const cell=make('td','No matching startup entries.');cell.colSpan=5;row.append(cell);body.append(row);}};
    filter.addEventListener('change',draw);page.append(toolbar(searchField('Search startup apps',value=>{needle=value.toLowerCase();draw();}),filter),container,toolbar(applySelected,button('Task Manager',()=>action(()=>api.nativeTool('task-manager'),{refresh:false,message:'Task Manager opened.'}))));draw();state.lastCount=entries.length;
  }
  function renderDebloat(page,data){
    const selected=new Set();const remove=button('Review removal',async()=>{await action(async()=>{
      const previews=[];for(const id of selected)previews.push({id,...await api.preview('managed',id)});
      const combined={label:previews.length+' selected apps',risk:'Advanced',changes:previews.flatMap(item=>item.changes.map(change=>({...change,label:item.label+' · '+change.label}))),recovery:'Retained app files can be re-registered. Otherwise reinstall from Microsoft Store or the saved OneDrive installer. Sign-in may be required.',restart:previews.some(item=>item.restart)};
      if(!await reviewChanges(combined))return{cancelled:true};
      const results=[];for(const preview of previews)results.push(await api.apply('managed',preview.id,preview.token));return results;
    },{message:'Selected package operations finished.'});},true);remove.disabled=true;
    page.append(toolbar(make('span',data.definitions.length+' installed items','toolbar-status'),remove));const list=make('div',undefined,'selection-list');
    for(const item of data.definitions){const choice=check(item.label);choice.input.addEventListener('change',()=>{if(choice.input.checked)selected.add(item.id);else selected.delete(item.id);remove.disabled=!selected.size;});const row=make('div',undefined,'selection-row');const copy=make('div',undefined,'setting-copy');copy.append(choice.wrapper,make('p',item.description,'setting-description'));row.append(copy,risk(item.risk));list.append(row);}page.append(list);if(!data.definitions.length)page.append(empty('No removable packages from the supported list are installed.'));
  }
  function renderRepair(page,data){
    const trimVolumes=data.capabilities.trimVolumes||[];
    const volume=select(trimVolumes.map(item=>({value:String(item.DriveLetter),label:String(item.DriveLetter)+': '+(item.FileSystemLabel||'')})),trimVolumes.find(item=>String(item.DriveLetter).toUpperCase()==='C')?.DriveLetter);
    const state=local.get('repair');const run=async id=>{const job=await action(()=>id==='permissions'?api.checkPermissions():api.repair(id,id==='trim'?volume.value:undefined),{refresh:false,message:''});if(job?.id)await watch(job);};
    const last=data.jobs.filter(job=>job.group==='system').at(-1);page.append(window.XeroUI.summary([{label:'Windows repair',value:last?jobState(last.status):'Ready',icon:'shield'},{label:'Last task',value:last?.label||'Not run this session',icon:'clock'}],[button('Run DISM + SFC',()=>run('recommended'),true)]));
    const layout=make('div',undefined,'repair-grid');const rows=make('div');rows.append(make('h2','Repair and maintenance','section-heading'));const icons={sfc:'shield',dism:'windows',trim:'disk',winget:'download',winsock:'network','tcp-reset':'network',standby:'ram','delivery-cache':'clean',permissions:'shield'};
    for(const tool of data.tools.filter(tool=>tool.id!=='recommended')){const row=make('div',undefined,'repair-tool');row.append(icon(icons[tool.id]||'tools'));const copy=make('div',undefined,'repair-tool-copy');copy.append(make('h3',tool.label),make('p',tool.description));if(tool.id==='trim'){if(trimVolumes.length)copy.append(field('SSD volume',volume));else copy.append(make('p','No confirmed SSD volume reported.'));}const start=button(tool.id==='permissions'?'Choose folder':tool.id==='delivery-cache'?'Clean cache':'Run',()=>run(tool.id));start.disabled=tool.id==='winget'&&!data.capabilities.winget||tool.id==='trim'&&!trimVolumes.length;row.append(copy,start);rows.append(row);}layout.append(rows);
    const aside=make('aside',undefined,'workspace-aside');const disks=state.health?.disks||[];const health=support('Disk health','disk',disks.length?disks.map(disk=>[disk.name,disk.health]):[['Storage',state.health?'Not reported':'Reading…']],[button('Disk details',()=>window.XeroUI.navigate('health'))]);const recovery=support('Recovery','shield',[],[button('Saved changes',()=>window.XeroUI.navigate('recovery')),button('System image backup',()=>action(()=>api.nativeTool('system-image'),{refresh:false,message:'Windows Backup opened.'})),button('Startup recovery',()=>action(()=>api.nativeTool('startup-repair'),{refresh:false,message:'Windows Recovery opened.'}))]);aside.append(health,recovery);layout.append(aside);page.append(layout);
    if(!state.healthPending&&!state.health){state.healthPending=true;void api.health().then(health=>{state.health=health;if(active==='repair'&&!state.working)render('repair',data);}).catch(()=>{state.health={disks:[]};}).finally(()=>{state.healthPending=false;});}
  }
  function renderHealth(page,data){
    for(const disk of data.disks||[]){const section=panel(disk.name,'disk');const info=make('dl',undefined,'detail-list');for(const[label,value]of[['Windows health',disk.health],['Type',disk.media+' · '+disk.bus],['Capacity',bytes(disk.size)],['Temperature',disk.temperature===null?'Not reported':disk.temperature+' °C'],['Wear',disk.wear===null?'Not reported':disk.wear+'%'],['Power-on hours',disk.hours??'Not reported'],['Read errors',disk.readErrors??'Not reported'],['Write errors',disk.writeErrors??'Not reported']]){const row=make('div',undefined,'detail-row');row.append(make('dt',label),make('dd',value));info.append(row);}section.append(info);if(disk.note)section.append(make('p',disk.note,'setting-description'));page.append(section);}if(!(data.disks||[]).length)page.append(empty('Storage health is not available from the installed driver.'));
    const smart=panel('SMART prediction','activity');if(data.smart?.length){for(const entry of data.smart)smart.append(make('p',entry.InstanceName+' · '+(entry.PredictFailure?'Failure predicted':'No failure predicted'),'setting-description'));}else smart.append(empty('This driver does not expose SMART predictive counters.'));page.append(smart);
  }
  function recoveryRows(records){const list=make('div',undefined,'setting-list');for(const record of records.slice().reverse()){const row=make('div',undefined,'setting-row');const copy=make('div',undefined,'setting-copy');copy.append(make('h3',record.label),make('p',record.phase+' · '+new Date(record.createdAt).toLocaleString(),'setting-description'));if(record.error)copy.append(make('p',record.error,'setting-description'));row.append(copy,button('Restore',()=>action(()=>api.restore(record.id),{message:'Saved state restored.'})));if(record.key.includes('appx-'))row.append(button('Store',()=>action(()=>api.openStore(record.id),{refresh:false,message:'Microsoft Store opened.'})));list.append(row);}return list;}
  function renderRecovery(page,data){
    const active=(data.records||[]).filter(item=>item.phase!=='restored');page.append(toolbar(make('span',active.length+' pending settings','toolbar-status'),button('Restore all',()=>action(()=>api.restoreAll(),{message:'Recovery finished. Review any remaining entries.'}),true)));
    if(data.warnings?.length)page.append(make('p',data.warnings.join('; '),'notice notice-error'),button('Recover background session',()=>action(()=>api.recoverWorker(),{message:'Background session restored.'}),true));
    if(active.length)page.append(recoveryRows(active));else page.append(empty('No pending module changes.'));
    const backups=panel('Windows recovery','layers');backups.append(toolbar(button('Backup files',()=>action(()=>api.openRecovery(),{refresh:false,message:'Recovery folder opened.'})),button('System Protection',()=>window.xerolag.profiles.openSystemProtection()),button('Windows System Restore',()=>action(()=>api.systemRestore(),{refresh:false,message:'Windows System Restore opened.'}))));page.append(backups);
  }
  const jobState=status=>({queued:'Queued',running:'In progress',completed:'Completed',cancelled:'Cancelled',failed:'Needs attention'})[status]||status;
  function renderActivity(page,data){
    const state=local.get('activity');const jobs=data.jobs||[];lastActivity=jobs;
    if(!jobs.length){const blank=make('section',undefined,'activity-empty');blank.append(icon('clock'),make('h2','No tasks yet'),make('p','Scans, cleanups and repairs appear here with their results and logs.'));page.append(blank);return;}
    const running=jobs.filter(job=>['running','queued'].includes(job.status));page.append(make('p',running.length?running.length+' task'+(running.length===1?'':'s')+' in progress':'This session · '+jobs.length+(jobs.length===1?' task':' tasks'),'toolbar-status'));
    const list=make('div',undefined,'activity-list');
    for(const job of jobs.slice().reverse()){
      const row=make('div',undefined,'activity-row');row.dataset.status=job.status;row.append(icon(job.status==='completed'?'check':job.status==='failed'?'info':'clock'));
      const copy=make('div',undefined,'activity-copy');const time=new Date(job.createdAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});copy.append(make('h3',job.label),make('p',jobState(job.status)+' · '+time));
      const details=button(state.selected===job.id?'Viewing log':'View log',()=>{state.selected=job.id;render('activity',{jobs:lastActivity});byId('page-activity').querySelector('.job-box')?.scrollIntoView({behavior:'auto',block:'nearest'});});details.dataset.activityJob=job.id;details.disabled=state.selected===job.id;row.append(copy,details);list.append(row);
    }
    page.append(list);
    const selected=jobs.find(job=>job.id===state.selected);if(selected){showJob('activity',selected);const log=page.querySelector('.job-box details');if(log)log.open=true;}
  }
  async function pollActivity(){
    clearTimeout(activityTimer);
    if(!document.hidden){try{
      const jobs=await api.jobs();lastActivity=jobs;
      const running=jobs.filter(job=>['queued','running'].includes(job.status));const count=running.length?String(running.length):'';if(byId('activity-count').textContent!==count)byId('activity-count').textContent=count;
      byId('activity-nav').classList.toggle('activity-running',running.length>0);byId('activity-nav').title=running.length?running.map(job=>job.label).join(', '):'Task history and logs for this session';
      const fingerprint=JSON.stringify(jobs.map(job=>[job.id,job.status]));
      if(active==='activity'){
        if(fingerprint!==activityFingerprint){const focused=document.activeElement?.dataset?.activityJob;render('activity',{jobs});if(focused)byId('page-activity').querySelector('[data-activity-job="'+focused+'"]')?.focus({preventScroll:true});}
        else{const selected=jobs.find(job=>job.id===local.get('activity').selected);if(selected)showJob('activity',selected);}
      }
      activityFingerprint=fingerprint;
    }catch{byId('activity-nav').title='Activity could not refresh. Open Activity to retry.';}}
    activityTimer=setTimeout(pollActivity,1800);
  }
  function render(route,data){
    const page=byId('page-'+route);page.replaceChildren();
    if(route==='cleaner')renderCaches(page,data);else if(route==='files')renderFiles(page);else if(['gaming','shell','services','devices'].includes(route))renderSettings(page,data,route);else if(route==='games')renderGames(page,data);else if(route==='booster')renderBooster(page,data);else if(route==='network')renderNetwork(page,data);else if(route==='startup')renderStartup(page,data);else if(route==='debloat')renderDebloat(page,data);else if(route==='repair')renderRepair(page,data);else if(route==='health')renderHealth(page,data);else if(route==='recovery')renderRecovery(page,data);else if(route==='activity')renderActivity(page,data);else if(route==='registry')renderRegistry(page,data);else if(route==='tools')renderTools(page,data);else if(route==='processes')renderProcesses(page,data);else if(route==='settings')renderSettingsPage(page);
    if(local.get(route).lastJob)showJob(route,local.get(route).lastJob);
  }
  document.addEventListener('xerolag:navigate',event=>{active=routes.includes(event.detail)?event.detail:null;clearInterval(boosterPoll);if(active!=='games')local.get('games').artObserver?.disconnect();if(active!=='network'){const state=local.get('network');state.monitor=false;clearTimeout(state.timer);}if(active)void load(active);});
  document.addEventListener('xerolag:refresh-module',()=>{if(active)void load(active,true);});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void pollActivity();});
  window.addEventListener('pagehide',()=>{clearTimeout(activityTimer);clearInterval(boosterPoll);},{once:true});
  void pollActivity();
})();
