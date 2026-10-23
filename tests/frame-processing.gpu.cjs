"use strict";
// Opt-in production-shader verification in an isolated hidden Electron process.
// Run: node_modules/.bin/electron tests/frame-processing.gpu.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reva-frame-gpu-"));
  app.setPath("userData", temporary);
  let window;
  try {
    const bundle = await build({ stdin: { contents: "export { FrameProcessor } from './src/core/frame-processing.ts'; export { drawLoupe } from './src/core/annotations.ts'; export { createProject } from './src/core/model.ts';", resolveDir: path.join(__dirname, "..") }, bundle: true, format: "iife", globalName: "FramePipeline", platform: "browser", write: false, target: "es2022" });
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL("data:text/html,<title>Local frame shader verification</title>");
    const result = await window.webContents.executeJavaScript(bundle.outputFiles[0].text + `
      (() => {
        const check=(condition,message)=>{if(!condition)throw new Error(message)};
        const processor=new FramePipeline.FrameProcessor();
        const canvas=new OffscreenCanvas(8,8), drawing=canvas.getContext('2d');
        const output=new OffscreenCanvas(8,8), reading=output.getContext('2d');
        const settings={look:'none',lut:null,lutIntensity:1,sharpen:0,grain:0};
        const pixels=(source,width=8,height=8)=>{output.width=width;output.height=height;reading.drawImage(source,0,0,width,height);return reading.getImageData(0,0,width,height).data};
        const at=(data,x,y,width=8)=>Array.from(data.slice((y*width+x)*4,(y*width+x)*4+4));
        drawing.fillStyle='rgb(64,64,64)';drawing.fillRect(0,0,8,8);drawing.fillStyle='rgb(128,128,128)';drawing.fillRect(4,4,1,1);
        check(processor.frame(canvas,8,8,settings,0)===canvas,'No-effect processing must bypass allocation');
        let image=pixels(processor.frame(canvas,8,8,{...settings,sharpen:.5},0));
        check(at(image,4,4)[0]>=188 && at(image,4,4)[0]<=196,'Sharpen must apply a real contrast-enhancing spatial kernel');
        check(at(image,3,4)[0]<60,'Sharpen must affect neighbouring edge pixels');
        drawing.fillStyle='rgb(64,128,192)';drawing.fillRect(0,0,8,8);
        const rows=[];for(let b=0;b<=1;b++)for(let g=0;g<=1;g++)for(let r=0;r<=1;r++)rows.push(b,g,r);
        const lut={title:'Swap R/B',size:2,domainMin:[0,0,0],domainMax:[1,1,1],data:rows};
        image=pixels(processor.frame(canvas,8,8,{...settings,lut},1));
        const swapped=at(image,4,4);check(Math.abs(swapped[0]-192)<=3&&Math.abs(swapped[1]-128)<=3&&Math.abs(swapped[2]-64)<=3,'3D LUT must preserve red-fast ordering and trilinear sampling');
        image=pixels(processor.frame(canvas,8,8,{...settings,look:'mono'},2));
        const mono=at(image,4,4);check(Math.abs(mono[0]-mono[1])<=1&&Math.abs(mono[1]-mono[2])<=1,'Mono look must modify actual pixels');
        const looks=['none','warm','cool','mono','cinematic','studio','film','cream','terra','moody','neon','punch','fade'], signatures=[];
        for(const look of looks) signatures.push(at(pixels(processor.frame(canvas,8,8,{...settings,look},2)),4,4).slice(0,3).join('/'));
        check(new Set(signatures).size===looks.length,'All13 look choices must produce distinct real color transforms');
        image=pixels(processor.frame(canvas,8,8,{...settings,look:'punch',lutIntensity:0},2));check(at(image,4,4).slice(0,3).every((value,index)=>Math.abs(value-[64,128,192][index])<=1),'Grading intensity zero must restore original colors');
        image=pixels(processor.frame(canvas,8,8,{...settings,look:'punch',gradingEnabled:false},2));check(at(image,4,4).slice(0,3).every((value,index)=>Math.abs(value-[64,128,192][index])<=1),'Disabling grading must preserve its settings and restore original colors');
        drawing.fillStyle='red';drawing.fillRect(0,0,8,4);drawing.fillStyle='blue';drawing.fillRect(0,4,8,4);
        image=pixels(processor.frame(canvas,8,8,{...settings,sharpen:.01},3));
        check(at(image,2,1)[0]>250&&at(image,2,6)[2]>250,'Processing must retain top-left source orientation');
        const banded=new OffscreenCanvas(64,64), bands=banded.getContext('2d');
        for(let x=0;x<64;x++){const value=x<32?64+Math.floor(x/8)*2:220;bands.fillStyle='rgb('+value+','+value+','+value+')';bands.fillRect(x,0,1,64)}
        image=pixels(processor.frame(banded,64,64,{deband:1},4),64,64);
        const column=x=>{let total=0;for(let y=0;y<64;y++)total+=image[(y*64+x)*4];return total/64};
        check(column(8)-column(7)<1.8,'Debanding must smooth a measured low-contrast quantization boundary');
        check(column(32)-column(31)>145,'Debanding must preserve high-contrast content edges');
        const deterministic=Array.from(image);image=pixels(processor.frame(banded,64,64,{deband:1},4),64,64);check(deterministic.every((value,index)=>value===image[index]),'Preview/export dither must be source-time deterministic');
        const mutable={...settings,sharpen:.01};drawing.fillStyle='red';drawing.fillRect(0,0,8,8);pixels(processor.frame(canvas,8,8,mutable,9));drawing.fillStyle='blue';drawing.fillRect(0,0,8,8);image=pixels(processor.frame(canvas,8,8,mutable,9));check(at(image,4,4)[2]>250,'Mutable canvas/matte pixels must invalidate processing even when settings and source time are unchanged');
        const lensSource=new OffscreenCanvas(200,200), lensPixels=lensSource.getContext('2d');lensPixels.fillStyle='red';lensPixels.fillRect(0,0,200,200);
        const lens=new OffscreenCanvas(200,200), lensContext=lens.getContext('2d'), project=FramePipeline.createProject({path:'/qa/screen.mp4',name:'Synthetic',width:200,height:200,duration:2});
        project.zooms=[{id:'lens',start:0,end:2,scale:2,x:.5,y:.5,mode:'manual',presentation:'loupe',loupeOptions:{radius01:.5,bevelRatio:0,chromaticAberration:0,hasGlassOptics:false}}];
        project.masks=[{id:'private',start:0,end:2,type:'sensitive-data',bounds:[{x:.4,y:.4,width:.2,height:.2}],blur:0,opacity:1}];
        const drawLens=()=>{lensContext.clearRect(0,0,200,200);FramePipeline.drawLoupe(lensContext,project,.5,lensSource,{x:0,y:0,width:1,height:1},{x:0,y:0,width:200,height:200},1);return lensContext.getImageData(100,100,1,1).data};
        check(drawLens()[0]<40,'A magnified lens must preserve manual redaction pixels');
        project.masks=[];project.privacy={sensitive:true,faces:false,analysis:{regions:[{start:0,end:2,kind:'email',x:.4,y:.4,width:.2,height:.2,confidence:1}]}};
        check(drawLens()[0]<40,'A magnified lens must preserve automatic privacy redaction pixels');
        const warm=new OffscreenCanvas(640,360), paint=warm.getContext('2d');paint.fillStyle='#444';paint.fillRect(0,0,640,360);
        const start=performance.now();
        for(let frame=0;frame<30;frame++)pixels(processor.frame(warm,640,360,{deband:1},frame/60),640,360);
        const milliseconds=performance.now()-start;
        processor.dispose();
        return {passed:['real GPU sharpen','3D LUT RGB ordering','all13 real look transforms','grading intensity/disable','source orientation','edge-preserving debanding','deterministic dither','mutable matte freshness','loupe manual and automatic privacy pixels'],warmCompletedFrames:30,warmCompletedMilliseconds:milliseconds,unverified:['proprietary enhancement model equivalence']};
      })()
    `);
    process.stdout.write(JSON.stringify(result) + "\n");
    window.destroy(); window = null;
    await fs.rm(temporary, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) window.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
    process.stderr.write(String(error.stack || error) + "\n");
    app.exit(1);
  }
})();
