import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2, Star } from "lucide-react";
import { t } from "./i18n";
import type { Project, SavedPreset } from "./types";
import "./presets-popover.css";

export default function PresetsPopover({ anchor, project, presets, defaultID, changed, apply, close, notify }: {
  anchor: HTMLElement | null; project: Project; presets: SavedPreset[]; defaultID: string | null; changed: () => Promise<void>;
  apply: (appearance: Project["appearance"]) => void; close: () => void; notify: (message: string) => void;
}) {
  const menuBox = useRef<HTMLDivElement>(null), gear = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ left: 8, top: 50 });
  const [name, setName] = useState(""), [menu, setMenu] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ kind: "rename" | "remove"; preset: SavedPreset; name: string } | null>(null);
  useLayoutEffect(() => {
    const place = () => { const rect = anchor?.getBoundingClientRect(); setPosition({ left: Math.max(8, Math.min(innerWidth - 438, (rect?.right ?? innerWidth - 8) - 430)), top: (rect?.bottom ?? 40) + 10 }); };
    place(); window.addEventListener("resize", place); return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node) && !menuBox.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); if (edit) setEdit(null); else if (menu) setMenu(null); else close(); };
    window.addEventListener("pointerdown", pointer, true); window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", pointer, true); window.removeEventListener("keydown", key, true); };
  }, [anchor, close, menu, edit]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return; setBusy(true);
    try { await action(); await changed(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const api = window.reva;
  return createPortal(<div ref={box} className="presets-popover" role="dialog" aria-label={t("Presets")} style={{ ...position, maxHeight: `calc(100vh - ${position.top + 12}px)` }}>
    {edit ? <form className="preset-edit" onSubmit={event => { event.preventDefault(); void run(async () => { if (edit.kind === "rename") await api?.updatePreset(edit.preset.id, { name: edit.name }); else await api?.removePreset(edit.preset.id); setEdit(null); }); }}>
      <label>{t(edit.kind === "rename" ? "Rename preset" : "Remove preset?")}</label>
      {edit.kind === "rename" ? <input aria-label={t("Preset name")} value={edit.name} autoFocus maxLength={512} onChange={event => setEdit({ ...edit, name: event.target.value })} /> : <p>{edit.preset.name}</p>}
      <div className="preset-edit-actions"><button className="outline-button" type="button" onClick={() => setEdit(null)}>{t("Cancel")}</button><button className={edit.kind === "remove" ? "outline-button danger" : "primary-button"} disabled={busy || !api || !edit.name.trim()}>{t(edit.kind === "rename" ? "Save" : "Remove")}</button></div>
    </form> : <>
      <div className="preset-rows">{presets.map(preset => <div className="preset-row" key={preset.id}>
        <button className="preset-apply" onClick={() => { apply(structuredClone(preset.appearance)); close(); }}>{preset.name}{defaultID === preset.id && <Star size={13} fill="currentColor" />}</button>
        <button className="preset-gear" aria-label={t("Preset actions: {name}", { name: preset.name })} aria-expanded={menu === preset.id} disabled={busy} onClick={event => { gear.current = event.currentTarget; setMenu(value => value === preset.id ? null : preset.id); }}><Settings2 size={18} /></button>
        {menu === preset.id && createPortal(<div ref={menuBox} className="preset-action-menu" role="menu" style={{ left: Math.max(8, Math.min(innerWidth - 312, (gear.current?.getBoundingClientRect().right ?? innerWidth) - 300)), top: Math.max(8, Math.min(innerHeight - 240, (gear.current?.getBoundingClientRect().bottom ?? position.top) + 2)) }}>
          <button role="menuitem" onClick={() => { setMenu(null); setEdit({ kind: "rename", preset, name: preset.name }); }}>{t("Rename…")}</button>
          <button role="menuitem" onClick={() => { setMenu(null); void run(() => api!.updatePreset(preset.id, { project })); }}>{t("Update to match currently edited project")}</button><hr />
          <button role="menuitem" onClick={() => { setMenu(null); void run(() => api!.setDefaultPreset(defaultID === preset.id ? null : preset.id)); }}>{t(defaultID === preset.id ? "Clear default for new projects" : "Use as default for new projects")}</button><hr />
          <button role="menuitem" onClick={() => { setMenu(null); void run(() => api!.revealPreset(preset.id)); }}>{t("Show in Finder")}</button><hr />
          <button role="menuitem" className="danger" onClick={() => { setMenu(null); setEdit({ kind: "remove", preset, name: preset.name }); }}>{t("Remove…")}</button>
        </div>, document.body)}
      </div>)}</div>
      <p className="preset-explanation">{t(presets.length ? "Presets are not linked to projects. Update a preset to match project settings after making changes." : "Presets will help you re-use the same project settings across projects")}</p>
      <form className="preset-create" onSubmit={event => { event.preventDefault(); if (name.trim()) void run(async () => { await api!.savePreset(project, name.trim()); setName(""); }); }}>
        <input aria-label={t("New preset name")} placeholder={t("New preset name…")} maxLength={512} value={name} onChange={event => setName(event.target.value)} /><button className="primary-button" disabled={busy || !api || !name.trim()}>{t("Create new preset")}</button>
      </form>
      <div className="preset-transfer"><button disabled={busy || !api} onClick={() => void run(async () => { const preset = await api!.importPreset(); if (preset) { apply(preset.appearance); setName(preset.name); notify(t("Preset imported. Save it to add it to your library.")); } })}>{t("Import preset…")}</button><button disabled={busy || !api} onClick={() => void run(() => api!.exportPreset(project, name || project.name))}>{t("Export preset…")}</button></div>
    </>}
  </div>, document.body);
}
