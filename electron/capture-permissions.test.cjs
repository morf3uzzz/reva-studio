"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CaptureMediaPermissions } = require("./capture-permissions.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const states = { camera: "not-determined", microphone: "not-determined" }, requests = [];
  const owner = new CaptureMediaPermissions({ platform: "darwin", systemPreferences: {
    getMediaAccessStatus: kind => states[kind],
    askForMediaAccess: kind => new Promise(resolve => requests.push({ kind, answer: allowed => { states[kind] = allowed ? "granted" : "denied"; resolve(allowed); } })),
  } });
  return { owner, states, requests };
}
test("media consent respects disabled inputs, current grants, denial and restrictions", async () => {
  const f = fixture();
  await f.owner.request({ camera: false, microphone: false });
  f.states.camera = "granted";
  await f.owner.request({ camera: true, microphone: false });
  assert.equal(f.requests.length, 0);
  f.states.microphone = "restricted";
  await assert.rejects(f.owner.request({ camera: false, microphone: true }), error => error.code === "microphone_permission_restricted" && error.mediaType === "microphone");
  f.states.camera = "not-determined";
  const declined = assert.rejects(f.owner.request({ camera: true, microphone: false }), error => error.code === "camera_permission_denied");
  await flush(); f.requests[0].answer(false); await declined;
  await assert.rejects(f.owner.request({ camera: true, microphone: false }), /Allow camera access/);
  assert.equal(f.requests.length, 1, "denied access is not repeatedly requested");
});
test("concurrent callers share serialized OS consent and retain fresh status", async () => {
  const f = fixture();
  const first = f.owner.request({ camera: true, microphone: true });
  const second = f.owner.request({ camera: true, microphone: true });
  await flush(); assert.deepEqual(f.requests.map(value => value.kind), ["camera"]);
  f.requests[0].answer(true);
  await flush(); assert.deepEqual(f.requests.map(value => value.kind), ["camera", "microphone"]);
  f.requests[1].answer(true);
  await Promise.all([first, second]);
  f.states.microphone = "denied";
  await assert.rejects(f.owner.request({ camera: false, microphone: true }), /Allow microphone access/);
});
test("cancellation settles before OS consent, skips obsolete queued prompts and permits a fresh caller", async () => {
  const f = fixture(), first = new AbortController(), queued = new AbortController();
  const canceled = assert.rejects(f.owner.request({ camera: true, microphone: true }, { signal: first.signal }), error => error.code === "capture_permission_cancelled");
  const canceledQueued = assert.rejects(f.owner.request({ camera: false, microphone: true }, { signal: queued.signal }), error => error.code === "capture_permission_cancelled");
  await flush(); first.abort(); queued.abort();
  await Promise.all([canceled, canceledQueued]);
  assert.deepEqual(f.requests.map(value => value.kind), ["camera"]);
  const fresh = f.owner.request({ camera: true, microphone: false });
  f.requests[0].answer(true);
  await fresh; await flush();
  assert.deepEqual(f.requests.map(value => value.kind), ["camera"], "the obsolete microphone request is never shown");
});
