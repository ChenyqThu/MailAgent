import { useState } from "react";
import { clsx } from "clsx";
import type { DashboardRange } from "@/hooks/useDashboard";
import { RANGES, RANGE_LABELS } from "@/components/dashboard/constants";
import { StatCards } from "@/components/dashboard/StatCards";
import { AttentionList } from "@/components/dashboard/AttentionList";
import { PriorityRing } from "@/components/dashboard/PriorityRing";
import { ActionTypeBar } from "@/components/dashboard/ActionTypeBar";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { SystemStatus } from "@/components/dashboard/SystemStatus";
import { TopSenders } from "@/components/dashboard/TopSenders";

export default function DashboardPage() {
  const [range, setRange] = useState<DashboardRange>("day");
  const labels = RANGE_LABELS[range];

  return (
    <div className="flex-1 overflow-y-auto p-6 w-full max-w-[1800px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-fg-primary tracking-tight">邮件看板</h1>
        <div className="flex items-center gap-0.5 bg-bg-secondary rounded-lg border border-border p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={clsx(
                "px-3 py-1 rounded-md text-xs font-medium transition-all",
                range === r.id
                  ? "bg-accent text-white shadow-sm"
                  : "text-fg-muted hover:text-fg-secondary"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <StatCards range={range} labels={labels} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5">
        <div className="lg:col-span-2">
          <AttentionList range={range} />
        </div>
        <div className="flex flex-col gap-5">
          <PriorityRing range={range} labels={labels} />
          <ActionTypeBar range={range} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5">
        <div className="lg:col-span-2">
          <TrendChart range={range} labels={labels} />
        </div>
        <div className="flex flex-col gap-5">
          <SystemStatus />
          <TopSenders range={range} labels={labels} />
        </div>
      </div>
    </div>
  );
}
