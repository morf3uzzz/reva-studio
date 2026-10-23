import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, RotateCcw, X, Scissors } from "lucide-react";
import { t } from "./i18n";
import Tooltip from "./Tooltip";
import ReferenceIcon from "./ReferenceIcon";

export function DisclosureChevron() {
  return <span className="disclosure-chevron"><ReferenceIcon name="chevron.down" size={14} /></span>;
}

/** Lucide artwork; does not depend on a proprietary icon font. */
export function ScissorsIcon({ size = 19 }: { size?: number }) {
  return <span className="reference-scissors" aria-hidden="true"><Scissors size={size} strokeWidth={2} /></span>;
}

export function IconButton({
  title,
  children,
  onClick,
  active = false,
  disabled = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [label, shortcut] = t(title).split(" · ");
  return (
    <Tooltip label={label} shortcut={shortcut}>
    <button
      className={`icon-button ${active ? "active" : ""} ${className}`}
      aria-label={t(title)}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
    </Tooltip>
  );
}

export function TransportButton({ label, shortcut, keys, children, onClick, disabled = false, className = "", pressed }: {
  label: string; shortcut?: string; keys?: string; children: ReactNode; onClick: () => void; disabled?: boolean; className?: string; pressed?: boolean;
}) {
  return <Tooltip label={t(label)} shortcut={shortcut}><button className={`icon-button ${className}`} aria-label={t(label)} aria-keyshortcuts={keys} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</button></Tooltip>;
}
export function Range({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  display,
  reset,
  disabled = false,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (n: number) => void;
  display?: string;
  reset?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={`range-field ${disabled ? "disabled" : ""}`}>
      <div className="field-heading">
        <label>{t(label)}</label>
        <span>
          {display ?? Math.round(value)}
          {reset && (
            <button
              title={t("Reset {label}", { label: t(label) })}
              onClick={reset}
            >
              <RotateCcw size={11} />
            </button>
          )}
        </span>
      </div>
      <input
        aria-label={label ? t(label) : undefined}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(+e.target.value)}
        style={
          {
            "--range": `${((value - min) / (max - min)) * 100}%`,
          } as React.CSSProperties
        }
      />
    </div>
  );
}
export function Toggle({
  label,
  description,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-field ${disabled ? "disabled" : ""}`}>
      <span>
        <b>{t(label)}</b>
        {description && <small>{t(description)}</small>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={t(label)}
        disabled={disabled}
        className={`toggle ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </label>
  );
}
export function Select({
  value,
  onChange,
  children,
  label,
  className = "",
}: {
  value: string | number;
  onChange: (s: string) => void;
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <label className={`select-wrap ${className}`}>
      <select
        aria-label={label ? t(label) : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={13} />
    </label>
  );
}
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (s: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label ? t(label) : undefined}>
      {options.map((o) => (
        <button
          className={o.value === value ? "selected" : ""}
          key={o.value}
          onClick={() => onChange(o.value)}
        >
          {t(o.label)}
        </button>
      ))}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  className = "",
  hideHeader = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  hideHeader?: boolean;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t(title)}
        className={`modal ${wide ? "wide" : ""} ${className}`}
      >
        {!hideHeader && (
          <header>
            <div>
              <h2>{t(title)}</h2>
              {subtitle && <p>{t(subtitle)}</p>}
            </div>
            <IconButton title="Close dialog" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>
        )}
        {children}
      </section>
    </div>
  );
}
export function CheckboxCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`choice-card ${selected ? "selected" : ""}`}
      onClick={onClick}
    >
      {children}
      {selected && (
        <span className="choice-check">
          <Check size={12} />
        </span>
      )}
    </button>
  );
}
export function NumberInput({
  label,
  value,
  min,
  max,
  step = 0.1,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(+value.toFixed(3)));
  const skipBlur = useRef(false);
  useEffect(() => setDraft(String(+value.toFixed(3))), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) {
      const next = Math.min(max, Math.max(min, n));
      onCommit(next);
      setDraft(String(+next.toFixed(3)));
    } else setDraft(String(value));
  };
  return (
    <input
      aria-label={t(label)}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!skipBlur.current) commit();
        skipBlur.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          skipBlur.current = true;
          setDraft(String(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}
