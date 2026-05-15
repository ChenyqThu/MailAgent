import { clsx } from "clsx";
import type { DashboardRange } from "@/hooks/useDashboard";
import { useDailyDigest } from "@/hooks/useDashboard";
import { ACTION_TYPE_COLORS } from "./constants";

interface Props {
  range: DashboardRange;
}

export function ActionTypeBar({ range }: Props) {
  const { data } = useDailyDigest(range);

  const entries = data?.action_types
    ? Object.entries(data.action_types).sort(([, a], [, b]) => b - a)
    : [];
  const total = entries.reduce((s, [, c]) => s + c, 0);

  if (!total) return null;

  return (
    <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold text-fg-primary">行动类型</span>
      </div>
      <div className="px-4 py-3">
        <div className="flex h-3 rounded-full overflow-hidden mb-3">
          {entries.map(([type, count]) => (
            <div
              key={type}
              className={clsx("transition-all", ACTION_TYPE_COLORS[type] || "bg-fg-faint/40")}
              style={{ width: `${(count / total) * 100}%` }}
              title={`${type}: ${count}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {entries.map(([type, count]) => (
            <div key={type} className="flex items-center gap-1.5 text-[11px]">
              <span className={clsx("w-2 h-2 rounded-sm flex-shrink-0", ACTION_TYPE_COLORS[type] || "bg-fg-faint/40")} />
              <span className="text-fg-tertiary truncate">{type}</span>
              <span className="text-fg-muted tabular-nums ml-auto">{count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
