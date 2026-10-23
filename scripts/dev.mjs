import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");
const vite = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin",
  "vite.js",
);
const children = new Set();
let stopping = false;

function run(command, args, extra = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", ...extra });
  children.add(child);
  child.once("close", () => children.delete(child));
  child.once("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 5000);
  Promise.all(
    [...children].map(
      (child) => new Promise((resolve) => child.once("close", resolve)),
    ),
  ).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));

try {
  await fs.access(path.join(root, "native", "build", "reva-capture"));
} catch {
  console.log("Building the macOS capture helper…");
  const native = run("/bin/bash", ["scripts/build-native.sh"]);
  const code = await new Promise((resolve) => native.once("close", resolve));
  if (code !== 0) {
    console.error("The native helper did not build.");
    process.exit(code || 1);
  }
}

const server = run(process.execPath, [
  vite,
  "--host",
  "127.0.0.1",
  "--port",
  "5178",
  "--strictPort",
]);
server.once("close", (code) => {
  if (!stopping) stop(code || 0);
});
let ready = false;
for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
  try {
    const response = await fetch("http://127.0.0.1:5178");
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* Wait for our dev server. */
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) {
  console.error("Vite did not start on http://127.0.0.1:5178.");
  stop(1);
} else {
  const environment = { ...process.env, REVA_DEV_URL: "http://127.0.0.1:5178" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const desktop = run(electron, ["."], { env: environment });
  desktop.once("close", (code) => {
    if (!stopping) stop(code || 0);
  });
}
