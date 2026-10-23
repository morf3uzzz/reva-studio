import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const captureHelperRelativePath = "Contents/Resources/app/native/build/reva-capture";

// This is an admission check, not proof of process ownership. It never signals a PID.
// `comm` omits arguments; -ww prevents a terminal width from truncating an app path.
export async function assertAppNotRunning(app, run, io = fs) {
  const roots = new Set([path.resolve(app)]);
  try { roots.add(await io.realpath(app)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let stdout;
  try { ({ stdout } = await run("/bin/ps", ["-axww", "-o", "pid=,comm="])); }
  catch (error) {
    throw new Error(`Cannot inspect running processes; the app has not been replaced. ${String(error.stderr || error.message).trim()}`);
  }
  const lines = stdout.split("\n").filter(line => line.trim());
  if (!lines.length) throw new Error("Process inspection returned no processes; refusing to replace the app.");
  const matches = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 0)
      throw new Error("Process inspection returned an unreadable row; refusing to replace the app.");
    const [, pid, command] = match;
    const inApp = [...roots].some(root => command.startsWith(`${root}/Contents/`));
    // ps can fall back to a short name when command information is unavailable.
    // Such a possible recorder cannot establish that the target bundle is idle.
    const unresolved = /^(?:\()?\b(?:Electron(?: Helper(?: \([^)]+\))?)?|reva-capture)(?:\))?$/.test(command);
    if (inApp || unresolved) matches.push(`${pid}: ${command}`);
  }
  if (matches.length)
    throw new Error(`Quit REVA Studio completely before packaging; a main/helper process is running or cannot be distinguished from it:\n${matches.join("\n")}\nNo process was stopped.`);
}

export async function resolveSigningIdentity(requested, run) {
  if (requested === undefined || requested === "-") return { identity: "-", name: "ad hoc" };
  if (typeof requested !== "string" || !requested.trim())
    throw new Error("REVA_CODESIGN_IDENTITY must be an exact valid certificate name or its SHA-1 fingerprint.");
  const { stdout } = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = [];
  let count;
  for (const line of stdout.split("\n").filter(line => line.trim())) {
    const identity = /^\s*\d+\)\s+([0-9a-f]{40})\s+"(.*)"\s*$/i.exec(line);
    const summary = /^\s*(\d+) valid identities found\s*$/.exec(line);
    if (identity) identities.push({ identity: identity[1].toUpperCase(), name: identity[2] });
    else if (summary && count === undefined) count = Number(summary[1]);
    else throw new Error("Cannot validate the requested signing identity: security returned an unreadable identity list.");
  }
  if (count !== identities.length)
    throw new Error("Cannot validate the requested signing identity: security returned an incomplete identity list.");
  const selected = identities.filter(item => item.name === requested || item.identity === requested.toUpperCase());
  const unique = new Map(selected.map(item => [item.identity, item]));
  if (unique.size !== 1)
    throw new Error(unique.size ? "The signing certificate name is ambiguous; set REVA_CODESIGN_IDENTITY to its SHA-1 fingerprint." : `The requested REVA_CODESIGN_IDENTITY is not a valid local code-signing identity: ${requested}. No ad hoc fallback was used.`);
  return [...unique.values()][0];
}

export async function verifyApp(app, run) {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  // The helper is currently in Resources, so deep verification treats it as data.
  await run("/usr/bin/codesign", ["--verify", "--strict", path.join(app, captureHelperRelativePath)]);
}

export async function signApp(app, identity, run) {
  await run("/usr/bin/codesign", ["--force", "--sign", identity, "--identifier", "com.reva.studio.capture", path.join(app, captureHelperRelativePath)]);
  // Keep the bundle identifiers from each Electron component's Info.plist.
  await run("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, app]);
  await verifyApp(app, run);
}

async function optionalDirectory(io, directory) {
  try {
    const stat = await io.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected an app directory, not a link or other file: ${directory}`);
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function removeOwnedDirectory(io, directory, identity) {
  const current = await optionalDirectory(io, directory);
  if (!current) return;
  if (!identity || current.dev !== identity.dev || current.ino !== identity.ino)
    throw new Error(`Directory identity changed or could not be verified; refusing to remove ${directory}.`);
  try { await io.rm(directory, { recursive: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export class PackageTransaction {
  constructor({ finalApp, run, io = fs, assertStopped = assertAppNotRunning }) {
    Object.assign(this, { finalApp: path.resolve(finalApp), run, io, assertStopped });
    this.directory = null;
    this.lock = null;
    this.previousMoved = false;
    this.publicationStarted = false;
    this.committed = false;
    this.archive = null;
  }

  async open() {
    if (this.lock || this.directory || this.committed) throw new Error("This packaging transaction already owns an operation.");
    const output = path.dirname(this.finalApp);
    await this.io.mkdir(output, { recursive: true });
    const lock = path.join(output, ".REVA-Studio-package-lock");
    try { await this.io.mkdir(lock); }
    catch (error) {
      if (error.code === "EEXIST")
        throw new Error(`Another packaging operation or retained cleanup owns ${lock}. Inspect its owner.json and resolve that operation before packaging again; no files were removed.`);
      throw error;
    }
    this.lock = lock;
    this.lockIdentity = await this.io.lstat(lock);
    this.directory = await this.io.mkdtemp(path.join(output, ".REVA-Studio-package-"));
    this.directoryIdentity = await this.io.lstat(this.directory);
    this.staging = path.join(this.directory, "REVA Studio.app");
    this.previous = path.join(this.directory, "previous", "REVA Studio.app");
    await this.io.writeFile(path.join(lock, "owner.json"), JSON.stringify({
      pid: process.pid, workspace: this.directory, finalApp: this.finalApp,
      staging: this.staging, previous: this.previous,
    }, null, 2));
    await this.assertStopped(this.finalApp, this.run, this.io);
  }

  async publish() {
    if (!this.directory || this.publicationStarted) throw new Error("The packaging transaction is not open for publication.");
    this.publicationStarted = true;
    const original = await optionalDirectory(this.io, this.finalApp);
    if (original) {
      await this.assertStopped(this.finalApp, this.run, this.io);
      const archive = path.join(this.directory, "previous.zip");
      const extracted = path.join(this.directory, "verify");
      await this.run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", this.finalApp, archive]);
      await this.run("/usr/bin/unzip", ["-tq", archive]);
      await this.run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
      await verifyApp(path.join(extracted, path.basename(this.finalApp)), this.run);
      // link publishes without overwriting an existing backup, even on a name collision.
      const retained = path.join(path.dirname(this.finalApp), `REVA Studio.previous-${Date.now()}-${crypto.randomUUID()}.zip`);
      await this.io.link(archive, retained);
      this.archive = retained;
    }
    await this.assertStopped(this.finalApp, this.run, this.io);
    const current = await optionalDirectory(this.io, this.finalApp);
    if (original ? !current || current.dev !== original.dev || current.ino !== original.ino : current)
      throw new Error("The installed app changed during packaging; it has not been replaced. Retry after resolving the other operation.");
    if (original) {
      await this.io.mkdir(path.dirname(this.previous));
      await this.io.rename(this.finalApp, this.previous);
      this.previousMoved = true;
      this.previousIdentity = original;
    }
    // close() owns rollback and cleanup on every exit path. Keeping that work in
    // one owner preserves the installation error separately from cleanup failures.
    await this.io.rename(this.staging, this.finalApp);
    this.committed = true;
    return this.archive;
  }

  async rollback() {
    if (!this.previousMoved || this.committed) return;
    const previous = await optionalDirectory(this.io, this.previous);
    if (!previous || previous.dev !== this.previousIdentity.dev || previous.ino !== this.previousIdentity.ino)
      throw new Error(`The previous app's identity changed; refusing to restore an unverified replacement at ${this.previous}. Validated ZIP: ${this.archive}.`);
    if (await optionalDirectory(this.io, this.finalApp))
      throw new Error(`Cannot restore the previous app because ${this.finalApp} now exists. Previous app retained at ${this.previous}; validated ZIP: ${this.archive}.`);
    try { await this.io.rename(this.previous, this.finalApp); }
    catch (error) { throw new Error(`Could not restore the previous app. It remains at ${this.previous}; validated ZIP: ${this.archive}.`, { cause: error }); }
    this.previousMoved = false;
    this.previousIdentity = null;
  }

  async close() {
    // A failed rollback retains both app copies, its ZIP and the lock for recovery.
    await this.rollback();
    if (this.directory) {
      try { await removeOwnedDirectory(this.io, this.directory, this.directoryIdentity); }
      catch (error) { throw new Error(`Packaging cleanup is incomplete. Retained workspace: ${this.directory}; lock: ${this.lock}; installed app: ${this.finalApp}; validated ZIP: ${this.archive ?? "none"}. Retry cleanup before packaging again.`, { cause: error }); }
      this.directory = null;
      this.directoryIdentity = null;
    }
    if (this.lock) {
      try { await removeOwnedDirectory(this.io, this.lock, this.lockIdentity); }
      catch (error) { throw new Error(`Packaging cleanup could not release ${this.lock}. Installed app: ${this.finalApp}; validated ZIP: ${this.archive ?? "none"}.`, { cause: error }); }
      this.lock = null;
      this.lockIdentity = null;
    }
  }
}
