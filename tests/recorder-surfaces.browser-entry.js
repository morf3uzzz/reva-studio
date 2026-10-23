import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import CapturePicker from '../src/CapturePicker.tsx';
import RecordingPanel from '../src/RecordingPanel.tsx';
import {setLanguage} from '../src/i18n.ts';
export async function verifyRecorderSurfaces(){
 const check=(v,m)=>{if(!v)throw new Error(m)},wait=()=>new Promise(r=>setTimeout(r,40)),host=document.querySelector('#root'),off=()=>()=>{};
 let stateChanged,viewportChanged;const calls=[];
 const frame={x:0,y:33,width:1512,height:982};
 const display={id:'display:1',kind:'display',name:'Owned display',width:1512,height:982,bounds:{x:0,y:0,width:1512,height:982}};
 const chosen={id:'window:42',kind:'window',name:'Owned window',width:1504,height:863,bounds:{x:4,y:33,width:1504,height:863},zIndex:0};
 globalThis.reva={getLanguage:async()=>'en',setLanguage:async()=>{},getCapturePicker:async()=>({mode:'window',sources:[display,chosen],display:display.bounds,viewport:display.bounds,autoZoom:false,afterRecording:'project',fps:60,savedAreas:[]}),onCapturePickerViewport:callback=>{viewportChanged=callback;callback(frame);return()=>{}},completeCapturePicker:async result=>calls.push(result)};
 await setLanguage('en');Object.assign(host.style,{width:'1000px',height:'650px'});
 let root=createRoot(host);flushSync(()=>root.render(React.createElement(CapturePicker)));await wait();
 const stage=document.querySelector('.capture-picker'),box=stage.getBoundingClientRect();
 stage.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:box.left+30,clientY:box.top+10}));await wait();
 let overlay=document.querySelector('.capture-picker-source-overlay');check(overlay,'Window under pointer was not highlighted');
 let rect=overlay.getBoundingClientRect();check(Math.abs(rect.top-box.top)<.1,'Window highlight adds a menu-bar offset');
 check(Math.abs(rect.height-863/982*box.height)<.1,'Window highlight uses display height instead of native viewport');
 viewportChanged({...frame,x:-1512});await wait();
 stage.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:box.left+30,clientY:box.top+10}));await wait();
 check(!document.querySelector('.capture-picker-source-overlay'),'Hit testing ignored the moved native viewport');
 viewportChanged(frame);await wait();stage.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:box.left+30,clientY:box.top+10}));await wait();
 stage.click();await wait();const start=Array.from(stage.querySelectorAll('button')).find(b=>b.textContent.trim()==='Start recording');check(start&&!start.disabled,'Selected window has no recording action');start.click();await wait();check(calls[0]?.sourceID==='window:42','Selection committed another window');root.unmount();
 const preferences={fps:60,countdown:0,systemAudio:false,microphone:false,camera:false,autoZoom:false,afterRecording:'project',cameraPreview:false,cameraPreviewWhileRecording:false};
 const recording={status:'recording',startedAt:Date.now(),elapsedMs:9e3,stateUpdatedAt:Date.now(),paused:true};
 globalThis.reva={getLanguage:async()=>'en',setLanguage:async()=>{},getRecordingPanel:async()=>({...recording,preferences,screenIssue:null}),getCaptureDevices:async()=>({cameras:[],microphones:[]}),getPermissions:async()=>({screen:'granted'}),getInputMonitorState:async()=>({state:{phase:'idle',camera:false,microphones:'none',microphoneDeviceIDs:[],errors:[],updatedAt:Date.now()},levels:[]}),onScreenCaptureIssue:off,onInputLevel:off,onInputMonitorState:off,onRecordingPreferences:off,onInputError:off,onError:off,onRecorderAction:off,onRecordingPanelState:callback=>{stateChanged=callback;return()=>{}},pauseRecording:async()=>calls.push('pause'),resumeRecording:async()=>calls.push('resume'),restartRecording:async()=>calls.push('restart'),discardRecording:async()=>calls.push('discard'),stopRecording:async()=>calls.push('stop')};
 for(const language of ['en','ru']){
  globalThis.reva.getLanguage=async()=>language;await setLanguage(language);Object.assign(host.style,{width:'160px',height:'36px'});document.documentElement.dataset.surface='recorder';
  root=createRoot(host);flushSync(()=>root.render(React.createElement(RecordingPanel)));await wait();
  const panel=document.querySelector('.recorder-active'),panelRect=panel.getBoundingClientRect();check(panelRect.width===160&&panelRect.height===36,'Active panel exceeds compact native bounds');
  for(const elapsedMs of [9000,3_600_000,86_399_000]){
   stateChanged({...recording,elapsedMs});await wait();
   for(const button of panel.querySelectorAll('button')){
    const bounds=button.getBoundingClientRect();check(bounds.left>=panelRect.left&&bounds.right<=panelRect.right+.1&&bounds.top>=panelRect.top&&bounds.bottom<=panelRect.bottom+.1,'Recorder button escapes the panel');
    for(const child of button.children){const childRect=child.getBoundingClientRect();check(childRect.left>=bounds.left-.1&&childRect.right<=bounds.right+.1,'Recorder timer/icon escapes its button at '+elapsedMs)}
   }
  }
  panel.querySelectorAll('button')[1].click();await wait();check(calls.includes('resume'),'Resume did not reach recorder owner');
  stateChanged({...recording,paused:false,stateUpdatedAt:Date.now()});await wait();panel.querySelectorAll('button')[1].click();await wait();check(calls.includes('pause'),'Pause did not reach recorder owner');
  root.unmount();delete document.documentElement.dataset.surface;
 }
 return{passed:['native viewport event before initial response','window highlight / source identity / menu-bar offset','pointer hit testing after native movement','160x36 panel in EN/RU','timer and icons through 24 hours','pause / resume owner actions']};
}
