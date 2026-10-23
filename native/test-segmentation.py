#!/usr/bin/env python3
"""Real CLI lifecycle/media regressions; optional authorized short person video."""
import hashlib
import json
import pathlib
import selectors
import subprocess
import sys
import time

helper = pathlib.Path(sys.argv[1]).resolve()
directory = pathlib.Path(sys.argv[2]).resolve()
person = pathlib.Path(sys.argv[3]).resolve() if len(sys.argv) > 3 and sys.argv[3] else None
checks = []


def run(source, target, cancel=None, extra=(), on_event=None):
    args = [str(helper), "segment-camera", "--input", str(source), "--output-directory", str(target), *extra]
    stderr_path = directory / (target.name + ".stderr.log")
    with stderr_path.open("w") as stderr:
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)
        events = []
        deadline = time.monotonic() + 60
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        sent = False
        if cancel == "startup":
            process.stdin.write("cancel\n"); process.stdin.flush(); process.stdin.close(); sent = True
        try:
            while True:
                if time.monotonic() >= deadline:
                    raise AssertionError("Native segmentation exceeded 60 seconds")
                if not selector.select(0.5):
                    if process.poll() is not None:
                        break
                    continue
                line = process.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                events.append(event)
                if on_event:
                    on_event(event)
                assert len(events) <= 1000, "Unexpected event volume"
                if not sent and ((cancel == "active" and event.get("phase") == "segmenting") or (cancel == "finalizing" and event.get("phase") == "finalizing")):
                    process.stdin.write("stop\n"); process.stdin.flush(); process.stdin.close(); sent = True
            code = process.wait(timeout=10)
        finally:
            selector.close()
            if process.poll() is None:
                process.kill(); process.wait()
            if not process.stdin.closed:
                process.stdin.close()
        assert events, stderr_path.read_text()
        return code, events


def success(source, target, **kwargs):
    code, events = run(source, target, **kwargs)
    assert code == 0 and events[-1]["type"] == "completed", (code, events)
    assert events[0]["type"] == "ready"
    result = json.loads((target / "manifest.json").read_text())
    assert result["source"]["path"] == str(source)
    assert result["source"]["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert result["timing"]["frameCount"] == events[-1]["frames"]
    assert result["timing"]["duration"] == events[-1]["duration"]
    assert set(p.name for p in target.iterdir()) == {"manifest.json", "camera-mask.mp4"}
    return result


def probe(path):
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-show_frames", "-of", "json", str(path)], text=True))


synthetic = directory / "synthetic-vfr.mp4"
assert synthetic.is_file(), "Run the native fixture/semantics test first"
manifest = success(synthetic, directory / "vfr-mask")
assert manifest["timing"]["frameCount"] == 3 and abs(manifest["timing"]["duration"] - 0.5) < 1e-6
timestamps = [float(f["best_effort_timestamp_time"]) for f in probe(directory / "vfr-mask/camera-mask.mp4")["frames"]]
assert len(timestamps) == 3 and all(abs(a - b) < 1e-5 for a, b in zip(timestamps, [0, 0.1, 0.35])), timestamps
checks.append("real Vision empty-person/VFR decode, encode, exact timestamps and hash")

delayed = directory / "synthetic-nonzero.mp4"
delayed_result = success(delayed, directory / "nonzero-mask")
assert delayed_result["timing"]["sourceTimeOrigin"] == 0, delayed_result
assert abs(delayed_result["timing"]["duration"] - 2.5) < 1e-6
assert delayed_result["timing"]["sourceEnd"]["seconds"] == 2.5
delayed_pts = [float(f["best_effort_timestamp_time"]) for f in probe(directory / "nonzero-mask/camera-mask.mp4")["frames"]]
# AVAssetReader materializes the leading empty edit as one blank frame at 0.
# Keep it plus the original 2s-offset media timestamps; do not collapse the gap.
assert len(delayed_pts) == 4 and all(abs(a - b) < 1e-5 for a, b in zip(delayed_pts, [0, 2, 2.1, 2.35]))
checks.append("leading empty edit and 2s-offset media retain the complete decoded source timeline")

changed = directory / "changed-source.mp4"
changed.write_bytes(synthetic.read_bytes())
def change_after_ready(event):
    if event["type"] == "ready":
        with changed.open("ab") as out:
            out.write(b"source changed after hashing")
code, events = run(changed, directory / "changed-result", on_event=change_after_ready)
assert code == 1 and events[-1]["code"] == "source_changed", (code, events)
assert not (directory / "changed-result").exists()
checks.append("source changed during decode prevents publication")

for phase in ["startup", "active", "finalizing"]:
    source = synthetic
    if phase == "finalizing":
        # A real final digest pass supplies a deterministic cancellation window;
        # video is still only 3 frames. No test hooks or fake Vision responses.
        source = directory / "padded-vfr.mp4"
        with source.open("xb") as out:
            out.write(synthetic.read_bytes())
            for _ in range(32):
                out.write(bytes(1024 * 1024))
    target = directory / ("cancel-" + phase)
    code, events = run(source, target, cancel=phase)
    assert code == 130 and events[-1]["type"] == "cancelled", (phase, code, events)
    assert not target.exists(), phase
    if phase == "startup":
        assert not any(e["type"] == "ready" for e in events), "Late ready after startup cancellation"
    assert not list(directory.glob(".reva-camera-*.tmp")), "Owned temporary output leaked"
    checks.append("CLI cancellation during " + phase)

bad = directory / "malformed.mp4"
bad.write_bytes(b"not video")
code, events = run(bad, directory / "bad-result")
assert code == 1 and events[-1]["type"] == "error"
assert not (directory / "bad-result").exists()
existing = directory / "existing-result"
existing.mkdir(); (existing / "foreign").write_text("keep")
code, events = run(synthetic, existing)
assert code == 1 and events[-1]["code"] == "output_exists"
assert (existing / "foreign").read_text() == "keep"
checks.append("malformed source and existing output fail without replacing files")

if person:
    result = success(person, directory / "person-mask")
    assert result["timing"]["frameCount"] > 0
    width, height = result["mask"]["width"], result["mask"]["height"]
    # ffmpeg decodes actual H.264 values; no simulated masks are accepted.
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(directory / "person-mask/camera-mask.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    red = raw[0::3]
    assert len(red) == width * height and min(red) <= 3 and max(red) >= 252
    assert sum(x >= 200 for x in red) > len(red) * 0.1, "No substantial foreground"
    assert sum(x <= 20 for x in red) > len(red) * 0.2, "No substantial background"
    checks.append("authorized real-person matte has substantial foreground/background and encoded black/white range")
    accurate_person = directory / "person-short.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-i", str(person), "-t", "0.1", "-an", "-c:v", "libx264", "-crf", "16", str(accurate_person)], check=True)
    accurate = success(accurate_person, directory / "accurate-mask", extra=("--quality", "accurate"))
    assert accurate["settings"]["quality"] == "accurate" and accurate["timing"]["frameCount"] == 3
    checks.append("real-person accurate-quality Vision path")
    rotated = directory / "person-rotated.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-display_rotation:v:0", "90", "-i", str(person), "-c", "copy", str(rotated)], check=True)
    rotated_result = success(rotated, directory / "rotated-mask")
    assert rotated_result["source"]["width"] == result["source"]["height"]
    assert rotated_result["source"]["height"] == result["source"]["width"]
    assert rotated_result["timing"]["frameCount"] == result["timing"]["frameCount"]
    def decoded_red(path, filters):
        pixels = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-vf", filters, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        return pixels[0::3]
    expected = decoded_red(directory / "person-mask/camera-mask.mp4", "scale=320:180,transpose=2")
    actual = decoded_red(directory / "rotated-mask/camera-mask.mp4", "scale=180:320")
    assert len(expected) == len(actual)
    intersection = sum(a >= 128 and b >= 128 for a, b in zip(expected, actual))
    union = sum(a >= 128 or b >= 128 for a, b in zip(expected, actual))
    assert union and intersection / union > 0.75, ("Rotated matte is not aligned with the rotated person", intersection / max(1, union))
    checks.append("real-person 90-degree track orientation and frame coverage")

assert not list(directory.glob(".reva-camera-*.tmp")), "Leaked camera transaction"
print(json.dumps({"passed": checks, "realPersonProvided": person is not None}, indent=2))
