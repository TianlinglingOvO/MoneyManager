import { createContext, useContext } from "react";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  tone?: "success" | "error";
}

export type Notify = (text: string, options?: ToastOptions) => void;

export const ToastContext = createContext<Notify>(() => undefined);

export function useToast(): Notify {
  return useContext(ToastContext);
}

/**
 * Confirms a reversible soft delete with an undo action instead of asking
 * beforehand. `restore` must call the API directly: the component that deleted
 * the item may already be unmounted when the user presses undo.
 */
export function offerUndo(notify: Notify, text: string, restore: () => Promise<unknown>, onRestored: () => void): void {
  notify(text, {
    action: {
      label: "撤销",
      run: () => {
        restore()
          .then(() => { onRestored(); notify("已恢复"); })
          .catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "恢复失败，可以在回收站中恢复", { tone: "error" }));
      }
    }
  });
}
