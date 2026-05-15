import { clsx } from "clsx";
import { useSystemStatus } from "@/hooks/useDashboard";

export function SystemStatus() {
  const { data } = useSystemStatus();

  if (!data) return null;

  const syncTotal = Object.values(data.sync_stats).reduce((s, n) => s + n, 0);
  const syncSynced = data.sync_stats["synced"] ?? 0;
  const llmSuccess = data.llm_stats["success"] ?? 0;
  const llmFailed = data.llm_stats["failed"] ?? 0;
  const llmTotal = Object.values(data.llm_stats).reduce((s, n) => s + n, 0);

  let lastSyncText = "未知";
  let syncHealthy = false;
  if (data.last_sync_time) {
    const ts = Number(data.last_sync_time);
    if (!isNaN(ts)) {
      const ago = Math.floor((Date.now() / 1000 - ts) / 60);
      lastSyncText = ago < 1 ? "刚刚" : ago < 60 ? `${ago} 分钟前` : `${Math.floor(ago / 60)} 小时前`;
      syncHealthy = ago < 10;
    }
  }

  const llmRate = llmTotal > 0 ? Math.round((llmSuccess / llmTotal) * 100) : 0;

  return (
    <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-fg-primary">系统状态</span>
        <span className={clsx(
          "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
          syncHealthy ? "bg-status-success/15 text-status-success" : "bg-status-warning/15 text-status-warning"
        )}>
          {syncHealthy ? "运行中" : "注意"}
        </span>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-fg-tertiary">邮件同步</span>
            <span className="text-fg-muted tabular-nums">{syncSynced} / {syncTotal}</span>
          </div>
          <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-status-success rounded-full transition-all"
              style={{ width: `${syncTotal > 0 ? (syncSynced / syncTotal) * 100 : 0}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-fg-tertiary">LLM 处理</span>
            <span className="text-fg-muted tabular-nums">
              {llmSuccess} 成功{llmFailed > 0 ? ` · ${llmFailed} 失败` : ""} · {llmRate}%
            </span>
          </div>
          <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className={clsx(
                "h-full rounded-full transition-all",
                llmRate >= 95 ? "bg-status-success" : llmRate >= 80 ? "bg-status-warning" : "bg-status-danger"
              )}
              style={{ width: `${llmRate}%` }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between text-[11px] pt-1 border-t border-border/50">
          <span className="text-fg-tertiary">上次同步</span>
          <span className={clsx(
            "font-medium tabular-nums",
            syncHealthy ? "text-fg-secondary" : "text-status-warning"
          )}>
            {lastSyncText}
          </span>
        </div>
      </div>
    </div>
  );
}
