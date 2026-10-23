import { useSyncExternalStore } from "react";
import core from "../locales/ru-core.json" with { type: "json" };
import inspector from "../locales/ru-inspector.json" with { type: "json" };
import dialogs from "../locales/ru-dialogs.json" with { type: "json" };
import native from "../locales/ru-native.json" with { type: "json" };
import timelineMarkers from "../locales/ru-timeline-markers.json" with { type: "json" };
import cursor from "../locales/ru-cursor.json" with { type: "json" };
import preferences from "../locales/ru-preferences.json" with { type: "json" };

export type Language = "ru" | "en";
const translations: Record<string, string> = {
  ...native,
  ...dialogs,
  ...inspector,
  ...cursor,
  ...preferences,
  ...core,
  ...timelineMarkers,
};
const listeners = new Set<() => void>();
const storageKey = "reva-language";
function savedLanguage(): Language {
  try {
    return localStorage.getItem(storageKey) === "en" ? "en" : "ru";
  } catch {
    return "ru";
  }
}
let language = savedLanguage();
function applyLanguage(next: Language) {
  language = next;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* Native settings still persist the choice. */
  }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const listener of listeners) listener();
}
export async function initializeLanguage() {
  if (typeof window !== "undefined" && window.reva?.getLanguage)
    applyLanguage(await window.reva.getLanguage());
  else applyLanguage(language);
}
export async function setLanguage(next: Language) {
  if (next !== "ru" && next !== "en")
    throw new Error("Unsupported interface language.");
  if (typeof window !== "undefined" && window.reva?.setLanguage)
    await window.reva.setLanguage(next);
  applyLanguage(next);
}
export function useLanguage(): [Language, typeof setLanguage] {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => language,
  );
  return [current, setLanguage];
}
export function translate(
  message: string,
  locale: Language,
  values: Record<string, string | number> = {},
): string {
  const translated =
    locale === "ru" && Object.hasOwn(translations, message)
      ? translations[message]
      : message;
  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
export function t(
  message: string,
  values?: Record<string, string | number>,
): string {
  return translate(message, language, values);
}
