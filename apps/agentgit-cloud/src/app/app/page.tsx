import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { DashboardPage } from "@/features/dashboard/dashboard-page";

export default async function AppDashboardRoute({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <DashboardPage previewState={previewState} />;
}
