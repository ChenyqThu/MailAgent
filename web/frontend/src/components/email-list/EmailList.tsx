import { useRef, useEffect } from "react";
import type { EmailListItem } from "@/lib/types";
import { EmailRow } from "./EmailRow";

interface Props {
  emails: EmailListItem[];
  activeId: number | null;
  onSelect: (id: number) => void;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
}

export function EmailList({
  emails,
  activeId,
  onSelect,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeId === null || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-id="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  if (emails.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        没有邮件
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto">
      {emails.map((email) => (
        <div key={email.internal_id} data-id={email.internal_id}>
          <EmailRow
            email={email}
            isActive={email.internal_id === activeId}
            onClick={() => {
              if (selectMode && onToggleSelect) {
                onToggleSelect(email.internal_id);
              } else {
                onSelect(email.internal_id);
              }
            }}
            selected={selectMode && !!selectedIds?.has(email.internal_id)}
            selectMode={selectMode}
          />
        </div>
      ))}
    </div>
  );
}
