import { createContext, useContext } from "react";

type Notify = (text: string) => void;

export const ToastContext = createContext<Notify>(() => undefined);

export function useToast(): Notify {
  return useContext(ToastContext);
}
