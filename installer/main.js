'use strict';
const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createController}=require('./controller');
function createInstallerWindow({controller:provided,preview=false,show=true}={}){
  const entry=path.join(__dirname,'renderer/index.html'),url=pathToFileURL(entry).href;
  const window=new BrowserWindow({width:980,height:640,frame:false,resizable:false,transparent:true,hasShadow:true,roundedCorners:true,show:false,icon:path.join(__dirname,'../assets/generated/icon.ico'),webPreferences:{preload:path.join(__dirname,'preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:preview}});
  const controller=provided||createController({resources:process.resourcesPath,version:app.getVersion(),chooseFolder:async defaultPath=>{const result=await dialog.showOpenDialog(window,{title:'Choose an installation folder',defaultPath,properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];},onChange:state=>{if(!window.isDestroyed())window.webContents.send('setup:state',state);}});
  ipcMain.handle('setup:call',async(event,method,value)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==url)throw Error('Untrusted installer request.');switch(method){case'state':return controller.state();case'directory':return controller.directory();case'install':return controller.install(value);case'open':await controller.open();window.close();return{success:true};case'minimize':window.minimize();return;case'close':if(!controller.busy())window.close();return;default:throw Error('Unknown installer request.');}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));window.webContents.session.on('will-download',event=>event.preventDefault());
  window.on('close',event=>{if(controller.busy())event.preventDefault();});window.on('closed',()=>ipcMain.removeHandler('setup:call'));
  window.once('ready-to-show',()=>{if(show)window.show();});void window.loadFile(entry).then(()=>controller.initialize()).catch(error=>{dialog.showErrorBox('XeroLag Setup',error.message);window.destroy();});return{window,controller};
}
if(require.main===module){app.setName('XeroLag Setup');if(!app.requestSingleInstanceLock())app.quit();else{let setup;app.on('second-instance',()=>{if(setup?.window&&!setup.window.isDestroyed()){setup.window.restore();setup.window.focus();}});app.whenReady().then(()=>{setup=createInstallerWindow();});app.on('window-all-closed',()=>app.quit());}}
module.exports={createInstallerWindow};
