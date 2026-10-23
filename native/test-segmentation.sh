#!/bin/bash
set -euo pipefail
native_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
studio_dir="$(cd "$native_dir/.." && pwd)"
cache_dir="$studio_dir/.cache/native-module-cache"
source "$native_dir/toolchain.sh"
mkdir -p "$native_dir/build" "$cache_dir"
xcrun swiftc -swift-version 5 -parse-as-library -module-cache-path "$cache_dir" \
  ${native_swift_flags[@]+"${native_swift_flags[@]}"} \
  -framework AVFoundation -framework CoreVideo -framework Vision -framework CryptoKit \
  "$native_dir/CaptureOptions.swift" "$native_dir/ProtocolOutput.swift" \
  "$native_dir/CameraMaskOutput.swift" "$native_dir/CameraSegmentation.swift" "$native_dir/SegmentationTests.swift" \
  -o "$native_dir/build/segmentation-tests"
test_dir="$(mktemp -d "$studio_dir/.cache/segmentation-tests.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
"$native_dir/build/segmentation-tests" "$test_dir"
python3 "$native_dir/test-segmentation.py" "$native_dir/build/reva-capture" "$test_dir" "${1:-}"
