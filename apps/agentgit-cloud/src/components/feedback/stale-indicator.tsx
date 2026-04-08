export function StaleIndicator({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "warning";
}) {
  const toneClassName =
    tone === "success"
      ? "border-[color:rgb(34_197_94_/_0.25)] text-[var(--ag-status-success)]"
      : tone === "warning"
        ? "border-[color:rgb(245_158_11_/_0.25)] text-[var(--ag-status-warning)]"
        : "border-[var(--ag-border-default)] text-[var(--ag-text-secondary)]";

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[12px] ${toneClassName}`}>
      {label}
    </span>
  );
}
