import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import App from '../src/App.tsx';
import {createProject} from '../src/core/model.ts';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function until(condition) {
  const end = performance.now() + 10000;
  while (!condition()) { check(performance.now() < end, 'Preview regression timed out'); await wait(15); }
}
let root, paints = 0;
const drawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
  if (source instanceof HTMLVideoElement) paints++;
  return drawImage.call(this, source, ...args);
};
async function mount(cursor = false) {
  root?.unmount();
  const callbacks = new Map();
  const project = createProject({path: '/source.mp4', name: 'Owned preview fixture', duration: 3, width: 640, height: 360});
  project.appearance = {...project.appearance, backgroundKind: 'color', background: '#111111', shadow: 0, cursorHidden: !cursor};
  if (cursor) project.cursor = [{t: 0, x: .5, y: .5, click: false}, {t: 3, x: .5, y: .5, click: false}];
  globalThis.reva = new Proxy({
    backgrounds: {listFavorites: async () => ({favorites: [], issues: []})},
    getLanguage: async () => 'en', getAppPreferences: async () => ({autoSaveProject: false}),
    listRecordingRecovery: async () => ({recordings: [], issues: []}),
    getWaveform: async () => ({duration: 3, peaks: []}),
    openProject: async () => ({project, path: '/owned/preview.revastudio'}),
    mediaURL: path => path, renderAudioPreview: async () => null,
  }, {get: (target, key) => key in target ? target[key] : String(key).startsWith('on')
    ? listener => { callbacks.set(key, listener); return () => callbacks.delete(key); }
    : async () => null});
  root = createRoot(document.querySelector('#root'));
  flushSync(() => root.render(React.createElement(App)));
  await until(() => callbacks.has('onMenuAction'));
  callbacks.get('onMenuAction')('open');
  await until(() => document.querySelector('video')?.readyState >= 2);
  await wait(200);
  return {video: document.querySelector('video'), canvas: document.querySelector('canvas[aria-label="Video preview"]')};
}
export async function verifyPreviewInvalidation() {
  const {canvas, video} = await mount();
  check(canvas && canvas.width > 0, 'The actual App preview is missing');
  const start = paints;
  await wait(350);
  const idlePaints = paints - start;
  check(idlePaints <= 1, `Paused preview repainted ${idlePaints} identical video frames`);
  const beforeHover = canvas.toDataURL();
  const bounds = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2}));
  await until(() => canvas.toDataURL() !== beforeHover);
  canvas.dispatchEvent(new PointerEvent('pointerout', {bubbles: true, relatedTarget: document.body}));
  await until(() => canvas.toDataURL() === beforeHover);
  const gradient = [...document.querySelectorAll('.inspector button')].find(button => button.textContent.trim() === 'Gradient');
  check(gradient, 'Actual background editing control is missing');
  gradient.click();
  await until(() => canvas.toDataURL() !== beforeHover);
  const beforeSeek = canvas.toDataURL();
  video.currentTime = 1;
  await until(() => !video.seeking && video.readyState >= 2);
  await until(() => canvas.toDataURL() !== beforeSeek);
  const beforeResize = canvas.width;
  await globalThis.previewHost.resize(900, 850);
  await until(() => canvas.width !== beforeResize);
  await wait(40);
  check(canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3] > 0, 'Resizing left a cleared canvas');

  const late = await mount(true);
  late.video.currentTime = 1;
  await until(() => !late.video.seeking && late.video.readyState >= 2);
  await until(() => globalThis.previewHost.cursorRequested());
  await wait(50);
  const withoutCursor = late.canvas.toDataURL();
  await until(() => late.canvas.toDataURL() !== withoutCursor);
  const settled = paints;
  await wait(250);
  check(paints - settled <= 1, 'Late artwork restarted continuous idle painting');
  root.unmount(); root = null;
  return {idlePaints, passed: ['paused-frame reuse', 'hover outline and leave', 'project appearance edit', 'actual media seek/decode', 'backing-size invalidation', 'late SVG cursor completion']};
}
