import { createContext, useContext } from "react";
import type { Transaction } from "@shared/types";

export interface EntryContextValue {
  openEntry: (transaction?: Transaction) => void;
  closeEntry: () => void;
}

export const EntryContext = createContext<EntryContextValue | null>(null);

export function useEntry(): EntryContextValue {
  const value = useContext(EntryContext);
  if (!value) throw new Error("EntryContext is missing");
  return value;
}
