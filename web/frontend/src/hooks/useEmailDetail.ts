import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { EmailDetail } from "@/lib/types";

export function useEmailDetail(internalId: number | null) {
  return useQuery({
    queryKey: ["email-detail", internalId],
    queryFn: () => apiFetch<EmailDetail>(`/emails/${internalId}`),
    enabled: internalId !== null,
  });
}
