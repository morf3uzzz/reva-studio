#!/usr/bin/env python3
"""Interrupt an owned synthetic capture, probe/remux fragments and metadata.

No screen, camera, microphone, event tap, permission request, or existing media
is used. Original interrupted bytes remain intact for repeatable recovery.
"""
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tool(name):
    candidates = [shutil.which(name), f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}"]
    return next((path for path in candidates if path and Path(path).is_file()), None)


def run(binary):
    ffprobe, ffmpeg = tool("ffprobe"), tool("ffmpeg")
    if not ffprobe or not ffmpeg:
        raise RuntimeError("Use the existing local FFmpeg/ffprobe installation to run this test.")
    directory = Path(tempfile.mkdtemp(prefix="reva-interrupted-recording-"))
    stderr_path = directory / "producer.stderr.log"
    started = time.monotonic()
    process = None
    try:
        with stderr_path.open("wb") as errors:
            process = subprocess.Popen([str(binary), "--recovery-fixture", str(directory)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors)
            manifest_path = directory / "screen.recovery.json"
            deadline = time.monotonic() + 20
            manifest = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"Synthetic producer exited before interruption ({process.returncode}): {stderr_path.read_text()[-4000:]}")
                if manifest_path.exists():
                    manifest = json.loads(manifest_path.read_text())
                    if manifest["duration"] >= 4:
                        break
                time.sleep(0.05)
            else:
                raise RuntimeError("Synthetic producer did not commit a four-second recovery checkpoint.")
            process.kill()
            process.wait(timeout=5)
        assert process.returncode == -9, "The fixture was not terminated by the deliberate SIGKILL."
        assert manifest["status"] == "recording", "A normally completed file is not an interruption test."
        assert manifest["cameraStartTime"] == .25, "Recovery lost the first camera frame's shared-clock offset."
        report = {"fixtureDirectory": str(directory), "termination": "SIGKILL", "checkpointSeconds": manifest["duration"], "media": [], "metadata": []}
        for key, expected in (("output", "video"), ("microphonePath", "audio"), ("cameraPath", "video")):
            source = Path(manifest[key])
            before = digest(source)
            probe = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_type,start_time", "-of", "json", str(source)], stderr=subprocess.PIPE, timeout=10))
            duration = float(probe["format"]["duration"])
            assert math.isfinite(duration) and 1.5 < duration <= manifest["duration"] + 0.5, f"Interrupted {key} has no usable completed fragments: {duration}."
            assert expected in [stream["codec_type"] for stream in probe["streams"]]
            recovered = directory / ("recovered-" + source.name)
            subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", str(source), "-map", "0", "-c", "copy", "-movflags", "+faststart", str(recovered)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
            verified = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(recovered)], stderr=subprocess.PIPE, timeout=10))
            assert float(verified["format"]["duration"]) > 1.5
            assert digest(source) == before, "Recovery modified the interrupted original media."
            report["media"].append({"path": str(source), "sha256": before, "playableSeconds": duration, "streamStartTimes": [stream.get("start_time") for stream in probe["streams"]], "recoveredPath": str(recovered), "recoveredSeconds": float(verified["format"]["duration"])})
        for key, length_key in (("cursorOutput", "cursorPrefixBytes"), ("activityOutput", "activityPrefixBytes")):
            source = Path(manifest[key])
            before = digest(source)
            values = json.loads(source.read_bytes()[:manifest[length_key]] + b"]")
            assert values and all(0 <= value.get("t", value.get("time", -1)) <= manifest["duration"] for value in values)
            assert digest(source) == before
            report["metadata"].append({"path": str(source), "sha256": before, "committedItems": len(values)})
        report["wallSeconds"] = time.monotonic() - started
        report["cameraStartTime"] = manifest["cameraStartTime"]
        report["scope"] = "Actual AVAssetWriter fragmented screen/AAC/delayed-camera output killed during writing; independent real FFmpeg probe/remux; committed cursor/activity recovery. Camera source offset retained in journal; editor recovery must reconstruct the gap. No physical-device acquisition or power-loss durability claimed."
        print(json.dumps(report, indent=2))
    except BaseException:
        print(f"Recovery-test artifacts retained at {directory}", file=sys.stderr)
        raise
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: test-recording-recovery.py /absolute/path/native-tests")
    run(Path(sys.argv[1]).resolve(strict=True))
