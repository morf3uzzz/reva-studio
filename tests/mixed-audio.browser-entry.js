import { useMixedAudio } from '../src/useMixedAudio.ts';
import { useProject } from '../src/hooks.ts';
import { createProject } from '../src/core/model.ts';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
export async function verifyAudio(audioURL) {
  const check=(value,message)=>{if(!value)throw new Error(message)}, delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const originalContext=globalThis.AudioContext, grains=[], errors=[], contexts=[];
  globalThis.AudioContext=function(options){
    const ctx=new originalContext(options), original=ctx.createBufferSource.bind(ctx), silent=ctx.createGain();
    silent.gain.value=0; silent.connect(ctx.destination); contexts.push(ctx);
    ctx.createBufferSource=()=>{
      const node=original(), start=node.start.bind(node), connect=node.connect.bind(node);
      node.connect=destination=>connect(destination===ctx.destination?silent:destination);
      node.start=(when,offset,duration)=>{grains.push({rate:node.playbackRate.value,detune:node.detune.value,offset,duration,buffer:node.buffer});return start(when,offset,duration)};
      return node;
    };
    const originalGain=ctx.createGain.bind(ctx);
    ctx.createGain=()=>{const gain=originalGain(), connect=gain.connect.bind(gain);gain.connect=destination=>connect(destination===ctx.destination?silent:destination);return gain};
    return ctx;
  };
  globalThis.reva={renderAudioPreview:async()=>({key:'owned-pcm',path:'owned.wav',start:0,duration:14}),cancelAudioPreview:async()=>{},mediaURL:()=>audioURL};
  const p=createProject({path:'/owned/screen.mp4',name:'Scrub regression',width:1280,height:720,duration:14});
  let audio,history;
  function Harness(){audio=useMixedAudio({project:p,time:0,playing:false,rate:1,scrubEnabled:true,onError:error=>errors.push(error)});history=useProject(p);return null}
  const root=createRoot(document.querySelector('#root'));
  flushSync(()=>root.render(React.createElement(Harness))); await delay(30);
  const targets=[1,1.01,2,9,8.8,8.1,4];
  for(const time of targets){audio.audition(time);await delay(100)}
  audio.audition(4.01,p,true);await delay(100);audio.audition(null);
  check(!errors.length,errors.join('; '));check(grains.length>=targets.length,'Continuous pointer input must deliver grains');
  check(grains.every(grain=>grain.rate===1&&grain.detune===0),'Pointer direction, speed or scale changed speech pitch');
  check(grains.every(grain=>Math.abs(grain.duration-.14)<1e-8),'Scrub duration varies with pointer velocity');
  check(new Set(grains.map(grain=>grain.buffer)).size===1,'Reverse scrubbing substituted a reversed waveform');
  check(grains.some(grain=>Math.abs(grain.offset-8.1)<.001)&&grains.some(grain=>Math.abs(grain.offset-1.01)<.001),'Latest targets were not auditioned');
  flushSync(()=>history.update(value=>({...value,name:'first movement'}),'gesture:owned-drag'));
  await delay(800);flushSync(()=>history.update(value=>({...value,name:'last movement'}),'gesture:owned-drag'));
  flushSync(()=>history.undo());check(history.project.name===p.name,'A long pointer gesture required multiple undo steps');
  root.unmount();await delay(20);await Promise.all(contexts.map(ctx=>ctx.state==='closed'?Promise.resolve():ctx.close()));
  return {passed:['real React audition hook','native Web Audio grains at 1x / zero detune','normal forward waveform during reverse pointer motion','rapid and slow position changes','fixed 140ms grain duration','volume audition','single undo across a paused gesture'],grains:grains.map(({buffer,...item})=>item),limitations:['PCM transport is a supplied already-mixed fixture; native mixing is tested by audio-preview.test.cjs','Device listening and original proprietary scrubbing equivalence are not established']};
}
