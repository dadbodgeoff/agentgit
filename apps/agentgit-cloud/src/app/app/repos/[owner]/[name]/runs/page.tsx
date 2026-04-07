import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function RepositoryRunsRoute({
  params,
}: {
  params: { owner: string; name: string };
}): JSX.Element {
  const { owner, name } = params;

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
