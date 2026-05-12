import { clsx } from "clsx";
import type { EmailListItem } from "@/lib/types";
import { PRIORITY_CONFIG, formatTime, extractSenderName } from "@/lib/constants";

interface Props {
  email: EmailListItem;
  isActive: boolean;
  onClick: () => void;
  selected?: boolean;
  selectMode?: boolean;
}

export function EmailRow({ email, isActive, onClick, selected, selectMode }: Props) {
  const pc = PRIORITY_CONFIG[email.priority || ""] ?? {
    label: "—",
    color: "text-gray-600",
    bg: "bg-gray-500/10",
    order: 9,
  };

  return (
    <div
      onClick={onClick}
      className={clsx(
        "px-3 py-2.5 border-b border-border cursor-pointer transition-colors",
        isActive
          ? "bg-bg-active border-l-2 border-l-accent"
          : "hover:bg-bg-hover"
      )}
    >
      {/* 第一行: Priority + Action Type + Sender + Time */}
      <div className="flex items-center gap-2 mb-1">
        {selectMode && (
          <span
            className={clsx(
              "w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[9px]",
              selected
                ? "bg-accent border-accent text-white"
                : "border-gray-600"
            )}
          >
            {selected && "✓"}
          </span>
        )}
        <span
          className={clsx(
            "text-[10px] font-semibold px-1.5 py-px rounded",
            pc.bg,
            pc.color
          )}
        >
          {pc.label}
        </span>
        {email.action_type && (
          <span className="text-[10px] text-gray-500">{email.action_type}</span>
        )}
        <span className="text-xs font-medium text-gray-200 flex-1 truncate">
          {extractSenderName(email.sender)}
        </span>
        <span className="text-[11px] text-gray-500 flex-shrink-0">
          {formatTime(email.date_received)}
        </span>
      </div>

      {/* 第二行: Subject */}
      <div className="text-xs text-gray-400 truncate mb-0.5">
        {email.subject || "(无主题)"}
      </div>

      {/* 第���行: AI Summary */}
      {email.ai_summary && (
        <div className="text-[11px] text-gray-600 truncate">
          {email.ai_summary}
        </div>
      )}

      {/* 标签 */}
      {(email.category || email.related_project) && (
        <div className="flex gap-1 mt-1.5">
          {email.category && (
            <span className="text-[10px] px-1.5 py-px rounded bg-bg-tertiary text-gray-500">
              {email.category}
            </span>
          )}
          {email.related_project && (
            <span className="text-[10px] px-1.5 py-px rounded bg-bg-tertiary text-gray-500">
              {email.related_project}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
