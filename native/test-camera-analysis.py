#!/usr/bin/env python3
"""Real AVFoundation/Vision/PCM verification; source screenshot is retained evidence.

Usage: python3 test-camera-analysis.py /path/to/reva-capture [ffmpeg]
Writes only a fresh temporary directory; does not touch original screenshots/media.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

helper = Path(sys.argv[1]).resolve()
ffmpeg = sys.argv[2] if len(sys.argv) > 2 else shutil.which("ffmpeg")
assert ffmpeg, "This opt-in test needs an existing ffmpeg; it never installs dependencies."
root = Path(__file__).resolve().parents[3]
portrait = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
assert portrait and portrait.is_file(), "Supply an explicitly selected face image as the third argument."

with tempfile.TemporaryDirectory(prefix="reva-camera-analysis-") as folder:
    folder = Path(folder)
    camera = folder / "moving-face.mp4"
    subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=10:d=4",
                    "-loop", "1", "-i", str(portrait), "-f", "lavfi", "-i",
                    r"aevalsrc=if(between(t\,1\,3)\,0\,0.25*sin(2*PI*440*t)):s=8000:d=4",
                    "-filter_complex", "[1:v]scale=300:300:force_original_aspect_ratio=increase,crop=300:300[face];[0:v][face]overlay=x='if(lt(t,2),20,320)':y=30:shortest=1[v]",
                    "-map", "[v]", "-map", "2:a", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(camera)], check=True)
    blank = folder / "blank.mp4"
    subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(blank)], check=True)

    def run(source, output, faces=True, silence=False, cancel=False):
        args = [str(helper), "analyze-camera", "--input", str(source), "--output", str(output), "--faces", str(faces).lower(), "--silence", str(silence).lower()]
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        events = []
        start = time.monotonic()
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

    output = folder / "measured.json"
    status, events, stderr, elapsed = run(camera, output, silence=True)
    assert status == 0, (events, stderr)
    result = json.loads(output.read_text())
    track, silence = result["faceTrack"], result["silence"]
    expected = hashlib.sha256(camera.read_bytes()).hexdigest()
    assert track["source"]["sha256"] == expected == silence["source"]["sha256"]
    assert (track["source"]["width"], track["source"]["height"]) == (640, 360)
    detected = [sample for sample in track["samples"] if sample["face"] is not None]
    assert len(detected) >= 12, detected
    first = next(sample for sample in detected if sample["t"] < 1)
    last = next(sample for sample in reversed(detected) if sample["t"] > 3)
    assert first["face"]["x"] < .4 < last["face"]["x"], (first, last)
    assert abs(last["face"]["x"] - first["face"]["x"] - 300 / 640) < .05
    assert all(0 <= sample["face"]["y"] < 1 for sample in detected)
    assert len(silence["intervals"]) == 1, silence
    quiet = silence["intervals"][0]
    assert abs(quiet["start"] - 1) < .08 and abs(quiet["end"] - 3) < .08, quiet

    shifted = folder / "camera-leading-gap.mp4"
    subprocess.run([ffmpeg, "-v", "error", "-itsoffset", "0.25", "-i", str(camera), "-map", "0:v", "-map", "0:a", "-c", "copy", str(shifted)], check=True)
    shifted_output = folder / "camera-leading-gap.json"
    status, events, stderr, _ = run(shifted, shifted_output)
    assert status == 0, (events, stderr)
    shifted_track = json.loads(shifted_output.read_text())["faceTrack"]
    first_covered = shifted_track["coverage"]["intervals"][0]["start"]
    assert first_covered >= .24, first_covered
    assert shifted_track["samples"][0]["t"] >= first_covered
    assert any(sample["face"] for sample in shifted_track["samples"])

    empty = folder / "no-face.json"
    status, events, stderr, _ = run(blank, empty)
    assert status == 0, (events, stderr)
    assert all(sample["face"] is None for sample in json.loads(empty.read_text())["faceTrack"]["samples"])
    absent = folder / "no-audio.json"
    status, events, stderr, _ = run(blank, absent, faces=True, silence=True)
    assert status != 0 and not absent.exists() and any(event.get("type") == "error" for event in events)
    cancelled = folder / "cancelled.json"
    status, events, stderr, _ = run(camera, cancelled, silence=True, cancel=True)
    assert status == 130 and not cancelled.exists() and any(event.get("type") == "cancelled" for event in events), (status, events, stderr)
    conflict = folder / "existing.json"
    conflict.write_text("keep original")
    status, events, stderr, _ = run(camera, conflict)
    assert status != 0 and conflict.read_text() == "keep original"
    print(json.dumps({"passed": ["real Apple Vision positive face detection and source-space movement", "leading camera empty edit remains uncovered", "explicit no-face samples", "real PCM tone/silence boundaries", "source SHA256 provenance", "missing audio remains unavailable", "cancellation prevents publication", "existing output preserved"], "faceSamples": len(track["samples"]), "detectedFaces": len(detected), "quietRange": quiet, "leadingGapCoverageStart": first_covered, "completedTaskElapsedSeconds": elapsed, "unverified": ["reference application's proprietary face model equivalence", "camera interaction UI", "every camera codec and orientation"]}))
