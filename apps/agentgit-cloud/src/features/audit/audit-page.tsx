"use client";

import { PageHeader } from "@/components/composites";
import { PageStatePanel } from "@/components/feedback";
import { Card, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow } from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import { useAuditQuery } from "@/lib/query/hooks";
import { formatRelativeTimestamp } from "@/lib/utils/format";

export function AuditPage() {
  const auditQuery = useAuditQuery();

  if (auditQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
          title="Audit log"
        />
        <PageStatePanel state="loading" />
      </>
    );
  }

  if (auditQuery.isError) {
    return (
      <>
        <PageHeader
          description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
          title="Audit log"
        />
        <PageStatePanel errorMessage={getApiErrorMessage(auditQuery.error, "Could not load audit log. Retry.")} state="error" />
      </>
    );
  }

  const audit = auditQuery.data;
  if (audit.items.length === 0) {
    return (
      <>
        <PageHeader
          description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
          title="Audit log"
        />
        <PageStatePanel
          emptyTitle="No audit entries yet"
          emptyDescription="Audit entries will appear as governed operations are recorded."
          state="empty"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
        title="Audit log"
      />
      <Card className="space-y-4">
        <TableRoot>
          <TableHead>
            <TableRow>
              <TableHeaderCell>When</TableHeaderCell>
              <TableHeaderCell>Actor</TableHeaderCell>
              <TableHeaderCell>Category</TableHeaderCell>
              <TableHeaderCell>Action</TableHeaderCell>
              <TableHeaderCell>Target</TableHeaderCell>
              <TableHeaderCell>Outcome</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {audit.items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(entry.occurredAt)}</TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="font-medium">{entry.actorLabel}</div>
                    <div className="text-xs text-[var(--ag-text-secondary)]">{entry.actorType}</div>
                  </div>
                </TableCell>
                <TableCell className="capitalize">{entry.category}</TableCell>
                <TableCell>{entry.action}</TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div>{entry.target}</div>
                    <div className="text-xs text-[var(--ag-text-secondary)]">{entry.details}</div>
                  </div>
                </TableCell>
                <TableCell className="capitalize">{entry.outcome}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableRoot>
      </Card>
    </>
  );
}
