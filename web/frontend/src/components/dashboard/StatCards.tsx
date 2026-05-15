import { clsx } from "clsx";
import type { DashboardRange } from "@/hooks/useDashboard";
import { useDashboardStats } from "@/hooks/useDashboard";
import type { RangeLabels } from "./constants";

interface Props {
  range: DashboardRange;
  labels: RangeLabels;
}

export function StatCards({ range, labels }: Props) {
  const { data } = useDashboardStats(range);
  if (!data) return <StatCardsSkeleton />;

  const cards = [
    { label: "待处理", value: data.pending, icon: "📥", accent: "text-status-caution", border: "border-status-caution/20" },
    { label: "紧急", value: data.urgent, icon: "🚨", accent: "text-status-danger", border: "border-status-danger/20" },
    { label: labels.new, value: data.range_new, icon: "📬", accent: "text-status-info", border: "border-status-info/20" },
    { label: "AI 已审", value: data.ai_reviewed, icon: "🤖", accent: "text-status-success", border: "border-status-success/20" },
    { label: labels.cost, value: `$${data.llm_cost}`, icon: "💰", accent: "text-status-purple", border: "border-status-purple/20" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className={clsx(
            "bg-bg-secondary rounded-xl border px-4 py-3.5 transition-all hover:shadow-md hover:-translate-y-px",
            c.border,
          )}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-fg-muted font-medium">{c.label}</span>
            <span className="text-sm">{c.icon}</span>
          </div>
          <div className={clsx("text-2xl font-bold tabular-nums tracking-tight", c.accent)}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="bg-bg-secondary rounded-xl border border-border px-4 py-3.5 animate-pulse">
          <div className="h-3 w-12 bg-bg-tertiary rounded mb-3" />
          <div className="h-7 w-16 bg-bg-tertiary rounded" />
        </div>
      ))}
    </div>
  );
}
