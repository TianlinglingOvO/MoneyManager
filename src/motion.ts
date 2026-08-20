import { useCallback, useEffect, useRef, useState } from "react";

export const motionDurations = {
  micro: 140,
  panel: 240,
  dialogExit: 200,
  trendChart: 800,
  pieChart: 900
} as const;

export const chartMotionEasing = {
  trend: "cubic-bezier(0,0,0.58,1)",
  pie: "linear"
} as const;

export function resolveChartMotionToken(
  requestedToken: number,
  resolvedToken: number,
  isPlaceholderData: boolean,
  hasData: boolean
): number {
  return !isPlaceholderData && hasData ? requestedToken : resolvedToken;
}

export function useResolvedChartMotionToken(
  requestedToken: number,
  isPlaceholderData: boolean,
  hasData: boolean
): number {
  const [resolvedToken, setResolvedToken] = useState(0);

  useEffect(() => {
    setResolvedToken((current) => resolveChartMotionToken(requestedToken, current, isPlaceholderData, hasData));
  }, [hasData, isPlaceholderData, requestedToken]);

  return resolvedToken;
}

export function useChartMotion(animationToken: number, enabled: boolean) {
  const latestToken = useRef(animationToken);
  const [completedToken, setCompletedToken] = useState(0);
  const [runningToken, setRunningToken] = useState<number | null>(null);
  latestToken.current = animationToken;

  useEffect(() => {
    setRunningToken(null);
    if (!enabled) setCompletedToken(animationToken);
  }, [animationToken, enabled]);

  const onAnimationStart = useCallback(() => {
    if (!enabled || animationToken <= 0 || latestToken.current !== animationToken) return;
    setRunningToken(animationToken);
  }, [animationToken, enabled]);

  const onAnimationEnd = useCallback(() => {
    if (!enabled || animationToken <= 0 || latestToken.current !== animationToken) return;
    setRunningToken(null);
    setCompletedToken(animationToken);
  }, [animationToken, enabled]);

  return {
    isAnimationActive: enabled && animationToken > 0 && completedToken !== animationToken,
    isAnimationRunning: runningToken === animationToken,
    onAnimationStart,
    onAnimationEnd
  };
}

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);

  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}
