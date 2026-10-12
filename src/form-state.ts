import { useRef } from "react";

/**
 * Captures the values a form opened with and reports whether they changed since.
 * Sheets pass the result to `BottomSheet`'s `dirty` prop so closing asks before discarding.
 * Forms are keyed per record, so the first render's values are the saved state.
 */
export function useDirtyCheck(values: unknown): boolean {
  const signature = JSON.stringify(values);
  const initial = useRef(signature);
  return signature !== initial.current;
}
