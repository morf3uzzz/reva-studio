#!/bin/bash
set -euo pipefail

studio_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_dir="$studio_dir/native"
cache_dir="$studio_dir/.cache/native-module-cache"
architecture="${REVA_NATIVE_ARCH:-$(uname -m)}"
if [[ "$architecture" != "arm64" && "$architecture" != "x86_64" ]]; then
  echo "Native capture requires macOS on arm64 or x86_64." >&2
  exit 1
fi
mkdir -p "$native_dir/build" "$cache_dir"
source "$native_dir/toolchain.sh"
build_output="$(mktemp "$native_dir/build/.reva-capture.XXXXXX")"
trap 'rm -f "$build_output"' EXIT
xcrun swiftc -swift-version 5 -O -whole-module-optimization -parse-as-library \
  ${native_swift_flags[@]+"${native_swift_flags[@]}"} \
  -target "$architecture-apple-macosx14.0" \
  -module-cache-path "$cache_dir" \
  -framework AppKit -framework AVFoundation -framework ScreenCaptureKit \
  -framework CoreMedia -framework CoreGraphics -framework CoreVideo -framework AudioToolbox -framework Vision -framework CryptoKit -framework CoreImage -framework ImageIO -framework CoreMediaIO -framework Speech -framework UniformTypeIdentifiers -framework ApplicationServices -framework CoreML \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$native_dir/Info.plist" \
  "$native_dir/CaptureOptions.swift" "$native_dir/CaptureWriter.swift" "$native_dir/RecordingTimeline.swift" "$native_dir/CaptureSources.swift" "$native_dir/CaptureDevices.swift" "$native_dir/CameraFrameScaler.swift" \
  "$native_dir/Recorder.swift" "$native_dir/PrivacyAnalysis.swift" "$native_dir/ProtocolOutput.swift" "$native_dir/LiveInputOutput.swift" "$native_dir/InputMonitor.swift" \
  "$native_dir/CameraMaskOutput.swift" "$native_dir/CameraSegmentation.swift" "$native_dir/CameraAnalysis.swift" "$native_dir/SpeechTranscription.swift" "$native_dir/SuperResolution.swift" "$native_dir/MediaRecovery.swift" \
  "$native_dir/ConnectedScreenCapture.swift" "$native_dir/CaptureShortcuts.swift" "$native_dir/RecordingRecovery.swift" "$native_dir/WindowUtilities.swift" "$native_dir/Main.swift" -o "$build_output"
codesign --force --sign - --identifier com.reva.studio.capture "$build_output" >/dev/null
chmod 755 "$build_output"
native_destination="${REVA_NATIVE_OUTPUT:-$native_dir/build/reva-capture}"
mkdir -p "$(dirname "$native_destination")"
mv -f "$build_output" "$native_destination"
echo "$native_destination"
