import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import FeatureTrack from '../src/FeatureTrack.tsx';
import Timeline from '../src/Timeline.tsx';
import AnnotationsPanel from '../src/AnnotationsPanel.tsx';
import AnimationInspector from '../src/AnimationInspector.tsx';
import PresetsPopover from '../src/PresetsPopover.tsx';
import CameraInspector from '../src/CameraInspector.tsx';
import CameraScenesPanel from '../src/CameraScenesPanel.tsx';
import {createProject} from '../src/core/model.ts';
import {useProject} from '../src/hooks.ts';
import {SPRING_PRESETS} from '../src/core/spring.ts';
import {setLanguage} from '../src/i18n.ts';
export async function verifyEditor() {
  const check=(value,message)=>{if(!value)throw new Error(message)}, wait=()=>new Promise(resolve=>setTimeout(resolve,35));
  const fixture=createProject({path:'/owned/screen.mp4',name:'Controlled editor',width:1280,height:720,duration:12});
  fixture.cameraPath='/owned/camera.mp4';
  fixture.masks=[{id:'mask',start:2,end:4,type:'highlight',opacity:.5,blur:32,bounds:[{x:.1,y:.1,width:.3,height:.2}]}];
  fixture.cameraScenes=[{id:'scene',start:5,end:9,layout:{type:'screen-only'}}];
  const errors=[],added=[],calls=[];let history,setPreview,setPanel;
  globalThis.reva={getLanguage:async()=>'en',setLanguage:async()=>{},savePreset:async(p,name)=>{calls.push(['create',name]);return{id:'saved',name,appearance:p.appearance}},updatePreset:async(id,changes)=>calls.push(['update',id,changes]),setDefaultPreset:async id=>calls.push(['default',id]),revealPreset:async id=>calls.push(['reveal',id]),removePreset:async id=>calls.push(['remove',id])};
  await setLanguage('en');
  const root=createRoot(document.querySelector('#root'));
  function Harness(){
    history=useProject(fixture);
    const [preview,previewSetter]=React.useState(0),[panel,panelSetter]=React.useState('mask');
    setPreview=previewSetter;setPanel=panelSetter;
    const update=history.update,project=history.project;
    return React.createElement('div',null,
      React.createElement('div',{id:'track',style:{width:600}},React.createElement(FeatureTrack,{project,kind:'masks',selectedId:'mask',select:()=>{},seek:time=>calls.push(['seek',time]),update,onAdd:(start,end)=>added.push({start,end})})),
      React.createElement('div',{id:'inspector',style:{width:330}},panel==='mask'?React.createElement(AnnotationsPanel,{project,update,time:0,previewTime:preview,selectedId:'mask',select:()=>{},onSeek:time=>{calls.push(['seek',time]);setPreview(time)},notify:message=>errors.push(message)}):panel==='processing'?React.createElement(CameraInspector,{project,update,processing:true,notify:message=>errors.push(message)}):panel==='scene'?React.createElement(CameraScenesPanel,{project,update,selectedId:'scene',onSelect:()=>{},onSeek:time=>calls.push(['seek',time])}):panel==='animation'?React.createElement(AnimationInspector,{project,update}):React.createElement(PresetsPopover,{anchor:document.querySelector('#anchor'),project,presets:[{id:'saved',name:'Owned preset',appearance:project.appearance}],defaultID:null,changed:async()=>{},apply:()=>{},close:()=>{},notify:message=>errors.push(message)}))
    );
  }
  flushSync(()=>root.render(React.createElement(Harness)));await wait();
  const textButton=(text,scope=document)=>Array.from(scope.querySelectorAll('button')).find(button=>button.textContent.trim()===text);
  const click=async button=>{check(button,'Expected button is absent; buttons: '+Array.from(document.querySelectorAll('#inspector button')).map(button=>button.textContent.trim()).join(' | '));button.click();await wait()};
  check(document.body.textContent.includes('Preview is showing different part'),'Outside-mask preview notice missing');
  await click(textButton('Focus the timeline on the mask'));
  check(calls.some(call=>call[0]==='seek'&&call[1]===3),'Focus did not choose source midpoint');
  check(!document.body.textContent.includes('Preview is showing different part'),'Notice did not clear inside mask');
  await click(document.querySelector('button[role=switch][aria-label=Disable]'));
  check(history.project.masks[0].disabled===true&&history.project.masks.length===1,'Disabling removed the mask');
  const row=document.querySelector('.feature-track'),bounds=row.getBoundingClientRect();
  row.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:bounds.left+300,clientY:bounds.top+8}));await wait();
  check(row.classList.contains('expanded'),'Hover did not expand feature row');
  const plus=row.querySelector('.feature-add-preview');check(plus,'Empty range has no plus insertion preview');
  check(Math.abs(row.querySelector('.feature-block').getBoundingClientRect().height-49)<1,'Hovered block is not expanded');
  plus.click();await wait();check(added.length===1&&added[0].start>=5.9,'Plus did not add the indicated range');
  row.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));await wait();
  flushSync(()=>setPanel('animation'));await wait();
  const group=document.querySelector('[aria-label="Screen animation style"]');
  await click(textButton('Smooth',group));check(history.project.appearance.screenSpring.stiffness===SPRING_PRESETS.screenSmooth.stiffness,'Screen card did not change rendering config');
  const cursors=document.querySelector('[aria-label="Cursor animation style"]');
  await click(textButton('Rapid',cursors));check(history.project.appearance.cursorSpring.stiffness===SPRING_PRESETS.cursorRapid.stiffness,'Cursor card did not change rendering config');
  await click(textButton('None',cursors));check(history.project.appearance.cursorSmooth===false,'None did not disable interpolation');
  flushSync(()=>setPanel('scene'));await wait();
  await click(textButton('Split screen'));check(history.project.cameraScenes[0].layout.type==='split-screen','Scene type card changed no range');
  const ratios=document.querySelector('[aria-label="Split ratio"]');
  await click(ratios.querySelectorAll('button')[2]);check(history.project.cameraScenes[0].layout.split.screenRatio===2/3,'Split ratio did not persist');
  await click(textButton('Padded'));check(history.project.cameraScenes[0].layout.split.enablePadding,'Scene fill did not persist');
  check(history.project.appearance.cameraLayout?.type!=='split-screen','Scene editor changed global layout');
  flushSync(()=>setPanel('processing'));await wait();
  const gallery=document.querySelector('.camera-look-gallery');check(gallery&&gallery.querySelectorAll('canvas').length===13,'Camera look gallery must contain thirteen real previews');
  const signatures=new Set(Array.from(gallery.querySelectorAll('canvas')).map(canvas=>{const pixels=canvas.getContext('2d').getImageData(0,0,96,96).data;let sum=0;for(let i=0;i<pixels.length;i+=4)sum=(sum+pixels[i]*3+pixels[i+1]*5+pixels[i+2]*7)>>>0;return sum}));
  check(signatures.size>=8,'Camera look previews do not reflect GPU transforms');
  await click(gallery.querySelector('button[aria-label=Golden]'));check(history.project.appearance.cameraProcessing.look==='warm','Camera thumbnail did not change render settings');
  flushSync(()=>setPanel('presets'));await wait();
  await click(document.querySelector('[aria-label="Preset actions: Owned preset"]'));
  const menu=document.querySelector('.preset-action-menu');check(menu&&menu.parentElement===document.body,'Preset actions are clipped inside popover');
  for(const label of ['Rename…','Update to match currently edited project','Use as default for new projects','Show in Finder','Remove…'])check(textButton(label,menu),'Missing preset action '+label);
  await click(textButton('Update to match currently edited project',menu));check(calls.some(call=>call[0]==='update'&&call[1]==='saved'),'Preset update did not reach owner');
  check(!errors.length,errors.join('; '));root.unmount();
  const timelineRoot=createRoot(document.querySelector('#root'));
  fixture.captions=[{id:'caption',start:1,end:6,text:'Owned caption'}];
  flushSync(()=>timelineRoot.render(React.createElement('div',{style:{display:'flex',flexDirection:'column',height:700,width:900}},
    React.createElement('div',{id:'stable-preview',style:{flex:'1 1 0',minHeight:0}}),
    React.createElement(Timeline,{project:fixture,time:0,seek:()=>{},update:()=>{},selectedZoom:null,onSelectZoom:()=>{},onAddZoom:()=>{},selectedSlice:null,onSelectSlice:()=>{},cutMode:false,onSplit:()=>{},onSplitZoom:()=>{},waveforms:[],scale:1,onScaleChange:()=>{}}))));
  await wait();
  const geometry=()=>Array.from(document.querySelectorAll('#stable-preview,.timeline,.timeline-scroll')).map(element=>{const rect=element.getBoundingClientRect();return[rect.x,rect.y,rect.width,rect.height]});
  const initialGeometry=geometry();
  for(const kind of ['layouts','masks']){
    const row=document.querySelector('.feature-track.'+kind),rect=row.getBoundingClientRect();
    row.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.left+rect.width*.85,clientY:rect.top+8}));await wait();
    check(row.classList.contains('expanded'),'Full timeline row did not expand: '+kind);
    check(JSON.stringify(geometry())===JSON.stringify(initialGeometry),'Preview or workspace moved while hovering '+kind);
    const caption=document.querySelector('.caption-track').getBoundingClientRect(),viewport=document.querySelector('.timeline-scroll').getBoundingClientRect();
    check(caption.bottom<=viewport.bottom,'Expanded tracks clipped captions');
    row.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));await wait();
    check(JSON.stringify(geometry())===JSON.stringify(initialGeometry),'Preview or workspace moved when leaving '+kind);
  }
  timelineRoot.unmount();
  return {passed:['mask preview notice / source midpoint focus','disable retains range','row hover expansion / plus insertion','stable preview geometry with layouts, masks and captions on hover and leave','real card edits reach spring configs','cursor interpolation none','range-only camera type / ratio / fill','thirteen camera look thumbnails with actual GPU transforms','preset popover and five actions / update owner'],limitations:['preset IPC is mocked here; real portable persistence and safe path handling are tested by project-bundle.test.cjs']};
}
