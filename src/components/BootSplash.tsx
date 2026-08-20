import { useEffect, useState } from "react";
import { useReducedMotion } from "../motion";

const sessionKey = "money-manager.boot-splash.v1";
let claimedThisDocument = false;

function claimSplash(): boolean {
  if (claimedThisDocument || typeof window === "undefined") return false;
  try {
    if (window.sessionStorage.getItem(sessionKey) === "shown") return false;
    window.sessionStorage.setItem(sessionKey, "shown");
  } catch {
    // A private browser may block session storage; the document guard still prevents replays.
  }
  claimedThisDocument = true;
  return true;
}

export function BootSplash() {
  const reducedMotion = useReducedMotion();
  const [claimed] = useState(() => !reducedMotion && claimSplash());
  const [phase, setPhase] = useState<"visible" | "closing" | "hidden">("visible");

  useEffect(() => {
    if (!claimed || reducedMotion) {
      setPhase("hidden");
      return;
    }
    const closeTimer = window.setTimeout(() => setPhase("closing"), 440);
    const hideTimer = window.setTimeout(() => setPhase("hidden"), 720);
    return () => {
      window.clearTimeout(closeTimer);
      window.clearTimeout(hideTimer);
    };
  }, [claimed, reducedMotion]);

  if (!claimed || phase === "hidden") return null;

  return (
    <div className={`boot-splash ${phase === "closing" ? "is-closing" : ""}`} aria-hidden="true">
      <div className="boot-splash__brand">
        <span>寸</span>
        <strong>寸金</strong>
      </div>
    </div>
  );
}
