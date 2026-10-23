#!/bin/bash
set -euo pipefail
native_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
studio_dir="$(cd "$native_dir/.." && pwd)"
cache_dir="$studio_dir/.cache/native-module-cache"
source "$native_dir/toolchain.sh"
mkdir -p "$native_dir/build" "$cache_dir"
xcrun swiftc -swift-version 5 -parse-as-library -module-cache-path "$cache_dir" \
  ${native_swift_flags[@]+"${native_swift_flags[@]}"} \
  -framework AVFoundation -framework CoreGraphics -framework CoreVideo -framework CoreText -framework AudioToolbox -framework UniformTypeIdentifiers \
  "$native_dir/CaptureOptions.swift" "$native_dir/CaptureWriter.swift" "$native_dir/RecordingTimeline.swift" "$native_dir/CaptureShortcuts.swift" "$native_dir/PrivacyFixtures.swift" \
  -o "$native_dir/build/privacy-fixtures"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/reva-privacy-tests.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
"$native_dir/build/privacy-fixtures" "$test_dir"
python3 "$native_dir/test-privacy.py" "$native_dir/build/reva-capture" "$test_dir"
