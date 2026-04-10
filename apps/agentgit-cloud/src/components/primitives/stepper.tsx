import { Check } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export function Stepper({
  currentStep,
  steps,
}: {
  currentStep: number;
  steps: Array<{ id: string; title: string; description?: string }>;
}) {
  return (
    <ol className="grid gap-4 md:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
      {steps.map((step, index) => {
        const isComplete = index < currentStep;
        const isCurrent = index === currentStep;

        return (
          <li className="flex gap-3" key={step.id}>
            <span className="flex flex-col items-center gap-2 pt-0.5">
              <span
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-full border ag-text-body-sm font-semibold",
                  isComplete
                    ? "border-[var(--ag-color-brand)] text-[var(--ag-color-brand)]"
                    : isCurrent
                      ? "border-[var(--ag-color-brand)] bg-[color:rgb(10_205_207_/_0.12)] text-[var(--ag-text-primary)]"
                      : "border-[var(--ag-border-default)] text-[var(--ag-text-secondary)]",
                )}
              >
                {isComplete ? <Check aria-hidden="true" className="size-4" strokeWidth={2} /> : index + 1}
              </span>
              {index < steps.length - 1 ? <span className="hidden h-full w-px bg-[var(--ag-border-subtle)] md:block" /> : null}
            </span>
            <span className="space-y-1">
              <span className={cn("ag-text-body-sm font-semibold", isCurrent ? "text-[var(--ag-text-primary)]" : "text-[var(--ag-text-secondary)]")}>
                {step.title}
              </span>
              {step.description ? <span className="ag-text-caption text-[var(--ag-text-secondary)]">{step.description}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
