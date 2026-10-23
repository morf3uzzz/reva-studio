export function matchesShortcut(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, keys: readonly string[] | null): boolean {
  if (!keys?.length) return false;
  if (event.metaKey !== keys.includes("Meta") || event.ctrlKey !== keys.includes("Control") || event.altKey !== keys.includes("Alt") || event.shiftKey !== keys.includes("Shift")) return false;
  const key = keys.find(value => !["Meta", "Control", "Alt", "Shift"].includes(value));
  return key !== undefined && (key.toLowerCase() === event.key.toLowerCase() || (key === "Space" && event.code === "Space"));
}
