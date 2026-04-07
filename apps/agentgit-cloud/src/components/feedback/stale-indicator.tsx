export function StaleIndicator({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--ag-border-default)] px-2 py-1 text-[12px] text-[var(--ag-text-secondary)]">
      {label}
    </span>
  );
}
