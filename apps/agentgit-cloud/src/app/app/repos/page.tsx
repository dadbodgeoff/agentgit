import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { RepositoryListPage } from "@/features/repos/repository-list-page";

export default async function RepositoryListRoute({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <RepositoryListPage previewState={previewState} />;
}
