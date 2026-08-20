import { registerSW } from "virtual:pwa-register";

const updateIntervalMs = 60_000;
let registration: ServiceWorkerRegistration | undefined;
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;
let started = false;
let deferredUpdateTimer: number | undefined;

function hasActiveEditor(): boolean {
  if (document.body.classList.contains("modal-open")) return true;
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
}

function installWhenSafe(): void {
  if (!updateServiceWorker) return;
  if (hasActiveEditor()) {
    window.clearTimeout(deferredUpdateTimer);
    deferredUpdateTimer = window.setTimeout(installWhenSafe, 10_000);
    return;
  }
  void updateServiceWorker(true);
}

function checkForUpdate(): void {
  if (!registration || navigator.onLine === false) return;
  void registration.update().catch(() => undefined);
}

export function startAppUpdates(): void {
  if (started || !("serviceWorker" in navigator)) return;
  started = true;
  updateServiceWorker = registerSW({
    immediate: true,
    onRegisteredSW: (_serviceWorkerUrl, nextRegistration) => {
      registration = nextRegistration;
      window.setTimeout(checkForUpdate, 10_000);
      window.setInterval(checkForUpdate, updateIntervalMs);
    },
    onNeedRefresh: installWhenSafe
  });
  window.addEventListener("focus", checkForUpdate);
  window.addEventListener("online", checkForUpdate);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
}

export async function refreshApplication(): Promise<void> {
  if (registration) {
    await registration.update().catch(() => undefined);
    if (registration.waiting && updateServiceWorker) {
      await updateServiceWorker(true);
      return;
    }
  }
  // /auth is outside the service-worker navigation fallback, so this always
  // downloads the current app shell while preserving cookies and IndexedDB.
  window.location.assign(`/auth/refresh?update=${Date.now()}`);
}
