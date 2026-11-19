'use strict';

const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const dnsProviders={cloudflare:{IPv4:['1.1.1.1','1.0.0.1'],IPv6:['2606:4700:4700::1111','2606:4700:4700::1001']},google:{IPv4:['8.8.8.8','8.8.4.4'],IPv6:['2001:4860:4860::8888','2001:4860:4860::8844']},quad9:{IPv4:['9.9.9.9','149.112.112.112'],IPv6:['2620:fe::fe','2620:fe::9']}};
const valueText=value=>value===null||value===undefined?'Windows default':Array.isArray(value)?value.join(', '):String(value);
const savedText=value=>value?.exists?valueText(value.value):'Windows default (not set)';
function desiredValue(entry,saved){
  if(!entry.clearBits)return entry.value;
  const number=saved?.exists&&/^\d+$/.test(String(saved.value))?Number(saved.value):510;
  return String(number&~entry.clearBits);
}
function matchesSetting(definition,state){
  if(!state)return false;
  if(definition.target?.type==='mtu')return state.active===definition.target.value&&state.persistent===definition.target.value;
  if(definition.type==='registry')return definition.entries.every((entry,index)=>{const value=state.values?.[index];return value?.exists&&value.kind===entry.kind&&equal(value.value,desiredValue(entry,value));});
  if(definition.type==='service')return definition.enable?state.running&&state.mode===(definition.name==='SysMain'?'Auto':'Manual'):state.mode==='Disabled'&&!state.running;
  if(['clock','tick'].includes(definition.kind))return state.value===(Object.hasOwn(definition,'bootValue')?definition.bootValue:definition.kind==='tick'?'Yes':null);
  if(['usb','unpark'].includes(definition.kind))return Boolean(state.items?.length)&&state.items.every(item=>item.ac===item.target&&item.dc===item.target);
  if(definition.target?.type==='nagle')return state.values?.every((value,index)=>value.exists&&value.kind==='DWord'&&value.value===(definition.target.disabled?1:index===0?2:0))===true;
  if(definition.target?.type==='msi')return state.values?.[0]?.value===Number(definition.target.msi)&&(definition.target.highPriority?state.values?.[1]?.value===3:!state.values?.[1]?.exists);
  if(definition.target?.type==='dns')return Boolean(state.families?.length)&&state.families.every(family=>family.enabled===false||(definition.target.provider==='default'?!family.manual:family.manual&&equal(family.addresses.map(value=>value.toLowerCase()),dnsProviders[definition.target.provider]?.[family.family])));
  return false;
}
function describeSetting(definition,state,supported=true){
  if(!supported||!state)return{label:'Unavailable',matches:false};
  const matches=matchesSetting(definition,state);
  if(definition.target?.type==='mtu')return{label:state.active+' bytes (active)',matches};
  if(definition.type==='service')return{label:state.mode==='Disabled'?(state.running?'Running · startup off':'Off'):state.running?'On':'Stopped',matches};
  if(definition.choices){
    const value=definition.type==='special'?state.value:state.values?.[0]?.exists?state.values[0].value:undefined;
    const choice=definition.choices.find(choice=>choice.value===value);
    return{label:choice?.label||(value===undefined||value===null?'Windows default':'Custom'),matches,choiceId:choice?.id||''};
  }
  if(definition.kind==='ultimate')return{label:'Current plan',matches:false};
  if(definition.type==='registry')return{label:matches?'Configured':state.values?.every(value=>!value.exists)?'Windows default':'Custom',matches};
  return{label:matches?'Configured':'Custom',matches};
}
function buildReview(definition,state){
  const changes=[];
  if(definition.type==='registry')definition.entries.forEach((entry,index)=>changes.push({label:entry.name,current:savedText(state.values?.[index]),requested:valueText(desiredValue(entry,state.values?.[index]))}));
  else if(definition.type==='service')changes.push({label:'Startup and running state',current:state.mode+' · '+(state.running?'Running':'Stopped'),requested:definition.enable?(definition.name==='SysMain'?'Automatic':'Manual')+' · Running':'Disabled · Stopped'});
  else if(['clock','tick'].includes(definition.kind))changes.push({label:definition.kind==='clock'?'useplatformclock':'disabledynamictick',current:valueText(state.value),requested:valueText(Object.hasOwn(definition,'bootValue')?definition.bootValue:definition.kind==='tick'?'Yes':null)});
  else if(['usb','unpark'].includes(definition.kind))for(const [index,item]of(state.items||[]).entries())changes.push({label:(definition.kind==='usb'?'USB suspend':index===0?'Minimum unparked cores':'Maximum unparked cores'),current:'AC '+item.ac+' / battery '+item.dc,requested:'AC '+item.target+' / battery '+item.target});
  else if(definition.kind==='ultimate')changes.push({label:'Power plan',current:state.plan,requested:'Create and activate XeroLag Ultimate Performance'});
  else{
    const target=definition.target||{};
    if(target.type==='mtu')changes.push({label:'IPv4 MTU · active',current:String(state.active),requested:String(target.value)},{label:'IPv4 MTU · persistent',current:String(state.persistent),requested:String(target.value)});
    else if(target.type==='dns')for(const family of state.families||[])changes.push({label:family.family+' DNS',current:(family.manual?'Manual: ':'Automatic: ')+(family.addresses.join(', ')||'None'),requested:family.enabled===false?'Unchanged · protocol disabled':target.provider==='default'?'Automatic (DHCP)':dnsProviders[target.provider]?.[family.family]?.join(', ')||'Unavailable'});
    else if(target.type==='msi')changes.push({label:'Interrupt mode',current:state.values?.[0]?.value===1?'MSI':'Legacy',requested:target.msi?'MSI':'Legacy'},{label:'Interrupt priority',current:state.values?.[1]?.exists?valueText(state.values[1].value):'Driver default',requested:target.highPriority?'High (3)':'Driver default'});
    else if(target.type==='nagle')for(const [index,name]of['TcpAckFrequency','TCPNoDelay'].entries())changes.push({label:name,current:savedText(state.values?.[index]),requested:String(target.disabled?1:index===0?2:0)});
    else if(target.type==='markc')target.values.forEach((entry,index)=>changes.push({label:entry.name,current:savedText(state.values?.[index]),requested:valueText(entry.value)}));
    else if(target.type==='startup-run'||target.type==='startup-task'||definition.type==='startup-file')changes.push({label:'Startup',current:target.type==='startup-task'?(state.enabled?'On':'Off'):'On',requested:target.enable?'On':'Off'});
    else changes.push({label:definition.label,current:target.type==='recall'?state.state:'Installed',requested:target.type==='recall'?'Disabled':'Uninstalled for this account'});
  }
  const type=definition.target?.type;
  const recovery=['appx','onedrive'].includes(type)?'Recovery can re-register retained app files or run the saved OneDrive installer. Reinstallation and sign-in may be required.':'Restore saved original settings from Repair > Recovery.';
  return{label:definition.label,risk:definition.risk||'Moderate',description:definition.description||'',restart:Boolean(definition.restart),signOut:Boolean(definition.signOut),changes,recovery,matches:matchesSetting(definition,state)};
}
module.exports={matchesSetting,describeSetting,buildReview};
