import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { EmailListItem } from "@/lib/types";

export function useThreadEmails(threadId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["thread-emails", threadId],
    queryFn: () =>
      apiFetch<EmailListItem[]>(`/emails/thread/${encodeURIComponent(threadId!)}`),
    enabled: enabled && threadId !== null,
    staleTime: 60_000,
  });
}
