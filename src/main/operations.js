'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const catalog = require('./action-catalog.json');
const { atomicJson } = require('./snapshot-store');
const { ProfileError, assertIdentity } = require('./profile-state');
const {describeSetting,buildReview,matchesSetting}=require('./action-review');

const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

function createOperations({ directory, scripts, profiles, identity, confirm = async () => true, logger, requireReview=false }) {
  let busy = false;
  const providers = new Map();
  const reviews=new Map();
  providers.set('system', { script: 'system-actions.ps1', definitions: catalog });
  const call=(source,action,payload,options)=>source.run?source.run(action,payload,options):scripts.run(source.script,action,payload,options);
  const indexFile = path.join(directory, 'operations.json');
  async function load() {
    try {
      const data = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      if (data.schema !== 1 || !Array.isArray(data.records)) throw new Error('Invalid recovery index.');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { schema: 1, records: [] }; throw new ProfileError('The recovery index is damaged. Restore the backup files before continuing.', 'INVALID_BACKUP'); }
  }
  async function readRecord(item,context=null) {
    if (!/^[a-f0-9-]{36}$/i.test(item.id)) throw new ProfileError('Invalid recovery identifier.', 'INVALID_BACKUP');
    const envelope = JSON.parse(await fs.readFile(path.join(directory, 'records', item.id + '.json'), 'utf8'));
    if (envelope.sha256 !== hash(envelope.data) || envelope.data.id !== item.id) throw new ProfileError('A recovery record failed its integrity check.', 'INVALID_BACKUP');
    assertIdentity(envelope.data.identity, context||await identity());
    return envelope.data;
  }
  function definition(provider, id) {
    const source = providers.get(provider);
    const entry = source?.definitions.find(item => item.id === id);
    if (!entry) throw new ProfileError('This item is no longer available. Refresh the page.', 'INVALID_ACTION');
    return { source, entry };
  }
  async function exclusive(work) {
    if (busy || profiles.isBusy()) throw new ProfileError('Another Windows operation is running.', 'BUSY');
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  async function reviewState(source,entry){return call(source,source.script==='managed-actions.ps1'?'Preview':'Capture',{id:entry.id,target:entry.target,dataRoot:directory});}
  async function preview(provider,id){
    const {source,entry}=definition(provider,id);
    const state=await reviewState(source,entry);
    const token=randomUUID();
    for(const [key,review]of reviews)if(Date.now()-review.createdAt>300_000)reviews.delete(key);
    if(reviews.size>=50)reviews.delete(reviews.keys().next().value);
    reviews.set(token,{provider,id,createdAt:Date.now(),state:hash(state),definition:hash(entry)});
    const review=buildReview(entry,state);
    const parent=source.definitions.find(definition=>definition.choices?.some(choice=>choice.id===id));
    if(parent){
      const requested=parent.choices.find(choice=>choice.id===id);
      const current=parent.choices.find(choice=>{const variant=source.definitions.find(definition=>definition.id===choice.id);return variant&&matchesSetting(variant,state);});
      review.technicalChanges=review.changes;
      review.changes=[{label:parent.label,current:current?.label||describeSetting(parent,state).label,requested:requested.label}];
    }
    return{...review,token};
  }
  async function apply(provider, id, token) {
    return exclusive(async () => {
      const { source, entry } = definition(provider, id);
      const context = await identity();
      if (!context.administrator || !context.desktopMatch) throw new ProfileError('Administrator access under the desktop account is required.', 'ADMIN_REQUIRED');
      let reviewed;
      if(requireReview||token){
        reviewed=reviews.get(token);reviews.delete(token);
        if(!reviewed||reviewed.provider!==provider||reviewed.id!==id||Date.now()-reviewed.createdAt>300_000||reviewed.definition!==hash(entry))throw new ProfileError('Review the change again before applying it.','REVIEW_REQUIRED');
        const live=await reviewState(source,entry);
        if(reviewed.state!==hash(live))throw new ProfileError('This setting changed after the preview. Refresh and review it again.','STALE_REVIEW');
        if(matchesSetting(entry,live))return{success:true,unchanged:true};
      }
      if (!await confirm(entry)) return { cancelled: true };
      const index = await load();
      const key = provider + ':' + (entry.scope||id);
      const existing = index.records.find(record => record.key === key && record.phase !== 'restored');
      if(existing&&(!entry.reapply||existing.phase!=='active'))throw new ProfileError('Restore this setting before applying it again.', 'ALREADY_APPLIED');
      const previous=existing?await readRecord(existing):null;
      await profiles.snapshot();
      const before = await call(source, 'Capture', { id, target: entry.target, dataRoot: directory });
      if(reviewed&&entry.target?.type!=='onedrive'&&reviewed.state!==hash(before))throw new ProfileError('This setting changed while the safety snapshot was being prepared. Review it again.','STALE_REVIEW');
      const original=previous?previous.original:structuredClone(before);
      const createdPlan = entry.kind === 'ultimate' ? randomUUID() : null;
      if (createdPlan) { original.created = createdPlan; before.created=createdPlan; }
      const data = { schema: 1, id: randomUUID(), key, provider, action: id, label: entry.label,
        identity: context, original, before, target: entry.target, createdAt: new Date().toISOString() };
      await atomicJson(path.join(directory, 'records', data.id + '.json'), { data, sha256: hash(data) });
      const record = { id: data.id, key, label: entry.label, phase: 'applying', createdAt: data.createdAt };
      index.records.push(record);
      await atomicJson(indexFile, index);
      try {
        await call(source, 'Apply', { id, target: entry.target, identity: context, original, createdPlan, dataRoot: directory }, { timeout: entry.timeout ?? 180_000 });
        record.phase = 'active';
        record.error = null;
        if(existing)existing.phase='restored';
        await atomicJson(indexFile, index);
        await logger.info('Applied ' + key);
        return { success: true, restart: Boolean(entry.restart), signOut: Boolean(entry.signOut) };
      } catch (error) {
        if(existing)existing.phase='active';
        try {
          await call(source, 'Restore', { id, target: entry.target, identity: context, original:before, dataRoot: directory }, { timeout: entry.timeout ?? 180_000 });
          record.phase = 'restored';
          record.error = error.message;
        } catch (rollback) { record.phase = 'recovery-required'; record.error = rollback.message; }
        await atomicJson(indexFile, index);
        throw new ProfileError(record.phase === 'restored' ? error.message + ' Previous settings were restored.' : error.message + ' Recovery is required.', 'ACTION_FAILED');
      }
    });
  }
  async function restoreRecord(item, index) {
    const data = await readRecord(item);
    const source = providers.get(data.provider);
    if (!source) throw new ProfileError('The recovery provider is unavailable.', 'UNSUPPORTED');
    // Static settings are resolved from the installed catalogue, never from backup paths.
    if (data.provider === 'system') definition(data.provider, data.action);
    item.phase = 'restoring';
    await atomicJson(indexFile, index);
    try {
      await call(source, 'Restore', { id: data.action, target: data.target, original: data.original, identity: await identity(), dataRoot: directory }, { timeout: 180_000 });
      item.phase = 'restored'; item.error = null;
    } catch (error) { item.phase = 'recovery-required'; item.error = error.message; throw error; }
    finally { await atomicJson(indexFile, index); }
  }
  async function restore(id) {
    return exclusive(async () => {
      const index = await load();
      const item = index.records.find(item => item.id === id && item.phase !== 'restored');
      if (!item) throw new ProfileError('Recovery entry not found.', 'INVALID_ACTION');
      await restoreRecord(item, index);
      return { success: true };
    });
  }
  async function restoreAll() {
    return exclusive(async () => {
      const index = await load();
      const result = [];
      for (const item of index.records.filter(item => item.phase !== 'restored').reverse()) {
        try { await restoreRecord(item, index); result.push({ id: item.id, label: item.label, success: true }); }
        catch (error) { result.push({ id: item.id, label: item.label, success: false, error: error.message }); }
      }
      if (result.every(item => item.success)) {
        const state = await profiles.status();
        if (state.canRevert) await profiles.revert();
      }
      return result;
    });
  }
  async function inspect(provider = 'system') {
    const source = providers.get(provider);
    if (!source) throw new ProfileError('Unknown page.', 'INVALID_ACTION');
    const current = await call(source, 'Inspect');
    const index = await load();
    const items=(current.items||[]).map(item=>{const entry=source.definitions.find(def=>def.id===item.id);return entry?{...item,status:{...describeSetting(entry,item.state,item.supported),choiceMatches:Object.fromEntries((entry.choices||[]).map(choice=>{const variant=source.definitions.find(def=>def.id===choice.id);return[choice.id,variant?describeSetting(variant,item.state,item.supported).matches:false];}))}}:item;});
    return { ...current, items, busy, definitions: source.definitions.map(def => ({ ...def, entries: undefined })), records: index.records };
  }
  return { apply, preview, restore, restoreAll, inspect, isBusy: () => busy,
    register: (name, script, definitions) => providers.set(name, { script, definitions }),
    registerRunner:(name,run,definitions)=>providers.set(name,{run,definitions}),
    record:async id=>{const item=(await load()).records.find(item=>item.id===id);if(!item)throw new ProfileError('Recovery entry not found.','INVALID_ACTION');return readRecord(item);},
    activeDetails:async prefixes=>{const context=await identity();const result=[];for(const item of(await load()).records.filter(item=>item.phase!=='restored'&&prefixes.some(prefix=>item.key.startsWith(prefix))))result.push({record:item,data:await readRecord(item,context)});return result;},
    history: async () => (await load()).records };
}

module.exports = { createOperations };
