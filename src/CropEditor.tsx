import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  Crop,
  Keyboard,
  PanelsTopLeft,
  CornerDownLeft,
} from "lucide-react";
import { initializeLanguage, useLanguage } from "./i18n";
import cropLayout from "../shared/crop-editor-layout.json";
import { applyCropShortcut, CROP_SHORTCUTS, cropShortcutForKey } from "./crop-shortcuts";
import {
  constrainPixelCrop,
  cropToNormalized,
  cropToPixels,
  fitCropAspect,
  movePixelCrop,
  resizePixelCrop,
  setCropDimension,
  type CropHandle,
  type CropRect,
} from "./crop-geometry";
import "./crop-editor.css";

type CropEditorData = NonNullable<
  Awaited<ReturnType<NonNullable<Window["reva"]>["getCropEditor"]>>
>;
const handles: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const labels = {
  en: {
    size: "Size",
    width: "Width",
    height: "Height",
    position: "Position",
    aspect: "Aspect ratio",
    select: "Select…",
    original: "Original",
    reset: "Reset",
    confirm: "Confirm changes",
    discard: "Discard changes",
    shortcuts: "Keyboard shortcuts",
    loading: "Loading recording…",
    empty: "No recording to crop.",
    failed: "Could not load this recording.",
    resize: "Resize crop",
    moveLeft: (step: number) => `Move left by ${step}px`,
    moveRight: (step: number) => `Move right by ${step}px`,
    moveUp: (step: number) => `Move up by ${step}px`,
    moveDown: (step: number) => `Move down by ${step}px`,
    reduceWidth: (step: number) => `Reduce width by ${step}px`,
    increaseWidth: (step: number) => `Increase width by ${step}px`,
    increaseHeight: (step: number) => `Increase height by ${step}px`,
    reduceHeight: (step: number) => `Reduce height by ${step}px`,
    area: "Crop area",
    help: "Drag the frame to move it. Drag a handle to resize.",
  },
  ru: {
    size: "Размер",
    width: "Ширина",
    height: "Высота",
    position: "Положение",
    aspect: "Пропорции",
    select: "Выбрать…",
    original: "Исходные",
    reset: "Сбросить",
    confirm: "Применить",
    discard: "Не сохранять",
    shortcuts: "Сочетания клавиш",
    loading: "Загрузка записи…",
    empty: "Нет записи для обрезки.",
    failed: "Не удалось загрузить запись.",
    resize: "Изменить размер",
    moveLeft: (step: number) => `Сдвинуть влево на ${step}px`,
    moveRight: (step: number) => `Сдвинуть вправо на ${step}px`,
    moveUp: (step: number) => `Сдвинуть вверх на ${step}px`,
    moveDown: (step: number) => `Сдвинуть вниз на ${step}px`,
    reduceWidth: (step: number) => `Уменьшить ширину на ${step}px`,
    increaseWidth: (step: number) => `Увеличить ширину на ${step}px`,
    increaseHeight: (step: number) => `Увеличить высоту на ${step}px`,
    reduceHeight: (step: number) => `Уменьшить высоту на ${step}px`,
    area: "Область обрезки",
    help: "Перетаскивайте рамку, чтобы переместить её, или маркеры, чтобы изменить размер.",
  },
};

function PixelField({
  label,
  value,
  max,
  min = 0,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  min?: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value)));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(Math.round(value)));
  }, [value, focused]);
  function commit() {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed))
      onCommit(Math.min(max, Math.max(min, Math.round(parsed))));
    else setDraft(String(Math.round(value)));
  }
  return (
    <input
      aria-label={label}
      title={`${label} (px)`}
      inputMode="numeric"
      type="number"
      min={min}
      max={max}
      step={1}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        commit();
        setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export default function CropEditor() {
  const [language] = useLanguage();
  const text = labels[language];
  const [data, setData] = useState<CropEditorData | null>(null);
  const [crop, setCrop] = useState<CropRect>({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const [preset, setPreset] = useState("free");
  const [loading, setLoading] = useState(true);
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const shortcutsButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{
    pointer: number;
    x: number;
    y: number;
    crop: CropRect;
    handle: CropHandle | "move";
  } | null>(null);
  const ratio =
    preset === "free"
      ? null
      : preset === "original" && data
        ? data.width / data.height
        : Number(preset);

  useEffect(() => {
    let disposed = false;
    void initializeLanguage();
    const api = window.reva;
    if (!api) {
      setError("REVA desktop bridge is unavailable.");
      setLoading(false);
      return;
    }
    void api
      .getCropEditor()
      .then((value) => {
        if (disposed) return;
        if (
          value &&
          Number.isFinite(value.width) &&
          value.width >= 1 &&
          Number.isFinite(value.height) &&
          value.height >= 1
        ) {
          setData(value);
          setCrop(cropToPixels(value.crop, value));
        }
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!showShortcuts) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !shortcutsRef.current?.contains(event.target))
        setShowShortcuts(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [showShortcuts]);

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const complete = useCallback(
    async (confirmed: boolean) => {
      if (busy || (confirmed && (!data || !frameReady))) return;
      setBusy(true);
      try {
        await window.reva?.completeCropEditor(
          confirmed && data ? cropToNormalized(crop, data) : null,
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setBusy(false);
      }
    },
    [busy, data, frameReady, crop],
  );

  const reset = useCallback(() => {
    if (!data) return;
    setCrop({ x: 0, y: 0, width: data.width, height: data.height });
    setPreset("free");
  }, [data]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const editing =
        event.target instanceof HTMLElement &&
        !!event.target.closest(
          "input, select, textarea, [contenteditable=true]",
        );
      if (event.key === "Escape") {
        event.preventDefault();
        if (showShortcuts) {
          setShowShortcuts(false);
          shortcutsButtonRef.current?.focus();
        }
        else void complete(false);
        return;
      }
      if (editing || busy) return;
      if (
        event.key === "Enter" &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        event.preventDefault();
        void complete(true);
        return;
      }
      if (!data) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        reset();
        return;
      }
      const shortcut = cropShortcutForKey(event);
      if (!shortcut) return;
      event.preventDefault();
      setCrop((current) =>
        applyCropShortcut(current, shortcut, data, ratio),
      );
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, complete, data, ratio, reset, showShortcuts]);

  function startDrag(
    event: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>,
    handle: CropHandle | "move",
  ) {
    if (!data || busy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      crop,
      handle,
    };
    selectionRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: ReactPointerEvent) {
    const drag = dragRef.current,
      rect = pictureRef.current?.getBoundingClientRect();
    if (
      !drag ||
      drag.pointer !== event.pointerId ||
      !data ||
      !rect?.width ||
      !rect.height
    )
      return;
    const dx = ((event.clientX - drag.x) * data.width) / rect.width;
    const dy = ((event.clientY - drag.y) * data.height) / rect.height;
    setCrop(
      drag.handle === "move"
        ? movePixelCrop(drag.crop, dx, dy, data)
        : resizePixelCrop(
            drag.crop,
            drag.handle,
            dx,
            dy,
            data,
            ratio ??
              (event.shiftKey ? drag.crop.width / drag.crop.height : null),
          ),
    );
  }
  function endDrag(event: ReactPointerEvent) {
    if (dragRef.current?.pointer !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function changePreset(value: string) {
    setPreset(value);
    if (!data || value === "free") return;
    setCrop((current) =>
      fitCropAspect(
        current,
        value === "original" ? data.width / data.height : Number(value),
        data,
      ),
    );
  }
  const scale = data
    ? Math.max(
        0,
        Math.min(viewport.width / data.width, viewport.height / data.height),
      )
    : 0;
  const normalized = data
    ? cropToNormalized(crop, data)
    : { x: 0, y: 0, width: 1, height: 1 };
  const percent = (value: number) => `${value * 100}%`;
  const selectionStyle: CSSProperties = {
    left: percent(normalized.x),
    top: percent(normalized.y),
    width: percent(normalized.width),
    height: percent(normalized.height),
  };

  return (
    <main className="crop-editor" aria-label={text.area} lang={language} style={{
      "--crop-toolbar-height": `${cropLayout.toolbarHeight}px`,
      "--crop-footer-height": `${cropLayout.footerHeight}px`,
      "--crop-frame-inset": `${cropLayout.frameInset}px`,
    } as CSSProperties}>
      <header className="crop-editor-toolbar">
        <div className="crop-editor-traffic-space" />
        <div className="crop-editor-fields">
          <span className="crop-editor-field-label">{text.size}</span>
          <PixelField
            label={text.width}
            value={crop.width}
            min={1}
            max={data?.width ?? 1}
            onCommit={(value) =>
              data &&
              setCrop((current) =>
                setCropDimension(current, "width", value, data, ratio),
              )
            }
          />
          <span className="crop-editor-times">×</span>
          <PixelField
            label={text.height}
            value={crop.height}
            min={1}
            max={data?.height ?? 1}
            onCommit={(value) =>
              data &&
              setCrop((current) =>
                setCropDimension(current, "height", value, data, ratio),
              )
            }
          />
          <label className="crop-editor-presets">
            <PanelsTopLeft size={19} />
            <select
              value={preset}
              onChange={(event) => changePreset(event.target.value)}
              aria-label={text.aspect}
            >
              <option value="free">{text.select}</option>
              <option value="original">{text.original}</option>
              {[
                [16, 9],
                [9, 16],
                [1, 1],
                [4, 3],
                [3, 4],
                [16, 10],
                [4, 5],
              ].map(([width, height]) => (
                <option
                  key={`${width}:${height}`}
                  value={String(width / height)}
                >
                  {width}:{height}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </label>
        </div>
        <div className="crop-editor-fields crop-editor-position">
          <span className="crop-editor-field-label">{text.position}</span>
          <PixelField
            label="X"
            value={crop.x}
            max={Math.max(0, (data?.width ?? 1) - crop.width)}
            onCommit={(value) =>
              data &&
              setCrop((current) =>
                constrainPixelCrop({ ...current, x: value }, data),
              )
            }
          />
          <PixelField
            label="Y"
            value={crop.y}
            max={Math.max(0, (data?.height ?? 1) - crop.height)}
            onCommit={(value) =>
              data &&
              setCrop((current) =>
                constrainPixelCrop({ ...current, y: value }, data),
              )
            }
          />
        </div>
        <button
          className="crop-editor-reset"
          onClick={reset}
          disabled={!data || busy}
        >
          <Crop size={21} />
          <span>{text.reset}</span>
        </button>
        <div className="crop-editor-keyboard-menu" ref={shortcutsRef}>
          <button
            ref={shortcutsButtonRef}
            className="crop-editor-keyboard"
            title={text.shortcuts}
            aria-label={text.shortcuts}
            aria-expanded={showShortcuts}
            aria-controls={showShortcuts ? "crop-shortcuts" : undefined}
            onClick={() => setShowShortcuts((value) => !value)}
          >
            <Keyboard size={21} />
          </button>
          {showShortcuts && (
            <aside
              id="crop-shortcuts"
              className="crop-editor-shortcuts"
              role="dialog"
              aria-label={text.shortcuts}
              lang={language}
            >
              <dl>
                {CROP_SHORTCUTS.map((shortcut, index) => (
                  <div key={shortcut.chord} className={index > 0 && index % 4 === 0 ? "crop-shortcut-group-start" : undefined}>
                    <dt><kbd>{shortcut.chord}</kbd></dt>
                    <dd>{text[shortcut.label](shortcut.step)}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          )}
        </div>
      </header>
      <section className="crop-editor-workspace">
        <div className="crop-editor-viewport" ref={workspaceRef}>
          {data && (
            <div
              className="crop-editor-picture"
              ref={pictureRef}
              style={{ width: data.width * scale, height: data.height * scale }}
            >
              <video
                src={window.reva?.mediaURL(data.mediaPath)}
                muted
                playsInline
                preload="auto"
                draggable={false}
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  const time = Math.max(
                    0,
                    Math.min(
                      data.time,
                      Number.isFinite(video.duration)
                        ? Math.max(0, video.duration - 1 / 1000)
                        : data.time,
                    ),
                  );
                  if (Math.abs(video.currentTime - time) > 1 / 1000)
                    video.currentTime = time;
                }}
                onLoadedData={(event) => {
                  if (!event.currentTarget.seeking) setFrameReady(true);
                }}
                onSeeked={() => setFrameReady(true)}
                onError={() => setError(text.failed)}
              />
              <div
                className="crop-editor-shade"
                style={{ inset: `0 0 auto 0`, height: percent(normalized.y) }}
              />
              <div
                className="crop-editor-shade"
                style={{
                  left: 0,
                  right: 0,
                  top: percent(normalized.y + normalized.height),
                  bottom: 0,
                }}
              />
              <div
                className="crop-editor-shade"
                style={{
                  left: 0,
                  top: percent(normalized.y),
                  width: percent(normalized.x),
                  height: percent(normalized.height),
                }}
              />
              <div
                className="crop-editor-shade"
                style={{
                  left: percent(normalized.x + normalized.width),
                  right: 0,
                  top: percent(normalized.y),
                  height: percent(normalized.height),
                }}
              />
              <div
                className="crop-editor-selection"
                ref={selectionRef}
                role="group"
                aria-label={text.area}
                aria-description={`${text.help} ${Math.round(crop.width)} × ${Math.round(crop.height)} px; X ${Math.round(crop.x)}, Y ${Math.round(crop.y)}`}
                tabIndex={0}
                style={selectionStyle}
                onPointerDown={(event) => startDrag(event, "move")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {[0.25, 0.5, 0.75].map((position) => (
                  <div
                    key={`x${position}`}
                    className={`crop-editor-grid vertical ${position === 0.5 ? "center" : ""}`}
                    style={{ left: percent(position) }}
                  />
                ))}
                {[0.25, 0.5, 0.75].map((position) => (
                  <div
                    key={`y${position}`}
                    className={`crop-editor-grid horizontal ${position === 0.5 ? "center" : ""}`}
                    style={{ top: percent(position) }}
                  />
                ))}
                {handles.map((handle) => (
                  <button
                    key={handle}
                    className={`crop-editor-handle handle-${handle}`}
                    tabIndex={-1}
                    aria-label={`${text.resize} (${handle.toUpperCase()})`}
                    onPointerDown={(event) => startDrag(event, handle)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  />
                ))}
              </div>
            </div>
          )}
          {(!data || !frameReady) && (
            <div className="crop-editor-status" role="status">
              {error ?? (loading || data ? text.loading : text.empty)}
            </div>
          )}
        </div>
      </section>
      <footer className="crop-editor-footer">
        {error && data && frameReady && (
          <span className="crop-editor-error" role="alert">
            {error}
          </span>
        )}
        <button
          className="crop-editor-confirm"
          disabled={!data || !frameReady || busy}
          onClick={() => void complete(true)}
        >
          {text.confirm}
          <CornerDownLeft size={17} />
        </button>
        <button
          className="crop-editor-discard"
          disabled={busy}
          onClick={() => void complete(false)}
        >
          {text.discard}
        </button>
      </footer>
    </main>
  );
}
