/**
 * Pinch gestures for the reader: two fingers on a touch screen, a trackpad pinch (Chrome and
 * Firefox send ctrl+wheel, Safari sends gesture events). The browser's own page zoom is blocked
 * while this is attached, because zooming the whole reader breaks its layout and page swipes;
 * the reader zooms its content instead.
 */
export interface PinchHandlers {
  /** The pinch so far, as a factor of where it started (1 = no change). */
  onChange: (scale: number) => void;
  onEnd: (scale: number) => void;
}

export function watchPinch(target: Document | HTMLElement, h: PinchHandlers): () => void {
  let start = 0;
  let scale = 1;
  let touching = false;
  let wheelTimer = 0;
  let wheeling = false;

  const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);

  const touchStart = (e: Event) => {
    const t = (e as TouchEvent).touches;
    if (t.length !== 2) return;
    touching = true;
    start = dist(t) || 1;
    scale = 1;
  };
  const touchMove = (e: Event) => {
    const t = (e as TouchEvent).touches;
    if (t.length < 2) return;
    // Two fingers: never let the browser zoom the page.
    if (e.cancelable) e.preventDefault();
    if (!touching) return touchStart(e);
    scale = dist(t) / start;
    h.onChange(scale);
  };
  const touchEnd = (e: Event) => {
    if (!touching || (e as TouchEvent).touches.length >= 2) return;
    touching = false;
    if (Math.abs(scale - 1) > 0.04) h.onEnd(scale);
    else h.onChange(1);
  };

  // Safari: trackpad pinch on a Mac, and the zoom gesture on iOS (handled by touches there).
  const gesture = (e: Event) => {
    e.preventDefault();
    if (touching) return;
    const s = (e as Event & { scale?: number }).scale ?? 1;
    if (e.type === "gestureend") {
      if (Math.abs(s - 1) > 0.04) h.onEnd(s);
      else h.onChange(1);
    } else h.onChange(s);
  };

  // Chrome / Firefox: a trackpad pinch arrives as wheel events with ctrlKey held.
  const wheel = (e: Event) => {
    const w = e as WheelEvent;
    if (!w.ctrlKey) return;
    w.preventDefault();
    if (!wheeling) {
      wheeling = true;
      scale = 1;
    }
    scale *= Math.exp(-w.deltaY / 120);
    h.onChange(scale);
    clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => {
      wheeling = false;
      h.onEnd(scale);
    }, 220);
  };

  const opts = { passive: false } as const;
  target.addEventListener("touchstart", touchStart, opts);
  target.addEventListener("touchmove", touchMove, opts);
  target.addEventListener("touchend", touchEnd);
  target.addEventListener("touchcancel", touchEnd);
  target.addEventListener("gesturestart", gesture, opts);
  target.addEventListener("gesturechange", gesture, opts);
  target.addEventListener("gestureend", gesture, opts);
  target.addEventListener("wheel", wheel, opts);
  return () => {
    clearTimeout(wheelTimer);
    target.removeEventListener("touchstart", touchStart);
    target.removeEventListener("touchmove", touchMove);
    target.removeEventListener("touchend", touchEnd);
    target.removeEventListener("touchcancel", touchEnd);
    target.removeEventListener("gesturestart", gesture);
    target.removeEventListener("gesturechange", gesture);
    target.removeEventListener("gestureend", gesture);
    target.removeEventListener("wheel", wheel);
  };
}
