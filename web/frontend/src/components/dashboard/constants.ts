import type { DashboardRange } from "@/hooks/useDashboard";

export const RANGES: { id: DashboardRange; label: string }[] = [
  { id: "day", label: "今日" },
  { id: "month", label: "本月" },
  { id: "quarter", label: "本季" },
  { id: "year", label: "本年" },
];

export interface RangeLabels {
  new: string;
  cost: string;
  trend: string;
  digest: string;
}

export const RANGE_LABELS: Record<DashboardRange, RangeLabels> = {
  day: { new: "今日新增", cost: "今日成本", trend: "近 7 天趋势", digest: "今日" },
  month: { new: "本月新增", cost: "本月成本", trend: "近 30 天趋势", digest: "本月" },
  quarter: { new: "本季新增", cost: "本季成本", trend: "近 3 月趋势", digest: "本季" },
  year: { new: "本年新增", cost: "本年成本", trend: "本年趋势", digest: "本年" },
};

export const PRIORITY_RING_COLORS: Record<string, string> = {
  "🔴 紧急": "rgb(var(--color-status-danger))",
  "🟡 重要": "rgb(var(--color-status-warning))",
  "🟢 一般": "rgb(var(--color-status-success))",
  "⚪ 低": "rgb(var(--color-fg-muted))",
};

export const ACTION_TYPE_COLORS: Record<string, string> = {
  需要回复: "bg-status-danger/70",
  需要决策: "bg-status-warning/70",
  "需要Review": "bg-status-purple/70",
  需要会议: "bg-status-info/70",
  需要跟进: "bg-status-caution/70",
  等待响应: "bg-accent/50",
  仅供参考: "bg-chart-bar",
  已完结: "bg-fg-faint/50",
};
