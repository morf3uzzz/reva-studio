import test from "node:test";
import assert from "node:assert/strict";
import { createProject, createScreenAnimator, getScreenGeometry, getScreenTarget } from "../src/core/model.ts";
import { defaultDeviceFrame, deviceFrameRect, deviceScreenRect, socialSafeRect } from "../src/core/screen-effects.ts";
import { drawFrame } from "../src/core/render.ts";

test("independent phone/tablet frames fit resting bounds and scale with shared preview/export geometry", () => {
  const p = createProject({ path: "/qa/phone.mov", name: "Phone", width: 1080, height: 1920, duration: 5 });
  p.appearance.aspect = "9:16";
  const original = getScreenTarget(p, 0, 1080, 1920).rect;
  for (const type of ["phone", "tablet"] as const) {
    const settings = { ...defaultDeviceFrame(), type }, inside = deviceScreenRect(original, settings), outside = deviceFrameRect(inside, settings);
    assert.ok(outside.x >= original.x && outside.y >= original.y);
    assert.ok(outside.x + outside.width <= original.x + original.width + 1e-7);
    assert.ok(outside.y + outside.height <= original.y + original.height + 1e-7);
    p.appearance.deviceFrame = settings;
    const preview = getScreenGeometry(p, 0, 540, 960, 60, createScreenAnimator(60)), exported = getScreenGeometry(p, 0, 1080, 1920, 60, createScreenAnimator(60));
    assert.equal(preview.rect.width * 2, exported.rect.width);
    assert.equal(preview.screenRadius * 2, exported.screenRadius);
  }
});

test("legacy cover/cursor-follow imports fill the viewport while retaining the caller's source crop", () => {
  const p = createProject({ path: "/qa/screen.mov", name: "Screen", width: 1920, height: 1080, duration: 5 });
  p.appearance.aspect = "9:16"; p.appearance.avoidEmptyZoomArea = true;
  p.cursor = [{ t: 0, x: 0, y: .5, click: false }, { t: 2, x: 1, y: .5, click: false }];
  const crop = structuredClone(p.appearance.crop), left = getScreenTarget(p, 0, 1080, 1920), right = getScreenTarget(p, 2, 1080, 1920);
  assert.ok(left.rect.width > 1080);
  assert.ok(left.rect.x > right.rect.x);
  assert.deepEqual(p.appearance.crop, crop);
});

test("social guides require an explicit preview option and are absent from normal/export draws", () => {
  const p = createProject({ path: "/qa/screen.mov", name: "Screen", width: 1920, height: 1080, duration: 5 });
  const texts: unknown[] = [];
  const context = new Proxy({ canvas: { width: 540, height: 960 } }, { get(target, key) { if (key in target) return Reflect.get(target, key); return (...args: unknown[]) => { if (key === "fillText") texts.push(args[0]); if (key === "createLinearGradient" || key === "createRadialGradient") return { addColorStop() {} }; }; } }) as unknown as CanvasRenderingContext2D;
  const options = { width: 540, height: 960, screen: { readyState: 2, videoWidth: 1920, videoHeight: 1080 } as unknown as HTMLVideoElement };
  drawFrame(context, p, 0, options);
  assert.equal(texts.length, 0);
  drawFrame(context, p, 0, { ...options, socialSafeArea: "tiktok" });
  assert.ok(texts.includes("TikTok"));
  assert.equal(socialSafeRect("off", 540, 960), null);
  const safe = socialSafeRect("instagram", 540, 960)!;
  assert.ok(safe.x > 0 && safe.y > 0 && safe.x + safe.width < 540 && safe.y + safe.height < 960);
});


test("advanced shadow reaches the common renderer and restores offsets before content", () => {
  const project = createProject({ path: "/owned/screen.mp4", name: "Shadow", width: 1920, height: 1080, duration: 3 });
  project.appearance.screenShadow = { style: "directional", distance: 60, angle: 180, blur: 8 };
  const fills: { x: number; y: number; blur: number }[] = [];
  const state: Record<PropertyKey, unknown> = { canvas: { width: 1920, height: 1080 } };
  const context = new Proxy(state, { get(target, key) {
    if (key in target) return target[key];
    return () => {
      if (key === "fill" && typeof target.shadowColor === "string" && target.shadowColor.startsWith("rgba")) fills.push({ x: Number(target.shadowOffsetX), y: Number(target.shadowOffsetY), blur: Number(target.shadowBlur) });
      if (key === "createLinearGradient" || key === "createRadialGradient") return { addColorStop() {} };
    };
  } }) as unknown as CanvasRenderingContext2D;
  drawFrame(context, project, 0, { width: 1920, height: 1080 });
  assert.ok(fills.some(value => Math.abs(value.x + 60) < 1e-8 && Math.abs(value.y) < 1e-8 && value.blur === 8));
  assert.equal(state.shadowOffsetX, 0);
  project.appearance.screenShadow.style = "classic";
  fills.length = 0;
  drawFrame(context, project, 0, { width: 1920, height: 1080 });
  assert.ok(fills.some(value => value.blur === 24));
});
