export const PRIORITY_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; order: number }
> = {
  "🔴 紧急": {
    label: "紧急",
    color: "text-status-danger",
    bg: "bg-status-danger/15",
    order: 1,
  },
  "🟡 重要": {
    label: "重要",
    color: "text-status-warning",
    bg: "bg-status-warning/15",
    order: 2,
  },
  "🟢 一般": {
    label: "一般",
    color: "text-status-success",
    bg: "bg-status-success/15",
    order: 3,
  },
  "⚪ 低": {
    label: "低",
    color: "text-fg-muted",
    bg: "bg-fg-muted/15",
    order: 4,
  },
};

export const ACTION_TYPE_LABELS: Record<string, string> = {
  需要回复: "需要回复",
  需要决策: "需要决策",
  需要Review: "需要Review",
  需要会议: "需要会议",
  需要跟进: "需要跟进",
  等待响应: "等待响应",
  仅供参考: "仅供参考",
  已完结: "已完结",
};

export function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return "昨天";
  }
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function extractSenderName(sender: string | null): string {
  if (!sender) return "未知";
  // "Name <email>" or just email
  const match = sender.match(/^"?([^"<]+)"?\s*</);
  if (match?.[1]) return match[1].trim();
  // email only
  const emailMatch = sender.match(/([^@]+)@/);
  return emailMatch?.[1] ?? sender.slice(0, 12);
}
