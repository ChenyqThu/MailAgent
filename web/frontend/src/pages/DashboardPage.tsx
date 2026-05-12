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

const RANGE_LABELS: Record<DashboardRange, { new: string; cost: string; trend: string }> = {
  day: { new: "今日新增", cost: "今日成本", trend: "近 7 天趋势" },
  month: { new: "本月新增", cost: "本月成本", trend: "近 30 天趋势" },
  quarter: { new: "本季新增", cost: "本季成本", trend: "近 3 月趋势" },
  year: { new: "本年新增", cost: "本年成本", trend: "本年趋势" },
};

export default function DashboardPage() {
  const [range, setRange] = useState<DashboardRange>("day");
  const labels = RANGE_LABELS[range];

  return (
    <div className="flex-1 overflow-y-auto p-6 w-full max-w-[1800px] mx-auto">
      {/* 时间范围选择器 */}
      <div className="flex items-center gap-1 mb-5">
        {RANGES.map((r) => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            className={clsx(
              "px-3 py-1 rounded text-xs font-medium transition-colors",
              range === r.id
                ? "bg-accent text-white"
                : "text-gray-500 hover:text-gray-300 hover:bg-bg-hover"
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      <StatCards range={range} labels={labels} />
      {/* 宽屏 3 列：关注占 2 列 + 摘要 1 列 / 系统状态 1 列 + 趋势 2 列 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5 mt-5">
        <div className="xl:col-span-2">
          <AttentionList range={range} />
        </div>
        <Digest range={range} />
        <SystemStatus />
        <div className="xl:col-span-2">
          <TrendChart range={range} labels={labels} />
        </div>
      </div>
    </div>
  );
}

/* ── 统计卡片 ── */

function StatCards({ range, labels }: { range: DashboardRange; labels: typeof RANGE_LABELS["day"] }) {
  const { data } = useDashboardStats(range);
  if (!data) return null;

  const cards = [
    { label: "待处理", value: data.pending, color: "text-yellow-400" },
    { label: "紧急", value: data.urgent, color: "text-red-400" },
    { label: labels.new, value: data.range_new, color: "text-blue-400" },
    { label: "AI 已审", value: data.ai_reviewed, color: "text-green-400" },
    { label: labels.cost, value: `$${data.llm_cost}`, color: "text-purple-400" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-bg-secondary rounded-lg border border-border px-4 py-3"
        >
          <div className="text-[11px] text-gray-500 mb-1">{c.label}</div>
          <div className={clsx("text-xl font-semibold", c.color)}>
            {c.value}
          </div>
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
    <div className="bg-bg-secondary rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
        <span className="text-xs font-medium text-gray-300">需要关注</span>
        <button
          onClick={() => navigate("/inbox")}
          className="text-[11px] text-accent hover:underline"
        >
          进入工作台
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {!emails?.length ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">
            没有紧急或重要邮件
          </div>
        ) : (
          emails.map((email) => {
            const pc = PRIORITY_CONFIG[email.priority || ""] ?? {
              label: "—",
              color: "text-gray-600",
              bg: "bg-gray-500/10",
            };
            return (
              <div
                key={email.internal_id}
                onClick={() => navigate(`/inbox?id=${email.internal_id}`)}
                className="px-4 py-2.5 border-b border-border cursor-pointer hover:bg-bg-hover transition-colors"
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={clsx("text-[10px] font-semibold px-1.5 py-px rounded", pc.bg, pc.color)}>
                    {pc.label}
                  </span>
                  {email.action_type && (
                    <span className="text-[10px] text-gray-500">{email.action_type}</span>
                  )}
                  <span className="text-[11px] text-gray-400 ml-auto flex-shrink-0">
                    {formatTime(email.date_received)}
                  </span>
                </div>
                <div className="text-xs text-gray-200 truncate">
                  {email.subject || "(无主题)"}
                </div>
                <div className="text-[11px] text-gray-600 truncate mt-0.5">
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

/* ── 摘要 ── */

function Digest({ range }: { range: DashboardRange }) {
  const { data } = useDailyDigest(range);

  const totalInRange = data?.categories.reduce((s, c) => s + c.count, 0) ?? 0;
  const prioEntries = data?.priorities
    ? Object.entries(data.priorities).sort(([, a], [, b]) => b - a)
    : [];

  const rangeText = { day: "今日", month: "本月", quarter: "本季", year: "本年" }[range];

  return (
    <div className="bg-bg-secondary rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border">
        <span className="text-xs font-medium text-gray-300">{rangeText}摘要</span>
      </div>
      <div className="px-4 py-3">
        {totalInRange === 0 ? (
          <div className="text-xs text-gray-600">{rangeText}暂无邮件</div>
        ) : (
          <>
            <div className="text-xs text-gray-400 mb-3">
              {rangeText}收到 <span className="text-gray-200 font-medium">{totalInRange}</span> 封
              {prioEntries.length > 0 && (
                <span>
                  {" · "}
                  {prioEntries.map(([p, c]) => {
                    const pc = PRIORITY_CONFIG[p];
                    return (
                      <span key={p} className={pc?.color || "text-gray-500"}>
                        {pc?.label || p} {c}
                      </span>
                    );
                  }).reduce<React.ReactNode[]>((acc, el, i) => {
                    if (i > 0) acc.push(<span key={`sep-${i}`}> · </span>);
                    acc.push(el);
                    return acc;
                  }, [])}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              {data?.categories.map((c) => (
                <div key={c.category} className="flex items-center gap-2">
                  <div
                    className="h-1.5 rounded-full bg-accent/60"
                    style={{ width: `${Math.max(8, (c.count / totalInRange) * 100)}%` }}
                  />
                  <span className="text-[11px] text-gray-400 flex-shrink-0">
                    {c.category}
                  </span>
                  <span className="text-[11px] text-gray-600">{c.count}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── 系统状态 ── */

function SystemStatus() {
  const { data } = useSystemStatus();

  if (!data) return null;

  const syncTotal = Object.values(data.sync_stats).reduce((s, n) => s + n, 0);
  const llmSuccess = data.llm_stats["success"] ?? 0;
  const llmTotal = Object.values(data.llm_stats).reduce((s, n) => s + n, 0);

  let lastSyncText = "未知";
  if (data.last_sync_time) {
    const ts = Number(data.last_sync_time);
    if (!isNaN(ts)) {
      const ago = Math.floor((Date.now() / 1000 - ts) / 60);
      lastSyncText = ago < 1 ? "刚刚" : ago < 60 ? `${ago} 分钟前` : `${Math.floor(ago / 60)} 小时前`;
    }
  }

  const items = [
    { label: "邮件同步", status: syncTotal > 0, text: `${syncTotal} 封已同步` },
    { label: "LLM 处理", status: llmSuccess > 0, text: `${llmSuccess}/${llmTotal} 成功` },
    { label: "上次同步", status: true, text: lastSyncText },
  ];

  return (
    <div className="bg-bg-secondary rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border">
        <span className="text-xs font-medium text-gray-300">系统状态</span>
      </div>
      <div className="px-4 py-3 space-y-2.5">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-2 text-xs">
            <span className={item.status ? "text-green-500" : "text-red-500"}>
              {item.status ? "●" : "○"}
            </span>
            <span className="text-gray-400 w-16">{item.label}</span>
            <span className="text-gray-300">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 趋势图 ── */

function TrendChart({ range, labels }: { range: DashboardRange; labels: typeof RANGE_LABELS["day"] }) {
  const { data: trend } = useTrend(range);

  if (!trend?.length) return null;

  const maxVal = Math.max(...trend.map((d) => d.total), 1);

  // 根据 range 调整日期标签显示
  function formatLabel(raw: string): string {
    if (range === "day" || range === "month") {
      return raw.slice(5); // MM-DD
    }
    if (range === "quarter") {
      return raw.slice(5); // W%W
    }
    return raw.slice(2); // YY-MM
  }

  return (
    <div className="bg-bg-secondary rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border">
        <span className="text-xs font-medium text-gray-300">{labels.trend}</span>
      </div>
      <div className="px-4 py-3">
        <div className="flex items-end gap-1.5 h-24">
          {trend.map((d) => {
            const h = (d.total / maxVal) * 100;
            const aiH = (d.ai_processed / maxVal) * 100;
            return (
              <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <div className="w-full flex flex-col items-center justify-end h-20 relative">
                  <div
                    className="w-full rounded-t bg-gray-700 absolute bottom-0"
                    style={{ height: `${h}%` }}
                  />
                  <div
                    className="w-full rounded-t bg-accent/70 absolute bottom-0"
                    style={{ height: `${aiH}%` }}
                  />
                </div>
                <span className="text-[9px] text-gray-600 truncate w-full text-center">
                  {formatLabel(d.day)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex gap-4 mt-2 text-[10px] text-gray-600">
          <span><span className="inline-block w-2 h-2 rounded bg-gray-700 mr-1" />总计</span>
          <span><span className="inline-block w-2 h-2 rounded bg-accent/70 mr-1" />AI 处理</span>
        </div>
      </div>
    </div>
  );
}
