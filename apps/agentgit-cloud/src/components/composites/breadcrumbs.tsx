import Link from "next/link";
import { ArrowLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

/** Page navigation hierarchy. Max 3 segments on desktop, back arrow only on mobile. */
export function Breadcrumbs({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  if (items.length === 0) return null;

  // Mobile: show back arrow linking to previous segment (or first if only one)
  const previous = items.length > 1 ? items[items.length - 2] : items[0];
  const mobileHref = previous?.href;

  return (
    <nav aria-label="Breadcrumb" className={cn("min-h-5", className)}>
      {/* Mobile: back arrow only */}
      {mobileHref ? (
        <Link
          className="ag-focus-ring inline-flex items-center gap-1 text-[13px] text-[var(--ag-text-secondary)] hover:text-[var(--ag-text-primary)] md:hidden"
          href={mobileHref}
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          <span>{previous.label}</span>
        </Link>
      ) : (
        <span className="text-[13px] text-[var(--ag-text-tertiary)] md:hidden">{items[0].label}</span>
      )}

      {/* Desktop: full breadcrumb */}
      <ol className="hidden items-center gap-1.5 md:flex">
        {items.slice(-3).map((item, index, arr) => {
          const isLast = index === arr.length - 1;

          return (
            <li className="flex items-center gap-1.5" key={`${item.label}-${index}`}>
              {index > 0 ? (
                <ChevronRight
                  aria-hidden="true"
                  className="text-[var(--ag-text-tertiary)]"
                  size={14}
                  strokeWidth={1.5}
                />
              ) : null}
              {isLast || !item.href ? (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={cn(
                    "text-[13px]",
                    isLast
                      ? "font-medium text-[var(--ag-text-primary)]"
                      : "text-[var(--ag-text-secondary)]",
                  )}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  className="ag-focus-ring text-[13px] text-[var(--ag-text-secondary)] transition-colors hover:text-[var(--ag-text-primary)]"
                  href={item.href}
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
