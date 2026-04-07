import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function PolicyRoute({
  params,
}: {
  params: { owner: string; name: string };
}): JSX.Element {
  const { owner, name } = params;

  return (
    <ScaffoldPage
      description={`Policy editor scaffold for ${owner}/${name} with rule editing, conflict handling, and dangerous-change warnings.`}
      sections={[
        { title: "Policy rules", description: "Form surface for thresholds, rule scopes, and defaults." },
        { title: "Conflict handling", description: "State rail for concurrent policy edits.", kind: "status" },
      ]}
      title="Policy editor"
    />
  );
}
