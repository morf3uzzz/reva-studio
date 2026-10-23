#!/bin/bash
# Sourced by native build/test scripts. This changes only the compiler's virtual
# filesystem for an observed CLT packaging defect; installed files stay intact.
native_swift_flags=()
native_swift_binary="$(xcrun --find swiftc)"
native_swift_include="$(dirname "$native_swift_binary")/../include/swift"
if [[ -f "$native_swift_include/module.modulemap" && -f "$native_swift_include/bridging.modulemap" ]]; then
  native_overlay="$(python3 - "$native_swift_include" "$studio_dir/.cache/native-toolchain" <<'PY'
import json
import re
import sys
from pathlib import Path

include = Path(sys.argv[1]).resolve()
legacy = include / 'module.modulemap'
modern = include / 'bridging.modulemap'
# Activate only for duplicate maps whose entire non-comment declarations match.
def declarations(path):
    return '\n'.join(line.strip() for line in path.read_text().splitlines()
                     if line.strip() and not line.lstrip().startswith('//'))

old, new = declarations(legacy), declarations(modern)
if old == new and re.search(r'^module SwiftBridging\s*\{', new, re.M):
    cache = Path(sys.argv[2]).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    empty = cache / 'empty.modulemap'
    empty.write_text('// Project-local view: the identical bridging.modulemap owns this module.\n')
    overlay = cache / 'overlay.json'
    overlay.write_text(json.dumps({'version': 0, 'roots': [
        {'type': 'file', 'name': str(legacy), 'external-contents': str(empty)}
    ]}))
    print(overlay)
    print('Using a local VFS overlay for duplicate Command Line Tools SwiftBridging maps.', file=sys.stderr)
PY
)"
  if [[ -n "$native_overlay" ]]; then
    native_swift_flags=(-vfsoverlay "$native_overlay" -Xcc -ivfsoverlay -Xcc "$native_overlay")
  fi
fi
