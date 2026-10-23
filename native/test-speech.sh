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
  -framework AVFoundation -framework Speech -framework CryptoKit -framework CoreGraphics \
  "$native_dir/CaptureOptions.swift" "$native_dir/ProtocolOutput.swift" "$native_dir/SpeechTranscription.swift" "$native_dir/SpeechTranscriptionTests.swift" \
  -o "$native_dir/build/speech-tests"
"$native_dir/build/speech-tests"
