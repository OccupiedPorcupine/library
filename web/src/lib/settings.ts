/**
 * Small per-device display preferences, kept in localStorage and mirrored onto
 * <html> data attributes so CSS can react before React mounts (see index.html).
 */
const DIM_KEY = "dimByProgress";

/** Whether unread parts of books are dimmed to show reading progress. On by default. */
export function getDimByProgress(): boolean {
  try {
    return localStorage.getItem(DIM_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDimByProgress(on: boolean) {
  const root = document.documentElement;
  if (on) delete root.dataset.dim;
  else root.dataset.dim = "off";
  try {
    if (on) localStorage.removeItem(DIM_KEY);
    else localStorage.setItem(DIM_KEY, "off");
  } catch {
    /* storage unavailable: setting still applies for this visit */
  }
}
