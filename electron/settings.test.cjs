"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { SettingsStore, translate, localizeError } = require("./settings.cjs");

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "reva-settings-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  return { directory, file, store: new SettingsStore(file) };
}

test("Russian default persists English across restart and preserves unrelated settings", async (t) => {
  const { file, store } = await fixture(t);
  assert.equal(await store.load(), "ru");
  await assert.rejects(fsp.access(file), { code: "ENOENT" });
  await store.setLanguage("en");
  assert.equal(await new SettingsStore(file).load(), "en");
  const previous = { language: "en", futureOption: { enabled: true }, version: 3 };
  await fsp.writeFile(file, JSON.stringify(previous));
  await store.setLanguage("ru");
  assert.deepEqual(JSON.parse(await fsp.readFile(file)), { ...previous, language: "ru" });
  assert.deepEqual(JSON.parse(await fsp.readFile(`${file}.bak`)), previous);
  const before = await fsp.stat(file);
  await store.setLanguage("ru");
  const after = await fsp.stat(file);
  assert.equal(after.ino, before.ino, "choosing the same language does not rewrite the file");
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("serialized choices finish in request order and invalid locale cannot alter settings", async (t) => {
  const { file, store } = await fixture(t);
  await store.load();
  await Promise.all([store.setLanguage("en"), store.setLanguage("ru"), store.setLanguage("en")]);
  await store.flush();
  assert.equal(store.language, "en");
  const before = await fsp.readFile(file);
  await assert.rejects(store.setLanguage("../../outside"), /Unsupported interface language/);
  assert.deepEqual(await fsp.readFile(file), before);
  assert.equal(await new SettingsStore(file).load(), "en");
});

test("failed atomic save leaves selected language and file intact, cleans stages and permits retry", async (t) => {
  const { directory, file, store } = await fixture(t);
  await store.setLanguage("ru");
  const original = await fsp.readFile(file);
  await fsp.mkdir(`${file}.bak`);
  await assert.rejects(store.setLanguage("en"));
  assert.equal(store.language, "ru");
  assert.deepEqual(await fsp.readFile(file), original);
  assert.deepEqual((await fsp.readdir(directory)).sort(), ["settings.json", "settings.json.bak"]);
  await fsp.rmdir(`${file}.bak`);
  await store.setLanguage("en");
  assert.equal(await new SettingsStore(file).load(), "en");
  assert.deepEqual(await fsp.readFile(`${file}.bak`), original);
});

test("malformed settings stay untouched on launch and their exact bytes are backed up on explicit choice", async (t) => {
  const { file, store } = await fixture(t);
  const damaged = Buffer.from('{"language": "en", broken UTF-8: \xff', "latin1");
  await fsp.writeFile(file, damaged);
  assert.equal(await store.load(), "ru");
  assert.ok(store.loadIssue);
  assert.deepEqual(await fsp.readFile(file), damaged);
  await store.setLanguage("en");
  assert.deepEqual(await fsp.readFile(`${file}.bak`), damaged);
  assert.deepEqual(JSON.parse(await fsp.readFile(file)), { language: "en" });
});

test("a settings symlink cannot overwrite another file", async (t) => {
  const { directory, file, store } = await fixture(t);
  const outside = path.join(directory, "other.json");
  const original = '{"language":"en","unrelated":"keep"}';
  await fsp.writeFile(outside, original);
  await fsp.symlink(outside, file);
  assert.equal(await store.load(), "ru");
  assert.ok(store.loadIssue);
  await assert.rejects(store.setLanguage("en"), /regular file/);
  assert.equal(await fsp.readFile(outside, "utf8"), original);
  assert.equal((await fsp.lstat(file)).isSymbolicLink(), true);
});

test("native errors translate nested context and validation while preserving diagnostics and source paths", () => {
  assert.equal(translate("Save Project", "ru"), "Сохранить проект");
  assert.equal(translate("Save Project", "en"), "Save Project");
  assert.equal(translate("__proto__", "ru"), "__proto__");
  assert.equal(translate("toString", "ru"), "toString");
  assert.equal(localizeError(new Error("Export width is out of range."), "ru").message,
    "Значение поля «Ширина экспорта» выходит за допустимые пределы.");
  const original = new Error("Screen Studio import: Asset changed while reading: recordings/Save Project.mov");
  original.code = "ESTALE";
  const localized = localizeError(original, "ru");
  assert.equal(localized.message,
    "Импорт Screen Studio: Файл изменился во время чтения: recordings/Save Project.mov");
  assert.equal(localized.code, "ESTALE");
  assert.equal(localized.cause, original);
  assert.equal(original.message, "Screen Studio import: Asset changed while reading: recordings/Save Project.mov");
  assert.equal(localizeError(localized, "ru").message, localized.message, "translation is idempotent");
  const diagnostic = new Error("decoder_error 0x1 /Users/test/Save Project.mov");
  assert.equal(localizeError(diagnostic, "ru").message,
    "Не удалось выполнить операцию: decoder_error 0x1 /Users/test/Save Project.mov");
  assert.equal(localizeError(diagnostic, "en").message, diagnostic.message);
});

test("preload language calls retain the narrow IPC contract and remove only Electron error framing", async () => {
  const invocations = [];
  let api;
  let failure;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "reva"); api = value; } },
    ipcRenderer: {
      async invoke(channel, ...args) {
        invocations.push([channel, ...args]);
        if (failure) throw failure;
        return channel === "reva:get-language" ? "ru" : undefined;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8"), {
    require(name) { assert.equal(name, "electron"); return electron; },
    process: { platform: "darwin" }, Error,
  });
  assert.equal(await api.getLanguage(), "ru");
  assert.equal(await api.setLanguage("en"), undefined);
  assert.deepEqual(invocations, [["reva:get-language"], ["reva:set-language", "en"]]);
  failure = new Error("Error invoking remote method 'reva:set-language': Error: Этот язык интерфейса не поддерживается.");
  await assert.rejects(api.setLanguage("invalid"), { message: "Этот язык интерфейса не поддерживается." });
  failure = new Error("A separate technical failure");
  await assert.rejects(api.getLanguage(), { message: "A separate technical failure" });
});

test("main IPC switches menus and dialogs immediately, localizes backend failures and rejects other senders", async (t) => {
  const { directory } = await fixture(t);
  const handlers = new Map();
  const windowEvents = new Map();
  const appPaths = { appData: directory };
  const dialogs = [];
  let menu;
  let window;
  const electron = {
    app: {
      setName() {}, setPath(key, value) { appPaths[key] = value; },
      getPath(key) { return appPaths[key]; }, getVersion() { return "test"; },
      isPackaged: true, setAboutPanelOptions() {}, on() {},
      // Register startup without creating any OS window, tray or permission prompt.
      whenReady() { return { then() { return { catch() {} }; } }; },
    },
    protocol: { registerSchemesAsPrivileged() {} },
    Menu: {
      buildFromTemplate(value) { return value; },
      setApplicationMenu(value) { menu = value; },
    },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, on() {} },
    dialog: { async showOpenDialog(_window, options) { dialogs.push(options); return { canceled: true, filePaths: [] }; } },
    BrowserWindow: class {
      constructor() {
        window = this;
        this.webContents = {
          mainFrame: { url: "reva-app://app/index.html" },
          setWindowOpenHandler() {},
          on(name, listener) { windowEvents.set(name, listener); },
        };
      }
      setWindowButtonVisibility() {} once() {} on() {} async loadURL() {}
      isDestroyed() { return false; }
    },
  };
  const mainPath = path.join(__dirname, "main.cjs");
  const ownRequire = createRequire(mainPath);
  const context = vm.createContext({
    require(name) { return name === "electron" ? electron : ownRequire(name); },
    __dirname, process: { env: {}, platform: "darwin" }, console, URL, Error,
  });
  vm.runInContext(fs.readFileSync(mainPath, "utf8"), context);
  context.installIPC();
  await context.createWindow();
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const call = (name, ...args) => handlers.get(name)(event, ...args);
  assert.equal(await call("reva:get-language"), "ru");
  await call("reva:set-language", "en");
  assert.ok(menu.some((entry) => entry.label === "File"));
  assert.equal(await call("reva:import-video"), null);
  assert.equal(dialogs.at(-1).title, "Import a recording");
  await call("reva:set-language", "ru");
  assert.ok(menu.some((entry) => entry.label === "Файл"));
  await call("reva:import-video");
  assert.equal(dialogs.at(-1).title, "Импорт записи");
  assert.equal(dialogs.at(-1).buttonLabel, "Импортировать");
  await assert.rejects(call("reva:export-frame", "missing", new Uint8Array()), {
    message: "Сейчас экспорт не выполняется.",
  });
  await assert.rejects(handlers.get("reva:set-language")({ sender: {}, senderFrame: {} }, "en"), {
    message: "Этот запрос поступил не из редактора REVA Studio.",
  });
  assert.equal(await call("reva:get-language"), "ru");
  assert.equal(await new SettingsStore(path.join(directory, "REVA Studio", "settings.json")).load(), "ru");
});
