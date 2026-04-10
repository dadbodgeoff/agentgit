"use client";

import { useMemo, useState, type ReactNode } from "react";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Button, Checkbox, Select, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow } from "@/components/primitives";
import { cn } from "@/lib/utils/cn";

type SortDirection = "asc" | "desc" | null;

export type DataTableColumn<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  mobileLabel?: string;
  sortValue?: (row: T) => string | number;
  className?: string;
};

export function DataTable<T>({
  bulkActions,
  columns,
  data,
  defaultPageSize = 25,
  getRowId,
  pageSizeOptions = [10, 25, 50, 100],
}: {
  bulkActions?: (rows: T[]) => ReactNode;
  columns: DataTableColumn<T>[];
  data: T[];
  defaultPageSize?: number;
  getRowId: (row: T) => string;
  pageSizeOptions?: number[];
}) {
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [page, setPage] = useState(0);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  const sortedData = useMemo(() => {
    if (!sortColumn || !sortDirection) {
      return data;
    }

    const column = columns.find((candidate) => candidate.key === sortColumn);
    if (!column?.sortValue) {
      return data;
    }

    return [...data].sort((left, right) => {
      const leftValue = column.sortValue?.(left) ?? "";
      const rightValue = column.sortValue?.(right) ?? "";

      if (leftValue === rightValue) {
        return 0;
      }

      const comparison = leftValue > rightValue ? 1 : -1;
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [columns, data, sortColumn, sortDirection]);

  const pageCount = Math.max(Math.ceil(sortedData.length / pageSize), 1);
  const safePage = Math.min(page, pageCount - 1);
  const pagedRows = sortedData.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const selectedRows = sortedData.filter((row) => selectedRowIds.includes(getRowId(row)));
  const visibleIds = pagedRows.map((row) => getRowId(row));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedRowIds.includes(id));
  const start = sortedData.length === 0 ? 0 : safePage * pageSize + 1;
  const end = Math.min((safePage + 1) * pageSize, sortedData.length);

  function toggleSort(key: string) {
    if (sortColumn !== key) {
      setSortColumn(key);
      setSortDirection("asc");
      return;
    }

    if (sortDirection === "asc") {
      setSortDirection("desc");
      return;
    }

    if (sortDirection === "desc") {
      setSortDirection(null);
      setSortColumn(null);
      return;
    }

    setSortDirection("asc");
  }

  return (
    <div className="space-y-4">
      {selectedRows.length > 0 && bulkActions ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--ag-radius-lg)] border border-[color:rgb(10_205_207_/_0.22)] bg-[color:rgb(10_205_207_/_0.08)] px-4 py-3">
          <div className="ag-text-body-sm text-[var(--ag-text-primary)]">
            {selectedRows.length} selected on this filtered view.
          </div>
          <div className="flex flex-wrap items-center gap-2">{bulkActions(selectedRows)}</div>
        </div>
      ) : null}

      <div className="md:hidden">
        <div className="space-y-3">
          {pagedRows.map((row) => {
            const rowId = getRowId(row);
            const isSelected = selectedRowIds.includes(rowId);

            return (
              <article
                className={cn(
                  "rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-surface-base)] p-4",
                  isSelected && "border-[color:rgb(10_205_207_/_0.28)] bg-[var(--ag-surface-selected)]",
                )}
                key={rowId}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <Checkbox
                    aria-label={`Select ${rowId}`}
                    checked={isSelected}
                    onChange={() =>
                      setSelectedRowIds((current) =>
                        current.includes(rowId) ? current.filter((id) => id !== rowId) : [...current, rowId],
                      )
                    }
                  />
                </div>
                <dl className="space-y-3">
                  {columns.map((column) => (
                    <div className="space-y-1" key={column.key}>
                      <dt className="ag-text-overline text-[var(--ag-text-tertiary)]">{column.mobileLabel ?? column.header}</dt>
                      <dd className="ag-text-body-sm text-[var(--ag-text-primary)]">{column.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            );
          })}
        </div>
      </div>

      <div className="hidden md:block">
        <TableRoot>
          <TableHead>
            <TableRow>
              <TableHeaderCell className="sticky left-0 z-[1] bg-[var(--ag-surface-raised)]">
                <Checkbox
                  aria-label="Select all visible rows"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelectedRowIds((current) =>
                      allVisibleSelected
                        ? current.filter((id) => !visibleIds.includes(id))
                        : Array.from(new Set([...current, ...visibleIds])),
                    )
                  }
                />
              </TableHeaderCell>
              {columns.map((column, index) => {
                const isSorted = sortColumn === column.key ? sortDirection : null;

                return (
                  <TableHeaderCell
                    aria-sort={
                      isSorted === "asc" ? "ascending" : isSorted === "desc" ? "descending" : "none"
                    }
                    className={cn(index === 0 && "sticky left-[57px] z-[1] bg-[var(--ag-surface-raised)]", column.className)}
                    key={column.key}
                  >
                    {column.sortValue ? (
                      <button
                        className="ag-focus-ring inline-flex items-center gap-2 rounded-sm"
                        onClick={() => toggleSort(column.key)}
                        type="button"
                      >
                        <span>{column.header}</span>
                        {isSorted === "asc" ? (
                          <ArrowUp aria-hidden="true" className="size-3.5" />
                        ) : isSorted === "desc" ? (
                          <ArrowDown aria-hidden="true" className="size-3.5" />
                        ) : (
                          <ArrowUpDown aria-hidden="true" className="size-3.5" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </TableHeaderCell>
                );
              })}
            </TableRow>
          </TableHead>
          <TableBody>
            {pagedRows.map((row) => {
              const rowId = getRowId(row);
              const isSelected = selectedRowIds.includes(rowId);

              return (
                <TableRow className={isSelected ? "bg-[var(--ag-surface-selected)]" : undefined} key={rowId}>
                  <TableCell className="sticky left-0 z-[1] bg-inherit">
                    <Checkbox
                      aria-label={`Select ${rowId}`}
                      checked={isSelected}
                      onChange={() =>
                        setSelectedRowIds((current) =>
                          current.includes(rowId) ? current.filter((id) => id !== rowId) : [...current, rowId],
                        )
                      }
                    />
                  </TableCell>
                  {columns.map((column, index) => (
                    <TableCell
                      className={cn(index === 0 && "sticky left-[57px] z-[1] bg-inherit", column.className)}
                      key={column.key}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </TableRoot>
      </div>

      <div className="flex flex-col gap-3 border-t border-[var(--ag-border-subtle)] pt-4 md:flex-row md:items-center md:justify-between">
        <div className="ag-text-body-sm text-[var(--ag-text-secondary)]">
          Showing {start}-{end} of {sortedData.length}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-28">
            <Select
              aria-label="Rows per page"
              id="data-table-page-size"
              onChange={(event) => {
                setPage(0);
                setPageSize(Number(event.target.value));
              }}
              value={String(pageSize)}
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option} / page
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button disabled={safePage === 0} onClick={() => setPage((current) => Math.max(current - 1, 0))} variant="secondary">
              Previous
            </Button>
            <span className="ag-text-body-sm text-[var(--ag-text-secondary)]">
              Page {safePage + 1} of {pageCount}
            </span>
            <Button
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((current) => Math.min(current + 1, pageCount - 1))}
              variant="secondary"
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
