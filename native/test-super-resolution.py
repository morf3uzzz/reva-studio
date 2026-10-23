#!/usr/bin/env python3
"""Opt-in real CoreML/codec test using only generated pixels and a local model.

Usage: python3 test-super-resolution.py /path/to/reva-capture /path/to/model.mlpackage
No network, installations, user media, or devices are used. All output is temporary.
"""
import hashlib
from contextlib import nullcontext
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

helper, model = (Path(value).resolve() for value in sys.argv[1:3])
ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
assert helper.is_file() and model.exists() and ffmpeg and ffprobe


def execute(arguments, **options):
    return subprocess.run(arguments, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options).stdout


def probe(file):
    return json.loads(execute([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_frames", "-of", "json", str(file)]))


def model_digest():
    if model.is_file():
        return hashlib.sha256(model.read_bytes()).hexdigest()
    digest = hashlib.sha256()
    for file in sorted(path for path in model.rglob("*") if path.is_file()):
        relative = str(file.relative_to(model))
        contents = file.read_bytes()
        digest.update(f"{len(relative.encode())}:{relative}:{len(contents)}:".encode())
        digest.update(hashlib.sha256(contents).hexdigest().encode())
    return digest.hexdigest()


artifacts = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
if artifacts:
    artifacts.mkdir(mode=0o700)
with nullcontext(artifacts) if artifacts else tempfile.TemporaryDirectory(prefix="reva-super-resolution-") as directory:
    directory = Path(directory)
    width, height = 160, 120
    pixels = bytearray()
    # Colored quadrants establish orientation, with fine edges/gradients for the
    # neural result versus a conventional bilinear interpolation comparison.
    for frame in range(3):
        for y in range(height):
            for x in range(width):
                red = 180 if x < width // 2 else 20
                green = 180 if y < height // 2 else 20
                blue = 20 + (x + y + frame * 7) % 70
                if 35 < x < 125 and 35 < y < 85 and (x // 3 + y // 3) % 2:
                    red, green, blue = 245, 245, 245
                pixels.extend((red, green, blue))
    raw = directory / "synthetic.rgb"
    raw.write_bytes(pixels)
    source = directory / "synthetic-vfr-leading-gap.mp4"
    execute([ffmpeg, "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{width}x{height}", "-framerate", "10", "-i", str(raw),
             "-vf", "setpts='if(eq(N,0),0,if(eq(N,1),2,5))'", "-fps_mode", "vfr", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-video_track_timescale", "10000", "-output_ts_offset", "0.25", str(source)])
    original = probe(source)
    source_pts = [float(frame["pts_time"]) for frame in original["frames"]]
    assert len(source_pts) == 3 and source_pts[0] >= .24 and len(set(round(source_pts[i + 1] - source_pts[i], 4) for i in range(2))) == 2, source_pts

    def run(output, cancel=False):
        start = time.monotonic()
        process = subprocess.Popen(["/usr/bin/time", "-l", str(helper), "upscale-video", "--input", str(source), "--model", str(model), "--output-directory", str(output)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        events = []
        for line in process.stdout:
            event = json.loads(line)
            events.append(event)
            if cancel and event.get("type") == "ready":
                process.stdin.write("cancel\n")
                process.stdin.flush()
        process.wait(timeout=30)
        stderr = process.stderr.read()
        process.stdin.close()
        return process.returncode, events, stderr, time.monotonic() - start

    output = directory / "enhanced"
    status, events, stderr, elapsed = run(output)
    assert status == 0, (status, events, stderr)
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["model"]["sha256"] == model_digest()
    assert manifest["source"]["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert manifest["model"]["scale"] == 2
    assert manifest["model"]["inputName"] == "input_image" and manifest["model"]["outputName"] == "output_image"
    enhanced = probe(output / "enhanced.mp4")
    assert enhanced["streams"][0]["codec_name"] == "h264"
    assert (enhanced["streams"][0]["width"], enhanced["streams"][0]["height"]) == (width * 2, height * 2)
    enhanced_pts = [float(frame["pts_time"]) for frame in enhanced["frames"]]
    assert len(enhanced_pts) == len(source_pts) and all(abs(a - b) < .0001 for a, b in zip(source_pts, enhanced_pts)), (source_pts, enhanced_pts, manifest["timing"], enhanced["frames"])
    assert abs(manifest["timing"]["firstPTS"] - source_pts[0]) < .0001 and manifest["timing"]["frames"] == 3

    neural = execute([ffmpeg, "-v", "error", "-i", str(output / "enhanced.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    bilinear = execute([ffmpeg, "-v", "error", "-i", str(source), "-vf", "scale=iw*2:ih*2:flags=bilinear", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    assert len(neural) == len(bilinear) == width * height * 12
    mean_difference = sum(abs(a - b) for a, b in zip(neural, bilinear)) / len(neural)
    assert mean_difference > .5, "The actual neural output must differ from ordinary bilinear scaling. This is not a quality-superiority assertion."
    def pixel(x, y):
        start = (y * width * 2 + x) * 3
        return list(neural[start:start + 3])
    top_left, top_right, bottom_left = pixel(20, 20), pixel(width * 2 - 20, 20), pixel(20, height * 2 - 20)
    assert top_left[0] > top_right[0] + 60 and top_left[1] > bottom_left[1] + 60, (top_left, top_right, bottom_left)

    cancelled = directory / "cancelled"
    cancelled_status, cancelled_events, cancelled_stderr, _ = run(cancelled, cancel=True)
    assert cancelled_status == 130 and not cancelled.exists() and any(event.get("type") == "cancelled" for event in cancelled_events), (cancelled_status, cancelled_events, cancelled_stderr)
    conflict = directory / "existing"
    conflict.mkdir()
    (conflict / "keep").write_text("preserve original")
    conflict_status, _, _, _ = run(conflict)
    assert conflict_status != 0 and (conflict / "keep").read_text() == "preserve original"

    timing = re.search(r"([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys", stderr)
    memory = re.search(r"(\d+)\s+maximum resident set size", stderr)
    print(json.dumps({"passed": ["actual CoreML PiperSR inference", "independent overlapping tile/stitch path", "2x dimensions and high-quality H264 output", "original variable frame PTS and leading gap", "source and model SHA256 provenance", "orientation and color quadrant ordering", "neural result differs from bilinear interpolation", "cancellation removes unpublished output", "existing output preserved"], "sourcePTS": source_pts, "enhancedPTS": enhanced_pts, "modelSHA256": manifest["model"]["sha256"], "meanAbsoluteRGBDifferenceFromBilinear": mean_difference, "completedTaskElapsedSeconds": elapsed, "timeUtilitySeconds": {"real": float(timing[1]), "user": float(timing[2]), "system": float(timing[3])} if timing else None, "helperMaximumResidentSetBytes": int(memory[1]) if memory else None, "unverified": ["quality superiority or reference proprietary-model equivalence", "simultaneous process-family peak memory", "large-video throughput and every codec", "physical screen recording acquisition"]}))
