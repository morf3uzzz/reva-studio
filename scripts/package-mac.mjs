import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PackageTransaction, resolveSigningIdentity, signApp } from "./package-mac-support.mjs";
import { verifyModelResources } from "./model-resources.mjs";

if (process.platform !== "darwin")
  throw new Error("The local macOS bundle must be built on macOS.");
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageInfo = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const electronApp = process.env.REVA_ELECTRON_APP ?? path.resolve(require("electron"), "..", "..", "..");
const nativeHelper = process.env.REVA_NATIVE_HELPER ?? path.join(root, "native/build/reva-capture");
const outputRoot = process.env.REVA_PACKAGE_DIR ?? path.join(root, "build");
const finalApp = path.join(outputRoot, "REVA Studio.app");
const signing = await resolveSigningIdentity(process.env.REVA_CODESIGN_IDENTITY, run);
const transaction = new PackageTransaction({ finalApp, run });

for (const required of [
  "dist/index.html",
  "electron/main.cjs",
])
  await fs.access(path.join(root, required));
await fs.access(nativeHelper);
let failure;
let archive;
await verifyModelResources(path.join(root, "resources", "models"));
try {
  await transaction.open();
  const staging = transaction.staging;
  const resources = path.join(staging, "Contents", "Resources");
  const installed = path.join(resources, "app");
  if (signing.identity === "-")
    console.warn("Using an ad hoc signature: changed builds have different code identities, so macOS privacy permissions may need to be granted again. Set REVA_CODESIGN_IDENTITY to an existing valid signing certificate for identity continuity.");
  else console.log(`Signing with ${signing.name} (${signing.identity}).`);
  console.log("Creating a local REVA Studio.app bundle…");
  await run("/usr/bin/ditto", [electronApp, staging]);
  await fs.rm(path.join(resources, "default_app.asar"), { force: true });
  await fs.mkdir(installed, { recursive: true });
  await fs.cp(path.join(root, "dist"), path.join(installed, "dist"), {
    recursive: true,
  });
  await fs.cp(path.join(root, "electron"), path.join(installed, "electron"), {
    recursive: true,
    filter: (source) => !source.endsWith(".test.cjs"),
  });
  await fs.cp(path.join(root, "shared"), path.join(installed, "shared"), { recursive: true });
  await fs.cp(path.join(root, "resources"), path.join(installed, "resources"), { recursive: true });
  await verifyModelResources(path.join(installed, "resources", "models"));
  await fs.copyFile(
    path.join(root, "wallpapers.json"),
    path.join(installed, "wallpapers.json"),
  );
  await fs.copyFile(path.join(root, "cursors.json"), path.join(installed, "cursors.json"));
  await fs.cp(path.join(root, "locales"), path.join(installed, "locales"), {
    recursive: true,
  });
  await fs.mkdir(path.join(installed, "native", "build"), { recursive: true });
  await fs.copyFile(
    nativeHelper,
    path.join(installed, "native", "build", "reva-capture"),
  );
  await fs.chmod(
    path.join(installed, "native", "build", "reva-capture"),
    0o755,
  );
  await fs.writeFile(
    path.join(installed, "package.json"),
    JSON.stringify(
      {
        name: packageInfo.name,
        productName: "REVA Studio",
        version: packageInfo.version,
        main: "electron/main.cjs",
        type: "module",
      },
      null,
      2,
    ),
  );
  const plist = path.join(staging, "Contents", "Info.plist");
  const set = (key, type, value) =>
    run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]).catch(
      () =>
        run("/usr/libexec/PlistBuddy", [
          "-c",
          `Add :${key} ${type} ${value}`,
          plist,
        ]),
    );
  await set("CFBundleName", "string", "REVA Studio");
  await set("CFBundleDisplayName", "string", "REVA Studio");
  await set("CFBundleIdentifier", "string", "io.github.morf3uzzz.revastudio");
  await set("CFBundleShortVersionString", "string", packageInfo.version);
  await set("CFBundleVersion", "string", packageInfo.version);
  await fs.copyFile(path.join(root, ".cache/branding/REVA.icns"), path.join(resources,"REVA.icns"));
  await set("CFBundleIconFile", "string", "REVA.icns");
  await set("LSMinimumSystemVersion", "string", "14.0");
  await set(
    "NSCameraUsageDescription",
    "string",
    "REVA Studio records your camera only when you enable camera recording.",
  );
  await set(
    "NSMicrophoneUsageDescription",
    "string",
    "REVA Studio records your microphone only when you enable microphone recording.",
  );
  await set(
    "NSScreenCaptureUsageDescription",
    "string",
    "REVA Studio records the screen or window you select after you press Record.",
  );
  await set(
    "NSAudioCaptureUsageDescription",
    "string",
    "REVA Studio records system audio only when you enable system audio recording.",
  );
  await set("NSHighResolutionCapable", "bool", "true");
  await set("NSSpeechRecognitionUsageDescription", "string", "REVA Studio creates a transcript from the local audio you select only when you request transcription.");
  await set("NSCameraUseContinuityCameraDeviceType", "bool", "true");
  await set("LSApplicationCategoryType", "string", "public.app-category.video");
  await signApp(staging, signing.identity, run);
  archive = await transaction.publish();
} catch (error) {
  failure = error;
}
try { await transaction.close(); }
catch (error) {
  failure = failure ? new AggregateError([failure, error], "Packaging failed and cleanup remains incomplete.", { cause: failure }) : error;
}
if (failure) {
  if (transaction.archive) console.error(`Validated previous bundle retained at ${transaction.archive}`);
  if (transaction.committed) console.error(`The new app is installed at ${finalApp}; packaging cleanup remains incomplete.`);
  throw failure;
}
console.log(`Built ${finalApp}`);
if (archive) console.log(`Previous bundle retained as a verified ZIP at ${archive}`);
console.log("FFmpeg and ffprobe are read from the existing local installation.");
