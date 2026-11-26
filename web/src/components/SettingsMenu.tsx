import { useEffect, useId, useRef, useState } from "react";
import { getDimByProgress, setDimByProgress } from "../lib/settings";
import { getTheme, setTheme, type ThemeChoice } from "../lib/theme";

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Display settings: theme and the reading-progress dimming of books. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme);
  const [dim, setDim] = useState(getDimByProgress);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="settings" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        aria-label="Display settings"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="10.5" cy="4.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="5.5" cy="11.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <div className={`settings__panel${open ? " is-open" : ""}`} id={panelId} role="dialog" aria-label="Display settings" hidden={!open}>
        <p className="settings__label">Appearance</p>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={theme === t.value}
              className={theme === t.value ? "is-on" : undefined}
              onClick={() => (setTheme(t.value), setThemeState(t.value))}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="switch-row">
          <span>
            <span className="switch-row__title">Dim by reading progress</span>
            <span className="switch-row__hint">Unread books start dim and light up as you read.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={dim}
            onChange={(e) => (setDimByProgress(e.target.checked), setDim(e.target.checked))}
          />
        </label>
      </div>
    </div>
  );
}
