import type { Appearance, Project } from "../types.ts";
import catalog from "../../cursors.json" with { type: "json" };
import { cursorCircleState, cursorFrameAt, cursorRippleOffset, resolveCursorSettings, type CursorFrameOptions, type CursorFrameState, type CursorSettings } from "./cursor.ts";

interface Rect { x: number; y: number; width: number; height: number }
export interface CursorAsset {
  set: string; type: string; id: string; file: string; width: number; height: number; hotspot: { x: number; y: number };
  url?: string;
}
export interface DrawCursorOptions extends CursorFrameOptions { onAssetReady?: () => void }
export interface CursorGeometry {
  /** Axis-aligned bounds of the full rotated artwork, matching the reference marker. */
  bounds: Rect;
  /** Full artwork before rotation; the alpha-height measurement only normalizes its size. */
  imageRect: Rect;
  hotspot: { x: number; y: number };
  rotation: number;
  opacity: number;
}
interface LoadedCursor { image: HTMLImageElement; visibleHeight: number; promise: Promise<void>; ready: boolean; listeners: Set<() => void> }
const images = new Map<string, LoadedCursor>();

export function cursorAsset(settings: CursorSettings, type: string): CursorAsset | null {
  const set = catalog.entries.filter(e => e.set === settings.set.id);
  const selected = set.filter(e => e.type === type);
  const candidates = selected.length ? selected : set.filter(e => e.type === "pointer");
  const choices = candidates.length ? candidates : set;
  return choices.find(e => e.id === settings.set.variants[e.type]) ?? choices[0] ?? null;
}

/** Mean nonzero alpha excludes translucent shadow when measuring visible size. */
export function cursorVisibleHeight(pixels: Uint8ClampedArray, width: number, height: number): number {
  let total = 0, count = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) { total += pixels[i]; count++; }
  if (!count) return 1;
  const threshold = total / count;
  let top = height, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3] >= threshold) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return top <= bottom ? (bottom - top + 1) / height : 1;
}

function loadCursor(asset: CursorAsset, invalidate?: () => void): LoadedCursor | null {
  if (typeof Image === "undefined") return null;
  const existing = images.get(asset.file);
  if (existing) { if (!existing.ready && invalidate) existing.listeners.add(invalidate); return existing; }
  const image = new Image();
  let resolve: () => void, reject: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Preview initiates loading without awaiting; export explicitly awaits readiness.
  promise.catch(() => {});
  const loaded: LoadedCursor = { image, visibleHeight: 1, promise, ready: false, listeners: new Set(invalidate ? [invalidate] : []) };
  images.set(asset.file, loaded);
  image.onload = () => {
    try {
      if (asset.url && (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height)) throw new Error("Cursor artwork dimensions changed. Import the image again.");
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Could not measure cursor image.");
      ctx.drawImage(image, 0, 0);
      loaded.visibleHeight = cursorVisibleHeight(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      canvas.width = 0; canvas.height = 0;
      loaded.ready = true; resolve();
      for (const listener of loaded.listeners) listener(); loaded.listeners.clear();
    } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
  };
  image.onerror = () => reject(new Error(`Cursor artwork is unavailable: ${asset.file}`));
  image.src = asset.url ?? `cursors/${asset.file}`;
  return loaded;
}

/** Export preflight; all shapes/variants in the selected set use fixed local URLs. */
export async function prepareCursorAssets(appearance: Appearance): Promise<void> {
  if (appearance.customCursor?.enabled) { await loadCursor(customCursorAsset(appearance.customCursor))?.promise; return; }
  const settings = resolveCursorSettings(appearance);
  const assets = catalog.entries.filter(asset => asset.set === settings.set.id);
  // Fixed bundled artwork is below 1.6M pixels/image. Limit simultaneous raster reads.
  for (let index = 0; index < assets.length; index += 4) await Promise.all(assets.slice(index, index + 4).map(asset => loadCursor(asset)?.promise));
}

function customCursorAsset(image: NonNullable<Appearance["customCursor"]>): CursorAsset {
  return { set: "imported", type: "pointer", id: image.sha256, file: `${image.path}:${image.sha256}`, url: window.reva ? `${window.reva.mediaURL(image.path)}&sha256=${image.sha256}` : undefined, width: image.width, height: image.height, hotspot: image.hotspot };
}

function screenPoint(x: number, y: number, crop: Rect, screen: Rect) {
  return { x: screen.x + (x - crop.x) / crop.width * screen.width, y: screen.y + (y - crop.y) / crop.height * screen.height };
}

function cursorSprite(project: Project, state: CursorFrameState, settings: CursorSettings, crop: Rect, screen: Rect, invalidate?: () => void): { image: HTMLImageElement; geometry: CursorGeometry } | null {
  if (state.opacity <= 0) return null;
  const asset = project.appearance.customCursor?.enabled ? customCursorAsset(project.appearance.customCursor) : cursorAsset(settings, state.type);
  const loaded = asset && loadCursor(asset, invalidate);
  if (!asset || !loaded?.ready) return null;
  const source = project.cursorSourceSize ?? { width: project.width, height: project.height };
  const height = settings.size * screen.width / (crop.width * source.width) / loaded.visibleHeight * state.scale, width = height * asset.width / asset.height;
  const hotspot = screenPoint(state.x, state.y, crop, screen);
  const imageRect = { x: hotspot.x - asset.hotspot.x * width, y: hotspot.y - asset.hotspot.y * height, width, height };
  // The original getCursorMarkerBounds encloses the full sprite after rotation
  // around its recorded hotspot, rather than cropping its translucent shadow.
  const cosine = Math.cos(state.rotation), sine = Math.sin(state.rotation);
  const cx = (0.5 - asset.hotspot.x) * width, cy = (0.5 - asset.hotspot.y) * height;
  const halfWidth = (Math.abs(cosine) * width + Math.abs(sine) * height) / 2;
  const halfHeight = (Math.abs(sine) * width + Math.abs(cosine) * height) / 2;
  const bounds = { x: hotspot.x + cx * cosine - cy * sine - halfWidth, y: hotspot.y + cx * sine + cy * cosine - halfHeight, width: halfWidth * 2, height: halfHeight * 2 };
  return { image: loaded.image, geometry: { bounds, imageRect, hotspot, rotation: state.rotation, opacity: state.opacity } };
}

/** Geometry uses the supplied screen coordinates (CSS or backing pixels), radians,
 * and the same asset/alpha measurement as rendering. No recorded/visible/loaded
 * cursor means no hitbox; asset completion uses the normal preview invalidation. */
export function cursorGeometryAt(project: Project, time: number, crop: Rect, screen: Rect, options: DrawCursorOptions = {}): CursorGeometry | null {
  const state = cursorFrameAt(project, time, options);
  return state ? cursorSprite(project, state, resolveCursorSettings(project.appearance), crop, screen, options.onAssetReady)?.geometry ?? null : null;
}

interface RippleClick { x: number; y: number; ageMs: number }
interface RippleGPU { canvas: HTMLCanvasElement; gl: WebGLRenderingContext; program: WebGLProgram; texture: WebGLTexture }
let rippleGPU: RippleGPU | null | undefined;
const vertexShader = `attribute vec2 position; varying vec2 uv; void main(){ uv=(position+1.0)*0.5; gl_Position=vec4(position,0.0,1.0); }`;
// Independent GLSL expression of the measured radial and chromatic offsets.
const fragmentShader = `precision highp float;
varying vec2 uv; uniform sampler2D image; uniform vec2 size; uniform float videoWidth;
uniform vec3 click0; uniform vec3 click1; uniform vec3 click2;
vec4 wave(vec3 click){
 if(click.z<0.0 || click.z>1000.0) return vec4(0.0);
 vec2 delta=uv*size-click.xy; float dist=length(delta); if(dist==0.0) return vec4(0.0);
 float p=click.z/1000.0; float sigma=videoWidth*0.05; float r=(dist-videoWidth*(0.04+p*0.2))/sigma;
 if(abs(r)>3.0) return vec4(0.0);
 float g=exp(-4.0*r*r); float w=exp(-3.0*p)*sin(9.4*p); vec2 axis=delta/dist;
 return vec4(axis*(w*g*videoWidth*0.015),axis*(abs(w)*g*(1.0-g)*4.0*videoWidth*0.004));
}
void main(){vec4 offsets=wave(click0)+wave(click1)+wave(click2);vec2 at=uv+offsets.xy/size;vec2 chroma=offsets.zw/size;
 vec4 mid=texture2D(image,at);gl_FragColor=vec4(texture2D(image,at+chroma).r,mid.g,texture2D(image,at-chroma).b,mid.a);}`;

function rippleRenderer(): RippleGPU | null {
  if (rippleGPU !== undefined) return rippleGPU;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) return rippleGPU = null;
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type); if (!s) throw new Error("Could not allocate ripple shader.");
    gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); throw new Error("Could not compile ripple shader."); }
    return s;
  };
  try {
    const vertex = shader(gl.VERTEX_SHADER, vertexShader), fragment = shader(gl.FRAGMENT_SHADER, fragmentShader), program = gl.createProgram(), texture = gl.createTexture(), buffer = gl.createBuffer();
    if (!program || !texture || !buffer) throw new Error("Could not allocate ripple resources.");
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Could not link ripple shader.");
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, "position"); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return rippleGPU = { canvas, gl, program, texture };
  } catch { return rippleGPU = null; }
}

/** Repaints the already-composited screen with a real displacement, under its clip. */
function drawRipple(context: CanvasRenderingContext2D, clicks: RippleClick[], videoWidth: number) {
  const gpu = rippleRenderer();
  if (!gpu || gpu.gl.isContextLost()) { drawRippleCPU(context, clicks, videoWidth); return; }
  const { canvas, gl, program, texture } = gpu, source = context.canvas;
  if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
  gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program); gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.uniform2f(gl.getUniformLocation(program, "size"), canvas.width, canvas.height); gl.uniform1f(gl.getUniformLocation(program, "videoWidth"), videoWidth);
  for (let i = 0; i < 3; i++) { const click = clicks[i]; gl.uniform3f(gl.getUniformLocation(program, `click${i}`), click?.x ?? 0, click ? canvas.height - click.y : 0, click?.ageMs ?? -1); }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  context.drawImage(canvas, 0, 0);
}

let rippleFallback: HTMLCanvasElement | undefined;
function drawRippleCPU(context: CanvasRenderingContext2D, clicks: RippleClick[], videoWidth: number) {
  if (typeof document === "undefined" || !clicks.length) return;
  const reach = videoWidth * 0.39;
  const x = Math.max(0, Math.floor(Math.min(...clicks.map(c => c.x - reach)))), y = Math.max(0, Math.floor(Math.min(...clicks.map(c => c.y - reach))));
  const right = Math.min(context.canvas.width, Math.ceil(Math.max(...clicks.map(c => c.x + reach)))), bottom = Math.min(context.canvas.height, Math.ceil(Math.max(...clicks.map(c => c.y + reach))));
  if (right <= x || bottom <= y) return;
  const source = context.getImageData(x, y, right - x, bottom - y), output = new ImageData(source.width, source.height), width = source.width, height = source.height;
  const channel = (sx: number, sy: number, c: number) => {
    const px = Math.max(0, Math.min(width - 1, sx)), py = Math.max(0, Math.min(height - 1, sy)), ax = Math.floor(px), ay = Math.floor(py), bx = Math.min(ax + 1, width - 1), by = Math.min(ay + 1, height - 1), fx = px - ax, fy = py - ay;
    return (source.data[(ay * width + ax) * 4 + c] * (1 - fx) + source.data[(ay * width + bx) * 4 + c] * fx) * (1 - fy) + (source.data[(by * width + ax) * 4 + c] * (1 - fx) + source.data[(by * width + bx) * 4 + c] * fx) * fy;
  };
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    let dx = 0, dy = 0, cx = 0, cy = 0;
    for (const click of clicks) {
      const rx = px + x - click.x, ry = py + y - click.y, distance = Math.hypot(rx, ry);
      const offset = cursorRippleOffset(click.ageMs, distance, videoWidth);
      if (distance > 0) { dx += rx / distance * offset.displacement; dy += ry / distance * offset.displacement; cx += rx / distance * offset.chromatic; cy += ry / distance * offset.chromatic; }
    }
    const at = (py * width + px) * 4;
    output.data[at] = channel(px + dx + cx, py + dy + cy, 0); output.data[at + 1] = channel(px + dx, py + dy, 1); output.data[at + 2] = channel(px + dx - cx, py + dy - cy, 2); output.data[at + 3] = channel(px + dx, py + dy, 3);
  }
  rippleFallback ??= document.createElement("canvas"); rippleFallback.width = width; rippleFallback.height = height;
  rippleFallback.getContext("2d")?.putImageData(output, 0, 0); context.drawImage(rippleFallback, x, y);
}

/** Shared cursor compositor for live preview, arbitrary seeks, and exported frames. */
export function drawCursorFrame(context: CanvasRenderingContext2D, project: Project, time: number, crop: Rect, screen: Rect, pixelScale: number, options: DrawCursorOptions = {}): void {
  const state = cursorFrameAt(project, time, options);
  if (!state) return;
  const settings = resolveCursorSettings(project.appearance);
  const visibleWidth = screen.width / crop.width;
  const clicks = state.clicks.map(click => ({ ...screenPoint(click.x, click.y, crop, screen), ageMs: click.ageMs }));
  context.save();
  if (settings.clickEffect === "ripple" && clicks.length) drawRipple(context, clicks, visibleWidth);
  if (settings.clickEffect === "circle") for (const click of clicks) {
    const effect = cursorCircleState(click.ageMs, visibleWidth);
    if (!effect) continue;
    context.globalAlpha = effect.alpha; context.fillStyle = "#dedede"; context.strokeStyle = "#00000080"; context.lineWidth = effect.rimWidth;
    context.beginPath(); context.arc(click.x, click.y, effect.radius, 0, Math.PI * 2); context.fill(); context.stroke();
  }
  const sprite = cursorSprite(project, state, settings, crop, screen, options.onAssetReady);
  if (!sprite) { context.restore(); return; }
  const { hotspot, imageRect, rotation, opacity } = sprite.geometry;
  context.globalAlpha = opacity; context.translate(hotspot.x, hotspot.y); context.rotate(rotation);
  if (state.fadeBlur > 0) context.filter = `blur(${state.fadeBlur * pixelScale}px)`;
  context.drawImage(sprite.image, imageRect.x - hotspot.x, imageRect.y - hotspot.y, imageRect.width, imageRect.height);
  context.restore();
}
