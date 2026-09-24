import { LoaderCircle } from "lucide-react";
import { BottomSheet } from "./BottomSheet";

export function ConfirmSheet({
  open,
  title,
  closeLabel,
  description,
  confirmLabel,
  danger = false,
  isPending = false,
  onConfirm,
  onClose
}: {
  open: boolean;
  title: string;
  closeLabel: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet
      open={open}
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      className="confirm-sheet"
      footer={
        <button className={danger ? "danger-button" : "primary-button"} type="button" disabled={isPending} onClick={onConfirm}>
          {isPending ? <LoaderCircle className="spin" size={17} /> : null}
          {confirmLabel}
        </button>
      }
    >
      <p className="sheet-intro">{description}</p>
    </BottomSheet>
  );
}
