const mobileQuery = "(max-width: 900px)";

/**
 * Mobile browsers (notably Chrome on Android) can leave `100dvh` stale after
 * the toolbar settles, which pushes the bottom nav below the screen until the
 * page is pulled. Mirror the measured layout viewport into `--app-height` so
 * the shell always matches what is actually visible.
 */
export function startViewportHeightSync(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const root = document.documentElement;
  const media = window.matchMedia(mobileQuery);
  let frame = 0;

  const apply = () => {
    frame = 0;
    if (media.matches) root.style.setProperty("--app-height", `${window.innerHeight}px`);
    else root.style.removeProperty("--app-height");
  };
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(apply);
  };

  apply();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.addEventListener("pageshow", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  media.addEventListener?.("change", schedule);

  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.removeEventListener("pageshow", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    media.removeEventListener?.("change", schedule);
    root.style.removeProperty("--app-height");
  };
}
