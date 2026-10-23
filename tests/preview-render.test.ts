import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/core/model.ts";
import { createPreviewRenderer } from "../src/core/preview-render.ts";

function surface() {
  const canvas = { width: 1440, height: 960 }, calls: { method: string; args: unknown[] }[] = [];
  const context = new Proxy({ canvas }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args });
        if (key === "createLinearGradient" || key === "createRadialGradient") return { addColorStop() {} };
      };
    },
  }) as unknown as CanvasRenderingContext2D;
  return { canvas, context, calls };
}
const project = () => createProject({ path: "/qa/recording.mov", name: "Recording", width: 1440, height: 900, duration: 6 });

test("scrubbing and rapid transport gaps keep the displayed frame until decode resumes", () => {
  const render = createPreviewRenderer(), p = project(), { context, calls } = surface();
  const video = { readyState: 2, videoWidth: 1440, videoHeight: 900 };
  const options = { width: 1440, height: 960, screen: video as unknown as HTMLVideoElement };
  assert.equal(render(context, p, 3, options), true);
  assert.equal(calls.filter(call => call.method === "drawImage").length, 1);
  const count = calls.length;
  video.readyState = 1;
  for (const time of [3.01, 3.02, 4, 2]) assert.equal(render(context, p, time, options), false);
  assert.equal(calls.length, count, "retention neither clears nor replaces the image with a welcome screen");
  video.readyState = 2;
  assert.equal(render(context, p, 2, options), true);
  assert.equal(calls.filter(call => call.method === "drawImage").length, 2);
  assert.equal(calls.some(call => call.method === "fillText"), false);
});

test("loading a different source or resizing invalidates retained pixels without showing the empty-project welcome", () => {
  const render = createPreviewRenderer(), p = project(), { context, canvas, calls } = surface();
  const video = { readyState: 2, videoWidth: 1440, videoHeight: 900 };
  const options = { width: 1440, height: 960, screen: video as unknown as HTMLVideoElement };
  render(context, p, 3, options);
  video.readyState = 1;
  assert.equal(render(context, { ...p, mediaPath: "/qa/other.mov" }, 0, options), true);
  assert.equal(calls.filter(call => call.method === "clearRect").length, 2);
  assert.equal(calls.some(call => call.method === "fillText"), false);
  video.readyState = 2;
  render(context, p, 3, options);
  video.readyState = 1;
  canvas.width = 720; canvas.height = 480;
  assert.equal(render(context, p, 4, { ...options, width: 720, height: 480 }), true);
  assert.equal(calls.filter(call => call.method === "clearRect").length, 4);
  assert.equal(calls.some(call => call.method === "fillText"), false);
  render(context, createProject(), 0, { width: 720, height: 480 });
  assert.ok(calls.some(call => call.method === "fillText" && call.args[0] === "Your next great recording"));
});
