import clsx from "clsx";

export interface BrandMarkProps {
  className?: string;
  compact?: boolean;
  decorative?: boolean;
}

export function BrandMark({ className, compact = false, decorative = true }: BrandMarkProps) {
  return (
    <img
      className={clsx("brand-mark", className)}
      src={compact ? "/smb-favicon-v2.svg" : "/smb-mark-v2.svg"}
      width="180"
      height="180"
      alt={decorative ? "" : "SMB"}
      aria-hidden={decorative || undefined}
      draggable={false}
    />
  );
}
