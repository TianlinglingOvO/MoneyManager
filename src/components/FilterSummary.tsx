import { SlidersHorizontal } from "lucide-react";

export function FilterSummary({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className={`filter-summary ${count > 0 ? "is-active" : ""}`} type="button" onClick={onClick} aria-label={`打开筛选，当前启用 ${count} 项`}>
      <SlidersHorizontal size={17} aria-hidden="true" />
      <span>筛选{count > 0 ? ` ${count}` : ""}</span>
    </button>
  );
}
