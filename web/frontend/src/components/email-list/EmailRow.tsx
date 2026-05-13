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
    color: "text-fg-faint",
    bg: "bg-fg-muted/10",
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
                : "border-border"
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
          <span className="text-[10px] text-fg-muted">{email.action_type}</span>
        )}
        <span className="text-xs font-medium text-fg-primary flex-1 truncate">
          {extractSenderName(email.sender)}
        </span>
        <span className="text-[11px] text-fg-muted flex-shrink-0">
          {formatTime(email.date_received)}
        </span>
      </div>

      {/* 第二行: Subject */}
      <div className="text-xs text-fg-tertiary truncate mb-0.5">
        {email.subject || "(无主题)"}
      </div>

      {/* 第���行: AI Summary */}
      {email.ai_summary && (
        <div className="text-[11px] text-fg-faint truncate">
          {email.ai_summary}
        </div>
      )}

      {/* 标签 */}
      {(email.category || email.related_project) && (
        <div className="flex gap-1 mt-1.5">
          {email.category && (
            <span className="text-[10px] px-1.5 py-px rounded bg-bg-tertiary text-fg-muted">
              {email.category}
            </span>
          )}
          {email.related_project && (
            <span className="text-[10px] px-1.5 py-px rounded bg-bg-tertiary text-fg-muted">
              {email.related_project}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
