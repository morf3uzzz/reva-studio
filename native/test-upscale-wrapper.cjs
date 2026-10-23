"use strict";
// Opt-in actual production lifecycle test; pass only a generated fixture source.
// node native/test-upscale-wrapper.cjs HELPER MODEL SYNTHETIC_SOURCE
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { ScreenUpscaler } = require("../electron/upscale.cjs");
const { MediaGrants } = require("../electron/media.cjs");

(async () => {
  const [helper, modelPath, source] = await Promise.all(process.argv.slice(2, 5).map(file => fs.realpath(file)));
  if (!helper || !modelPath || !source) throw new Error("Pass helper, local model, and a generated synthetic source.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-real-upscale-wrapper-")), grants = new MediaGrants(), progress = [];
  await grants.grant(source);
  const upscaler = new ScreenUpscaler({ helper, modelPath, cacheRoot: directory, grants, onProgress: value => progress.push(value) }), start = performance.now();
  try {
    const result = await upscaler.upscale(source);
    assert.ok(result); assert.equal(result.sourcePath, source); assert.equal(result.scale, 2); assert.equal(result.enabled, true);
    assert.equal(await grants.assert(result.path), result.path); assert.equal(upscaler.active, false); assert.ok(progress.includes(1));
    await upscaler.dispose(); assert.equal((await fs.stat(result.path)).isFile(), true);
    process.stdout.write(JSON.stringify({ passed: ["actual production wrapper invokes genuine CoreML helper", "native manifest and current source SHA validation", "derived asset grants and successful handoff", "completed progress and disposal preserve published media"], width: result.width, height: result.height, duration: result.duration, sourceStartTime: result.sourceStartTime, sourceSHA256: result.sourceSHA256, modelSHA256: result.modelSHA256, modelName: result.modelName, completedTaskElapsedSeconds: (performance.now() - start) / 1000 }) + "\n");
  } finally {
    try { await upscaler.dispose(); } catch (error) { process.stderr.write(`Owned resources retained for cleanup: ${directory}\n`); throw error; }
    await fs.rm(directory, { recursive: true });
  }
})().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
