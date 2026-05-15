import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface ThreadEmailBody {
  internal_id: number;
  subject: string | null;
  sender: string | null;
  sender_name: string | null;
  date_received: string | null;
  body: string;
}

export function useThreadBodies(threadId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["thread-bodies", threadId],
    queryFn: () =>
      apiFetch<ThreadEmailBody[]>(`/emails/thread/${encodeURIComponent(threadId!)}/bodies`),
    enabled: enabled && threadId !== null,
    staleTime: 5 * 60_000,
  });
}
