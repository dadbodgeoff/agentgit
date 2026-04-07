import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function RepositoryDetailRoute({
  params,
}: {
  params: { owner: string; name: string };
}): JSX.Element {
  const { owner, name } = params;

  return (
    <ScaffoldPage
      description={`Repository detail scaffold for ${owner}/${name}, including overview, pipelines, branches, activity, and settings tabs.`}
      sections={[
        { title: "Overview", description: "Weighted grid for run health and summary cards." },
        { title: "Pipelines", description: "Table scaffold with drawer-ready row interactions.", kind: "table" },
        { title: "Agent activity", description: "Filterable timeline for autonomous actions.", kind: "status" },
      ]}
      title={`${owner}/${name}`}
    />
  );
}
