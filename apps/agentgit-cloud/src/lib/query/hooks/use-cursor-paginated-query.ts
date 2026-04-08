import { useInfiniteQuery, type InfiniteData, type QueryKey } from "@tanstack/react-query";

import type { PaginatedEnvelope } from "@/schemas/cloud";

type CursorPaginatedQueryOptions<TPage extends PaginatedEnvelope<TItem>, TItem> = {
  queryKey: QueryKey;
  queryFn: (params: { cursor?: string | null }) => Promise<TPage>;
  enabled?: boolean;
};

export function useCursorPaginatedQuery<TPage extends PaginatedEnvelope<TItem>, TItem>({
  queryKey,
  queryFn,
  enabled,
}: CursorPaginatedQueryOptions<TPage, TItem>) {
  const query = useInfiniteQuery<TPage, Error, InfiniteData<TPage, string | null>, QueryKey, string | null>({
    queryKey,
    initialPageParam: null,
    queryFn: ({ pageParam }) => queryFn({ cursor: pageParam }),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled,
  });

  const pages = query.data?.pages ?? [];
  const data =
    pages.length === 0
      ? undefined
      : ({
          ...pages[pages.length - 1],
          items: pages.flatMap((page) => page.items),
        } as TPage);

  return {
    ...query,
    data,
  };
}
