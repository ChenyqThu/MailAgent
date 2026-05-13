import { clsx } from "clsx";
import type { EmailView } from "@/lib/types";

interface Props {
  isFlagged: boolean;
  isRead: boolean;
  isDone: boolean;
  view?: EmailView;
  onAction: (action: string) => void;
}

export function ActionBar({ isFlagged, isRead, isDone, view, onAction }: Props) {
  const isBrowse = view === "browse";
  const primaryAction = isBrowse ? "mark_browsed" : "mark_done";
  const primaryLabel = isBrowse ? "已阅" : "标记已处理";
  const primaryDoneLabel = isBrowse ? "已阅" : "已完成";

  return (
    <div className="px-5 py-3 border-b border-border flex gap-2 flex-wrap">
      {/* 核心动作：pending → 标记已处理，browse → 已阅 */}
      <button
        onClick={() => onAction(primaryAction)}
        className={clsx(
          "px-3 py-1.5 rounded text-xs font-medium transition-colors",
          isDone
            ? "bg-status-success/30 text-status-success border border-status-success/30"
            : "bg-accent text-white hover:bg-accent/80"
        )}
      >
        <span className="mr-1">{isDone ? "✓" : "○"}</span>
        {isDone ? primaryDoneLabel : primaryLabel}
      </button>

      {/* 旗标切换 */}
      <button
        onClick={() => onAction("toggle_flag")}
        className={clsx(
          "px-3 py-1.5 rounded text-xs font-medium transition-colors",
          isFlagged
            ? "bg-accent-dim text-accent border border-accent/30"
            : "bg-bg-tertiary text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover"
        )}
      >
        <span className="mr-1">⚑</span>
        {isFlagged ? "取消旗标" : "加旗标"}
      </button>

      {/* 已读切换 */}
      <button
        onClick={() => onAction("toggle_read")}
        className={clsx(
          "px-3 py-1.5 rounded text-xs font-medium transition-colors",
          isRead
            ? "bg-accent-dim text-accent border border-accent/30"
            : "bg-bg-tertiary text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover"
        )}
      >
        <span className="mr-1">{isRead ? "●" : "○"}</span>
        {isRead ? "标记未读" : "标记已读"}
      </button>
    </div>
  );
}
