import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export type DashboardRange = "day" | "month" | "quarter" | "year";

export function useDashboardStats(range: DashboardRange = "day") {
  return useQuery({
    queryKey: ["dashboard-stats", range],
    queryFn: () => apiFetch<{
      total: number;
      pending: number;
      urgent: number;
      range_new: number;
      ai_reviewed: number;
      llm_cost: number;
      range: string;
    }>(`/dashboard/stats?range=${range}`),
    refetchInterval: 30_000,
  });
}

export function useAttentionEmails(range: DashboardRange = "day") {
  return useQuery({
    queryKey: ["dashboard-attention", range],
    queryFn: () => apiFetch<{
      internal_id: number;
      subject: string | null;
      sender: string | null;
      date_received: string | null;
      priority: string | null;
      action_type: string | null;
      ai_summary: string | null;
      category: string | null;
    }[]>(`/dashboard/attention?range=${range}`),
    refetchInterval: 30_000,
  });
}

export function useDailyDigest(range: DashboardRange = "day") {
  return useQuery({
    queryKey: ["dashboard-digest", range],
    queryFn: () => apiFetch<{
      categories: { category: string; count: number }[];
      priorities: Record<string, number>;
      action_types: Record<string, number>;
      top_senders: { name: string; count: number }[];
    }>(`/dashboard/digest?range=${range}`),
    refetchInterval: 60_000,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: ["dashboard-system"],
    queryFn: () => apiFetch<{
      last_sync_time: string | null;
      sync_stats: Record<string, number>;
      llm_stats: Record<string, number>;
    }>("/dashboard/system"),
    refetchInterval: 30_000,
  });
}

export function useTrend(range: DashboardRange = "day") {
  return useQuery({
    queryKey: ["dashboard-trend", range],
    queryFn: () => apiFetch<{ day: string; total: number; ai_processed: number }[]>(
      `/dashboard/trend?range=${range}`
    ),
    refetchInterval: 300_000,
  });
}
