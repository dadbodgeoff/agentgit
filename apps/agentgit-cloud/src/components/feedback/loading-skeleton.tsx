import { cn } from "@/lib/utils/cn";

export function LoadingSkeleton({
  className,
  lines = 1,
}: {
  className?: string;
  lines?: number;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <div
          className="h-4 animate-pulse rounded-full bg-[color:rgb(255_255_255_/_0.08)]"
          key={`skeleton-${index}`}
        />
      ))}
    </div>
  );
}
