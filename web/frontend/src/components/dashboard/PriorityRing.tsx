import type { DashboardRange } from "@/hooks/useDashboard";
import { useDailyDigest } from "@/hooks/useDashboard";
import { PRIORITY_CONFIG } from "@/lib/constants";
import { PRIORITY_RING_COLORS, type RangeLabels } from "./constants";

interface Props {
  range: DashboardRange;
  labels: RangeLabels;
}

export function PriorityRing({ range, labels }: Props) {
  const { data } = useDailyDigest(range);

  const entries = data?.priorities
    ? Object.entries(data.priorities).sort(([a], [b]) => {
        const oa = PRIORITY_CONFIG[a]?.order ?? 99;
        const ob = PRIORITY_CONFIG[b]?.order ?? 99;
        return oa - ob;
      })
    : [];
  const total = entries.reduce((s, [, c]) => s + c, 0);

  if (!total) return null;

  let cumPct = 0;
  const stops: string[] = [];
  for (const [prio, count] of entries) {
    const pct = (count / total) * 100;
    const color = PRIORITY_RING_COLORS[prio] || "rgb(var(--color-fg-faint))";
    stops.push(`${color} ${cumPct}% ${cumPct + pct}%`);
    cumPct += pct;
  }
  const gradient = `conic-gradient(from 180deg, ${stops.join(", ")})`;

  return (
    <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold text-fg-primary">{labels.digest}优先级</span>
      </div>
      <div className="px-4 py-4 flex items-center gap-4">
        <div className="relative flex-shrink-0">
          <div className="w-20 h-20 rounded-full" style={{ background: gradient }} />
          <div className="absolute inset-2 rounded-full bg-bg-secondary flex items-center justify-center">
            <span className="text-base font-bold text-fg-primary tabular-nums">{total}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 min-w-0">
          {entries.map(([prio, count]) => {
            const pc = PRIORITY_CONFIG[prio];
            const pct = Math.round((count / total) * 100);
            return (
              <div key={prio} className="flex items-center gap-2 text-[11px]">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: PRIORITY_RING_COLORS[prio] || "rgb(var(--color-fg-faint))" }}
                />
                <span className="text-fg-tertiary truncate">{pc?.label || prio}</span>
                <span className="text-fg-primary font-medium tabular-nums ml-auto">{count}</span>
                <span className="text-fg-faint tabular-nums w-8 text-right">{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
