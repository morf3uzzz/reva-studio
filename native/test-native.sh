#!/bin/bash
set -euo pipefail
native_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
studio_dir="$(cd "$native_dir/.." && pwd)"
cache_dir="$studio_dir/.cache/native-module-cache"
mkdir -p "$native_dir/build" "$cache_dir"
source "$native_dir/toolchain.sh"
xcrun swiftc -swift-version 5 -parse-as-library -module-cache-path "$cache_dir" \
  -target "$(uname -m)-apple-macosx14.0" \
  ${native_swift_flags[@]+"${native_swift_flags[@]}"} \
  -framework AVFoundation -framework CoreGraphics -framework CoreVideo -framework AudioToolbox -framework CoreImage -framework ImageIO -framework CoreMediaIO -framework UniformTypeIdentifiers \
  "$native_dir/CaptureOptions.swift" "$native_dir/CaptureDevices.swift" "$native_dir/CameraFrameScaler.swift" "$native_dir/WindowFrameNormalizer.swift" "$native_dir/CaptureWriter.swift" "$native_dir/RecordingTimeline.swift" "$native_dir/ProtocolOutput.swift" \
  "$native_dir/LiveInputOutput.swift" "$native_dir/InputMonitor.swift" "$native_dir/CaptureShortcuts.swift" "$native_dir/RecordingRecovery.swift" "$native_dir/ConnectedScreenCapture.swift" "$native_dir/Tests.swift" \
  -o "$native_dir/build/native-tests"
"$native_dir/build/native-tests"
