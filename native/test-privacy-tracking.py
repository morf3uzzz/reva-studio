#!/usr/bin/env python3
"""Real Vision object tracking on a moving face retained from reference evidence.

Only a new local temporary fixture is generated. No device capture, TCC request,
network operation, or modification of the source screenshot is performed.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

helper = Path(sys.argv[1]).resolve(strict=True)
ffmpeg = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
portrait = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
assert portrait and portrait.is_file(), "Supply an explicitly selected face image as the second argument."
directory = Path(tempfile.mkdtemp(prefix='reva-privacy-tracking-'))
source, output = directory / 'moving-face.mp4', directory / 'tracked.json'
subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=20:d=4',
                '-loop', '1', '-i', str(portrait), '-filter_complex',
                "[1:v]scale=300:300:force_original_aspect_ratio=increase,crop=300:300[face];[0:v][face]overlay=x='20+75*t':y=30:shortest=1[v]",
                '-map', '[v]', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True)
def analyze(video, destination):
    digest = hashlib.sha256(video.read_bytes()).hexdigest()
    process = subprocess.Popen([str(helper), 'analyze-privacy', '--input', str(video), '--output', str(destination), '--sensitive', 'false', '--faces', 'true'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    events = [json.loads(line) for line in process.stdout if line.strip()]
    process.wait(timeout=10)
    stderr = process.stderr.read()
    process.stdin.close()
    assert process.returncode == 0 and events[-1]['type'] == 'completed', (events, stderr, str(directory))
    result = json.loads(destination.read_text())
    assert result['source']['sha256'] == digest == hashlib.sha256(video.read_bytes()).hexdigest()
    return result

before = hashlib.sha256(source.read_bytes()).hexdigest()
started = time.monotonic()
result = analyze(source, output)
assert result['settings']['faceTrackingMethod'] == 'vision-object-tracking' and result['settings']['faceTrackingInterval'] == .1
assert result['coverage']['complete'] and result['coverage']['sampledFrames'] == result['coverage']['plannedFrames'] == 8
assert result['coverage']['trackedFrames'] >= 30, result['coverage']
faces = [region for region in result['regions'] if region['kind'] == 'face']
assert len(faces) >= 30
first = min(faces, key=lambda region: region['start'])
center = first['x'] + first['width'] / 2
covered = 0
for index in range(40):
    t = (index + .5) / 10
    expected_x = center + 75 * t / 640
    active = [region for region in faces if region['start'] <= t < region['end']]
    assert any(region['x'] <= expected_x <= region['x'] + region['width'] for region in active), (t, expected_x, active, str(directory))
    covered += 1
assert any(region['start'] > 3.5 and region['x'] > first['x'] + .35 for region in faces), 'The face mask did not follow source-space movement.'
assert all(0 <= region['start'] < region['end'] <= 4 and 0 <= region['x'] < 1 and 0 < region['width'] <= 1 for region in faces)
shifted = directory / 'leading-gap.mp4'
subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-itsoffset', '0.25', '-i', str(source), '-map', '0:v', '-c', 'copy', str(shifted)], check=True)
delayed = analyze(shifted, directory / 'delayed-tracked.json')
assert delayed['coverage']['complete'] and delayed['coverage']['plannedFrames'] == delayed['coverage']['sampledFrames'] == 8
assert abs(delayed['coverage']['intervals'][0]['start'] - .25) < 1e-5, delayed['coverage']
assert delayed['samples'][0]['requestedTime'] >= .25 and delayed['samples'][0]['actualTime'] >= .25
assert len([region for region in delayed['regions'] if region['kind'] == 'face']) >= 30
print(json.dumps({'result':'passed','fixtureDirectory':str(directory),'faceRegions':len(faces),'trackedFrames':result['coverage']['trackedFrames'],
                  'coveredBetweenFrameInstants':covered,'leadingEmptyEditCoverageStart':delayed['coverage']['intervals'][0]['start'],
                  'sourceSHA256':before,'wallSeconds':time.monotonic()-started,
                  'limitations':['Bounded positive fixture; brief appearances before re-detection or tracking loss remain possible.','No proprietary original-model or exhaustive real-recording equivalence claim.']},indent=2))
