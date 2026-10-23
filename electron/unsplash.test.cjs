"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { BackgroundAssets, parseUnsplashPhoto, referralURL, imageInfo, MAX_IMAGE_BYTES } = require("./unsplash.cjs");
const { MediaGrants } = require("./media.cjs");

const key = "synthetic-test-access-key-not-a-real-credential";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function photo(id = "test-photo") {
  const image = `https://images.unsplash.com/photo-${id}?ixid=retained-source-metadata&ixlib=rb-4.1.0`;
  return { id, width: 4000, height: 3000, description: "Original source description", alt_description: "Test landscape", color: "#aabbcc",
    urls: { raw: image, full: `${image}&fm=jpg`, regular: `${image}&w=1080`, small: `${image}&w=400`, thumb: `${image}&w=200` },
    links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download?ixid=retained-tracking-metadata` },
    user: { name: "Synthetic Photographer", username: "fixture", links: { html: "https://unsplash.com/@fixture" } } };
}
function png() {
  const crc32 = bytes => { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; };
  const chunk = (type, bytes) => { const name = Buffer.from(type), result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); name.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), bytes.length + 8); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.from([0, 255,0,0,255, 0,255,0,255, 0, 0,0,255,255, 255,255,255,255]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR",header), chunk("IDAT",zlib.deflateSync(pixels)), chunk("IEND",Buffer.alloc(0))]);
}
async function fixture(t, fetchImpl, Class = BackgroundAssets) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-background-test-")), root = path.join(directory, "Library"), grants = new MediaGrants();
  const assets = new Class({ root, grants, fetchImpl: fetchImpl ?? (async () => { throw new Error("Network was not authorized by this fixture"); }) });
  t.after(async () => { try { await assets.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { directory, root, grants, assets };
}
async function noTemporaries(root) {
  for (const sub of ["Images", "Favorites"]) assert.equal((await fs.readdir(path.join(root, sub))).some(name => name.endsWith(".tmp")), false);
}

test("Unsplash client requires an explicit key, preserves official source URLs and validates photo identity", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; });
  assert.throws(() => f.assets.search("mountains", 1, ""), error => error.code === "access_key_required");
  assert.throws(() => f.assets.importPhoto(photo(), ""), error => error.code === "access_key_required");
  assert.equal(calls, 0);
  const parsed = parseUnsplashPhoto(photo());
  assert.equal(parsed.urls.raw, photo().urls.raw);
  assert.equal(parsed.links.downloadLocation, photo().links.download_location);
  assert.equal(parsed.photographer.name, "Synthetic Photographer");
  assert.equal(new URL(referralURL(parsed.photographer.profileURL)).searchParams.get("utm_source"), "reva_studio");
  for (const mutated of [
    { ...photo(), urls: { ...photo().urls, raw: "http://127.0.0.1/private" } },
    { ...photo(), links: { ...photo().links, download_location: "https://api.unsplash.com/photos/other/download" } },
    { ...photo(), urls: { ...photo().urls, raw: `https://images.unsplash.com/photo?client_id=${key}` } },
  ]) assert.throws(() => parseUnsplashPhoto(mutated));
});

test("official search sends credentials only in the API header and retains partial valid results", async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ total: 3, total_pages: 2, results: [photo(), { ...photo("bad"), urls: { ...photo().urls, small: "file:///private/local" } }, photo()] }), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "42" } });
  });
  const result = await f.assets.search("snow & sea", 2, key);
  assert.equal(result.photos.length, 1); assert.equal(result.omitted, 2); assert.equal(result.rateLimitRemaining, 42);
  assert.equal(new URL(calls[0].url).searchParams.get("query"), "snow & sea");
  assert.equal(new URL(calls[0].url).searchParams.get("page"), "2");
  assert.equal(calls[0].url.includes(key), false); assert.equal(calls[0].options.headers.Authorization, `Client-ID ${key}`); assert.equal(calls[0].options.redirect, "error");
});

test("selecting a photo tracks the download then streams only its selected image and preserves provenance", async t => {
  const calls = [], bytes = png();
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    return new URL(url).hostname === "api.unsplash.com" ? new Response(JSON.stringify({ url: "https://images.unsplash.com/not-an-embedding-url" })) : new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
  });
  const imported = await f.assets.importPhoto(photo(), key);
  assert.equal(calls.length, 2); assert.equal(calls[0].url, photo().links.download_location);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(new URL(calls[1].url).searchParams.get("ixid"), "retained-source-metadata");
  assert.equal(new URL(calls[1].url).searchParams.get("w"), "3840");
  assert.equal(await f.grants.assert(imported.path), imported.path);
  assert.deepEqual(await fs.readFile(imported.path), bytes); assert.equal(imported.photo.photographer.name, "Synthetic Photographer");
  assert.equal(imported.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(JSON.stringify(imported).includes(key), false);
  assert.deepEqual(await imageInfo(imported.path), { width: 2, height: 2, extension: "png", size: bytes.length });
  const favorite = await f.assets.saveFavorite({ kind: "image", path: imported.path, photo: imported.photo, downloadURL: imported.downloadURL, downloadedAt: imported.downloadedAt });
  const reopened = (await f.assets.listFavorites()).favorites.find(item => item.id === favorite.id);
  assert.equal(reopened.downloadURL, imported.downloadURL); assert.equal(reopened.downloadedAt, imported.downloadedAt); assert.equal(reopened.sha256, imported.sha256);
  await f.assets.importPhoto(photo(), key); assert.equal(calls.length, 4, "A repeated explicit selection records a new download event");
  await noTemporaries(f.root);
});

test("content-equivalent images keep distinct source identity and photographer attribution", async t => {
  const f = await fixture(t), source = path.join(f.directory, "source.png"); await fs.writeFile(source, png()); await f.grants.grant(source);
  const first = await f.assets.saveFavorite({ kind: "image", path: source, photo: photo("author-one") });
  const second = await f.assets.saveFavorite({ kind: "image", path: source, photo: photo("author-two") });
  assert.notEqual(first.id, second.id); assert.equal(first.path, second.path, "Byte-identical cache data is reused without equating provenance");
  const listing = await f.assets.listFavorites();
  assert.deepEqual(new Set(listing.favorites.map(item => item.photo.id)), new Set(["author-one", "author-two"]));
});

test("favorites persist owned image copies and wallpaper identity, without granting persisted source paths", async t => {
  const f = await fixture(t), source = path.join(f.directory, "Chosen original.png");
  await fs.writeFile(source, png());
  await assert.rejects(f.assets.saveFavorite({ kind: "image", path: source }), /not been selected/);
  await f.grants.grant(source);
  const image = await f.assets.saveFavorite({ kind: "image", path: source, name: "My chosen image" });
  const wallpaper = await f.assets.saveFavorite({ kind: "wallpaper", wallpaperId: 0 });
  assert.equal(image.sourcePath, source); assert.notEqual(image.path, source); assert.equal(wallpaper.wallpaperId, 0);
  assert.equal((await f.assets.saveFavorite({ kind: "image", path: source })).id, image.id);
  const freshGrants = new MediaGrants(), reopened = new BackgroundAssets({ root: f.root, grants: freshGrants });
  t.after(() => reopened.dispose());
  const listing = await reopened.listFavorites();
  assert.equal(listing.favorites.length, 2); assert.deepEqual(listing.issues, []);
  await assert.rejects(freshGrants.assert(source), /not been selected/); assert.equal(await freshGrants.assert(image.path), image.path);
  await reopened.removeFavorite(image.id);
  assert.equal((await reopened.listFavorites()).favorites.length, 1);
  assert.deepEqual(await fs.readFile(image.path), png(), "A project can keep using an unfavorited image");
  assert.equal((await fs.readdir(path.join(f.root, "Removed"))).length, 1, "Removed favorite metadata is backed up");
  assert.deepEqual(await fs.readFile(source), png(), "The selected original is unchanged");
  await noTemporaries(f.root);
});

test("favorite listing preserves valid partial results and refuses changed, symlinked or arbitrary path data", async t => {
  const f = await fixture(t), source = path.join(f.directory, "outside.png"); await fs.writeFile(source, png()); await f.grants.grant(source);
  const image = await f.assets.saveFavorite({ kind: "image", path: source });
  await f.assets.saveFavorite({ kind: "wallpaper", wallpaperId: 0 });
  const metadataFile = path.join(f.root, "Favorites", `${image.id}.json`), metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  metadata.path = "/private/unselected-user-media.png"; await fs.writeFile(metadataFile, JSON.stringify(metadata));
  const grants = new MediaGrants(), opened = new BackgroundAssets({ root: f.root, grants }); t.after(() => opened.dispose());
  assert.equal((await opened.listFavorites()).favorites.length, 2);
  await assert.rejects(grants.assert(source), /not been selected/); await assert.rejects(grants.assert(metadata.path), /not been selected/);
  await fs.unlink(image.path); await fs.symlink(source, image.path);
  const listing = await opened.listFavorites(); assert.equal(listing.favorites.length, 1); assert.equal(listing.issues.length, 1);
  assert.deepEqual(await fs.readFile(source), png());
});

test("download limits, invalid payloads and provider errors leave no partial files or credentials", async t => {
  for (const mode of ["oversized", "html", "key-rejected", "network-error"]) await t.test(mode, async t => {
    const f = await fixture(t, async (url) => {
      if (mode === "network-error") throw new Error(`Transport error containing ${key}`);
      if (mode === "key-rejected") return new Response("Denied", { status: 401 });
      if (new URL(url).hostname === "api.unsplash.com") return new Response("{}");
      return mode === "oversized" ? new Response(png(), { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } }) : new Response("<html>Not an image</html>");
    });
    await assert.rejects(f.assets.importPhoto(photo(), key), error => !error.message.includes(key));
    await f.assets.directory(); await noTemporaries(f.root); assert.deepEqual(await fs.readdir(path.join(f.root, "Images")), []);
  });
});

test("concurrent photo downloads retain separate cleanup ownership", async t => {
  const bytes = png();
  const f = await fixture(t, async url => {
    if (new URL(url).hostname === "api.unsplash.com") return new Response("{}");
    const delayed = url.includes("slower");
    return new Response(new ReadableStream({ async start(controller) { controller.enqueue(bytes.subarray(0, 20)); if (delayed) await new Promise(r => setTimeout(r, 30)); controller.enqueue(bytes.subarray(20)); controller.close(); } }));
  });
  const [one, two] = await Promise.all([f.assets.importPhoto(photo("fast"), key), f.assets.importPhoto(photo("slower"), key)]);
  assert.deepEqual(await fs.readFile(one.path), bytes); assert.equal(one.path, two.path); await noTemporaries(f.root);
});

test("dispose cancels a request during final cleanup and cleanup failures remain retryable", async t => {
  const entered = deferred(), release = deferred();
  class BlockingCleanup extends BackgroundAssets { async cleanupFile(file) { if (!this.blocked && this.pendingCleanup.has(file)) { this.blocked = true; entered.resolve(); await release.promise; } return super.cleanupFile(file); } }
  const fetcher = async url => new URL(url).hostname === "api.unsplash.com" ? new Response("{}") : new Response(png());
  const f = await fixture(t, fetcher, BlockingCleanup);
  const result = f.assets.importPhoto(photo(), key); const rejected = assert.rejects(result, error => error.code === "cancelled");
  await entered.promise; const disposed = f.assets.dispose(); release.resolve(); await disposed; await rejected; await noTemporaries(f.root);
  class FailedCleanup extends BackgroundAssets { async cleanupFile(file) { if (!this.failed && this.pendingCleanup.has(file)) { this.failed = true; throw new Error("Synthetic cleanup failure"); } return super.cleanupFile(file); } }
  const retry = await fixture(t, fetcher, FailedCleanup);
  await assert.rejects(retry.assets.importPhoto(photo(), key)); assert.equal(retry.assets.pendingCleanup.size, 1);
  await retry.assets.dispose(); assert.equal(retry.assets.pendingCleanup.size, 0); await noTemporaries(retry.root);
});
