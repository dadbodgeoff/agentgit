import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default async function RepositoryRunsRoute({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = await params;

  return (
    <ScaffoldPage
      description={`Run inventory for ${owner}/${name} with filtering, sorting, and future live updates.`}
      sections={[
        { title: "Run filters", description: "Search, status, branch, and sort query controls." },
        { title: "Run table", description: "Run list with route-based navigation into detail.", kind: "table" },
      ]}
      title={`${owner}/${name} runs`}
    />
  );
}
