import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

interface BodyResponse {
  internal_id: number;
  body: string;
}

export function useEmailBody(emailId: number | null) {
  return useQuery({
    queryKey: ["email-body", emailId],
    queryFn: () => apiFetch<BodyResponse>(`/emails/${emailId}/body`),
    enabled: emailId !== null,
    staleTime: 5 * 60 * 1000, // 5min 缓存，正文不常变
  });
}
