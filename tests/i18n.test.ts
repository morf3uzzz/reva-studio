import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { translate } from "../src/i18n.ts";
import { shortcutKeyLabels } from "../src/core/annotations.ts";

test("Russian interface templates preserve user-supplied file names and English switches back", () => {
  const name = "My <demo> {file} — 2026";
  assert.equal(
    translate("Delete preset {name}", "ru", { name }),
    `Удалить стиль «${name}»`,
  );
  assert.equal(
    translate("Delete preset {name}", "en", { name }),
    `Delete preset ${name}`,
  );
  assert.equal(translate("Export", "ru"), "Экспорт");
  assert.equal(translate("Export", "en"), "Export");
  assert.equal(
    translate("unknown technical detail", "ru"),
    "unknown technical detail",
  );
  assert.equal(translate("__proto__", "ru"), "__proto__");
  assert.equal(translate("toString", "ru"), "toString");
});

test("translation catalogs preserve interpolation fields", () => {
  const placeholders = (s: string) =>
    [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const file of ["core", "inspector", "dialogs", "native", "cursor", "preferences", "timeline-markers"]) {
    const catalog = JSON.parse(
      fs.readFileSync(
        new URL(`../locales/ru-${file}.json`, import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>;
    for (const [english, russian] of Object.entries(catalog)) {
      assert.equal(typeof russian, "string", `${file}: ${english}`);
      assert.ok(russian.trim(), `${file}: empty translation for ${english}`);
      assert.deepEqual(
        placeholders(russian),
        placeholders(english),
        `${file}: ${english}`,
      );
    }
  }
});

test("new panel and export translations preserve source names and switch cleanly to English", () => {
  const name = "Jane {name} <photo> — my-file.png";
  assert.equal(translate("Photo by {name}", "ru", { name }), `Фото: ${name}`);
  assert.equal(translate("Photo by {name}", "en", { name }), `Photo by ${name}`);
  assert.equal(translate("Mask {dimension}", "ru", { dimension: translate("Width", "ru") }), "Маска: Ширина");
  assert.equal(translate("Import cursor PNG…", "ru"), "Импортировать курсор PNG…");
  assert.equal(translate("Transcript tokens: {count}", "ru", { count: 17 }), "Элементов в расшифровке: 17");
  assert.equal(translate("{start}–{end}s", "ru", { start: "1.25", end: "2.75" }), "1.25–2.75 с");
  assert.equal(translate("Recover another copy", "ru"), "Восстановить ещё одну копию");
  assert.equal(translate("Software", "ru"), "Программное");
  assert.equal(translate("Hardware (VideoToolbox)", "ru"), "Аппаратное (VideoToolbox)");
  assert.equal(translate("Both", "ru"), "Оба");
  const help = "Writes H.264 to the selected filename and HEVC to a companion ending in -hevc.mp4. Both files use the same rendered frames and mixed audio.";
  assert.notEqual(translate(help, "ru"), help);
  assert.equal(translate(help, "en"), help);
});

test("shortcut display follows Mac or Windows labels without changing recorded identities", () => {
  const keys = ["command", "option", "shift", "ArrowLeft", "Ж"];
  assert.deepEqual(shortcutKeyLabels(keys, "mac"), ["⌘", "⌥", "⇧", "←", "Ж"]);
  assert.deepEqual(shortcutKeyLabels(keys, "windows"), ["Win", "Alt", "Shift", "ArrowLeft", "Ж"]);
  assert.deepEqual(keys, ["command", "option", "shift", "ArrowLeft", "Ж"]);
});
