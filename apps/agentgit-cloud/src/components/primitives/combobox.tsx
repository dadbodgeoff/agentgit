"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export type ComboboxOption = {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
};

export function Combobox({
  className,
  emptyMessage = "No matches found.",
  label,
  onValueChange,
  options,
  placeholder = "Search",
  value,
}: {
  className?: string;
  emptyMessage?: string;
  label?: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value) ?? null;
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return options;
    }

    return options.filter((option) => {
      const haystack = [option.label, option.description ?? "", ...(option.keywords ?? [])].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [options, query]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  function commitSelection(nextValue: string) {
    onValueChange(nextValue);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className={cn("flex w-full flex-col gap-1", className)} ref={rootRef}>
      {label ? <span className="ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">{label}</span> : null}
      <div className="relative">
        <div className="relative">
          <input
            aria-autocomplete="list"
            aria-expanded={open}
            aria-label={label ?? placeholder}
            className="ag-focus-ring min-h-11 w-full rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] px-3 pr-10 ag-text-body text-[var(--ag-text-primary)] placeholder:text-[var(--ag-text-tertiary)]"
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                setOpen(true);
                return;
              }

              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlightedIndex((current) => Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlightedIndex((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter" && filteredOptions[highlightedIndex]) {
                event.preventDefault();
                commitSelection(filteredOptions[highlightedIndex].value);
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder={selected?.label ?? placeholder}
            role="combobox"
            value={query}
          />
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--ag-text-secondary)]"
            strokeWidth={1.5}
          />
        </div>

        {open ? (
          <div className="absolute z-[var(--ag-z-dropdown)] mt-2 max-h-80 w-full overflow-auto rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] p-1 shadow-[var(--ag-shadow-lg)]">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 ag-text-body-sm text-[var(--ag-text-secondary)]">{emptyMessage}</div>
            ) : (
              <div role="listbox">
                {filteredOptions.map((option, index) => {
                  const active = index === highlightedIndex;
                  const isSelected = option.value === value;

                  return (
                    <button
                      className={cn(
                        "flex w-full items-start justify-between gap-3 rounded-[var(--ag-radius-sm)] px-3 py-2 text-left transition-colors duration-[var(--ag-duration-fast)]",
                        active ? "bg-[var(--ag-surface-hover)]" : "hover:bg-[var(--ag-surface-hover)]",
                      )}
                      key={option.value}
                      onClick={() => commitSelection(option.value)}
                      role="option"
                      type="button"
                    >
                      <span className="space-y-0.5">
                        <span className="ag-text-body-sm font-medium text-[var(--ag-text-primary)]">{option.label}</span>
                        {option.description ? (
                          <span className="ag-text-caption text-[var(--ag-text-secondary)]">{option.description}</span>
                        ) : null}
                      </span>
                      {isSelected ? <Check aria-hidden="true" className="mt-0.5 size-4 text-[var(--ag-color-brand)]" strokeWidth={2} /> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
