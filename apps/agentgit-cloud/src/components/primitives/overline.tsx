import type { ElementType, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export function Overline<T extends ElementType = "span">({
  as,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: T; children: ReactNode }) {
  const Component = (as ?? "span") as ElementType;

  return (
    <Component className={cn("ag-text-overline text-[var(--ag-text-tertiary)]", className)} {...props}>
      {children}
    </Component>
  );
}
