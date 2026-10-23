"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const wallpaperCatalog = require("../wallpapers.json");

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 8192 * 4320;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_FAVORITES = 1000;
const IMAGE_HOSTS = new Set(["images.unsplash.com", "hd.unsplash.com", "plus.unsplash.com"]);
const DOCS = Object.freeze({ api: "https://unsplash.com/documentation", guidelines: "https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines" });

class BackgroundFailure extends Error {
  constructor(code, message) { super(message); this.name = "BackgroundFailure"; this.code = code; }
}
const fail = (code, message) => { throw new BackgroundFailure(code, message); };
const obj = (v, label) => { if (!v || typeof v !== "object" || Array.isArray(v)) fail("invalid_data", `${label} must be an object.`); return v; };
const str = (v, label, max = 8192) => { if (typeof v !== "string" || v.length > max || v.includes("\0")) fail("invalid_data", `${label} is invalid.`); return v; };
const integer = (v, min, max, label) => { if (!Number.isSafeInteger(v) || v < min || v > max) fail("invalid_data", `${label} is out of range.`); return v; };
function safeURL(value, hosts, label) {
  let url; const source = str(value, label);
  try { url = new URL(source); } catch { fail("unsafe_url", `${label} is not a valid URL.`); }
  if (/[\x00-\x20\x7f]/.test(source)) fail("unsafe_url", `${label} contains unencoded whitespace or controls.`);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) fail("unsafe_url", `${label} must use an official HTTPS Unsplash host.`);
  // client_id is documented API transport authentication, unlike ixid, which
  // is image attribution/view metadata and must be retained.
  if (url.searchParams.has("client_id") || url.searchParams.has("access_token")) fail("unsafe_url", `${label} contains transport credentials.`);
  return source;
}
function referralURL(value) {
  const url = new URL(safeURL(value, new Set(["unsplash.com", "www.unsplash.com"]), "Attribution URL"));
  url.searchParams.set("utm_source", "reva_studio"); url.searchParams.set("utm_medium", "referral"); return url.href;
}
function imageFavoriteID(sha256, sourcePath, photo) {
  const identity = photo ? `unsplash:${photo.id}` : sourcePath;
  return `image-${crypto.createHash("sha256").update(`${sha256}\0${identity}`).digest("hex")}`;
}
function parseBackgroundImageSource(input) {
  const v = obj(input, "Background image source"), sha256 = str(v.sha256, "Background image digest", 64);
  if (!/^[\da-f]{64}$/.test(sha256)) fail("invalid_data", "Background image digest is invalid.");
  const downloadedAt = v.downloadedAt === undefined ? undefined : str(v.downloadedAt, "Image download date", 128);
  if (downloadedAt !== undefined && !Number.isFinite(Date.parse(downloadedAt))) fail("invalid_data", "Image download date is invalid.");
  return { sha256, ...(v.downloadURL === undefined ? {} : { downloadURL: safeURL(v.downloadURL, IMAGE_HOSTS, "Downloaded image URL") }), ...(downloadedAt === undefined ? {} : { downloadedAt }) };
}
function parseUnsplashPhoto(input, requestKey) {
  const v = obj(input, "Unsplash photo"), urls = obj(v.urls, "Unsplash photo URLs"), links = obj(v.links, "Unsplash photo links");
  const id = str(v.id, "Unsplash photo ID", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail("invalid_data", "Unsplash photo ID is invalid.");
  const photographer = v.photographer ? obj(v.photographer, "Photographer") : obj(v.user, "Photographer");
  const downloadLocation = safeURL(links.downloadLocation ?? links.download_location, new Set(["api.unsplash.com"]), "Download tracking URL");
  if (new URL(downloadLocation).pathname !== `/photos/${id}/download`) fail("unsafe_url", "Download tracking URL belongs to another photo.");
  const imageURLs = Object.fromEntries(["raw", "full", "regular", "small", "thumb"].map(key => [key, safeURL(urls[key], IMAGE_HOSTS, "Photo image URL")]));
  const nullable = (value, label, max = 16384) => value == null ? null : str(value, label, max);
  const color = nullable(v.color, "Photo color", 32);
  if (color && !/^#[\da-f]{6}$/i.test(color)) fail("invalid_data", "Unsplash photo color is invalid.");
  const photo = { id, width: integer(v.width, 1, Number.MAX_SAFE_INTEGER, "Photo width"), height: integer(v.height, 1, Number.MAX_SAFE_INTEGER, "Photo height"),
    description: nullable(v.description, "Photo description"), altDescription: nullable(v.altDescription ?? v.alt_description, "Photo alt text"), color,
    urls: imageURLs, links: { html: safeURL(links.html, new Set(["unsplash.com", "www.unsplash.com"]), "Photo link"), downloadLocation },
    photographer: { name: str(photographer.name, "Photographer name", 1024), username: str(photographer.username, "Photographer username", 256),
      profileURL: safeURL(photographer.profileURL ?? photographer.links?.html, new Set(["unsplash.com", "www.unsplash.com"]), "Photographer link") } };
  if (requestKey && JSON.stringify(photo).includes(requestKey)) fail("invalid_response", "Photo metadata contains request credentials and cannot be retained.");
  return photo;
}
function accessKey(value) {
  if (typeof value !== "string" || !value.trim()) fail("access_key_required", "Enter your Unsplash access key to search or select online photos.");
  const key = value.trim();
  if (key.length > 4096 || /[^\x21-\x7e]/.test(key)) fail("invalid_access_key", "The Unsplash access key is invalid.");
  return key;
}
async function boundedBytes(response, maximum, signal) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { await response.body?.cancel().catch(() => {}); fail("capacity", "The remote response exceeds its size bound."); }
  if (!response.body) fail("invalid_response", "The remote response has no body.");
  const chunks = []; let length = 0;
  for await (const bytes of response.body) {
    if (signal?.aborted) fail("cancelled", "The background request was cancelled.");
    length += bytes.byteLength;
    if (length > maximum) { await response.body.cancel?.().catch(() => {}); fail("capacity", "The remote response exceeds its size bound."); }
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}
async function readJSON(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) fail("invalid_data", "Favorite metadata is invalid or too large.");
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1); let size = 0;
    while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size); if (!bytesRead) break; size += bytesRead; }
    if (size > MAX_RECORD_BYTES) fail("capacity", "Favorite metadata grew beyond its size bound.");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { await handle.close(); }
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset); if (!bytesWritten) fail("write_failed", "Cannot write the background image."); offset += bytesWritten; }
}
async function imageInfo(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_IMAGE_BYTES) fail("capacity", "Background images must be regular files no larger than 32 MiB.");
    const head = Buffer.alloc(32); await handle.read(head, 0, 32, 0);
    let width, height, extension;
    if (head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && head.toString("ascii", 12, 16) === "IHDR") { width = head.readUInt32BE(16); height = head.readUInt32BE(20); extension = "png"; }
    else if (["GIF87a", "GIF89a"].includes(head.toString("ascii", 0, 6))) { width = head.readUInt16LE(6); height = head.readUInt16LE(8); extension = "gif"; }
    else if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
      const kind = head.toString("ascii", 12, 16);
      if (kind === "VP8X") { width = head.readUIntLE(24, 3) + 1; height = head.readUIntLE(27, 3) + 1; }
      else if (kind === "VP8L" && head[20] === 0x2f) { const bits = head.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      else if (kind === "VP8 " && head.subarray(23, 26).equals(Buffer.from([0x9d,0x01,0x2a]))) { width = head.readUInt16LE(26) & 0x3fff; height = head.readUInt16LE(28) & 0x3fff; }
      extension = "webp";
    } else if (head[0] === 0xff && head[1] === 0xd8) {
      let offset = 2;
      const marker = Buffer.alloc(9);
      for (let index = 0; index < 4096 && offset + 4 < stat.size; index++) {
        await handle.read(marker, 0, 4, offset);
        if (marker[0] !== 0xff) break;
        if (marker[1] === 0xff) { offset++; continue; }
        if ([0xd8,0xd9,0x01].includes(marker[1])) { offset += 2; continue; }
        const length = marker.readUInt16BE(2);
        if (length < 2 || offset + length + 2 > stat.size) break;
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker[1])) {
          await handle.read(marker, 0, 9, offset); height = marker.readUInt16BE(5); width = marker.readUInt16BE(7); extension = "jpg"; break;
        }
        offset += length + 2;
      }
    }
    if (!width || !height || !extension) fail("unsupported_image", "Use a supported PNG, JPEG, WebP or GIF background image.");
    if (width * height > MAX_IMAGE_PIXELS) fail("capacity", "The background image exceeds the 8192×4320 decoded pixel budget.");
    return { width, height, extension, size: stat.size };
  } finally { await handle.close(); }
}

/** Official API adapter and an owned local asset/favorite store. Keys live only in requests. */
class BackgroundAssets {
  constructor({ root, grants, fetchImpl = globalThis.fetch, validateImage = null, timeoutMs = 45000 }) {
    Object.assign(this, { root, grants, fetchImpl, validateImage, timeoutMs });
    this.requests = new Set(); this.pendingCleanup = new Map(); this.operations = new Set(); this.serial = Promise.resolve(); this.closed = false;
  }
  async directory() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.root)).isDirectory()) fail("invalid_directory", "The background library path was replaced.");
    // The cache owns canonical paths. Keep user-selected original sourcePath
    // separately; /var and /private/var aliases must not create two asset IDs.
    this.root = await fs.realpath(this.root);
    for (const folder of [path.join(this.root, "Images"), path.join(this.root, "Favorites"), path.join(this.root, "Removed")]) {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      if (!(await fs.lstat(folder)).isDirectory()) fail("invalid_directory", "The background library path was replaced.");
    }
    return this.root;
  }
  track(work) {
    if (this.closed) return Promise.reject(new BackgroundFailure("closed", "The background library is closing."));
    const operation = Promise.resolve().then(() => { if (this.closed) fail("closed", "The background library is closing."); return work(); }); this.operations.add(operation);
    operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation)); return operation;
  }
  mutate(work) {
    const previous = this.serial;
    const operation = this.track(() => previous.then(work));
    this.serial = operation.catch(() => {}); return operation;
  }
  async request(url, key, controller) {
    const api = new URL(url).hostname === "api.unsplash.com";
    const response = await this.fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal,
      headers: api ? { Authorization: `Client-ID ${key}`, "Accept-Version": "v1", Accept: "application/json" } : { Accept: "image/jpeg,image/png,image/webp" } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) fail("invalid_access_key", "Unsplash rejected this access key.");
      if (response.status === 403 || response.status === 429) fail("rate_limited", "Unsplash denied this request or its rate limit has been reached. Try again later.");
      fail("request_failed", `Unsplash returned HTTP ${response.status}.`);
    }
    return response;
  }
  network(work) {
    return this.track(async () => {
      const controller = new AbortController(); this.requests.add(controller);
      if (this.requests.size > 4) { this.requests.delete(controller); fail("capacity", "Wait for an active background request to finish before starting another."); }
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try { const value = await work(controller); if (controller.signal.aborted) fail("cancelled", "The background request was cancelled or timed out."); return value; }
      catch (error) {
        const cancelled = controller.signal.aborted; controller.abort();
        if (error instanceof BackgroundFailure) throw error;
        if (cancelled) fail("cancelled", "The background request was cancelled or timed out.");
        fail("request_failed", "Cannot reach Unsplash or read its response. Check the connection and try again.");
      } finally { clearTimeout(timer); this.requests.delete(controller); }
    });
  }
  search(query, page, keyInput) {
    const key = accessKey(keyInput), term = str(query, "Search query", 4096).trim();
    if (!term) fail("invalid_query", "Enter a photo search query.");
    integer(page, 1, Number.MAX_SAFE_INTEGER, "Search page");
    const url = new URL("https://api.unsplash.com/search/photos");
    url.searchParams.set("query", term); url.searchParams.set("page", String(page)); url.searchParams.set("per_page", "24"); url.searchParams.set("orientation", "landscape");
    if (url.href.length > 16384) fail("capacity", "This search exceeds the 16 KiB request URL budget.");
    return this.network(async controller => {
      const response = await this.request(url.href, key, controller);
      const raw = obj(JSON.parse((await boundedBytes(response, MAX_JSON_BYTES, controller.signal)).toString("utf8")), "Unsplash search response");
      if (!Array.isArray(raw.results) || raw.results.length > 30) fail("invalid_response", "Unsplash returned an invalid result page.");
      const photos = [], ids = new Set(); let omitted = 0;
      for (const item of raw.results) { try { const photo = parseUnsplashPhoto(item, key); if (ids.has(photo.id)) { omitted++; continue; } ids.add(photo.id); photos.push(photo); } catch { omitted++; } }
      const remaining = response.headers.get("x-ratelimit-remaining");
      return { query: term, page, total: integer(raw.total, 0, Number.MAX_SAFE_INTEGER, "Photo result total"), totalPages: integer(raw.total_pages, 0, Number.MAX_SAFE_INTEGER, "Photo page total"), photos, omitted,
        rateLimitRemaining: remaining && /^\d+$/.test(remaining) ? Number(remaining) : null };
    });
  }
  importPhoto(input, keyInput) {
    const key = accessKey(keyInput), photo = parseUnsplashPhoto(input, key);
    // The download event is tracked for each explicit selection, even if a
    // previous download is locally cached. It is not an image embedding URL.
    return this.network(async controller => {
      await this.directory();
      const tracking = await this.request(photo.links.downloadLocation, key, controller);
      await boundedBytes(tracking, MAX_JSON_BYTES, controller.signal);
      const url = new URL(photo.urls.raw);
      url.searchParams.delete("auto"); url.searchParams.set("fm", "jpg"); url.searchParams.set("w", "3840"); url.searchParams.set("h", "3840"); url.searchParams.set("fit", "max"); url.searchParams.set("q", "85");
      const response = await this.request(url.href, null, controller);
      let stored;
      try { stored = await this.storeImage(response.body, response.headers.get("content-length"), controller.signal); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      return { path: stored.path, photo, sha256: stored.sha256, downloadURL: url.href, downloadedAt: new Date().toISOString() };
    });
  }
  async cleanupFile(file) {
    const identity = this.pendingCleanup.get(file); if (!identity) return;
    let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") { this.pendingCleanup.delete(file); return; } throw error; }
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) fail("cleanup_identity", "An owned background temporary file was replaced; cleanup needs attention.");
    await fs.unlink(file); this.pendingCleanup.delete(file);
  }
  async cleanup() {
    for (const file of this.pendingCleanup.keys()) await this.cleanupFile(file);
  }
  async storeImage(body, declaredSize, signal) {
    if (!body) fail("invalid_response", "The selected photo has no image data.");
    if (declaredSize && (!/^\d+$/.test(String(declaredSize)) || Number(declaredSize) > MAX_IMAGE_BYTES)) fail("capacity", "The background image exceeds the 32 MiB download bound.");
    await this.directory();
    const temporary = path.join(this.root, "Images", `.${crypto.randomUUID()}.tmp`), handle = await fs.open(temporary, "wx", 0o600);
    this.pendingCleanup.set(temporary, await handle.stat());
    let sha256, total = 0;
    try {
      const hash = crypto.createHash("sha256");
      try {
        for await (const chunk of body) {
          if (signal?.aborted) fail("cancelled", "The image selection was cancelled.");
          total += chunk.byteLength;
          if (total > MAX_IMAGE_BYTES) fail("capacity", "The background image exceeds the 32 MiB download bound.");
          const bytes = Buffer.from(chunk); await writeAll(handle, bytes); hash.update(bytes);
        }
        await handle.sync(); sha256 = hash.digest("hex");
      } finally { await handle.close(); }
      const info = await imageInfo(temporary);
      if (this.validateImage) await this.validateImage(temporary, info);
      if (signal?.aborted) fail("cancelled", "The image selection was cancelled.");
      const file = path.join(this.root, "Images", `${sha256}.${info.extension}`);
      try { await fs.link(temporary, file); } catch (error) { if (error.code !== "EEXIST") throw error; if (await this.imageDigest(file) !== sha256) fail("cache_changed", "An existing background cache file has changed and was preserved."); }
      return { path: await this.grants.grant(file), sha256, extension: info.extension };
    } finally { await this.cleanupFile(temporary); }
  }
  async imageDigest(file) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) fail("cache_changed", "A cached background file is invalid.");
      const hash = crypto.createHash("sha256"); for await (const data of handle.createReadStream({ autoClose: false })) hash.update(data); return hash.digest("hex");
    } finally { await handle.close(); }
  }
  parseFavorite(input) {
    const v = obj(input, "Background favorite");
    if (v.version !== 1 || !["wallpaper", "image"].includes(v.kind)) fail("invalid_data", "Background favorite format is unsupported.");
    const name = str(v.name, "Favorite name", 4096), createdAt = str(v.createdAt, "Favorite date", 128);
    if (!Number.isFinite(Date.parse(createdAt))) fail("invalid_data", "Favorite date is invalid.");
    if (v.kind === "wallpaper") {
      const file = str(v.wallpaperFile, "Wallpaper identity", 4096), index = wallpaperCatalog.entries.findIndex(w => w.file === file);
      const id = `wallpaper-${crypto.createHash("sha256").update(file).digest("hex")}`;
      if (v.id !== id) fail("invalid_data", "Wallpaper favorite identity is invalid.");
      return { id, kind: "wallpaper", name, wallpaperId: index, wallpaperFile: file, createdAt };
    }
    const sha256 = str(v.sha256, "Favorite image digest", 64), extension = str(v.extension, "Favorite image format", 8);
    const sourcePath = v.sourcePath == null ? null : str(v.sourcePath, "Favorite source path", 32768), photo = v.photo === undefined ? undefined : parseUnsplashPhoto(v.photo);
    if (!/^[\da-f]{64}$/.test(sha256) || !["png", "jpg", "webp", "gif"].includes(extension)
      || (v.id !== imageFavoriteID(sha256, sourcePath, photo) && v.id !== `image-${sha256}`)) fail("invalid_data", "Favorite image identity is invalid.");
    return { id: v.id, kind: "image", name, path: path.join(this.root, "Images", `${sha256}.${extension}`), ...parseBackgroundImageSource(v), createdAt,
      ...(sourcePath == null ? {} : { sourcePath }), ...(photo === undefined ? {} : { photo }) };
  }
  listFavorites() {
    return this.track(async () => {
      await this.directory(); const folder = path.join(this.root, "Favorites"), entries = await fs.readdir(folder), favorites = [], issues = [];
      const files = entries.filter(file => /^(?:wallpaper|image)-[\da-f]{64}\.json$/.test(file));
      if (files.length > MAX_FAVORITES) issues.push({ file: folder, message: `Only the first ${MAX_FAVORITES} favorites were examined due to the bounded library size.` });
      for (const file of files.slice(0, MAX_FAVORITES)) {
        try {
          const favorite = this.parseFavorite(await readJSON(path.join(folder, file)));
          if (`${favorite.id}.json` !== file) fail("invalid_data", "Favorite filename and content disagree.");
          if (favorite.kind === "image") {
            if (await this.imageDigest(favorite.path) !== favorite.sha256) fail("cache_changed", "The cached favorite image changed and was preserved.");
            await imageInfo(favorite.path); await this.grants.grant(favorite.path);
          }
          favorites.push(favorite);
        } catch (error) { issues.push({ file, message: error instanceof BackgroundFailure ? error.message : "This favorite cannot be read. Its metadata and image were preserved." }); }
      }
      return { favorites: favorites.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), issues };
    });
  }
  saveFavorite(input) {
    return this.mutate(async () => {
      await this.directory(); const v = obj(input, "Favorite selection");
      let record;
      if (v.kind === "wallpaper") {
        const index = integer(v.wallpaperId, 0, wallpaperCatalog.entries.length - 1, "Selected wallpaper");
        const file = wallpaperCatalog.entries[index].file;
        record = { version: 1, id: `wallpaper-${crypto.createHash("sha256").update(file).digest("hex")}`, kind: "wallpaper", name: v.name === undefined ? wallpaperCatalog.entries[index].name : str(v.name, "Favorite name", 4096), wallpaperFile: file, createdAt: new Date().toISOString() };
      } else if (v.kind === "image") {
        const sourcePath = str(v.path, "Selected favorite path", 32768), photo = v.photo === undefined ? undefined : parseUnsplashPhoto(v.photo), opened = await this.grants.open(sourcePath);
        let stored;
        try { stored = await this.storeImage(opened.handle.createReadStream({ autoClose: false }), opened.stat.size); } finally { await opened.handle.close(); }
        record = { version: 1, id: imageFavoriteID(stored.sha256, sourcePath, photo), kind: "image", name: v.name === undefined ? path.basename(sourcePath) : str(v.name, "Favorite name", 4096), sourcePath,
          ...parseBackgroundImageSource({ sha256: stored.sha256, downloadURL: v.downloadURL, downloadedAt: v.downloadedAt }), extension: stored.extension, createdAt: new Date().toISOString(), ...(photo === undefined ? {} : { photo }) };
      } else fail("invalid_data", "Choose a local image or wallpaper to favorite.");
      const file = path.join(this.root, "Favorites", `${record.id}.json`), bytes = Buffer.from(JSON.stringify(record));
      if (bytes.length > MAX_RECORD_BYTES) fail("capacity", "Favorite metadata exceeds the 128 KiB record budget.");
      const temporary = path.join(this.root, "Favorites", `.${crypto.randomUUID()}.tmp`), handle = await fs.open(temporary, "wx", 0o600);
      this.pendingCleanup.set(temporary, await handle.stat());
      try {
        try { await writeAll(handle, bytes); await handle.sync(); } finally { await handle.close(); }
        try { await fs.link(temporary, file); } catch (error) { if (error.code !== "EEXIST") throw error; return this.parseFavorite(await readJSON(file)); }
      } finally { await this.cleanupFile(temporary); }
      return this.parseFavorite(record);
    });
  }
  removeFavorite(id) {
    return this.mutate(async () => {
      if (typeof id !== "string" || !/^(?:wallpaper|image)-[\da-f]{64}$/.test(id)) fail("invalid_data", "Favorite ID is invalid.");
      await this.directory(); const file = path.join(this.root, "Favorites", `${id}.json`);
      let record; try { record = this.parseFavorite(await readJSON(file)); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (record.id !== id) fail("invalid_data", "Favorite identity does not match the selected record.");
      // Keep a backup of removed metadata and the image, which may be used by a project.
      await fs.rename(file, path.join(this.root, "Removed", `${id}-${crypto.randomUUID()}.json`));
    });
  }
  async dispose() {
    this.closed = true; for (const controller of this.requests) controller.abort();
    await Promise.allSettled([...this.operations]); await this.cleanup();
  }
}

module.exports = { BackgroundAssets, BackgroundFailure, parseUnsplashPhoto, parseBackgroundImageSource, referralURL, imageInfo, IMAGE_HOSTS, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, DOCS };
