'use strict';

const {ProfileError}=require('./profile-state');

function parseMarkC(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>16*1024)throw new ProfileError('Select a small MarkC registry preset.','INVALID_PRESET');
  const text=(buffer[0]===0xff&&buffer[1]===0xfe?buffer.toString('utf16le'):buffer.toString('utf8')).replace(/^\uFEFF/,'').replace(/\\\r?\n\s*/g,'');
  const allowed=new Set(['SmoothMouseXCurve','SmoothMouseYCurve','MouseSensitivity','MouseSpeed','MouseThreshold1','MouseThreshold2']);
  const values=[];let section=false;
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith(';')||line==='Windows Registry Editor Version 5.00'||line==='REGEDIT4')continue;
    if(line.startsWith('[')){if(line!=='[HKEY_CURRENT_USER\\Control Panel\\Mouse]')throw new ProfileError('The preset contains settings outside the mouse curves.','INVALID_PRESET');section=true;continue;}
    const match=/^"([^"]+)"=(.*)$/.exec(line);if(!section||!match||!allowed.has(match[1])||values.some(item=>item.name===match[1]))throw new ProfileError('Unsupported mouse preset content.','INVALID_PRESET');
    if(/^hex:/i.test(match[2])){
      const bytes=match[2].slice(4).split(',');if(!['SmoothMouseXCurve','SmoothMouseYCurve'].includes(match[1])||bytes.length!==40||bytes.some(value=>!/^[a-f0-9]{2}$/i.test(value.trim())))throw new ProfileError('A MarkC curve must contain 40 bytes.','INVALID_PRESET');
      values.push({name:match[1],kind:'Binary',value:Buffer.from(bytes.map(value=>parseInt(value.trim(),16))).toString('base64')});
    }else{
      const value=/^"(\d{1,2})"$/.exec(match[2]);if(!value||['SmoothMouseXCurve','SmoothMouseYCurve'].includes(match[1]))throw new ProfileError('Unsupported mouse preference.','INVALID_PRESET');
      const number=Number(value[1]);if(match[1]==='MouseSensitivity'&&(number<1||number>20)||match[1]==='MouseSpeed'&&number>2||match[1].startsWith('MouseThreshold')&&number>20)throw new ProfileError('Mouse preference is outside its supported range.','INVALID_PRESET');
      values.push({name:match[1],kind:'String',value:value[1]});
    }
  }
  if(!values.some(item=>item.name==='SmoothMouseXCurve')||!values.some(item=>item.name==='SmoothMouseYCurve'))throw new ProfileError('Both MarkC mouse curves are required.','INVALID_PRESET');
  return values;
}

module.exports={parseMarkC};
