import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { t, useLanguage } from "./i18n";
import { Modal } from "./components";
export interface EditorCommand { id: string; label: string; section: string; shortcut?: string; disabled?: boolean; run: () => void }
export default function CommandPalette({ commands, onClose }: { commands: EditorCommand[]; onClose: () => void }) {
  const [language] = useLanguage();
  const [query, setQuery] = useState(""), [selected, setSelected] = useState(0), input = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => commands.filter(command => `${t(command.label)} ${t(command.section)} ${command.label} ${command.section}`.toLocaleLowerCase(language).includes(query.trim().toLocaleLowerCase(language))), [commands, query, language]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => setSelected(0), [query]);
  const run = (command: EditorCommand | undefined) => { if (command && !command.disabled) { onClose(); command.run(); } };
  return <Modal title={t("Command menu")} onClose={onClose}><div className="command-palette"><label><Search size={17} /><input ref={input} aria-label={t("Search commands")} placeholder={t("Search tools, editing and recording actions…")} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected(index => Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); } if (event.key === "Enter") { event.preventDefault(); run(filtered[selected]); } }} /></label><div className="command-results" role="listbox" aria-label={t("Commands")}>{filtered.map((command, index) => <button key={command.id} role="option" aria-selected={selected === index} disabled={command.disabled} className={selected === index ? "selected" : ""} onPointerMove={() => setSelected(index)} onClick={() => run(command)}><small>{t(command.section)}</small><span>{t(command.label)}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button>)}{!filtered.length && <p>{t("No matching commands")}</p>}</div></div></Modal>;
}
