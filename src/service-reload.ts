import type { SystemReload } from "@shared/types";

const healthWaitMs = 30_000;
const healthPollMs = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function requestServiceReload(): Promise<SystemReload | null> {
  try {
    const response = await fetch("/api/v1/system/reload", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const payload = await response.json() as { data?: SystemReload };
    return payload.data ?? null;
  } catch {
    return null;
  }
}

export async function waitForServiceReady(previousVersion: string, timeoutMs = healthWaitMs): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawUnavailable = false;
  while (Date.now() < deadline) {
    await sleep(healthPollMs);
    try {
      const response = await fetch(`/health?t=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        sawUnavailable = true;
        continue;
      }
      const body = await response.json() as { status?: string; version?: string };
      if (body.status !== "ok" || !body.version) {
        sawUnavailable = true;
        continue;
      }
      if (sawUnavailable || body.version !== previousVersion) return true;
    } catch {
      sawUnavailable = true;
    }
  }
  return false;
}
