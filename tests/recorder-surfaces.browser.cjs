'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {build}=require('esbuild');
let finished=false;
app.on('window-all-closed',()=>{});
app.on('will-quit',()=>{if(!finished){console.error('Editor regression exited without a result');process.exitCode=1}});
const deadline=setTimeout(()=>{console.error('Editor regression deadline exceeded');app.exit(1)},30000);
(async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'reva-controls-browser-'));app.setPath('userData',temporary);
 let window,server;
 try{
  const bundle=await build({entryPoints:[path.join(__dirname,'recorder-surfaces.browser-entry.js')],bundle:true,format:'iife',globalName:'ControlQA',platform:'browser',write:false,target:'es2022',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/"'}});
  await app.whenReady();window=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end("<title>Owned editor controls</title><button id='anchor'>Presets</button><div id='root'></div>")});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await window.loadURL('http://127.0.0.1:'+server.address().port+'/');
  const styles=await Promise.all(['styles.css','capture-picker.css','recording-panel.css','recorder-popover.css'].map(file=>fs.readFile(path.join(__dirname,'../src',file),'utf8')));
  await window.webContents.insertCSS(styles.join('\n'));
  const result=await window.webContents.executeJavaScript(bundle.outputFiles[0].text+'\nControlQA.verifyRecorderSurfaces()');
  finished=true;clearTimeout(deadline);console.log(JSON.stringify({type:'reva-recorder-surfaces-regression',...result},null,2));
 }finally{window?.destroy();if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(temporary,{recursive:true,force:true});app.quit()}
})().catch(error=>{console.error(error);app.exit(1)});
