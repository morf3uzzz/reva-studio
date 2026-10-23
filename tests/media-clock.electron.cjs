"use strict";
// Opt-in Chromium media clock probe. Run with node; it owns an isolated Electron
// child and removes that child's temporary profile only after the child exits.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { build } = require("esbuild");
const { spawn } = require("node:child_process");

if (!app) {
  (async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reva-media-clock-owned-")), identity = await fs.lstat(temporary);
    const child = spawn(require("electron"), [__filename, ...process.argv.slice(2), `--owned-profile=${temporary}`], { stdio: "inherit" });
    const forward = signal => child.kill(signal);
    process.once("SIGINT", forward); process.once("SIGTERM", forward);
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({code, signal})); });
    process.removeListener("SIGINT", forward); process.removeListener("SIGTERM", forward);
    const current = await fs.lstat(temporary);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`Owned probe profile was replaced; retained at ${temporary}`);
    await fs.rm(temporary, { recursive: true });
    process.exitCode = result.code ?? 1;
  })().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
} else (async () => {
  if (process.env.REVA_CLOCK_DEBUG) process.stderr.write(JSON.stringify({ phase: "start", argv: process.argv }) + "\n");
  const suppliedProfile = process.argv.find(value => value.startsWith("--owned-profile="));
  const temporary = suppliedProfile ? suppliedProfile.slice("--owned-profile=".length) : await fs.mkdtemp(path.join(os.tmpdir(), "reva-media-clock-retained-"));
  app.setPath("userData", temporary); let window;
  // A hidden probe owns its conclusion. Preserve any unexpected graceful quit
  // until the bounded decoder operation returns, then exit only this process.
  app.on("before-quit", event => { event.preventDefault(); if (process.env.REVA_CLOCK_DEBUG) process.stderr.write("Deferring unexpected probe quit\n"); });
  try {
    const file = path.resolve(process.argv[2]); await fs.access(file);
    const bundle = await build({ stdin: { contents: "export * from './src/core/playback.ts'; export { cameraSourceTime } from './src/core/camera-effects.ts'; export { seekVideo } from './src/hooks.ts';", resolveDir: path.join(__dirname, "..") }, bundle: true, format: "iife", globalName: "MediaClock", platform: "browser", write: false, target: "es2022" });
    const html = path.join(temporary, "probe.html"); await fs.writeFile(html, "<!doctype html><title>Isolated media clock verification</title>");
    await app.whenReady(); window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); await window.loadFile(html);
    if (process.env.REVA_CLOCK_DEBUG) { process.stderr.write("Probe window ready\n"); window.webContents.on("render-process-gone", (_event, details) => process.stderr.write(JSON.stringify({ phase: "renderer-gone", details }) + "\n")); app.on("before-quit", () => process.stderr.write("Probe before quit\n")); }
    const firstArgument = process.argv.find(value => value.startsWith("--first-seek="));
    const knownArgument = process.argv.find(value => value.startsWith("--known-end="));
    const result = await window.webContents.executeJavaScript(bundle.outputFiles[0].text + `(async()=>{
      const video=document.createElement('video');video.muted=true;video.preload='auto';
      const metadata=new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Media load failed: '+video.error?.message));setTimeout(()=>reject(new Error('Metadata timed out')),10000)});
      video.src=${JSON.stringify(pathToFileURL(file).href)};document.body.appendChild(video);await metadata;
      if(${firstArgument ? "true" : "false"}){
        const requested=${firstArgument ? Number(firstArgument.split("=")[1]) : 0},knownEnd=${knownArgument ? Number(knownArgument.split("=")[1]) : "undefined"};
        if(${JSON.stringify(process.argv.includes("--after-loadeddata"))}&&video.readyState<2)await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Initial data decode failed'))});
        const before={duration:video.duration,readyState:video.readyState,timelineEnd:MediaClock.mediaTimelineEnd(video),seekable:Array.from({length:video.seekable.length},(_,i)=>[video.seekable.start(i),video.seekable.end(i)])};
        const target=MediaClock.mediaSeekTarget(video,MediaClock.cameraSourceTime({appearance:{cameraDelayMs:0}},requested,knownEnd),knownEnd);
        const productionSeek=${JSON.stringify(process.argv.includes("--production-seek"))},productionStages=[];
        if(productionSeek){video.addEventListener('seeked',()=>productionStages.push({currentTime:video.currentTime,duration:video.duration,seekable:Array.from({length:video.seekable.length},(_,i)=>[video.seekable.start(i),video.seekable.end(i)])}));await MediaClock.seekVideo(video,MediaClock.cameraSourceTime({appearance:{cameraDelayMs:0}},requested,knownEnd),knownEnd);}
        else{const done=new Promise((resolve,reject)=>{video.onseeked=resolve;setTimeout(()=>reject(new Error('Fresh first seek timed out')),5000)});video.currentTime=target;await done;}
        const read=source=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const drawing=canvas.getContext('2d');drawing.drawImage(source,0,0,2,2);return Array.from(drawing.getImageData(0,0,2,2).data)};
        const facts=()=>({duration:video.duration,currentTime:video.currentTime,seekable:Array.from({length:video.seekable.length},(_,i)=>[video.seekable.start(i),video.seekable.end(i)])});
        const afterFirst=facts(),firstPixels=read(video);let retried=productionStages.length>1;
        const decodedFrame=await new Promise(resolve=>{video.requestVideoFrameCallback(()=>resolve('decoded-frame'));setTimeout(()=>resolve('no-new-frame-within100ms'),100)}),afterDecodedFrame=facts();
        const previousEnd=Math.max(0,...before.seekable.map(range=>range[1]));
        if(!productionSeek&&Math.abs(video.currentTime-requested)>.0001&&afterDecodedFrame.seekable.some(range=>range[0]<=requested&&range[1]>=requested&&range[1]>previousEnd)){
          const retryDone=new Promise((resolve,reject)=>{video.onseeked=resolve;setTimeout(()=>reject(new Error('Covered first-seek retry timed out')),5000)});video.currentTime=MediaClock.mediaSeekTarget(video,requested,knownEnd);await retryDone;retried=true;
        }
        const pixels=read(video),actual=video.currentTime;
        const reference=document.createElement('video');reference.muted=true;reference.preload='auto';const loaded=new Promise((resolve,reject)=>{reference.onloadeddata=resolve;reference.onerror=()=>reject(new Error('Reference decode failed'));setTimeout(()=>reject(new Error('Reference load timed out')),10000)});reference.src=${JSON.stringify(pathToFileURL(file).href)};document.body.appendChild(reference);await loaded;
        const referenceDone=new Promise((resolve,reject)=>{reference.onseeked=resolve;setTimeout(()=>reject(new Error('Reference first seek timed out')),5000)});reference.currentTime=requested;await referenceDone;
        if(Math.abs(reference.currentTime-requested)>.0001&&Array.from({length:reference.seekable.length},(_,i)=>reference.seekable.end(i)).some(end=>end>=requested)){const retry=new Promise(resolve=>reference.onseeked=resolve);reference.currentTime=requested;await retry;}
        const referencePixels=read(reference),referenceTime=reference.currentTime;
        const passed=Math.abs(actual-requested)<.0001&&pixels.every((value,index)=>value===referencePixels[index]);
        return {mode:'fresh-first-seek',seekOwner:productionSeek?'production hooks.seekVideo':'diagnostic covered-range retry',requested,knownEnd,before,target,productionStages,afterFirst,firstPixels,decodedFrame,afterDecodedFrame,retried,actual,pixels,referenceTime,referencePixels,passed};
      }
      const duration=video.duration, samples=[],initialTimelineEnd=MediaClock.mediaTimelineEnd(video);
      if(typeof MediaClock.mediaSeekTarget!=='function')throw new Error('Production mediaSeekTarget owner is required by this integration probe');
      for(const requested of [0,.2,.25,1.7,1.9,2,2.1]){
        const seeked=new Promise((resolve,reject)=>{video.onseeked=resolve;setTimeout(()=>reject(new Error('Seek timed out: '+requested)),5000)});
        const sourceTime=MediaClock.cameraSourceTime({appearance:{cameraDelayMs:0}},requested,MediaClock.mediaTimelineEnd(video)),target=MediaClock.mediaSeekTarget(video,sourceTime);
        video.currentTime=target;await seeked;
        const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const drawing=canvas.getContext('2d');drawing.drawImage(video,0,0,2,2);
        samples.push({requested,target,actual:video.currentTime,pixels:Array.from(drawing.getImageData(0,0,2,2).data),readyState:video.readyState});
      }
      if(${JSON.stringify(process.argv.includes("--assert-moving-tail"))}){
        const before=samples.find(sample=>sample.requested===1.7),after=samples.find(sample=>sample.requested===1.9);
        if(after.actual<=before.actual+.1||after.pixels.every((value,index)=>value===before.pixels[index]))throw new Error('The production camera clock must reach changed real tail pixels at1.9s');
      }
      const playbackEvents=[],decodedFrames=[];
      for(const event of ['timeupdate','ended','waiting'])video.addEventListener(event,()=>playbackEvents.push({event,time:video.currentTime,ended:video.ended}));
      const playingFrom=Math.min(1.7,Math.max(0,duration-.01));
      const tailSeek=new Promise(resolve=>video.onseeked=resolve);video.currentTime=playingFrom;await tailSeek;
      let capture=true;const next=(_now,metadata)=>{if(!capture)return;decodedFrames.push(metadata.mediaTime);video.requestVideoFrameCallback(next)};video.requestVideoFrameCallback(next);
      await video.play();await new Promise(resolve=>setTimeout(resolve,650));video.pause();capture=false;
      return {duration,initialTimelineEnd,timelineEnd:MediaClock.mediaTimelineEnd(video),width:video.videoWidth,height:video.videoHeight,seekable:Array.from({length:video.seekable.length},(_,i)=>[video.seekable.start(i),video.seekable.end(i)]),samples,playback:{playingFrom,currentTime:video.currentTime,ended:video.ended,decodedFrames,events:playbackEvents}};
    })()`);
    await new Promise(resolve => process.stdout.write(JSON.stringify({ file, ...result }) + "\n", resolve)); window.destroy(); window = null;
    app.exit(result.passed === false ? 1 : 0);
  } catch (error) { if (window && !window.isDestroyed()) window.destroy(); await new Promise(resolve => process.stderr.write(String(error.stack || error) + "\n", resolve)); app.exit(1); }
})();
