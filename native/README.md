# Native capture helper

Original macOS 14+ implementation using ScreenCaptureKit, AVFoundation, CoreMedia,
and CoreGraphics. It has no third-party dependencies and does not read or modify
the installed reference application.

Build from the project directory with `bash scripts/build-native.sh`. The script uses the
installed Command Line Tools, keeps Swift module caches in `.cache/`, and writes
an ad-hoc signed executable to `native/build/reva-capture`. The embedded plist
contains the microphone, camera, and screen recording usage descriptions.
Some Command Line Tools installations contain two identical `SwiftBridging`
module maps. When that exact defect is detected, the build creates a project-local
virtual filesystem overlay that exposes one declaration. It does not modify the
installed toolchain or install any software; the overlay generator uses the
existing Python 3 supplied with Command Line Tools.

## Protocol

All stdout is JSON. Diagnostics go to stderr. A terminal error is
`{"type":"error","code":"...","message":"..."}` and exits nonzero.
Live-input diagnostics additionally declare `recoverable`; a recoverable error
does not stop healthy inputs or the recording.

- `reva-capture permissions` reports `screen`, `microphone`, `camera`, and
  opt-in shortcut `keyboard` access
  without requesting it. CoreGraphics does not distinguish a screen permission
  that has never been requested from one that was denied; both are reported as
  `not-granted`, without inferring which state applies.
- `reva-capture list [--exclude-process-id PID]` prints one JSON array of sources
  with `id`, `name`, `kind`, `width`, `height`, and `bounds: {x,y,width,height}`.
  IDs are `display:<CGDirectDisplayID>`, `window:<CGWindowID>`, or
  `device:<opaque-AVFoundation-ID>`. Mac source dimensions are **logical points**;
  connected-device dimensions are physical pixels. Without existing
  screen recording permission, only display geometry is enumerated; this command
  never requests permission or captures frames. Bounds use global Quartz coordinates
  and may have negative origins. Windows have optional positive `ownerPID` and
  optional `zIndex`, with a smaller index closer to the front in the current
  CoreGraphics window snapshot. A missing index means unknown order. Display entries
  have neither field. Window names remain sorted independently of their order.
  The helper's own windows and the explicitly excluded PID are omitted.
- `reva-capture list-devices` prints `{cameras: [{id,name,default}], microphones:
  [{id,name,default}], screenDevices: [{id,name,default,width,height}], screenDeviceIssue?}`.
  Wired muxed screen devices are enabled only for this helper process through
  CoreMediaIO discovery; this does not unlock a device, establish trust, or grant
  permission. Device IDs are opaque AVFoundation identities. Discovery
  does not request access or start a device session. Disconnected devices are absent.
- `reva-capture list-audio-applications [--exclude-process-id PID]` lists distinct
  eligible `{id: bundleIdentifier,name,processID}` applications. It requires
  already-granted screen permission and never prompts or starts an audio stream.
- `reva-capture record --source display:1 --output /absolute/video.mp4
  --cursor-output /absolute/cursor.json --fps 30 --system-audio false
  --microphone false --camera false` starts recording. The ID must come from the
  current source list. Optional `--area x,y,width,height` is in source-local
  logical points; it must fit entirely within the source. FPS is 24, 30, or 60.
  Permission is requested by explicit recording/monitoring commands for enabled devices.
  Optional `--camera-device-id ID` and `--microphone-device-id ID` select exact
  devices; omitted IDs select the system defaults. A disconnected selected ID
  fails instead of selecting another device. `--camera-max-resolution 720|1080|2160`
  defaults to 1080 and caps the encoded camera height. A camera with only larger
  native formats can still be used: Core Image scales its output proportionally
  to even encoder dimensions. Among native formats within the 16-megapixel input
  budget, the largest encoded pixel area wins, then the supported rate nearest
  30 fps, then the smallest source. Exact fractional rates and devices whose
  minimum rate exceeds 30 are supported. If a device declares no usable frame-rate
  range, a usable current format and its timing are preserved. Video is never
  upscaled. At most three scaled pixel buffers are allocated; new frames are
  dropped while those buffers remain in use. Device selection never falls back
  to another camera.
  `--exclude-process-id PID` excludes that application's windows from display/area
  capture. Selecting one of those windows directly fails with `source_excluded`.
  Exclusion applies only to the given PID and the helper itself, not other apps
  using the same runtime.
  `--audio-applications '["com.example.app"]'` restricts system sound to exactly
  those distinct bundle IDs through a separate audio-only ScreenCaptureKit
  stream. Omission means all eligible apps; an explicit empty group or missing
  selected app fails instead of widening the selection. This filter is independent
  of the selected video window. A connected screen uses its own muxed device
  audio and rejects a Mac application filter. `--area` applies only to Mac
  sources. Device orientation changes are letterboxed proportionally into one
  fixed encoded size, with a three-buffer allocation limit.
  `--record-shortcuts true` explicitly opts into a listen-only keyboard event tap
  and requests Input Monitoring if needed. It defaults to false.
- Once the selected screen and enabled devices have delivered samples, stdout
  emits `type: "ready"` with `output`, `cursorOutput`, pixel `width`, pixel
  `height`, `fps`, `systemAudio`, `microphone`, and `camera`.
  Resolved optional `cameraDeviceID` and `microphoneDeviceID` preserve the actual
  selected defaults for subsequent live events.
- Send `stop\n` to stdin. EOF, SIGINT, and SIGTERM also stop and finalize every
  owned capture resource. Repeated stop requests share the same finalization.
- Send `pause\n` or `resume\n`. A `state` event acknowledges the transition with
  `status: "paused"|"recording"` and pause-adjusted `elapsedMs`. The same event
  follows readiness. Repeated requests are idempotent. Pausing retains the capture
  sessions and preview/meter feeds without finalizing media. Screen, camera,
  system audio, microphone, cursor, and activity share one host-clock mapping;
  all paused spans are removed. Late media buffers from past pauses are rejected.
  PCM buffers crossing a boundary are copied by complete audio frames, including
  planar layouts; at most one audio frame is omitted at each boundary.
- Send `flag\n` to record a user marker. A `{type:"flag",time,id}` acknowledgment
  uses the same source clock. Paused or inactive recording produces no flag.
- Successful completion emits `type: "stopped"`, `output`, `cursorOutput`,
  `duration` in seconds, pixel `width` and `height`, optional `cameraPath`,
  `cameraStartTime`, `cameraEndTime`, and `microphonePath`, plus `droppedVideoFrames` and
  `droppedAudioBuffers`. Only then
  are output files ready to consume. A failure emits an error after attempting
  cleanup; no successful stopped event is emitted for partial output.
  `cursorSourceSize: {width,height}` is the initial selected logical source/crop
  size, separately from encoded Retina pixel dimensions. Later window resizes
  may change the normalization bounds; this value is not per-sample geometry.
  `activityOutput` identifies `<output-stem>.activity.json`, described below.

The screen MP4 is H.264 with optional AAC system audio. Camera video is written to
`<output-stem>.camera.mp4`; microphone audio to `<output-stem>.microphone.m4a`.
Media timestamps are converted from each capture clock to the host clock and
share the first screen frame as their zero point, with paused spans excluded.
Stopping while paused uses the frozen active duration. Microphone sidecars include
explicit initial silence when that device starts later because the macOS M4A
writer removes initial empty edits. Camera and microphone use the selected device
or the system default when no ID was supplied. Camera files retain the actual
bounded output dimensions and original timestamps.
`cameraStartTime` is the actual first camera frame in the shared source clock;
it prevents the HTML video element from showing a future frame during an initial
empty edit. Finished late-camera files receive an explicit lossless passthrough
empty edit before atomic replacement of the completed camera file.
`cameraEndTime` is read from the completed AVAsset presentation duration. It
provides a source-clock endpoint before Chromium has decoded seekable ranges;
the shorter HTML media-length field must not clip a fresh first seek.

Cursor output is a JSON array of `{t,x,y,click,visible,event?,button?}`. `t` uses the same screen
timeline; `x` and `y` are normalized output coordinates. `click` is a sampled
button-down state, so a rising edge identifies a click. `visible` is false outside
the selected source. Position and button state are polled every 8 ms without
installing event taps or logging keys; very short button transitions can be
missed. Cursor history is streamed to disk with bounded buffering.
`event` is `mouseMoved`, `mouseDragged`, `mouseDown`, or `mouseUp`; `button` is
`left`, `right`, or `center`. These are poll-derived observations. A hold that
predates startup does not invent a down/up pair, and multiple button transitions
within one poll omit ambiguous event metadata. An up is reported only after an
observed down inside the source. Cursor type is unknown and omitted: public
[`currentSystem`](https://developer.apple.com/documentation/appkit/nscursor/currentsystem)
provides an image/hotspot and is deprecated, while
[`current`](https://developer.apple.com/documentation/appkit/nscursor/current)
describes the helper application's cursor rather than arbitrary target hovers.

Activity output is a streamed JSON array of `{type:"pause",time,duration}`,
`{type:"typing",time,count}`, `{type:"flag",time,id}`, and optionally
`{type:"shortcut",time,keys,keyCode}`. All times are source seconds after pauses are
removed. A pause marker is written at resume or stop while paused; its duration
is the excluded wall time. Typing observes only deltas of the public
`CGEventSource.counterForEventType(.combinedSessionState,eventType:.keyDown)`
counter at the same approximately 8 ms poll. It never reads or stores key codes,
characters, modifier identities, or text, and installs no event tap. Startup and
resume reset the baseline; counter reset/wrap is treated as unknown activity.
This counter-only typing path remains independent of the optional shortcut tap.
The SDK documents that autorepeat, modifier changes, and special media keys are
not counted. Activity covers the login session and is not attributed to the
selected window; secure-input/permission behavior and real keyboard timing have
not been verified. The Electron boundary derives typing ranges with the observed
source thresholds: successive gaps strictly below 500 ms, duration at least
1.5 seconds, and at least two counted key-downs per second. Encoded endpoint
rounding may clamp only a final marker to the playable movie duration.

Shortcut recording is a separate explicit opt-in. It stores semantic modifier
chords and navigation/function keys using virtual key codes; unmodified printable
typing, Shift-only printable typing, and autorepeat are excluded. It never reads
Unicode input or stores typed text. A denied Input Monitoring request is an error,
not an empty successful shortcut recording. The listen-only tap and its run-loop
source are stopped during cleanup. USB device recordings do not fabricate Mac
cursor, typing, or shortcut events.

The Electron Capture owner exposes `pause()`/`resume()` returning the acknowledged
state, `restart()` and `discard()`. Restart closes and discards the current
session before starting the same validated options again. Discard suppresses
editor publication, waits for actual child close and pending result reads, then
removes only its exclusive recording directory after verifying device/inode
identity. It does not enumerate or delete other recordings. Shutdown is bounded
by 30 seconds, SIGTERM with a 5-second grace, and SIGKILL with a 2-second close
deadline. An unclosed child or failed directory removal remains owned for cleanup
retry; no replacement recording is admitted while that owner is retained.

Output paths must be absolute, distinct, and absent. Existing files are never
overwritten. Parent directories are created only during an explicit record.
ScreenCaptureKit's six-frame queue and a 32-megapixel source limit bound video
queue memory. Encoder capability is checked separately and can reject smaller
dimensions. Backpressure drops are counted and returned.

## Interrupted recording recovery

Each recording owns an adjacent `<output-stem>.recovery.json` journal. It includes
schema version 1, source/output paths, geometry, FPS, source duration hint, durable
cursor/activity prefix lengths, optional camera/microphone paths and camera start
time, timestamps, and `recording|finalizing|complete|failed` status. Journal
replacement is atomic. Initial output allocation is exclusive.

The media producer uses AVAssetWriter's Apple-HLS segment delegate. Initialization
and completed two-second fragments are written and synchronized directly to the
owned public MP4/M4A paths. An AVAssetWriter URL writer's private `.sb-*` staging
files are deliberately not scanned: in the actual interruption test those files
left the public destination empty. The journal's duration hint can be ahead of
the last complete fragment; recovery must probe the readable media, copy/remux
to new files, and trim metadata to the usable duration. Never treat a journal
as proof of a playable recording or overwrite its original source files.

Metadata arrays stay valid at checkpoints. A recovery reader takes exactly the
committed prefix byte count and appends `]`; an incomplete later append cannot
corrupt that prefix. Complete journals are not interrupted sessions. Failed
finalization retains the journal and its error for a later recovery attempt.

After `bash native/test-native.sh`, run
`python3 native/test-recording-recovery.py native/build/native-tests`. It starts
an owned synthetic recording producer, kills that exact child with SIGKILL after a checkpoint, probes/remuxes
the actual media and verifies original hashes and committed metadata. It uses
no screen or input device. The measured fixture checkpointed at four seconds and
retained roughly two seconds of completed media fragments; this is not a
power-loss durability or exact last-frame recovery guarantee.

## Live input monitoring

`reva-capture monitor-inputs [--microphones all|selected|none] [--microphone-device-id ID] [--camera true|false]
[--camera-device-id ID] [--exclude-microphone-device-id ID]` opens only the
requested microphone/camera inputs, without screen capture or media files.
Microphones default to `all`, camera to `false`. The toolbar uses `selected` with the exact chosen microphone ID (or the system default when omitted); the microphone menu uses `all`. Each microphone has its own
AVCaptureSession and opaque ID; at most 32 microphone sessions and one camera
are admitted. A disconnected explicit camera never falls back to another.
The excluded microphone is useful when the recording helper already owns that
device and emits its selected microphone levels.

JSONL events are:

- `permission`, `mediaType: "microphone"`, `status`: actual native authorization before and after a request. Values distinguish `not-determined`, `denied`, `restricted`, `granted`, and `unknown`.
- `ready`, `kind: "input-monitor"`, optional `cameraDeviceID`,
  `microphonePermission`, and `microphoneDeviceIDs`: only sessions that actually started. Samples follow ready. Empty readiness does not mean silence or successful microphone access.
- `levels`, `deviceID`, `rms`, `peak`: measured PCM amplitude in 0..1, at most 20 Hz
  per microphone. There are no generated demo levels. Packed little-endian
  Float32/Int16/Int32, planar or interleaved, are parsed from the declared format.
- `camera-frame`, `deviceID`, `jpegBase64`, `width`, `height`: real camera JPEG,
  at most 15 fps, 360 px per side, 256 KiB encoded. No data is saved to disk.
- `error`, `code`, `message`, optional `deviceID`/`mediaType`, `recoverable`:
  startup failure of one input preserves the others. Session-wide runtime or
  cleanup failure is terminal.
- `stopped`, `kind: "input-monitor"`: sessions stopped and queued output drained.
  Send `stop\n`, close stdin, or send SIGINT/SIGTERM to stop. A late ready after
  cancellation cannot restart output. Failed shutdown retains owned sessions
  until helper exit and is never reported as successful cleanup.

For an active recording, pass `--preview-camera true|false` and
`--monitor-microphone true|false` to `record` (both default to false). The respective
recording input must be enabled. The same event shapes then come from the
recording's existing AVCaptureSession; no second camera process is opened.
Send `preview-camera true\n` or `preview-camera false\n` on stdin to toggle the
recording camera preview. Before transitioning from standalone monitoring to a
camera recording, the Electron owner must await monitor shutdown.

Send `camera-effects\n` to an already-active camera monitor or recording to open
the public macOS Video Effects interface in that same capture process. Success
acknowledges `{type:"camera-effects",deviceID}` using the actual running camera.
An absent camera produces a recoverable camera error. This command does not
enable Portrait, Center Stage, Studio Light, or background replacement itself;
the user and macOS own those settings and their hardware availability. No OS
camera-effects UI or physical camera was opened by the synthetic test suite.

Encoding and stdout run on a separate queue. The delegate retains at most one
pending camera frame and one audio sample per device; a blocked consumer drops
new telemetry instead of blocking the recording writer. JSONL writes are atomic
across queues. Electron validates line budgets, exact source IDs, normalized
levels, canonical base64 and JPEG dimensions before dispatching callbacks. Its
InputMonitor retains the exact ChildProcess until close, awaits terminal cleanup,
and retains an unclosed child for cleanup retry.

Synthetic verification covers real PCM measurements, actual JPEG encoding and
decode, pending-work bounds, ready/terminal ordering, startup cancellation,
partial input failures and cleanup retry. Real device startup, all-microphone
coexistence, camera handoff and sound/video latency remain hardware verification
gaps. No application cold/warm timing, device CPU/GPU cost or process-family peak
memory has been measured for this feature.

Apple API references: [AVCaptureAudioDataOutput](https://developer.apple.com/documentation/avfoundation/avcaptureaudiodataoutput),
[CIContext image encoding](https://developer.apple.com/documentation/coreimage/cicontext/jpegrepresentation(of:colorspace:options:)).

## Verification

Run `bash native/test-native.sh` from `apps/studio` for argument/geometry checks
and a real AVAssetWriter encode using synthetic pixels and generated silence.
The test does not initialize screen, microphone, or camera capture. It checks
device argument validation and camera format selection, timestamps, both output
tracks, idle-image extension, no-overwrite behavior,
separate AAC audio timing, cancellation state, and finalized cursor JSON. macOS
codec services must be accessible: a restricted agent sandbox can reject AAC
encoder creation even though the same synthetic test passes on the host. That
failure is reported without a crash.
Camera tests cover high-resolution-only and 60-fps-only format selection, real
Core Image 1920×1440 to 960×720 scaling, unchanged timestamps and color pixels,
pool exhaustion/recovery, and actual H.264 encoding and decoding. These synthetic
checks do not establish real Desk View/Continuity startup or format negotiation.
The pause test encodes actual H.264 screen/camera and AAC system/microphone tracks,
checks the shared 0.6-second active duration across a two-second pause, trims PCM
at both boundaries, excludes late paused frames, and checks paused-stop metadata
and counter-only activity serialization. Electron real-child/controlled-child
tests cover acknowledgments, restart/discard, cancellation during finalization,
directory replacement and retained cleanup retry. These synthetic checks do not
establish real-device pause latency or live key-counter availability.

Live capture requires a user-invoked recording with macOS permission. Until
checked on real hardware, display/window movement and resizing, external display
scaling, camera startup, audio synchronization, and device removal remain runtime
verification gaps. Synthetic encoding does not establish those behaviors.

Apple references: [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit),
[sourceRect](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect),
and the matching local SDK headers for `SCStream`, `SCShareableContent`, and
`AVCaptureSession.synchronizationClock`.

## Local privacy analysis

`reva-capture analyze-privacy --input /absolute/video.mp4 --output /absolute/new.json
--sensitive true --faces true [--custom-phrases '["local phrase"]']` analyzes an explicitly supplied local video with
Apple Vision. At least one detector must be enabled. This command does not start
screen, camera, or microphone capture, request their permissions, upload media,
or modify the source. It independently implements the observed privacy controls;
the reference application's recognition algorithm remains unknown.

Stdout is JSONL:

- `ready`: `duration`, `plannedFrames`, `sampleInterval` (0.5 seconds).
- `progress`: `progress` from 0 to 1, actual source timestamp `t`,
  `sampledFrames`, and `plannedFrames`. Reaching 1 means the planned frames were
  examined; wait for `completed` before consuming the file.
- `completed`: absolute `output`, rectangle count `regions`, `sampledFrames`.
- `cancelled`: emitted after cancellation; exits with code 130 and publishes no
  new output. `cancel\n`, `stop\n`, stdin EOF, SIGINT, and SIGTERM cancel analysis.
- `error`: `code` and `message`; exits nonzero. A cleanup error explicitly reports
  remaining owned temporary paths, and a publication/cleanup error can leave a
  complete already-published output. Never infer completion from file presence.

The version 1 output contains:

- `source`: original `path`, SHA-256, oriented full-frame `width` and `height`,
  and original source `duration` in seconds. Hashes before and after analysis
  must match; a changed input is rejected without publishing.
- `settings`: enabled detectors, custom phrases, 0.5-second detection interval,
  0.1-second face tracking interval and `vision-object-tracking` method, maximum
  analysis dimension (4096), Vision OCR/face request revisions (3), and pattern
  revision (1).
- `coordinateSpace: "oriented-top-left-normalized"`: all rectangles use x/y from
  the upper left and width/height fractions of the fully oriented source frame.
  No cropping is performed. AVAssetImageGenerator applies 0/90/180/270-degree
  track rotations; nonstandard scaled or mirrored matrices are explicitly
  rejected. Larger frames are downscaled for analysis, keeping normalized
  rectangle coordinates valid for the original frame.
- `samples`: `{requestedTime,actualTime,analysisWidth,analysisHeight}` for each
  planned sample. Requested and decoded times are retained separately.
- `regions`: `{start,end,kind,x,y,width,height,confidence}`. `kind` is `email`,
  `phone`, `card`, `key`, `phrase`, or `face`. Text intervals extend half a second
  on each side of the detected sample, clipped to the original video duration.
  Faces are re-detected at 0.5 seconds and tracked with Vision object-tracking
  requests every 0.1 seconds; each interval conservatively covers the previous
  and current boxes plus padding. Lost tracks are not invented or extrapolated.
  Overlapping masks are allowed. Confidence is Vision's observation score,
  not a calibrated probability that the content is sensitive.
- `coverage`: `complete`, `sampledFrames`, `plannedFrames`, `trackedFrames`, source timeline
  `intervals`, explicit `meaning`, and `limitations`. `complete` means all
  planned decoding/analysis requests succeeded. It does **not** mean that every
  sensitive item or face was found. Review remains necessary before sharing.
  A leading empty edit is excluded: sampling and the coverage interval begin at
  the first nonempty media segment's presentation timestamp, not at a fabricated
  source frame zero.

Sensitive detection uses the top accurate OCR candidate with language correction
disabled. Local patterns match email addresses; formatted phone-like values with
7–15 digits; 13–19-digit card-like values passing Luhn; common structured key/JWT
prefixes; and values labelled as API keys, secrets, or access/private keys. These
heuristics have false positives and false negatives. The complete recognized
line receives padding and a mask when a pattern matches; character boxes are
deliberately not treated as exact image segmentation. Faces receive 15% padding.
Recognized strings are transient and are never written to the result or logs.
Custom phrases match OCR lines case- and diacritic-insensitively. The configured
phrases themselves are persisted in settings; recognized OCR text is not.

Only one frame and one set of Vision requests are processed at a time. Inputs
are limited to 24 hours and 32768 pixels per oriented source dimension. Metadata
streams to exclusive spool files, with at most 500,000 regions and a 64 MiB budget
for the complete serialized result. Output
is synchronized and atomically linked into place without replacing any existing
entry. Spool cleanup verifies each file's original device/inode identity before
removing it. Cancellation cancels pending image generation and current Vision
requests, then removes owned spool files. Apple decoder/model internal memory
and shared service costs remain separate from these application-owned bounds.

Run `bash native/test-privacy.sh` outside a restricted agent sandbox after the
native helper build. It creates synthetic CoreText video, performs real OCR via
the public CLI, checks rotated video, all four text categories, normalized boxes,
source digests, absence of recognized text in output, cancellation, and an atomic
no-overwrite race. It also invokes the real face detector on that text-only
fixture; this does not establish positive face-detection coverage. The test
reports wall time, helper process CPU time and peak RSS where `/usr/bin/time`
provides them. Shared Vision/codec service costs, GPU time, agent token costs,
and true cold model-cache costs are unmeasured.

`python3 native/test-privacy-tracking.py native/build/reva-capture` adds a positive
moving-face fixture derived from retained local reference evidence. It checks
actual Vision tracking, forty between-frame source positions, source-space
movement, unchanged video hashes, and a leading empty edit. This bounded fixture
does not establish exhaustive coverage on real recordings or equivalence to the
reference application's undisclosed model.

From `apps/studio`, run `node --test electron/privacy.test.cjs` for process
lifecycle checks. Its scoped synthetic helper executables test grant validation,
startup/active/finalization cancellation, delayed child exit, malformed and
oversized output, conflicting terminal messages, bounded message framing,
directory replacement, and cleanup retry. They do not establish Vision behavior.
After `test-privacy.sh` builds the fixture generator, set
`REVA_PRIVACY_NATIVE_TESTS=1 node --test electron/privacy.test.cjs` on the host to
also test real OCR through the production Electron wrapper and `MediaGrants`,
including rotated coordinates, source identity, provenance retention, and cleanup.

Apple references: [Vision coordinate conventions](https://developer.apple.com/documentation/vision),
[recognized text box limitations](https://developer.apple.com/documentation/vision/vnrecognizedtext/boundingbox(for:)),
[image generation and actual timestamps](https://developer.apple.com/documentation/avfoundation/creating-images-from-a-video-asset),
and [supported preferred track transforms](https://developer.apple.com/documentation/avfoundation/avassetimagegenerator/appliespreferredtracktransform).
# Camera Cutout

`reva-capture segment-camera --input /absolute/camera.mp4 --output-directory /absolute/new-directory [--quality balanced|accurate]`

The parent directory must already exist. This command reads an existing regular video file and performs local Apple Vision person segmentation. It never starts screen, microphone or camera acquisition. A successful transaction publishes `camera-mask.mp4` and `manifest.json` together by an exclusive atomic directory rename. Existing files, directories and dangling symlinks are never replaced.

Standard output is JSONL:

- `ready`: `duration`, oriented source `width`/`height`, `quality`.
- `progress`: `phase` (`segmenting` or `finalizing`), `progress` (0…0.95), source timestamp `t`, completed `frames`.
- `completed`: `outputDirectory`, `maskPath`, `manifestPath`, `frames`, mask `duration`; exit 0.
- `cancelled`: exit 130. Send `stop` or `cancel` plus newline, close stdin, or send SIGINT/SIGTERM. Cancellation is registered before hashing/decoder setup. Finalization drains the writer before cleanup. Commit and cancellation are serialized; after commit, completion wins and this process never deletes published artifacts.
- `error`: `code`, `message`; exit 1. `segmentation_cleanup_failed` additionally carries `ownedPaths`. The owner retains identities across failed cleanup attempts and never removes a replaced child or directory.

Manifest version 1 contains source path/SHA256/oriented dimensions/duration/EXIF orientation; mask dimensions/codec/channel; original `firstPTS`, `lastPTS`, `sourceEnd` as `{value,timescale,seconds}`; `sourceTimeOrigin`, mask duration/frame count; Vision revision/quality and OS version. Mask time equals camera source time minus `sourceTimeOrigin`. PTS and source gaps are preserved; AVAssetReader can materialize an initial empty edit as a blank frame, which is retained. Negative, repeated, nonfinite timestamps and unresolvable final durations fail explicitly. A second identity/hash check prevents publication if the source changes during processing.

The mask is **opaque H.264 grayscale video**. Set alpha from the **decoded RGB red channel**, not from the video's alpha channel. Its dimensions/aspect may differ from the source: the verified balanced output was 512×384 for 1920×1080 video. Stretch the complete mask over the oriented source, then apply identical source-time, crop and mirror transforms to RGB and mask. There is no circular or elliptical fallback. Encoder black/white levels were verified within 3/255 after decoding. The reference application's segmentation model is unknown; this is an independent implementation and is not a claim of model parity.

Input is limited to 24 hours, 8192 pixels per side and 16 megapixels. The pipeline retains at most two decoded frames, one Vision request and one pending writer sample; decoder/encoder/Vision service allocations are framework-owned. Source pixel-aspect/aperture scaling and nonorthogonal transforms require preprocessing. Orthogonal rotation/reflection metadata is supported. `balanced` is the default; `accurate` adds Vision's refinement. Relevant Apple documentation: [person segmentation](https://developer.apple.com/documentation/vision/vngeneratepersonsegmentationrequest), [output formats](https://developer.apple.com/documentation/vision/vngeneratepersonsegmentationrequest/outputpixelformat), [frame-sequence processing and mask compositing](https://developer.apple.com/videos/play/wwdc2021/10040/).

Run `bash native/test-segmentation.sh [absolute-short-person-video]` from the studio workspace. It uses actual AVFoundation/Vision with synthetic VFR and optional explicitly supplied person footage. Tests cover native pixels/levels, eight transform mappings, positive-person/rotated-person alignment, accurate quality, leading gaps, changed inputs, startup/active/finalization cancellation, collisions, identity replacement and cleanup retry. They acquire no devices. macOS codec/Vision services were unavailable in the agent sandbox; these tests passed on the host. The optional person test needs the existing `ffmpeg`/`ffprobe` tools; the script installs nothing.


Microphone UI status is snapshotted with native permission, actual started IDs, and typed errors, so a newly mounted toolbar cannot lose a prior permission failure. Only recent real PCM packets produce meter values; zero samples indicate measured silence, while missing or expired packets show unavailable/no-input status. Explicit retry stops the previous owned helper before rechecking permission and reconnecting. Privacy navigation accepts only microphone/screen pane identifiers, never arbitrary renderer URLs.

## Camera face and silence analysis

`reva-capture analyze-camera --input /absolute/camera.mp4 --output /absolute/new.json
--faces true --silence true [--audio-input /absolute/microphone.m4a]
[--silence-threshold-db -40] [--silence-minimum-seconds 1]` analyzes granted local
files, never acquisition devices. At least one detector is required. The result
has separate source SHA-256, source-time coverage and limitations for each detector.

Face rectangles use local Apple Vision at five samples per second, a maximum
1280-pixel analysis dimension, and oriented top-left normalized coordinates.
A valid frame with no detected face is explicit `face: null`. The chosen
largest/nearest face is not a person-identity assertion. Sampling begins at the
first nonempty track edit's presentation time; a leading camera gap stays uncovered.
Silence uses actual mono 8 kHz PCM, 20 ms RMS windows and the configured dBFS
threshold/minimum duration. Gaps and unavailable audio do not count as silence.

`python3 native/test-camera-analysis.py native/build/reva-capture` exercises actual
Vision face detections and source-space motion, tone/silence boundaries, leading
empty edits, hashes, no-face samples, unavailable audio, cancellation and collisions.
It uses generated videos and a retained test image, with no camera acquisition.

## Local speech recognition

`reva-capture speech-status [--locale en-US]` reports current native permission,
supported locales, local-engine availability and a reason. It never requests
permission or downloads a model. `transcribe-speech --input /absolute/audio.m4a
--output-directory /absolute/new-directory --locale en-US --track microphone
[--offset 0] [--contextual-string "project name"]` is the explicit transcription
action. Track is `microphone` or `system`; offset maps its words into source time.

The current Command Line Tools SDK supports legacy `SFSpeechRecognizer`, not
macOS 26 `SpeechAnalyzer`. Every recognition request sets
`requiresOnDeviceRecognition = true`, with no cloud fallback. Installed language
assets, on-device language support and Speech Recognition authorization are
prerequisites. Recognition uses consecutive 45-second local chunks; punctuation,
filler retention and word timing can differ at boundaries. Cancellation owns the
recognition task and temporary audio chunks. No transcript is published on failure.

`bash native/test-speech.sh` verifies parser and local-only policy behavior.
A read-only check outside the restricted agent sandbox reported an available
en-US on-device engine and `not-determined` Speech Recognition authorization on
2026-10-22. The earlier sandbox-only denied/unavailable result did not describe
the host. No permission prompt was accepted and no actual recognition was run;
recognition accuracy therefore remains unverified.

## Lossless camera recovery

`reva-capture recover-camera --input /absolute/interrupted.camera.mp4
--output /absolute/new.camera.mp4 --start-time 0.25` copies compressed camera media
through an AVMutableComposition and passthrough export. It restores the journal's
first-frame offset as an explicit empty edit, retaining transforms and interior
timeline gaps. Publication is atomic without replacing an existing output;
source SHA-256 is checked before and after. Standard `stop`/`cancel`, stdin EOF
and SIGINT/SIGTERM cancel. `completed` reports `output`, shared-clock `duration`,
`startTime` and `sourceSHA256` only after finalization and owned temporary cleanup.

The actual SIGKILL fixture recovered a camera beginning at 0.25 seconds and ending
at 2.016667 seconds without changing its source. FFprobe and Chromium report
1.766667 as the track's media length despite the correct 2.016667 movie header
and empty edit. A consumer must retain presentation endpoints and inspect decoded
seekable ranges rather than clamp source time to `HTMLVideoElement.duration`.
The app's shared playback owner handles that distinction in preview and export.
Actual Chromium decoding and playback continued through the last 1.983333-second
frame; media length is not the absolute source-time endpoint.

## Local neural super-resolution

`reva-capture upscale-video --input /absolute/screen.mp4
--model /absolute/PiperSR_2x.mlpackage --output-directory /absolute/new-directory`
performs actual local Core ML image-to-image inference. The app bundles pinned
PiperSR weights from commit `8a57d04190768bcf924ae88b59f82558f90b9a1d` with
their CC-BY-4.0 model license and attribution. Only the model package/card/license
were obtained; upstream AGPL training and inference code was not copied.
REVA's tile/stitch implementation is independent. Per-file hashes and upstream
Pinned file identities are verified by `scripts/fetch-model.mjs` and the model catalog.

The bundled graph takes a 128×128 sRGB tile and produces 256×256 pixels. Overlap
and edge clamping preserve complete opaque source frames. Input is bounded to
2,073,600 pixels and 24 hours; derived output is bounded to 3840×2160 in either
orientation. Original nonempty edit ranges, VFR timestamps and orientation are
preserved. One-frame lookahead resolves missing decoder sample durations from
the next presentation timestamp or exact remaining media range, without guessing
a nominal frame rate. Memory retains bounded tile buffers and decoded frames.

Successful output contains `enhanced.mp4` plus `manifest.json`, with original
source SHA-256, a deterministic model-package digest, dimensions, scale and
timing. The derived video uses high-quality lossy H.264, no frame reordering and
a capped bitrate; original audio remains separately owned by the project. The
editor keeps original source identity, privacy/cursor coordinates and timeline
edits while selecting this alternate visual asset for preview/export. An earlier
ProRes intermediate was rejected by actual Chromium decoding and is not the
production format.

Standard cancellation stops decoding, drains the producing writer and removes
only unpublished owned output. It never calls `cancelWriting` before writer
startup. Source/model hashes are rechecked before completion; existing output
directories or symlinks are not replaced.

`python3 native/test-super-resolution.py native/build/reva-capture
resources/models/PiperSR_2x.mlpackage /absolute/new-fixture-directory` verifies
actual neural inference, source/model hashes, orientation, exact three-frame VFR
timestamps with a leading gap, cancellation and collisions. The measured pixels
differ from bilinear interpolation; that establishes real inference, not quality
superiority or equivalence to the reference application's undisclosed model.
The actual production process wrapper and Chromium decoding were also exercised.
Large-recording throughput and simultaneous Core ML service/process-family memory
have not been measured.

Model attribution: PiperSR by Ben Racicot / ModelPiper
([modelpiper.com](https://modelpiper.com)), weights under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Weights are unmodified;
REVA supplies independent inference, tiling and video packaging.
