import { clsx } from "clsx";
import type { EmailDetail } from "@/lib/types";
import { PRIORITY_CONFIG } from "@/lib/constants";

interface Props {
  email: EmailDetail;
}

export function AIFieldsCard({ email }: Props) {
  const pc = PRIORITY_CONFIG[email.priority || ""] ?? {
    label: "—",
    color: "text-gray-600",
    bg: "bg-gray-500/10",
  };

  const fields = [
    { label: "优先级", value: email.priority, badge: true },
    { label: "操作类型", value: email.action_type },
    { label: "分类", value: email.category },
    { label: "关联项目", value: email.related_project },
    { label: "AI 摘要", value: email.ai_summary, full: true },
    { label: "建议回复", value: email.reply_suggestion, full: true },
    { label: "关键要点", value: email.key_points, full: true },
    { label: "紧急原因", value: email.urgency_reason },
    { label: "发件人优先级", value: email.sender_priority },
    { label: "语言", value: email.language },
  ];

  const hasAny = fields.some((f) => f.value);
  if (!hasAny) return null;

  return (
    <div className="px-5 py-3 border-b border-border">
      <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">
        AI 分析
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {fields.map((f) => {
          if (!f.value) return null;
          return (
            <div
              key={f.label}
              className={clsx(f.full && "col-span-2")}
            >
              <div className="text-[10px] text-gray-600 mb-0.5">{f.label}</div>
              {f.badge ? (
                <span
                  className={clsx(
                    "text-[11px] font-medium px-1.5 py-px rounded",
                    pc.bg,
                    pc.color
                  )}
                >
                  {f.value}
                </span>
              ) : (
                <div className="text-xs text-gray-300 leading-relaxed">
                  {f.value}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
