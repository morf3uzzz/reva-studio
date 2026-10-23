import { useEffect, useRef, useState } from "react";
import { CircleDot, MousePointer2, Orbit, Route, Zap } from "lucide-react";
import { Range, Toggle } from "./components";
import { defaultAppearance } from "./core/model";
import { createSpringState, DEFAULT_SPRING, integrateSpring, setSpringTarget, SPRING_PRESETS, type SpringConfig } from "./core/spring";
import type { Appearance, Project } from "./types";
import { t } from "./i18n";
import "./animation-inspector.css";

function Demo({ config }: { config: SpringConfig | null }) {
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let id = 0, last = 0, nextTarget = 0, target = 0, state = createSpringState(0);
    const frame = (now: number) => {
      if (now >= nextTarget) { target = 1 - target; state = setSpringTarget(state, target, config ?? DEFAULT_SPRING); nextTarget = now + 1700; }
      state = config ? integrateSpring(state, last ? Math.min(50, now - last) : 0, config) : { ...state, position: target };
      if (element.current) element.current.style.left = `${8 + state.position * 80}%`;
      last = now; id = requestAnimationFrame(frame);
    };
    id = requestAnimationFrame(frame); return () => cancelAnimationFrame(id);
  }, [config]);
  return <div className="animation-demo" aria-hidden="true"><span ref={element} /></div>;
}
const screenChoices = [{ id: "focused", label: "Focused", config: SPRING_PRESETS.screenFocused, icon: CircleDot }, { id: "smooth", label: "Smooth", config: SPRING_PRESETS.screenSmooth, icon: Route }];
const cursorChoices = [{ id: "smooth", label: "Smooth", config: SPRING_PRESETS.cursorSmooth, icon: Orbit }, { id: "medium", label: "Medium", config: SPRING_PRESETS.cursorMedium, icon: MousePointer2 }, { id: "rapid", label: "Rapid", config: SPRING_PRESETS.cursorRapid, icon: Zap }, { id: "none", label: "None", config: null, icon: MousePointer2 }];
const same = (a: SpringConfig, b: SpringConfig) => (Object.keys(a) as (keyof SpringConfig)[]).every(key => a[key] === b[key]);
export default function AnimationInspector({ project, update }: { project: Project; update: (value: Project | ((p: Project) => Project), group?: string) => void }) {
  const a = project.appearance, screen = a.screenSpring ?? DEFAULT_SPRING, cursor = a.cursorSmooth ? a.cursorSpring ?? DEFAULT_SPRING : null;
  const [hoverScreen, setHoverScreen] = useState<string | null>(null), [hoverCursor, setHoverCursor] = useState<string | null>(null);
  const screenId = screenChoices.find(value => same(screen, value.config))?.id, cursorId = cursor ? cursorChoices.find(value => value.config && same(cursor, value.config))?.id : "none";
  const previewScreen = screenChoices.find(value => value.id === hoverScreen)?.config ?? screen;
  const previewCursor = hoverCursor ? cursorChoices.find(value => value.id === hoverCursor)!.config : cursor;
  const change = (patch: Partial<Appearance>, group?: string) => update(p => ({ ...p, appearance: { ...p.appearance, ...patch } }), group);
  return <div className="animation-settings">
    <h3>{t("Screen animation style")}</h3>
    <div className="animation-cards" role="group" aria-label={t("Screen animation style")} onMouseLeave={() => setHoverScreen(null)}>{screenChoices.map(({ id, label, config, icon: Icon }) => <button key={id} aria-pressed={screenId === id} onMouseEnter={() => setHoverScreen(id)} onFocus={() => setHoverScreen(id)} onBlur={() => setHoverScreen(null)} onClick={() => change({ screenSpring: { ...config } })}><Icon size={20} />{t(label)}</button>)}</div>
    <p className="animation-description">{t((hoverScreen ?? screenId) === "smooth" ? "Animation is more fluid. Great for more creative content not focused on reading" : "Animation stabilizes quickly making it easier to follow and read the content")}</p>
    {!screenId && <small className="animation-custom">{t("Custom")}</small>}
    <Demo config={previewScreen} /><button className="outline-button full" onClick={() => change({ screenSpring: { ...defaultAppearance().screenSpring! } })}>{t("Reset")}</button>
    <h3>{t("Cursor animation style")}</h3>
    <div className="animation-cards cursor-animation-cards" role="group" aria-label={t("Cursor animation style")} onMouseLeave={() => setHoverCursor(null)}>{cursorChoices.map(({ id, label, config, icon: Icon }) => <button key={id} aria-pressed={cursorId === id} onMouseEnter={() => setHoverCursor(id)} onFocus={() => setHoverCursor(id)} onBlur={() => setHoverCursor(null)} onClick={() => change({ cursorSmooth: config !== null, ...(config ? { cursorSpring: { ...config } } : {}) })}><Icon size={19} />{t(label)}</button>)}</div>
    {!cursorId && <small className="animation-custom">{t("Custom")}</small>}
    <Demo config={previewCursor} /><button className="outline-button full" onClick={() => change({ cursorSmooth: true, cursorSpring: undefined })}>{t("Reset")}</button>
    <hr /><h3>{t("Motion blur")}</h3><p className="animation-description">{t("Elements that are moving will have a cinematic motion blur effect applied")}</p><Range label="Motion blur" value={a.motionBlur ?? 0} max={1} step={.01} onChange={motionBlur => change({ motionBlur }, "motionBlur")} display={`${Math.round((a.motionBlur ?? 0) * 100)}%`} />
    <details className="animation-advanced"><summary>{t("Advanced")}</summary>{(["stiffness", "damping", "mass"] as const).map(key => <Range key={key} label={key === "stiffness" ? "Stiffness" : key === "damping" ? "Damping" : "Mass"} value={screen[key]} min={key === "mass" ? .1 : 5} max={key === "mass" ? 15 : key === "damping" ? 200 : 600} step={key === "mass" ? .1 : 1} onChange={value => change({ screenSpring: { ...screen, [key]: value } }, `spring-${key}`)} reset={() => change({ screenSpring: { ...screen, [key]: DEFAULT_SPRING[key] } })} />)}
      <Toggle label="Start zoom animations early" description="Begin the animation before the zoom starts on the timeline." value={a.zoomStartEarly ?? false} onChange={zoomStartEarly => change({ zoomStartEarly })} />
      <Range label="Fade in" value={a.fadeIn} max={5} step={.1} onChange={fadeIn => change({ fadeIn }, "fadeIn")} /><Range label="Fade out" value={a.fadeOut} max={5} step={.1} onChange={fadeOut => change({ fadeOut }, "fadeOut")} />
    </details>
  </div>;
}
