"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { getWaveform } = require("./waveform.cjs");
const { MediaGrants, findTool, runProcess } = require("./media.cjs");

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-waveform-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function binaries() {
  return { ffmpeg: await findTool("ffmpeg"), ffprobe: await findTool("ffprobe") };
}
const average = (array) => array.reduce((a, b) => a + b, 0) / array.length;
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

test("real audio waveform preserves quiet/loud/silent regions on the source clock", async (t) => {
  const root = await temporary(t), tools = await binaries(), file = path.join(root, "levels.wav");
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "aevalsrc='if(lt(t,1),0.1*sin(2*PI*440*t),if(lt(t,2),0.8*sin(2*PI*220*t),0))':s=48000:d=3", "-c:a", "pcm_s16le", file]);
  const grants = new MediaGrants(); await grants.grant(file);
  const result = await getWaveform(file, { ...tools, grants });
  assert.equal(result.duration, 3);
  assert.ok(result.peaks instanceof Float32Array);
  assert.equal(result.peaks.length, 2400);
  assert.ok(result.peaks.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  const third = result.peaks.length / 3;
  const quiet = average(result.peaks.slice(10, third - 10));
  const loud = average(result.peaks.slice(third + 10, third * 2 - 10));
  const silent = Math.max(...result.peaks.slice(third * 2 + 10));
  assert.ok(quiet > 0.1 && quiet < 0.2, `quiet amplitude ${quiet}`);
  assert.ok(loud > 0.9 && loud / quiet > 6, `loud amplitude ${loud}`);
  assert.ok(silent < 0.001, `silent amplitude ${silent}`);
});

test("seekable granted MP4 decoding and silent video have distinct results", async (t) => {
  const root = await temporary(t), tools = await binaries(), audioVideo = path.join(root, "tail-moov.mp4"), silentVideo = path.join(root, "silent.mp4");
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-t", "1", audioVideo]);
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", audioVideo, "-map", "0:v", "-c", "copy", silentVideo]);
  const grants = new MediaGrants(); await grants.grant(audioVideo); await grants.grant(silentVideo);
  const audio = await getWaveform(audioVideo, { ...tools, grants });
  assert.ok(audio.peaks.some((value) => value > 0.9));
  assert.deepEqual(await getWaveform(silentVideo, { ...tools, grants }), { duration: 1, peaks: new Float32Array(0) });
});

test("phase-opposed stereo and high frequencies retain their actual envelope", async (t) => {
  const root = await temporary(t), tools = await binaries(), file = path.join(root, "stereo.wav");
  const sample = "if(lt(t,1),0.2*sin(2*PI*440*t),if(lt(t,2),0.8*sin(2*PI*12000*t),0))";
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", `aevalsrc='${sample}|-(${sample})':s=48000:d=3`, "-c:a", "pcm_f32le", file]);
  const grants = new MediaGrants(); await grants.grant(file);
  const { peaks } = await getWaveform(file, { ...tools, grants });
  const quiet = average(peaks.slice(10, 790)), high = average(peaks.slice(810, 1590));
  assert.ok(quiet > .23 && quiet < .27, `quiet stereo envelope ${quiet}`);
  assert.ok(high > .99, `12 kHz energy retained: ${high}`);
  assert.ok(peaks.slice(1610).every(value => value === 0));
});

test("a minute-long recording keeps separate five-millisecond transients beyond the old bin limit", async (t) => {
  const root = await temporary(t), tools = await binaries(), file = path.join(root, "transients.wav");
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "aevalsrc='if(between(t,40,40.005)+between(t,40.015,40.02),0.8*sin(2*PI*1000*t),0)':s=48000:d=60", "-c:a", "pcm_s16le", file]);
  const grants = new MediaGrants(); await grants.grant(file);
  const started = performance.now();
  const { duration, peaks } = await getWaveform(file, { ...tools, grants });
  t.diagnostic(`60s waveform: ${Math.round(performance.now() - started)}ms, ${peaks.byteLength} envelope bytes`);
  assert.equal(duration, 60); assert.equal(peaks.length, 48000);
  assert.ok(peaks.slice(32000, 32004).every(value => value > .99));
  assert.ok(peaks.slice(32006, 32010).every(value => value === 0), "separate impulses do not merge into a plateau");
  assert.ok(peaks.slice(32012, 32016).every(value => value > .99));
  assert.ok(peaks.slice(0, 31999).every(value => value === 0));
  assert.ok(peaks.slice(32017).every(value => value === 0));
});

test("waveform requires a current local media grant and rejects renamed replacements", async (t) => {
  const root = await temporary(t), tools = await binaries(), file = path.join(root, "source.wav"), grants = new MediaGrants();
  await fs.writeFile(file, "not-media");
  await assert.rejects(getWaveform(file, { ...tools, grants }), /not been selected/);
  await grants.grant(file);
  await fs.rename(file, path.join(root, "old.wav")); await fs.writeFile(file, "replacement");
  await assert.rejects(getWaveform(file, { ...tools, grants }), /changed/);
});

test("cancellation terminates the owned decoder, closes resources and allows retry", async (t) => {
  const root = await temporary(t), tools = await binaries(), file = path.join(root, "long.wav");
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=60", "-c:a", "pcm_s16le", file]);
  const wrapper = path.join(root, "ffmpeg-realtime"), pidFile = path.join(root, "decoder.pid");
  await fs.writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${shellQuote(pidFile)}\nexec ${shellQuote(tools.ffmpeg)} -re "$@"\n`, { mode: 0o700 });
  const grants = new MediaGrants(); await grants.grant(file);
  const controller = new AbortController();
  const pending = getWaveform(file, { ...tools, ffmpeg: wrapper, grants, signal: controller.signal });
  let premature;
  pending.then(() => { premature = new Error("Decoder completed before cancellation."); }, (error) => { premature = error; });
  const waitStarted = performance.now();
  try {
    while (true) {
      try { await fs.access(pidFile); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (premature) throw premature;
      if (performance.now() - waitStarted > 5000) throw new Error("Decoder did not start.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) {
    controller.abort(); await pending.catch(() => {}); throw error;
  }
  const started = performance.now();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError", code: "ABORT_ERR" });
  assert.ok(performance.now() - started < 3000, "cancellation should not wait for real-time playback");
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned decoder has exited before cancellation resolves");
  const result = await getWaveform(file, { ...tools, grants });
  assert.equal(result.peaks.length, 48000);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(getWaveform(file, { ...tools, grants, signal: alreadyAborted.signal }), { name: "AbortError" });
});

test("in-place source changes during decoding invalidate the waveform", async (t) => {
  const root = await temporary(t), tools = await binaries(), file = path.join(root, "source.wav");
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=0.4", "-c:a", "pcm_s16le", file]);
  const wrapper = path.join(root, "ffmpeg-realtime");
  await fs.writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(tools.ffmpeg)} -re "$@"\n`, { mode: 0o700 });
  const grants = new MediaGrants(); await grants.grant(file);
  const task = getWaveform(file, { ...tools, ffmpeg: wrapper, grants });
  const mutation = new Promise((resolve, reject) => setTimeout(() => fs.utimes(file, new Date(), new Date(Date.now() + 10000)).then(resolve, reject), 120));
  await assert.rejects(task, /changed during waveform/);
  await mutation;
});
