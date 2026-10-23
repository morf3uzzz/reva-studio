"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  validateProject,
  readPortableProject,
  writePortableProject,
  portableAssetPath,
  parseByteRange,
  validateExport,
  tempoFilters,
  buildEncoderArgs,
  validatePng,
} = require("./core.cjs");
const {
  MediaGrants,
  mediaResponse,
  findTool,
  runProcess,
  probe,
} = require("./media.cjs");
const { Exporter } = require("./exporter.cjs");
const { Capture, parseSources } = require("./capture.cjs");

function project(mediaPath = null) {
  return {
    version: 1,
    name: "Example",
    mediaPath,
    cameraPath: null,
    microphonePath: null,
    duration: 3,
    width: 16,
    height: 16,
    trimStart: 0.5,
    trimEnd: 2.5,
    speed: 2,
    appearance: {
      backgroundKind: "gradient",
      background: "#151515",
      gradient: 0,
      wallpaper: 0,
      image: null,
      blur: 0,
      padding: 0.1,
      radius: 16,
      shadow: 0.3,
      inset: 0,
      aspect: "auto",
      cursorSize: 36,
      cursorHidden: false,
      cursorSmooth: true,
      cursorHideIdle: true,
      clickEffect: "circle",
      cameraSize: 0.22,
      cameraRadius: 100,
      cameraX: 0.85,
      cameraY: 0.8,
      cameraMirror: true,
      cameraHidden: false,
      volume: 0.7,
      microphoneVolume: 1,
      cameraVolume: 0,
      fadeIn: 0.1,
      fadeOut: 0.2,
      zoomDuration: 0.55,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    },
    zooms: [
      { id: "z1", start: 1, end: 2, scale: 2, x: 0.5, y: 0.5, mode: "manual" },
    ],
    cursor: [
      { t: 0, x: 0.5, y: 0.5, click: false, visible: true },
      { t: 0.5, x: 0.6, y: 0.7, click: true, visible: false },
    ],
    captions: [
      {
        id: "caption",
        text: "Hello",
        start: 0.5,
        end: 2,
        x: 0.5,
        y: 0.8,
        size: 40,
        color: "#ffffff",
      },
    ],
  };
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height) {
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([length, t, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 4 + 1) + 1 + x * 4;
      pixels[i] = 120;
      pixels[i + 1] = 60;
      pixels[i + 2] = 200;
      pixels[i + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reva-backend-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("project validation preserves cursor visibility and rejects malformed boundaries", () => {
  assert.equal(validateProject(project()).cursor[1].visible, false);
  for (const mutation of [
    (p) => (p.speed = NaN),
    (p) => (p.appearance.crop.x = 0.5),
    (p) => (p.appearance.volume = 2),
    (p) => (p.cursor[1].t = -0.1),
    (p) => (p.zooms[0].end = 4),
    (p) => (p.version = 2),
    (p) => (p.mediaPath = {}),
  ]) {
    const p = project();
    mutation(p);
    assert.throws(() => validateProject(p));
  }
  const parsed = validateProject({ ...project(), unknown: "dropped" });
  assert.equal(Object.hasOwn(parsed, "unknown"), false);
});

test("portable assets cannot use URL, absolute, traversal or ambiguous separators", () => {
  for (const value of [
    "https://example.com/a.mp4",
    "/tmp/a.mp4",
    "../a.mp4",
    "assets/../../a.mp4",
    "assets\\video.mp4",
    "./video.mp4",
    "file:///tmp/file",
    "assets//video.mp4",
  ])
    assert.throws(() => portableAssetPath("/tmp/projects", value));
  assert.equal(
    portableAssetPath("/tmp/projects", "example.assets/video.mp4"),
    "/tmp/projects/example.assets/video.mp4",
  );
});

test("portable save copies local assets, reopens after source removal, and retains a backup", async (t) => {
  const dir = await temporary(t);
  const source = path.join(dir, "source.mp4");
  const outDir = path.join(dir, "Project");
  await fs.mkdir(outDir);
  await fs.writeFile(source, "local video bytes");
  const grants = new MediaGrants();
  await grants.grant(source);
  const file = path.join(outDir, "demo.revastudio");
  const p = project(source);
  await writePortableProject(file, p, (f) => grants.assert(f));
  const saved = JSON.parse(await fs.readFile(file));
  assert.equal(path.isAbsolute(saved.mediaPath), false);
  assert.equal(
    await fs.readFile(path.resolve(outDir, saved.mediaPath), "utf8"),
    "local video bytes",
  );
  p.name = "Changed";
  await writePortableProject(file, p, (f) => grants.assert(f));
  assert.equal(JSON.parse(await fs.readFile(`${file}.bak`)).name, "Example");
  await fs.unlink(source);
  const reopened = await readPortableProject(file);
  assert.equal(reopened.name, "Changed");
  assert.equal(
    await fs.readFile(reopened.mediaPath, "utf8"),
    "local video bytes",
  );
  assert.deepEqual(reopened.cursor, p.cursor);
});

test("portable open rejects symlinks that escape the selected project directory", async (t) => {
  const dir = await temporary(t);
  const outside = path.join(dir, "private.mp4");
  const root = path.join(dir, "Project");
  await fs.mkdir(root);
  await fs.writeFile(outside, "private");
  await fs.symlink(outside, path.join(root, "escape.mp4"));
  const file = path.join(root, "unsafe.revastudio");
  await fs.writeFile(file, JSON.stringify(project("escape.mp4")));
  await assert.rejects(readPortableProject(file), /outside/);
});

test("saving a backup replaces a symlink without following it", async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, "project.revastudio");
  const outside = path.join(dir, "unrelated.txt");
  await fs.writeFile(outside, "keep this");
  await fs.writeFile(file, JSON.stringify(project()));
  await fs.symlink(outside, `${file}.bak`);
  await writePortableProject(file, project(), async () => {
    throw new Error("No assets expected.");
  });
  assert.equal(await fs.readFile(outside, "utf8"), "keep this");
  assert.equal((await fs.lstat(`${file}.bak`)).isSymbolicLink(), false);
});

test("media grants prevent arbitrary reads and revocation-by-replacement, with correct streaming ranges", async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, "video.mp4");
  await fs.writeFile(file, "0123456789");
  const grants = new MediaGrants();
  const url = `reva-media://asset/?path=${encodeURIComponent(file)}`;
  assert.equal((await mediaResponse(new Request(url), grants)).status, 404);
  await grants.grant(file);
  const partial = await mediaResponse(
    new Request(url, { headers: { Range: "bytes=2-5" } }),
    grants,
  );
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");
  const suffix = await mediaResponse(
    new Request(url, { headers: { Range: "bytes=-3" } }),
    grants,
  );
  assert.equal(await suffix.text(), "789");
  const invalid = await mediaResponse(
    new Request(url, { headers: { Range: "bytes=99-" } }),
    grants,
  );
  assert.equal(invalid.status, 416);
  const head = await mediaResponse(
    new Request(url, { method: "HEAD" }),
    grants,
  );
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  await fs.rename(file, `${file}.old`);
  await fs.writeFile(file, "replacement");
  assert.equal((await mediaResponse(new Request(url), grants)).status, 404);
});

test("byte ranges and PNGs reject malformed or oversized input", () => {
  assert.deepEqual(parseByteRange("bytes=5-999", 10), { start: 5, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-999", 10), { start: 0, end: 9 });
  for (const range of [
    "bytes=0-1,5-6",
    "bytes=-0",
    "bytes=5-4",
    "bytes=-",
    "bytes=9007199254740992-",
  ])
    assert.throws(() => parseByteRange(range, 10));
  assert.equal(validatePng(png(16, 16), 16, 16).length > 0, true);
  assert.throws(() => validatePng(png(16, 16), 20, 16), /dimensions/);
  assert.throws(
    () => validatePng(png(16, 16).subarray(0, 45), 16, 16),
    /truncated|incomplete/,
  );
  assert.throws(() => validatePng(Buffer.from("not png"), 16, 16), /PNG/);
});

test("encoder command preserves trim, speed, independent mix volumes, fades and strict frame count", () => {
  const options = {
    format: "mp4",
    fps: 30,
    width: 1920,
    height: 1080,
    quality: "balanced",
    project: project("/selected/video.mp4"),
  };
  const validated = validateExport(options);
  assert.equal(validated.frameCount, 30);
  assert.equal(validated.duration, 1);
  const args = buildEncoderArgs(options, "/selected/output.mp4", [
    { path: "/selected/video.mp4", volume: 0.7 },
    { path: "/selected/mic.m4a", volume: 1 },
  ]);
  const filters = args[args.indexOf("-filter_complex") + 1];
  assert.match(
    filters,
    /atrim=start=0.5:end=2.5,asetpts=PTS-STARTPTS,atempo=2,volume=0.7/,
  );
  assert.match(filters, /afade=t=in:st=0:d=0.1/);
  assert.match(filters, /afade=t=out:st=0.8:d=0.2/);
  assert.match(filters, /amix=inputs=2:duration=longest:normalize=0/);
  assert.equal(args[args.indexOf("-frames:v") + 1], "30");
  assert.deepEqual(tempoFilters(0.125), [
    "atempo=0.5",
    "atempo=0.5",
    "atempo=0.5",
  ]);
  assert.deepEqual(tempoFilters(8), ["atempo=2", "atempo=2", "atempo=2"]);
});

test("real multi-slice export removes the middle audio and changes the last slice speed", async (t) => {
  const dir = await temporary(t);
  const ffmpeg = await findTool("ffmpeg"),
    ffprobe = await findTool("ffprobe");
  const source = path.join(dir, "tones.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=size=16x16:rate=10:duration=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2:sample_rate=48000",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=1:sample_rate=48000",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=3:sample_rate=48000",
    "-filter_complex",
    "[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]",
    "-map",
    "0:v",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-y",
    source,
  ]);
  const p = project(source);
  Object.assign(p, {
    duration: 6,
    trimStart: 0,
    trimEnd: 6,
    speed: 1,
    slices: [
      { id: "first", start: 0, end: 2, speed: 1, volume: 1 },
      { id: "last", start: 3, end: 6, speed: 2, volume: 0.5 },
    ],
  });
  Object.assign(p.appearance, { volume: 1, fadeIn: 0, fadeOut: 0 });
  const grants = new MediaGrants();
  await grants.grant(source);
  const exporter = new Exporter({ grants, ffmpeg, ffprobe });
  t.after(() => exporter.dispose());
  const destination = path.join(dir, "montage.mp4");
  const options = {
    project: p,
    format: "mp4",
    fps: 10,
    width: 16,
    height: 16,
    quality: "high",
  };
  assert.equal(validateExport(options).frameCount, 35);
  const session = await exporter.start(options, async () => destination);
  for (let i = 0; i < 35; i++) await exporter.frame(session.id, png(16, 16));
  await exporter.finish(session.id);
  const media = await probe(destination, ffprobe);
  assert.ok(Math.abs(media.duration - 3.5) < 0.05);
  const pcm = path.join(dir, "audio.f32");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    destination,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "-y",
    pcm,
  ]);
  const bytes = await fs.readFile(pcm);
  const readTone = (seconds) => {
    const start = Math.round(seconds * 48000),
      count = 4800;
    let crossings = 0,
      squares = 0,
      previous = bytes.readFloatLE(start * 4);
    for (let i = start + 1; i < start + count; i++) {
      const value = bytes.readFloatLE(i * 4);
      if (previous <= 0 && value > 0) crossings++;
      squares += value * value;
      previous = value;
    }
    return { frequency: crossings * 10, rms: Math.sqrt(squares / count) };
  };
  const first = readTone(0.5),
    last = readTone(2.5);
  assert.ok(Math.abs(first.frequency - 440) <= 10);
  assert.ok(Math.abs(last.frequency - 220) <= 10);
  assert.ok(last.rms / first.rms > 0.4 && last.rms / first.rms < 0.6);
});

test("capture source identities reject duplicates and mismatched source kinds", () => {
  assert.deepEqual(
    parseSources([
      {
        id: "display:1",
        name: "Display",
        kind: "display",
        width: 1920,
        height: 1080,
      },
    ])[0].id,
    "display:1",
  );
  assert.throws(
    () =>
      parseSources([
        {
          id: "window:1",
          name: "Display",
          kind: "display",
          width: 1920,
          height: 1080,
        },
      ]),
    /identity/,
  );
});

test(
  "real FFmpeg export produces trimmed video+audio, GIF, cancellation and cleanup retry preserve destinations",
  { timeout: 30000 },
  async (t) => {
    let ffmpeg, ffprobe;
    try {
      ffmpeg = await findTool("ffmpeg");
      ffprobe = await findTool("ffprobe");
    } catch {
      t.skip("FFmpeg/ffprobe are not installed.");
      return;
    }
    const dir = await temporary(t);
    const source = path.join(dir, "source.mp4");
    await runProcess(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=16x16:r=6:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ]);
    const grants = new MediaGrants();
    await grants.grant(source);
    const exporter = new Exporter({ grants, ffmpeg, ffprobe });
    t.after(() => exporter.dispose());
    const options = {
      format: "mp4",
      fps: 6,
      width: 16,
      height: 16,
      quality: "balanced",
      project: project(source),
    };
    const output = path.join(dir, "result.mp4");
    const result = await exporter.start(options, async () => output);
    assert.ok(result.id);
    await assert.rejects(
      exporter.start(options, async () => output),
      /already active/,
    );
    await assert.rejects(exporter.finish(result.id), /incomplete/);
    for (let i = 0; i < 6; i++) await exporter.frame(result.id, png(16, 16));
    await assert.rejects(exporter.frame(result.id, png(16, 16)), /Too many/);
    const actualCleanup = exporter.cleanup.bind(exporter);
    let failOnce = true;
    exporter.cleanup = async (s) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Simulated cleanup failure");
      }
      return actualCleanup(s);
    };
    await assert.rejects(exporter.finish(result.id), /cleanup failure/);
    assert.equal(exporter.active, true);
    assert.equal(await exporter.finish(result.id), output);
    assert.equal(exporter.active, false);
    const info = await probe(output, ffprobe);
    assert.equal(info.width, 16);
    assert.equal(info.hasAudio, true);
    assert.ok(Math.abs(info.duration - 1) < 0.2);
    const color = JSON.parse(
      await runProcess(ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=color_range,color_space,color_transfer,color_primaries,pix_fmt",
        "-of",
        "json",
        output,
      ]),
    ).streams[0];
    assert.equal(color.color_range, "pc");
    assert.equal(color.color_space, "bt709");
    assert.equal(color.color_transfer, "bt709");
    assert.equal(color.color_primaries, "bt709");
    const oldOutput = await fs.readFile(output);
    const cancel = await exporter.start(options, async () => output);
    await exporter.cancel(cancel.id);
    await exporter.cancel(cancel.id);
    assert.deepEqual(await fs.readFile(output), oldOutput);
    assert.equal(
      (await fs.readdir(dir)).some((name) => name.startsWith(".reva-export-")),
      false,
    );
    const gifOutput = path.join(dir, "result.gif");
    const gif = await exporter.start(
      { ...options, format: "gif" },
      async () => gifOutput,
    );
    for (let i = 0; i < 6; i++) await exporter.frame(gif.id, png(16, 16));
    await exporter.finish(gif.id);
    assert.equal(
      (await fs.readFile(gifOutput)).subarray(0, 6).toString(),
      "GIF89a",
    );
    assert.ok(
      (await fs.readFile(gifOutput)).includes(Buffer.from("NETSCAPE2.0")),
    );
    const onceOutput = path.join(dir, "once.gif");
    const once = await exporter.start(
      { ...options, format: "gif", gifHighQuality: true, gifLoop: false },
      async () => onceOutput,
    );
    for (let i = 0; i < 6; i++) await exporter.frame(once.id, png(16, 16));
    await exporter.finish(once.id);
    assert.equal(
      (await fs.readFile(onceOutput)).includes(Buffer.from("NETSCAPE2.0")),
      false,
    );
    const proresOutput = path.join(dir, "result.mov");
    const prores = await exporter.start(
      { ...options, format: "prores" },
      async () => proresOutput,
    );
    for (let i = 0; i < 6; i++) await exporter.frame(prores.id, png(16, 16));
    await exporter.finish(prores.id);
    const codecs = JSON.parse(
      await runProcess(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,profile,pix_fmt,duration",
        "-of",
        "json",
        proresOutput,
      ]),
    );
    assert.equal(codecs.streams[0].codec_name, "prores");
    assert.equal(codecs.streams[0].profile, "HQ");
    assert.equal(codecs.streams[0].pix_fmt, "yuv422p10le");
    assert.equal(codecs.streams[1].codec_name, "pcm_s24le");
    assert.ok(Math.abs(Number(codecs.streams[0].duration) - 1) < 0.01);
    // Exercise the delivered alternative codec/profile through the production
    // exporter, and inspect real streams instead of only matching arguments.
    for (const [extension, settings, expectedCodec, expectedProfile] of [
      ["hevc.mp4", { format: "mp4", codec: "hevc" }, "hevc", "Main"],
      ["lt.mov", { format: "prores", proresProfile: "422-lt" }, "prores", "LT"],
      [
        "standard.mov",
        { format: "prores", proresProfile: "422" },
        "prores",
        "Standard",
      ],
      [
        "4444.mov",
        { format: "prores", proresProfile: "4444" },
        "prores",
        "4444",
      ],
    ]) {
      const destination = path.join(dir, extension);
      const alternative = await exporter.start(
        { ...options, width: 64, height: 64, ...settings },
        async () => destination,
      );
      for (let i = 0; i < 6; i++)
        await exporter.frame(alternative.id, png(64, 64));
      await exporter.finish(alternative.id);
      const metadata = JSON.parse(
        await runProcess(ffprobe, [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,codec_tag_string,profile,duration,nb_frames",
          "-of",
          "json",
          destination,
        ]),
      );
      assert.equal(metadata.streams[0].codec_name, expectedCodec);
      assert.equal(metadata.streams[0].profile, expectedProfile);
      assert.equal(metadata.streams[0].nb_frames, "6");
      assert.ok(Math.abs(Number(metadata.streams[0].duration) - 1) < 0.01);
      if (expectedCodec === "hevc")
        assert.equal(metadata.streams[0].codec_tag_string, "hvc1");
    }
    const playlist = path.join(dir, "playlist.m3u8");
    await fs.writeFile(playlist, "#EXTM3U\n#EXTINF:3,\nsource.mp4\n");
    await assert.rejects(probe(playlist, ffprobe), /Could not read/);
  },
);

test(
  "capture cancellation sends stop during startup and ignores a late ready handshake (simulated helper)",
  { timeout: 5000 },
  async (t) => {
    const dir = await temporary(t);
    const helper = path.join(dir, "helper");
    await fs.writeFile(
      helper,
      `#!${process.execPath}\nconst args=process.argv.slice(2);const output=args[args.indexOf('--output')+1],cursorOutput=args[args.indexOf('--cursor-output')+1];\nif(args[0]==='list'){console.log(JSON.stringify([{id:'display:1',name:'Test display',kind:'display',width:1920,height:1080}]));process.exit(0);}\nprocess.stdin.once('data',()=>{console.log(JSON.stringify({type:'ready',output,cursorOutput}));console.log(JSON.stringify({type:'error',code:'recording_cancelled',message:'Recording startup cancelled.'}));process.exit(1);});\nsetTimeout(()=>process.exit(2),3000);\n`,
      { mode: 0o755 },
    );
    let ready = false,
      idle = false;
    const capture = new Capture({
      helper,
      recordingRoot: path.join(dir, "recordings"),
      ffprobe: "/unused",
      grants: new MediaGrants(),
      onReady: () => {
        ready = true;
      },
      onIdle: () => {
        idle = true;
      },
    });
    const starting = capture.start({
      source: { id: "display:1" },
      fps: 30,
      systemAudio: false,
      microphone: false,
      camera: false,
    });
    const rejectedStart = assert.rejects(starting, /cancelled/);
    while (!capture.session)
      await new Promise((resolve) => setTimeout(resolve, 2));
    await assert.rejects(capture.stop(), /cancelled/);
    await rejectedStart;
    assert.equal(ready, false);
    assert.equal(idle, true);
    assert.equal(capture.active, false);
  },
);
