import { PreviewStateSchema, type PreviewState } from "@/schemas/cloud";

export interface RouteListState {
  page: number;
  perPage: number;
  sort?: string;
  direction?: "asc" | "desc";
  tab?: string;
  detail?: string;
  previewState: PreviewState;
}

type SearchParamReader = {
  get(name: string): string | null;
};

export function parsePreviewState(searchParams: SearchParamReader): PreviewState {
  const candidate = searchParams.get("state") ?? "ready";
  const parsed = PreviewStateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : "ready";
}

export function parseRouteListState(searchParams: SearchParamReader): RouteListState {
  const page = Number(searchParams.get("page") ?? "1");
  const perPage = Number(searchParams.get("per_page") ?? "25");
  const direction = searchParams.get("dir");

  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    perPage: Number.isFinite(perPage) && perPage > 0 ? perPage : 25,
    sort: searchParams.get("sort") ?? undefined,
    direction: direction === "asc" || direction === "desc" ? direction : undefined,
    tab: searchParams.get("tab") ?? undefined,
    detail: searchParams.get("detail") ?? undefined,
    previewState: parsePreviewState(searchParams),
  };
}

export function withPreviewState(pathname: string, previewState: PreviewState): string {
  const url = new URL(pathname, "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }
  return `${url.pathname}${url.search}`;
}
