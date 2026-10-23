#!/usr/bin/env python3
"""Read-only production CLI discovery checks. Never starts any capture device."""
import json
import math
import pathlib
import subprocess
import sys

helper = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).parent / 'build/reva-capture'


def command(*arguments, fails=False):
    result = subprocess.run([str(helper), *arguments], capture_output=True, text=True, timeout=30)
    lines = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, (arguments, result.returncode, result.stderr)
    assert (result.returncode != 0) == fails, (arguments, result.returncode, lines, result.stderr)
    return lines[0]


def positive_integer(value):
    return type(value) is int and value > 0


def check_sources(sources):
    assert isinstance(sources, list)
    assert len({item['id'] for item in sources}) == len(sources)
    z_indexes = []
    for item in sources:
        assert item['kind'] in ('display', 'window', 'device') and isinstance(item['name'], str)
        assert item['id'].startswith(item['kind'] + ':')
        if item['kind'] == 'device':
            assert item['id'][7:] and '\0' not in item['id']
        else:
            assert int(item['id'].split(':')[1]) > 0
        assert positive_integer(item['width']) and positive_integer(item['height'])
        bounds = item['bounds']
        assert all(type(bounds[key]) in (int, float) and math.isfinite(bounds[key]) for key in ('x', 'y', 'width', 'height'))
        assert bounds['width'] > 0 and bounds['height'] > 0
        assert abs(bounds['width'] - item['width']) < 1 and abs(bounds['height'] - item['height']) < 1
        if 'ownerPID' in item:
            assert item['kind'] == 'window' and positive_integer(item['ownerPID']) and item['ownerPID'] <= 2**31 - 1
        if 'zIndex' in item:
            assert item['kind'] == 'window' and type(item['zIndex']) is int and item['zIndex'] >= 0
            z_indexes.append(item['zIndex'])
    assert len(set(z_indexes)) == len(z_indexes)


before = command('permissions')
devices = command('list-devices')
for kind in ('cameras', 'microphones', 'screenDevices'):
    entries = devices[kind]
    assert isinstance(entries, list) and len({entry['id'] for entry in entries}) == len(entries)
    for entry in entries:
        assert isinstance(entry['id'], str) and entry['id']
        assert isinstance(entry['name'], str) and type(entry['default']) is bool
    assert sum(entry['default'] for entry in entries) <= 1
    if kind == 'screenDevices':
        assert all(positive_integer(entry['width']) and positive_integer(entry['height']) for entry in entries)

sources = command('list')
check_sources(sources)
if before['screen'] == 'granted':
    applications = command('list-audio-applications')
    assert isinstance(applications, list) and len({entry['id'] for entry in applications}) == len(applications)
    assert all(isinstance(entry['id'], str) and entry['id'] and isinstance(entry['name'], str) and positive_integer(entry['processID']) for entry in applications)
else:
    denied = command('list-audio-applications', fails=True)
    assert denied['code'] == 'screen_permission_denied'
    applications = None
owners = [source['ownerPID'] for source in sources if 'ownerPID' in source]
if owners:
    excluded = command('list', '--exclude-process-id', str(owners[0]))
    check_sources(excluded)
    assert all(source.get('ownerPID') != owners[0] for source in excluded)
    before_other = {source['id'] for source in sources if source.get('ownerPID') != owners[0]}
    assert not before_other or before_other.intersection(source['id'] for source in excluded), 'Exclusion removed every unrelated source.'

for arguments in [('list', '--exclude-process-id', '0'), ('list', '--exclude-process-id', '-1'), ('list-devices', '--unexpected')]:
    failure = command(*arguments, fails=True)
    assert failure.get('type') == 'error' and failure.get('code') == 'invalid_arguments'

after = command('permissions')
assert before == after, 'Read-only discovery unexpectedly changed permission state.'
print(json.dumps({
    'result': 'passed', 'captureStarted': False, 'permissions': after,
    'cameras': len(devices['cameras']), 'microphones': len(devices['microphones']),
    'screenDevices': len(devices['screenDevices']), 'screenDeviceIssue': devices.get('screenDeviceIssue'),
    'selectableAudioApplications': len(applications) if applications is not None else None,
    'displays': sum(source['kind'] == 'display' for source in sources),
    'windows': sum(source['kind'] == 'window' for source in sources),
    'windowExclusionChecked': bool(owners),
    'windowOrderEntries': sum('zIndex' in source for source in sources),
}))
