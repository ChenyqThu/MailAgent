import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ViewCounts } from "@/lib/types";

export function useViewCounts() {
  return useQuery({
    queryKey: ["view-counts"],
    queryFn: () => apiFetch<ViewCounts>("/emails/view-counts"),
    refetchInterval: 15_000,
  });
}
