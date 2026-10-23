"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { AudioLibrary, ORIGINAL_TRACKS, SAMPLE_RATE } = require("./audio-library.cjs");
const { MediaGrants } = require("./media.cjs");

test("local original music is audible, deterministic, bounded WAV and reusable without rewrites", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-original-music-"));
  const grants = new MediaGrants(), library = new AudioLibrary({ root, grants });
  t.after(async () => { try { await library.dispose(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  const first = library.list();
  assert.equal(library.list(), first, "Concurrent callers share one synthesis pass");
  const assets = await first;
  assert.equal(assets.length, 3);
  const fingerprints = [], timestamps = [];
  for (const asset of assets) {
    assert.equal(await grants.assert(asset.path), asset.path);
    const audio = await fs.readFile(asset.path), stat = await fs.stat(asset.path);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF"); assert.equal(audio.toString("ascii", 8, 12), "WAVE");
    assert.equal(audio.readUInt16LE(22), 2); assert.equal(audio.readUInt32LE(24), SAMPLE_RATE); assert.equal(audio.readUInt16LE(34), 16);
    assert.equal(audio.length, 44 + 32 * SAMPLE_RATE * 4);
    let squares = 0, peak = 0;
    for (let offset = 44; offset < audio.length; offset += 128) { const sample = audio.readInt16LE(offset) / 32768; squares += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
    assert.ok(Math.sqrt(squares / Math.ceil((audio.length - 44) / 128)) > .01, "Original track has meaningful audible energy");
    assert.ok(peak < .9, "Synthesis never clips");
    assert.equal(audio.readInt16LE(44), 0, "Loop starts smoothly at zero");
    fingerprints.push(crypto.createHash("sha256").update(audio).digest("hex")); timestamps.push(stat.mtimeMs);
  }
  assert.equal(new Set(fingerprints).size, 3, "Each original arrangement has distinct samples");
  const warm = await library.list(); assert.deepEqual(warm, assets);
  for (const [index, asset] of assets.entries()) assert.equal((await fs.stat(asset.path)).mtimeMs, timestamps[index]);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith(".tmp")), false);
  // A missing sidecar is repaired only after exact regenerated audio matches.
  await fs.unlink(path.join(root, `${ORIGINAL_TRACKS[0].id}.json`));
  await library.list();
  assert.equal(crypto.createHash("sha256").update(await fs.readFile(assets[0].path)).digest("hex"), fingerprints[0]);
  // Verify the actual local decoder sees usable 32-second stereo PCM.
  const ffprobe = spawnSync(process.env.REVA_TEST_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=channels,sample_rate", "-of", "json", assets[0].path]);
  if (!ffprobe.error) {
    assert.equal(ffprobe.status, 0, ffprobe.stderr.toString()); const parsed = JSON.parse(ffprobe.stdout.toString());
    assert.equal(Number(parsed.format.duration), 32); assert.equal(parsed.streams[0].channels, 2);
  }
});

test("original music cache refuses replacements and preserves unrelated local files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-original-conflict-"));
  const library = new AudioLibrary({ root, grants: new MediaGrants() });
  t.after(async () => { try { await library.dispose(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  const target = path.join(root, `${ORIGINAL_TRACKS[0].id}.wav`);
  await fs.writeFile(target, "User audio at this path must survive");
  await assert.rejects(library.list(), /changed/);
  assert.equal(await fs.readFile(target, "utf8"), "User audio at this path must survive");
  assert.equal((await fs.readdir(root)).some(name => name.endsWith(".tmp")), false);
});
