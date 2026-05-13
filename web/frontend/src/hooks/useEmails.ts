import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { EmailFilter, EmailListItem, PagedResponse } from "@/lib/types";

function buildParams(filter: EmailFilter, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("page_size", String(pageSize));
  if (filter.view) params.set("view", filter.view);
  if (filter.mailbox) params.set("mailbox", filter.mailbox);
  if (filter.priority) params.set("priority", filter.priority);
  if (filter.action_type) params.set("action_type", filter.action_type);
  if (filter.category) params.set("category", filter.category);
  if (filter.is_flagged !== undefined) params.set("is_flagged", String(filter.is_flagged));
  if (filter.pending_only !== undefined && !filter.view) params.set("pending_only", String(filter.pending_only));
  if (filter.search) params.set("search", filter.search);
  return params.toString();
}

export function useEmails(filter: EmailFilter, page = 1, pageSize = 50) {
  return useQuery({
    queryKey: ["emails", filter, page, pageSize],
    queryFn: () =>
      apiFetch<PagedResponse<EmailListItem>>(
        `/emails?${buildParams(filter, page, pageSize)}`
      ),
    refetchInterval: 15_000,
  });
}
