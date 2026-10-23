#!/usr/bin/env python3
"""Real public CLI/Vision checks; supplied video is entirely synthetic."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time

helper = pathlib.Path(sys.argv[1]).resolve()
directory = pathlib.Path(sys.argv[2]).resolve()
source = directory / 'synthetic-privacy.mp4'
rotated = directory / 'synthetic-privacy-rotated.mov'
original_digest = hashlib.sha256(source.read_bytes()).hexdigest()


def run(input_path, output, sensitive=True, faces=True, cancel=None, create_conflict=False, phrases=None):
    args = ['/usr/bin/time', '-lp', str(helper), 'analyze-privacy', '--input', str(input_path), '--output', str(output),
            '--sensitive', str(sensitive).lower(), '--faces', str(faces).lower()]
    if phrases is not None:
        args += ['--custom-phrases', json.dumps(phrases)]
    started = time.monotonic()
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    events = []
    for line in process.stdout:
        event = json.loads(line)
        events.append(event)
        if event['type'] == 'ready':
            if create_conflict:
                output.write_text('caller-owned sentinel')
            if cancel:
                if cancel == 'eof':
                    process.stdin.close()
                else:
                    process.stdin.write(cancel + '\n')
                    process.stdin.flush()
    status = process.wait(timeout=30)
    if not process.stdin.closed:
        process.stdin.close()
    error_text = process.stderr.read()
    metrics = {}
    for name in ['user', 'sys']:
        match = re.search(r'^' + name + r'\s+([0-9.]+)', error_text, re.M)
        if match:
            metrics[name + 'Seconds'] = float(match.group(1))
    peak = re.search(r'^\s*(\d+)\s+maximum resident set size', error_text, re.M)
    if peak:
        metrics['helperPeakRSSBytes'] = int(peak.group(1))
    assert not list(directory.glob('.reva-privacy-*.tmp')), 'Owned privacy spool files were leaked.'
    return status, events, time.monotonic() - started, error_text, metrics


output = directory / 'privacy.json'
status, events, elapsed, stderr, metrics = run(source, output)
assert status == 0, (status, events, stderr)
assert events[0]['type'] == 'ready' and events[-1]['type'] == 'completed', events
result = json.loads(output.read_text())
assert result['source']['sha256'] == original_digest
assert result['source']['width'] == 1280 and result['source']['height'] == 800
assert result['coordinateSpace'] == 'oriented-top-left-normalized'
assert result['coverage']['complete'] is True
assert len(result['samples']) == result['coverage']['plannedFrames'] == 6
kinds = {region['kind'] for region in result['regions']}
assert {'email', 'phone', 'card', 'key'}.issubset(kinds), kinds
for region in result['regions']:
    assert 0 <= region['x'] < 1 and 0 <= region['y'] < 1
    assert 0 < region['width'] <= 1 and 0 < region['height'] <= 1
    assert region['x'] + region['width'] <= 1.000001
    assert region['y'] + region['height'] <= 1.000001
    assert 0 <= region['start'] < region['end'] <= result['source']['duration']
assert any(0.17 < region['y'] < 0.3 for region in result['regions'] if region['kind'] == 'email'), 'Vision Y coordinates were not converted to top-left.'
serialized = output.read_text()
for secret in ['alex@example.test', '555-0147', '4242 4242', 'sk_test_']:
    assert secret not in serialized, 'Recognized sensitive text leaked into metadata.'
assert hashlib.sha256(source.read_bytes()).hexdigest() == original_digest

phrase_output = directory / 'phrases.json'
status, events, _, stderr, _ = run(source, phrase_output, faces=False, phrases=['local synthetic privacy'])
assert status == 0, (status, events, stderr)
phrase_result = json.loads(phrase_output.read_text())
assert phrase_result['settings']['customPhrases'] == ['local synthetic privacy']
assert any(region['kind'] == 'phrase' and region['y'] < .2 for region in phrase_result['regions']), 'A custom phrase was not matched by real OCR.'

status, events, rotated_elapsed, stderr, rotated_metrics = run(rotated, directory / 'rotated.json')
assert status == 0, (status, events, stderr)
rotated_result = json.loads((directory / 'rotated.json').read_text())
assert rotated_result['source']['width'] == 800 and rotated_result['source']['height'] == 1280
assert all(sample['analysisWidth'] == 800 and sample['analysisHeight'] == 1280 for sample in rotated_result['samples'])
assert any(region['kind'] == 'email' for region in rotated_result['regions']), 'Rotated video did not run real OCR.'

for command in ['cancel', 'stop', 'eof']:
    target = directory / (command + '.json')
    status, events, _, stderr, _ = run(source, target, cancel=command)
    assert status == 130 and events[-1]['type'] == 'cancelled', (status, events, stderr)
    assert not target.exists(), 'Cancellation published an output.'

conflict = directory / 'conflict.json'
status, events, _, stderr, _ = run(source, conflict, create_conflict=True)
assert status == 1 and events[-1]['code'] == 'output_exists', (status, events, stderr)
assert conflict.read_text() == 'caller-owned sentinel', 'Concurrent output was overwritten.'
status, events, _, _, _ = run(source, output)
assert status == 1 and events[-1]['code'] == 'output_exists'

faces_output = directory / 'faces-only.json'
status, events, _, stderr, _ = run(source, faces_output, sensitive=False, faces=True)
assert status == 0, (status, events, stderr)
assert all(region['kind'] == 'face' for region in json.loads(faces_output.read_text())['regions'])
print(json.dumps({'passed': ['real OCR email/phone/card/key and custom phrase', 'face detector invocation', 'rotated AVAsset video',
                             'normalized rectangles', 'source digest preservation', 'no recognized-text persistence',
                             'cancel/stop/EOF cleanup', 'atomic no-overwrite race'],
                  'syntheticVideoSeconds': 3, 'sampledFrames': 6, 'firstAnalysisSeconds': round(elapsed, 3),
                  'rotatedAnalysisSeconds': round(rotated_elapsed, 3),
                  'helperProcess': metrics, 'rotatedHelperProcess': rotated_metrics,
                  'unmeasuredCosts': ['agent tokens', 'shared Apple Vision/codec service CPU and memory', 'true cold system model cache'],
                  'unverified': ['positive face detection on a real or photorealistic face', 'real screen recordings']}))
