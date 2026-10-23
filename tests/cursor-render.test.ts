import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../src/core/model.ts";
import { defaultCursorSettings } from "../src/core/cursor.ts";
import { cursorAsset, cursorGeometryAt, drawCursorFrame } from "../src/core/cursor-render.ts";
import { drawFrame } from "../src/core/render.ts";

test("paused compositor redraws loaded styles and size at the same recorded point, including out-of-order SVG completion", t => {
  const priorImage = Object.getOwnPropertyDescriptor(globalThis, "Image"), priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const pending = new Map<string, DeferredImage>();
  class DeferredImage {
    naturalWidth = 8;
    naturalHeight = 8;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private url = "";
    get src() { return this.url; }
    set src(value: string) { this.url = value; pending.set(value, this); }
    complete() { this.onload?.(); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: DeferredImage });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => {
      assert.equal(tag, "canvas");
      return { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(255) }) }) };
    },
  } });
  t.after(() => {
    if (priorImage) Object.defineProperty(globalThis, "Image", priorImage); else Reflect.deleteProperty(globalThis, "Image");
    if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument); else Reflect.deleteProperty(globalThis, "document");
  });
  const original = createProject({ path: "/recorded.mp4", name: "recorded", duration: 5, width: 1000, height: 1000 });
  original.appearance = { ...original.appearance, backgroundKind: "color", padding: 0, cursorSettings: defaultCursorSettings() };
  original.cursor = [{ t: 0, x: 0.4, y: 0.6, click: false, event: "mouseMoved" }];
  const recorded = structuredClone(original.cursor);
  let current = original, redraws = 0;
  const draws: { url: string; x: number; y: number; width: number; height: number }[] = [], positions: number[][] = [];
  const context = new Proxy({
    drawImage(image: unknown, x: number, y: number, width: number, height: number) {
      if (image instanceof DeferredImage) draws.push({ url: image.src, x, y, width, height });
    },
    translate(x: number, y: number) { positions.push([x, y]); },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as CanvasRenderingContext2D;
  const pausedTime = 2;
  const redraw = () => {
    redraws++;
    drawFrame(context, current, pausedTime, { width: 1000, height: 1000, screen: { width: 1000, height: 1000 } as HTMLCanvasElement, onCursorAssetReady: redraw });
  };
  const url = () => `cursors/${cursorAsset(current.appearance.cursorSettings!, "pointer")!.file}`;
  const changeSet = (id: string) => {
    current = { ...current, appearance: { ...current.appearance, cursorSettings: { ...current.appearance.cursorSettings!, set: { id, variants: {} } } } };
    redraw();
  };
  redraw();
  assert.equal(draws.length, 0, "the original SVG is not ready yet");
  const originalURL = url();
  pending.get(originalURL)!.complete();
  assert.equal(redraws, 2, "asset completion reaches the shared frame compositor invalidation callback");
  assert.equal(draws.at(-1)!.url, originalURL);
  assert.equal(draws.at(-1)!.height, 48);
  assert.deepEqual(positions.at(-1), [400, 600]);

  changeSet("custom-1"); const staleURL = url();
  changeSet("custom-2"); const selectedURL = url();
  const before = draws.length;
  pending.get(staleURL)!.complete();
  assert.equal(draws.length, before, "an old style completing must not draw over the newer selection");
  pending.get(selectedURL)!.complete();
  assert.equal(draws.at(-1)!.url, selectedURL);
  assert.deepEqual(positions.at(-1), [400, 600]);
  const sizeBefore = draws.at(-1)!;
  current = { ...current, appearance: { ...current.appearance, cursorSettings: { ...current.appearance.cursorSettings!, size: 96 } } };
  redraw();
  assert.equal(draws.at(-1)!.height, sizeBefore.height * 2);
  assert.equal(draws.at(-1)!.width, sizeBefore.width * 2);
  assert.deepEqual(positions.at(-1), [400, 600], "size changes preserve the recorded hotspot position");
  assert.equal(current.cursor, original.cursor);
  assert.deepEqual(current.cursor, recorded, "style and size changes never edit captured cursor data");

  const loadedCount = pending.size, drawCount = draws.length;
  current = { ...current, cursor: [] };
  redraw();
  assert.equal(draws.length, drawCount, "a video without cursor metadata receives no invented cursor");
  assert.equal(pending.size, loadedCount);
});

test("cursor hitbox follows the rendered sprite through crop, rotation, Retina scaling and live style/size changes", t => {
  const priorImage = Object.getOwnPropertyDescriptor(globalThis, "Image"), priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const pending = new Map<string, DeferredImage>();
  class DeferredImage {
    naturalWidth = 16;
    naturalHeight = 8;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private url = "";
    get src() { return this.url; }
    set src(value: string) { this.url = value; pending.set(value, this); }
    complete() { this.onload?.(); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: DeferredImage });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      drawImage() {},
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        // Opaque artwork occupies half the height; transparent padding must
        // still belong to the full-sprite reference hitbox.
        for (let y = 2; y < 6; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = 255;
        return { data };
      },
    }) }),
  } });
  t.after(() => {
    if (priorImage) Object.defineProperty(globalThis, "Image", priorImage); else Reflect.deleteProperty(globalThis, "Image");
    if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument); else Reflect.deleteProperty(globalThis, "document");
  });
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} != ${expected}`);
  const project = createProject({ path: "/moving.mp4", name: "moving", duration: 2, width: 1000, height: 1000 });
  project.cursorSourceSize = { width: 500, height: 500 };
  project.appearance.cursorSmooth = false;
  project.appearance.cursorSettings = { ...defaultCursorSettings(), size: 50, set: { id: "custom-3", variants: {} }, baseRotation: 90, tiltAmount: 0, shakeThreshold: 0, optimizeChanges: false };
  project.cursor = [{ t: 0, x: 0.5, y: 0.5, click: false }, { t: 1, x: 0.625, y: 0.375, click: false }];
  const recorded = structuredClone(project.cursor);
  const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, screen = { x: 40, y: 60, width: 200, height: 100 };
  let invalidated = 0;
  assert.equal(cursorGeometryAt(project, 0.5, crop, screen, { onAssetReady: () => invalidated++ }), null);
  const asset = cursorAsset(project.appearance.cursorSettings, "pointer")!;
  const originalImage = pending.get(`cursors/${asset.file}`)!;
  originalImage.complete();
  assert.equal(invalidated, 1, "hit testing requests the same asset-readiness invalidation as rendering");
  const geometry = cursorGeometryAt(project, 0.5, crop, screen)!;
  assert.deepEqual(geometry.hotspot, { x: 140, y: 110 });
  close(geometry.imageRect.height, 80);
  close(geometry.imageRect.width, 80 * asset.width / asset.height);
  close(geometry.bounds.width, geometry.imageRect.height);
  close(geometry.bounds.height, geometry.imageRect.width);
  close(geometry.bounds.x, 140 - (1 - asset.hotspot.y) * 80);
  close(geometry.bounds.y, 110 - asset.hotspot.x * geometry.imageRect.width);
  close(geometry.opacity, 1);

  const draws: { image: unknown; x: number; y: number; width: number; height: number }[] = [], positions: number[][] = [], rotations: number[] = [];
  const context = new Proxy({
    drawImage(image: unknown, x: number, y: number, width: number, height: number) { draws.push({ image, x, y, width, height }); },
    translate(x: number, y: number) { positions.push([x, y]); },
    rotate(angle: number) { rotations.push(angle); },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as CanvasRenderingContext2D;
  drawCursorFrame(context, project, 0.5, crop, screen, 1);
  assert.equal(draws.at(-1)!.image, originalImage, "rendering retains the original image; the alpha-measurement canvas is never an undersized sprite cache");
  close(draws.at(-1)!.x + geometry.hotspot.x, geometry.imageRect.x);
  close(draws.at(-1)!.y + geometry.hotspot.y, geometry.imageRect.y);
  close(draws.at(-1)!.width, geometry.imageRect.width);
  close(draws.at(-1)!.height, geometry.imageRect.height);
  assert.deepEqual(positions.at(-1), [140, 110]);
  close(rotations.at(-1)!, geometry.rotation);
  const retina = cursorGeometryAt(project, 0.5, crop, { x: 80, y: 120, width: 400, height: 200 })!;
  for (const key of ["x", "y", "width", "height"] as const) close(retina.bounds[key], geometry.bounds[key] * 2);

  const changed = { ...project, appearance: { ...project.appearance, cursorSettings: { ...project.appearance.cursorSettings, size: 100, set: { id: "custom-4", variants: {} } } } };
  assert.equal(cursorGeometryAt(changed, 1, crop, screen), null, "a pending new style must not reuse a previous style's hitbox");
  const nextAsset = cursorAsset(changed.appearance.cursorSettings, "pointer")!;
  const nextImage = pending.get(`cursors/${nextAsset.file}`)!;
  nextImage.complete();
  const live = cursorGeometryAt(changed, 1, crop, screen)!;
  assert.deepEqual(live.hotspot, { x: 190, y: 85 }, "the marker follows the new recorded playback position");
  close(live.imageRect.height, 160);
  close(live.imageRect.width, 160 * nextAsset.width / nextAsset.height);
  drawCursorFrame(context, changed, 1, crop, screen, 1);
  assert.equal(draws.at(-1)!.image, nextImage);
  close(draws.at(-1)!.height, live.imageRect.height);
  assert.deepEqual(positions.at(-1), [190, 85]);
  assert.equal(changed.cursor, project.cursor);
  assert.deepEqual(changed.cursor, recorded);
  assert.equal(cursorGeometryAt({ ...changed, cursor: [] }, 1, crop, screen), null);
  assert.equal(cursorGeometryAt({ ...changed, appearance: { ...changed.appearance, cursorSettings: { ...changed.appearance.cursorSettings, hidden: true } } }, 1, crop, screen), null);
  assert.equal(cursorGeometryAt({ ...changed, slices: [{ id: "hidden", start: 0, end: 2, speed: 1, volume: 1, cursorHidden: true }] }, 1, crop, screen), null);
});
