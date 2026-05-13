import { useState } from "react";
import { useNavigate } from "react-router";
import { clsx } from "clsx";
import type { DashboardRange } from "@/hooks/useDashboard";
import {
  useDashboardStats,
  useAttentionEmails,
  useDailyDigest,
  useSystemStatus,
  useTrend,
} from "@/hooks/useDashboard";
import { PRIORITY_CONFIG, formatTime, extractSenderName } from "@/lib/constants";

const RANGES: { id: DashboardRange; label: string }[] = [
  { id: "day", label: "今日" },
  { id: "month", label: "本月" },
  { id: "quarter", label: "本季" },
  { id: "year", label: "本年" },
];

const RANGE_LABELS: Record<DashboardRange, { new: string; cost: string; trend: string; digest: string }> = {
  day: { new: "今日新增", cost: "今日成本", trend: "近 7 天趋势", digest: "今日" },
  month: { new: "本月新增", cost: "本月成本", trend: "近 30 天趋势", digest: "本月" },
  quarter: { new: "本季新增", cost: "本季成本", trend: "近 3 月趋势", digest: "本季" },
  year: { new: "本年新增", cost: "本年成本", trend: "本年趋势", digest: "本年" },
};

/* 优先级颜色映射（用于 conic-gradient） */
const PRIORITY_RING_COLORS: Record<string, string> = {
  "🔴 紧急": "rgb(var(--color-status-danger))",
  "🟡 重要": "rgb(var(--color-status-warning))",
  "🟢 一般": "rgb(var(--color-status-success))",
  "⚪ 低": "rgb(var(--color-fg-muted))",
};

const ACTION_TYPE_COLORS: Record<string, string> = {
  需要回复: "bg-status-danger/70",
  需要决策: "bg-status-warning/70",
  "需要Review": "bg-status-purple/70",
  需要会议: "bg-status-info/70",
  需要跟进: "bg-status-caution/70",
  等待响应: "bg-accent/50",
  仅供参考: "bg-chart-bar",
  已完结: "bg-fg-faint/50",
};

export default function DashboardPage() {
  const [range, setRange] = useState<DashboardRange>("day");
  const labels = RANGE_LABELS[range];

  return (
    <div className="flex-1 overflow-y-auto p-6 w-full max-w-[1800px] mx-auto">
      {/* Header + 时间范围 */}
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

      {/* Row 2: 关注 + 分布面板 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5">
        <div className="lg:col-span-2">
          <AttentionList range={range} />
        </div>
        <div className="flex flex-col gap-5">
          <PriorityRing range={range} labels={labels} />
          <ActionTypeBar range={range} />
        </div>
      </div>

      {/* Row 3: 趋势 + 系统 + 发件人 */}
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

/* ── 统计卡片 ── */

function StatCards({ range, labels }: { range: DashboardRange; labels: typeof RANGE_LABELS["day"] }) {
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

/* ── 需要关注 ── */

function AttentionList({ range }: { range: DashboardRange }) {
  const { data: emails } = useAttentionEmails(range);
  const navigate = useNavigate();

  return (
    <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg-primary">需要关注</span>
          {emails?.length ? (
            <span className="text-[10px] text-fg-faint bg-bg-tertiary px-1.5 py-0.5 rounded-full tabular-nums">
              {emails.length}
            </span>
          ) : null}
        </div>
        <button
          onClick={() => navigate("/inbox")}
          className="text-[11px] text-accent hover:text-accent/80 font-medium transition-colors"
        >
          进入工作台 →
        </button>
      </div>
      <div className="max-h-[340px] overflow-y-auto divide-y divide-border/50">
        {!emails?.length ? (
          <div className="px-4 py-10 text-center">
            <div className="text-2xl mb-2">✨</div>
            <div className="text-xs text-fg-faint">没有紧急或重要邮件</div>
          </div>
        ) : (
          emails.map((email) => {
            const pc = PRIORITY_CONFIG[email.priority || ""] ?? {
              label: "—", color: "text-fg-faint", bg: "bg-fg-muted/10", order: 99,
            };
            return (
              <div
                key={email.internal_id}
                onClick={() => navigate(`/inbox?id=${email.internal_id}`)}
                className="px-4 py-3 cursor-pointer hover:bg-bg-hover transition-colors group"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={clsx(
                    "text-[10px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wide",
                    pc.bg, pc.color,
                  )}>
                    {pc.label}
                  </span>
                  {email.action_type && (
                    <span className="text-[10px] text-fg-muted bg-bg-tertiary px-1.5 py-0.5 rounded">
                      {email.action_type}
                    </span>
                  )}
                  {email.category && (
                    <span className="text-[10px] text-fg-faint hidden sm:inline">
                      {email.category}
                    </span>
                  )}
                  <span className="text-[10px] text-fg-faint ml-auto flex-shrink-0 tabular-nums">
                    {formatTime(email.date_received)}
                  </span>
                </div>
                <div className="text-xs text-fg-primary truncate font-medium group-hover:text-accent transition-colors">
                  {email.subject || "(无主题)"}
                </div>
                <div className="text-[11px] text-fg-faint truncate mt-0.5">
                  {extractSenderName(email.sender)}
                  {email.ai_summary ? ` · ${email.ai_summary}` : ""}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── 优先级环 ── */

function PriorityRing({ range, labels }: { range: DashboardRange; labels: typeof RANGE_LABELS["day"] }) {
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

  // Build conic-gradient stops
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
        {/* Ring */}
        <div className="relative flex-shrink-0">
          <div
            className="w-20 h-20 rounded-full"
            style={{ background: gradient }}
          />
          <div className="absolute inset-2 rounded-full bg-bg-secondary flex items-center justify-center">
            <span className="text-base font-bold text-fg-primary tabular-nums">{total}</span>
          </div>
        </div>
        {/* Legend */}
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

/* ── 行动类型分布 ── */

function ActionTypeBar({ range }: { range: DashboardRange }) {
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
        {/* Stacked bar */}
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
        {/* Legend */}
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

/* ── 趋势图 ── */

function TrendChart({ range, labels }: { range: DashboardRange; labels: typeof RANGE_LABELS["day"] }) {
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
              <div
                key={d.day}
                className="flex-1 flex flex-col items-center gap-1 min-w-0 group"
              >
                <div className="w-full flex flex-col items-center justify-end h-28 relative">
                  {/* Total bar */}
                  <div
                    className="w-full rounded-t-sm bg-chart-bar absolute bottom-0 transition-all group-hover:opacity-80"
                    style={{ height: `${totalH}%` }}
                  />
                  {/* AI bar overlaid */}
                  <div
                    className="w-full rounded-t-sm bg-accent/60 absolute bottom-0 transition-all group-hover:bg-accent/80"
                    style={{ height: `${aiH}%` }}
                  />
                  {/* Hover tooltip */}
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

/* ── 系统状态 ── */

function SystemStatus() {
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
        {/* 同步 */}
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
        {/* LLM */}
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
        {/* 时间 */}
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

/* ── Top Senders ── */

function TopSenders({ range, labels }: { range: DashboardRange; labels: typeof RANGE_LABELS["day"] }) {
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
