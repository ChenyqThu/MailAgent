import { clsx } from "clsx";
import type { DashboardRange } from "@/hooks/useDashboard";
import { useTrend } from "@/hooks/useDashboard";
import type { RangeLabels } from "./constants";

interface Props {
  range: DashboardRange;
  labels: RangeLabels;
}

export function TrendChart({ range, labels }: Props) {
  const { data: trend } = useTrend(range);

  if (!trend?.length) return null;

  const maxVal = Math.max(...trend.map((d) => d.total), 1);
  const avgTotal = Math.round(trend.reduce((s, d) => s + d.total, 0) / trend.length);
  const avgAI = Math.round(trend.reduce((s, d) => s + d.ai_processed, 0) / trend.length);

  function formatLabel(raw: string): string {
    if (range === "day" || range === "month") return raw.slice(5);
    if (range === "quarter") return raw.slice(5);
    return raw.slice(2);
  }

  return (
    <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-fg-primary">{labels.trend}</span>
        <div className="flex gap-4 text-[10px] text-fg-muted">
          <span>日均 <span className="text-fg-primary font-medium tabular-nums">{avgTotal}</span> 封</span>
          <span>AI <span className="text-fg-primary font-medium tabular-nums">{avgAI}</span> 封</span>
        </div>
      </div>
      <div className="px-4 py-4">
        <div className="flex items-end gap-[3px] h-32">
          {trend.map((d, i) => {
            const totalH = (d.total / maxVal) * 100;
            const aiH = (d.ai_processed / maxVal) * 100;
            return (
              <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0 group">
                <div className="w-full flex flex-col items-center justify-end h-28 relative">
                  <div
                    className="w-full rounded-t-sm bg-chart-bar absolute bottom-0 transition-all group-hover:opacity-80"
                    style={{ height: `${totalH}%` }}
                  />
                  <div
                    className="w-full rounded-t-sm bg-accent/60 absolute bottom-0 transition-all group-hover:bg-accent/80"
                    style={{ height: `${aiH}%` }}
                  />
                  <div className="absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover:block
                    bg-fg-primary text-bg-primary text-[9px] px-1.5 py-0.5 rounded whitespace-nowrap z-10 tabular-nums">
                    {d.total} / {d.ai_processed}
                  </div>
                </div>
                <span className={clsx(
                  "text-[9px] truncate w-full text-center tabular-nums",
                  i === trend.length - 1 ? "text-accent font-medium" : "text-fg-faint"
                )}>
                  {formatLabel(d.day)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex gap-4 mt-3 text-[10px] text-fg-faint">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 rounded-sm bg-chart-bar" />总计
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 rounded-sm bg-accent/60" />AI 处理
          </span>
        </div>
      </div>
    </div>
  );
}
