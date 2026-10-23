'use strict';
// Opt-in native Web Audio / React regression. Optional argument: an owned WAV.
const { app, BrowserWindow } = require('electron');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {build}=require('esbuild');
const http=require('node:http');
let finished=false; app.on('window-all-closed',()=>{}); app.on('will-quit',()=>{if(!finished){console.error('Audio regression exited before producing a result');process.exitCode=1}});
const deadline=setTimeout(()=>{console.error('Audio regression deadline exceeded');app.exit(1)},30000);
console.error('Audio regression: start');
function tone(){
  const samples=14*48000,bytes=Buffer.alloc(44+samples*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/48000)*6000),44+i*2);
  return bytes;
}
(async()=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'reva-audio-browser-'));app.setPath('userData',temporary);
  app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');let window,server;
  try{
    const wav=process.argv[2]?await fs.readFile(process.argv[2]):tone();
    if(wav.length>16*1024*1024)throw new Error('Use a short WAV fixture under 16 MiB.');
    const bundle=await build({entryPoints:[path.join(__dirname,'mixed-audio.browser-entry.js')],bundle:true,format:'iife',globalName:'ScrubQA',platform:'browser',write:false,target:'es2022'});
    await app.whenReady();window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end("<title>Owned audio regression</title><div id='root'></div>")});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    await window.loadURL('http://127.0.0.1:'+server.address().port+'/');
    const url='data:audio/wav;base64,'+wav.toString('base64');
    console.error('Audio regression: renderer ready');
    const result=await window.webContents.executeJavaScript(bundle.outputFiles[0].text+'\nScrubQA.verifyAudio('+JSON.stringify(url)+')');
    finished=true; clearTimeout(deadline);
    console.log(JSON.stringify({type:'reva-scrub-normal-pitch-regression',fixture:process.argv[2]?'operator-owned WAV':'generated 220Hz tone',sha256:crypto.createHash('sha256').update(wav).digest('hex'),...result},null,2));
  }finally{window?.destroy();if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(temporary,{recursive:true,force:true});app.quit()}
})().catch(error=>{console.error(error);app.exit(1)});
