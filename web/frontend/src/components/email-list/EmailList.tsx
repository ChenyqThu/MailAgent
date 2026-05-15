import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import type { EmailListItem } from "@/lib/types";
import type { ThreadGroup } from "@/pages/InboxPage";
import { EmailRow } from "./EmailRow";
import { ThreadChildRow } from "./ThreadChildRow";
import { useThreadEmails } from "@/hooks/useThreadEmails";

interface Props {
  emails: EmailListItem[];
  groups: ThreadGroup[];
  activeId: number | null;
  onSelect: (id: number) => void;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
}

export function EmailList({
  emails,
  groups,
  activeId,
  onSelect,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (activeId === null || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-id="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const toggleThread = useCallback((threadId: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  if (emails.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-faint text-sm">
        没有邮件
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto">
      {groups.map((group) => (
        <ThreadGroupRow
          key={group.representative.internal_id}
          group={group}
          activeId={activeId}
          onSelect={onSelect}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          expanded={group.threadId ? expandedThreads.has(group.threadId) : false}
          onToggleThread={
            group.threadId ? () => toggleThread(group.threadId!) : undefined
          }
        />
      ))}
    </div>
  );
}

// --- Thread group row with lazy-loaded children ---

interface ThreadGroupRowProps {
  group: ThreadGroup;
  activeId: number | null;
  onSelect: (id: number) => void;
  selectMode: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  expanded: boolean;
  onToggleThread?: () => void;
}

function ThreadGroupRow({
  group,
  activeId,
  onSelect,
  selectMode,
  selectedIds,
  onToggleSelect,
  expanded,
  onToggleThread,
}: ThreadGroupRowProps) {
  const { data: threadEmails } = useThreadEmails(
    group.threadId,
    expanded,
  );

  // 子邮件 = 线程内除代表邮件外的邮件（按时间正序）
  const children = useMemo(() => {
    if (!threadEmails) return [];
    return threadEmails.filter(
      (e) => e.internal_id !== group.representative.internal_id,
    );
  }, [threadEmails, group.representative.internal_id]);

  // 聚合线程状态：任意一封未读 → 线程未读；任意一封有旗标 → 线程有旗标
  const threadStatus = useMemo(() => {
    if (!group.threadId || group.members.length <= 1) return null;
    return {
      hasUnread: group.members.some((m) => !m.is_read),
      hasFlagged: group.members.some((m) => m.is_flagged),
    };
  }, [group.threadId, group.members]);

  const email = group.representative;

  return (
    <>
      <div data-id={email.internal_id}>
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
          threadCount={group.count}
          threadExpanded={expanded}
          onToggleThread={onToggleThread}
          threadHasUnread={threadStatus?.hasUnread}
          threadHasFlagged={threadStatus?.hasFlagged}
        />
      </div>

      {/* 展开的子邮件 */}
      {expanded &&
        children.map((child, idx) => (
          <div key={child.internal_id} data-id={child.internal_id}>
            <ThreadChildRow
              email={child}
              isActive={child.internal_id === activeId}
              onClick={() => onSelect(child.internal_id)}
              isLast={idx === children.length - 1}
            />
          </div>
        ))}
    </>
  );
}
