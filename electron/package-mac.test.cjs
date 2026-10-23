"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const support = import("../scripts/package-mac-support.mjs");
const exec = promisify(execFile);
const firstHash = "1234567890ABCDEF1234567890ABCDEF12345678";
const secondHash = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";

async function writeApp(app, value) {
  const { captureHelperRelativePath } = await support;
  await fs.mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  await fs.mkdir(path.dirname(path.join(app, captureHelperRelativePath)), { recursive: true });
  await fs.writeFile(path.join(app, "Contents", "MacOS", "Electron"), value, { mode: 0o755 });
  await fs.writeFile(path.join(app, captureHelperRelativePath), `helper-${value}`, { mode: 0o755 });
  await fs.symlink("Electron", path.join(app, "Contents", "MacOS", "linked"));
}

const appValue = app => fs.readFile(path.join(app, "Contents", "MacOS", "Electron"), "utf8");

async function fixture(t, options = {}) {
  const { PackageTransaction } = await support;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-package-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const finalApp = path.join(directory, "REVA Studio.app");
  if (options.original !== false) await writeApp(finalApp, "original");
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    const override = await options.command?.(command, args, calls);
    if (override !== undefined) return override;
    if (command === "/bin/ps") return { stdout: " 12 /sbin/launchd\n 13 /bin/ps\n" };
    if (command === "/usr/bin/codesign") {
      // Synthetic bundles are never signed or executed. Exercise real ZIP creation,
      // CRC checking and extraction; the signature verifier is the failure seam.
      await fs.access(args.at(-1));
      return { stdout: "", stderr: "" };
    }
    return exec(command, args);
  };
  const transaction = new PackageTransaction({ finalApp, run, ...(options.io ? { io: options.io } : {}) });
  return { directory, finalApp, calls, run, transaction };
}

test("process admission handles app paths with spaces and rejects a native helper without a main process", async () => {
  const { assertAppNotRunning } = await support;
  const app = "/Applications/REVA Studio.app";
  const io = { realpath: async value => value };
  for (const command of [`${app}/Contents/MacOS/Electron`, `${app}/Contents/Resources/app/native/build/reva-capture`, `${app}/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper`]) {
    await assert.rejects(assertAppNotRunning(app, async (tool, args) => {
      assert.equal(tool, "/bin/ps");
      assert.deepEqual(args, ["-axww", "-o", "pid=,comm="]);
      return { stdout: ` 231 ${command}\n` };
    }, io), /Quit REVA Studio completely.*\n231:/);
  }
  await assertAppNotRunning(app, async () => ({ stdout: " 12 /Applications/Other Electron.app/Contents/MacOS/Electron\n 13 /Applications/REVA Studio.previous-1.app/Contents/MacOS/Electron\n" }), io);
});

test("process admission fails closed on failed, malformed, empty or unresolved inspection", async () => {
  const { assertAppNotRunning } = await support;
  const io = { realpath: async () => "/real/REVA Studio.app" };
  for (const stdout of ["", "not a process\n", "19 (Electron)\n", "20 reva-capture\n", "21 /real/REVA Studio.app/Contents/MacOS/Electron\n"])
    await assert.rejects(assertAppNotRunning("/alias/REVA Studio.app", async () => ({ stdout }), io));
  await assert.rejects(assertAppNotRunning("/Applications/REVA Studio.app", async () => { throw new Error("inspection denied"); }, io), /Cannot inspect running processes.*inspection denied/);
});

test("signing selection pins an exact available identity and never silently falls back", async () => {
  const { resolveSigningIdentity } = await support;
  const run = async () => ({ stdout: ` 1) ${firstHash} "Apple Development: Local Dev"\n 2) ${secondHash} "Apple Development: Local Dev"\n 2 valid identities found\n` });
  assert.deepEqual(await resolveSigningIdentity(firstHash.toLowerCase(), run), { identity: firstHash, name: "Apple Development: Local Dev" });
  assert.equal((await resolveSigningIdentity("Apple Development: Local Dev", async () => ({ stdout: `1) ${firstHash} "Apple Development: Local Dev"\n1 valid identities found\n` }))).identity, firstHash);
  await assert.rejects(resolveSigningIdentity("Apple Development: Local Dev", run), /ambiguous/);
  await assert.rejects(resolveSigningIdentity("unavailable", run), /No ad hoc fallback/);
  await assert.rejects(resolveSigningIdentity("", run), /must be an exact/);
  await assert.rejects(resolveSigningIdentity(firstHash, async () => ({ stdout: "0 valid identities found\n" })), /not a valid local/);
  await assert.rejects(resolveSigningIdentity(firstHash, async () => ({ stdout: `1) ${firstHash} "Name"\n 2 valid identities found\n` })), /incomplete identity list/);
  assert.equal((await resolveSigningIdentity(undefined, async () => assert.fail("Default ad hoc does not consult Keychain"))).identity, "-");
  assert.equal((await resolveSigningIdentity("-", run)).identity, "-");
});

test("signing explicitly signs the capture helper before the app and verifies both", async () => {
  const { signApp, captureHelperRelativePath } = await support;
  const calls = [], app = "/staging/REVA Studio.app";
  await signApp(app, firstHash, async (tool, args) => { calls.push({ tool, args }); });
  assert.deepEqual(calls.map(call => call.args), [
    ["--force", "--sign", firstHash, "--identifier", "com.reva.studio.capture", path.join(app, captureHelperRelativePath)],
    ["--force", "--deep", "--sign", firstHash, app],
    ["--verify", "--deep", "--strict", app],
    ["--verify", "--strict", path.join(app, captureHelperRelativePath)],
  ]);
  assert.ok(calls.every(call => call.tool === "/usr/bin/codesign"));
  let attempted = 0;
  await assert.rejects(signApp(app, firstHash, async () => { attempted++; throw new Error("signing failed"); }), /signing failed/);
  assert.equal(attempted, 1);
});

test("publication retains a real verified ZIP, preserves symlinks and leaves one app", async t => {
  const f = await fixture(t);
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  const archive = await f.transaction.publish();
  assert.equal(await appValue(f.finalApp), "replacement");
  const restore = path.join(f.directory, "restore");
  await exec("/usr/bin/ditto", ["-x", "-k", archive, restore]);
  assert.equal(await appValue(path.join(restore, "REVA Studio.app")), "original");
  assert.equal(await fs.readlink(path.join(restore, "REVA Studio.app", "Contents", "MacOS", "linked")), "Electron");
  assert.equal((await fs.stat(path.join(restore, "REVA Studio.app", "Contents", "MacOS", "Electron"))).mode & 0o777, 0o755);
  await fs.rm(restore, { recursive: true });
  await f.transaction.close();
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ["REVA Studio.app", path.basename(archive)].sort());
  assert.equal(f.calls.filter(call => call.command === "/bin/ps").length, 3);
});

test("first installation creates no previous archive", async t => {
  const f = await fixture(t, { original: false });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "first");
  assert.equal(await f.transaction.publish(), null);
  await f.transaction.close();
  assert.deepEqual(await fs.readdir(f.directory), ["REVA Studio.app"]);
});

test("corrupt ZIP and failed restored signature leave the original app untouched", async t => {
  for (const failure of ["zip", "signature"]) {
    const f = await fixture(t, { command: async (command, args) => {
      if (failure === "zip" && command === "/usr/bin/unzip") await fs.writeFile(args.at(-1), "corrupt");
      if (failure === "signature" && command === "/usr/bin/codesign") throw new Error("restored signature is invalid");
    } });
    await f.transaction.open();
    await writeApp(f.transaction.staging, "replacement");
    await assert.rejects(f.transaction.publish());
    assert.equal(await appValue(f.finalApp), "original");
    assert.equal(f.transaction.previousMoved, false);
    assert.equal(f.transaction.archive, null);
    await f.transaction.close();
    assert.deepEqual(await fs.readdir(f.directory), ["REVA Studio.app"]);
  }
});

test("a helper launched during archival prevents publication and keeps the validated backup", async t => {
  let snapshots = 0;
  const f = await fixture(t, { command: async command => {
    if (command === "/bin/ps" && ++snapshots === 3)
      return { stdout: `42 ${f.finalApp}/Contents/Resources/app/native/build/reva-capture\n` };
  } });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await assert.rejects(f.transaction.publish(), /Quit REVA Studio completely/);
  assert.equal(await appValue(f.finalApp), "original");
  assert.ok(f.transaction.archive);
  await f.transaction.close();
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ["REVA Studio.app", path.basename(f.transaction.archive)].sort());
});

test("failed installation restores the original app and retains its verified ZIP", async t => {
  const io = { ...fs, rename: async (from, to) => {
    if (from === f.transaction.staging) throw new Error("installation failed");
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { io });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await assert.rejects(f.transaction.publish(), /installation failed/);
  await f.transaction.close();
  assert.equal(await appValue(f.finalApp), "original");
  assert.equal(f.transaction.previousMoved, false);
  await fs.access(f.transaction.archive);
});

test("rollback failure retains both copies and blocks a new package until retry restores the app", async t => {
  let restorationFails = true;
  const io = { ...fs, rename: async (from, to) => {
    if (from === f.transaction.staging) throw new Error("installation failed");
    if (from === f.transaction.previous && restorationFails) throw new Error("restoration failed");
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { io });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await assert.rejects(f.transaction.publish(), /installation failed/);
  await assert.rejects(f.transaction.close(), /Could not restore the previous app/);
  await assert.rejects(f.transaction.publish(), /not open for publication/);
  assert.equal(await appValue(f.transaction.previous), "original");
  assert.equal(await appValue(f.transaction.staging), "replacement");
  await fs.access(f.transaction.archive);
  const { PackageTransaction } = await support;
  const other = new PackageTransaction({ finalApp: f.finalApp, run: f.run });
  await assert.rejects(other.open(), /retained cleanup owns/);
  await other.close();
  await fs.access(f.transaction.lock);
  restorationFails = false;
  await f.transaction.close();
  assert.equal(await appValue(f.finalApp), "original");
  assert.equal(f.transaction.directory, null);
  assert.equal(f.transaction.lock, null);
});

test("failed final cleanup retains its owner and retries without losing the installed app or archive", async t => {
  let removalFails = true;
  const io = { ...fs, rm: async (target, options) => {
    if (target === f.transaction.directory && removalFails) throw new Error("cleanup denied");
    return fs.rm(target, options);
  } };
  const f = await fixture(t, { io });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await f.transaction.publish();
  await assert.rejects(f.transaction.close(), /Packaging cleanup is incomplete/);
  assert.equal(await appValue(f.finalApp), "replacement");
  await fs.access(f.transaction.archive);
  const owner = JSON.parse(await fs.readFile(path.join(f.transaction.lock, "owner.json"), "utf8"));
  assert.equal(owner.workspace, f.transaction.directory);
  removalFails = false;
  await f.transaction.close();
  assert.equal(f.transaction.directory, null);
  assert.equal(f.transaction.lock, null);
});

test("failure to retain the ZIP prevents any app move", async t => {
  const f = await fixture(t, { io: { ...fs, link: async () => { throw new Error("archive publication failed"); } } });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await assert.rejects(f.transaction.publish(), /archive publication failed/);
  assert.equal(await appValue(f.finalApp), "original");
  assert.equal(f.transaction.previousMoved, false);
  await f.transaction.close();
});

test("the initial process guard refuses staging while the installed app is running", async t => {
  const f = await fixture(t, { command: async command => command === "/bin/ps" ? { stdout: `42 ${f.finalApp}/Contents/MacOS/Electron\n` } : undefined });
  await assert.rejects(f.transaction.open(), /Quit REVA Studio completely/);
  assert.equal(f.calls.length, 1);
  await f.transaction.close();
  assert.equal(await appValue(f.finalApp), "original");
  assert.deepEqual(await fs.readdir(f.directory), ["REVA Studio.app"]);
});

test("an externally replaced app is not overwritten after archive verification", async t => {
  let snapshots = 0;
  const f = await fixture(t, { command: async command => {
    if (command === "/bin/ps" && ++snapshots === 3) {
      await fs.rename(f.finalApp, path.join(f.directory, "externally moved.app"));
      await writeApp(f.finalApp, "external replacement");
    }
  } });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await assert.rejects(f.transaction.publish(), /installed app changed during packaging/);
  await f.transaction.close();
  assert.equal(await appValue(f.finalApp), "external replacement");
  assert.equal(await appValue(path.join(f.directory, "externally moved.app")), "original");
});

test("lock cleanup failure retains only the unresolved lock and can be retried", async t => {
  let removalFails = true;
  const io = { ...fs, rm: async (target, options) => {
    if (target === f.transaction.lock && removalFails) throw new Error("lock cleanup denied");
    return fs.rm(target, options);
  } };
  const f = await fixture(t, { io });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await f.transaction.publish();
  await assert.rejects(f.transaction.close(), /could not release/);
  assert.equal(f.transaction.directory, null);
  await fs.access(f.transaction.lock);
  assert.equal(await appValue(f.finalApp), "replacement");
  removalFails = false;
  await f.transaction.close();
  assert.equal(f.transaction.lock, null);
});

test("existing previous app bundles are preserved without migration", async t => {
  const f = await fixture(t);
  const existing = path.join(f.directory, "REVA Studio.previous-123.app");
  await writeApp(existing, "older backup");
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await f.transaction.publish();
  await f.transaction.close();
  assert.equal(await appValue(existing), "older backup");
  assert.ok(f.transaction.archive.endsWith(".zip"));
});

test("cleanup retry never removes a replacement lock at the same path", async t => {
  const f = await fixture(t);
  await f.transaction.open();
  const retainedLock = path.join(f.directory, "original-lock");
  await fs.rename(f.transaction.lock, retainedLock);
  await fs.mkdir(f.transaction.lock);
  await fs.writeFile(path.join(f.transaction.lock, "foreign-owner"), "keep");
  await assert.rejects(f.transaction.close(), error => /could not release/.test(error.message) && /identity changed/.test(error.cause.message));
  assert.equal(f.transaction.directory, null);
  assert.equal(await fs.readFile(path.join(f.transaction.lock, "foreign-owner"), "utf8"), "keep");
  await fs.rm(f.transaction.lock, { recursive: true });
  await fs.rename(retainedLock, f.transaction.lock);
  await f.transaction.close();
  assert.equal(f.transaction.lock, null);
});

test("cleanup of an already removed owned directory releases the remaining lock", async t => {
  const f = await fixture(t);
  await f.transaction.open();
  await fs.rm(f.transaction.directory, { recursive: true });
  await f.transaction.close();
  assert.equal(f.transaction.directory, null);
  assert.equal(f.transaction.lock, null);
  assert.equal(await appValue(f.finalApp), "original");
});

test("rollback rejects a substituted previous app and preserves the validated archive", async t => {
  const io = { ...fs, rename: async (from, to) => {
    if (from === f.transaction.staging) throw new Error("installation failed");
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { io });
  await f.transaction.open();
  await writeApp(f.transaction.staging, "replacement");
  await assert.rejects(f.transaction.publish(), /installation failed/);
  const original = path.join(f.directory, "moved-original.app");
  await fs.rename(f.transaction.previous, original);
  await writeApp(f.transaction.previous, "substitution");
  await assert.rejects(f.transaction.close(), /previous app's identity changed/);
  await assert.rejects(fs.access(f.finalApp), { code: "ENOENT" });
  await fs.access(f.transaction.archive);
  await fs.access(f.transaction.lock);
  await fs.rm(f.transaction.previous, { recursive: true });
  await fs.rename(original, f.transaction.previous);
  await f.transaction.close();
  assert.equal(await appValue(f.finalApp), "original");
});
