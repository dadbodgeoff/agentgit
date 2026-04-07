import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { ApprovalQueuePage } from "@/features/approvals/approval-queue-page";

export default async function ApprovalsRoute({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <ApprovalQueuePage previewState={previewState} />;
}
