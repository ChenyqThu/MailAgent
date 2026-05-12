import { clsx } from "clsx";

interface Props {
  isFlagged: boolean;
  isRead: boolean;
  isDone: boolean;
  onAction: (action: string) => void;
}

export function ActionBar({ isFlagged, isRead, isDone, onAction }: Props) {
  return (
    <div className="px-5 py-3 border-b border-border flex gap-2 flex-wrap">
      {/* 已处理 / 未处理 — 核心动作 */}
      <button
        onClick={() => onAction("mark_done")}
        className={clsx(
          "px-3 py-1.5 rounded text-xs font-medium transition-colors",
          isDone
            ? "bg-green-900/30 text-green-400 border border-green-500/30"
            : "bg-accent text-white hover:bg-accent/80"
        )}
      >
        <span className="mr-1">{isDone ? "✓" : "○"}</span>
        {isDone ? "已完成" : "标记已处理"}
      </button>

      {/* 旗标切换 */}
      <button
        onClick={() => onAction("toggle_flag")}
        className={clsx(
          "px-3 py-1.5 rounded text-xs font-medium transition-colors",
          isFlagged
            ? "bg-accent-dim text-accent border border-accent/30"
            : "bg-bg-tertiary text-gray-400 hover:text-gray-200 hover:bg-bg-hover"
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
            : "bg-bg-tertiary text-gray-400 hover:text-gray-200 hover:bg-bg-hover"
        )}
      >
        <span className="mr-1">{isRead ? "●" : "○"}</span>
        {isRead ? "标记未读" : "标记已读"}
      </button>
    </div>
  );
}
