import type { DashboardRange } from "@/hooks/useDashboard";
import { useDailyDigest } from "@/hooks/useDashboard";
import type { RangeLabels } from "./constants";

interface Props {
  range: DashboardRange;
  labels: RangeLabels;
}

export function TopSenders({ range, labels }: Props) {
  const { data } = useDailyDigest(range);

  if (!data?.top_senders?.length) return null;

  const maxCount = data.top_senders[0]?.count || 1;

  return (
    <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold text-fg-primary">{labels.digest}活跃发件人</span>
      </div>
      <div className="px-4 py-2.5 space-y-1.5">
        {data.top_senders.slice(0, 6).map((s, i) => (
          <div key={s.name} className="flex items-center gap-2 text-[11px]">
            <span className="text-fg-faint w-3 text-right tabular-nums">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-fg-secondary truncate">{s.name}</span>
                <span className="text-fg-faint tabular-nums ml-auto flex-shrink-0">{s.count}</span>
              </div>
              <div className="h-1 bg-bg-tertiary rounded-full mt-0.5 overflow-hidden">
                <div
                  className="h-full bg-accent/40 rounded-full"
                  style={{ width: `${(s.count / maxCount) * 100}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
