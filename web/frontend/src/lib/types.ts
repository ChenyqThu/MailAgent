export interface EmailListItem {
  internal_id: number;
  message_id: string | null;
  subject: string | null;
  sender: string | null;
  sender_name: string | null;
  to_addr: string | null;
  date_received: string | null;
  mailbox: string | null;
  is_read: boolean;
  is_flagged: boolean;
  has_attachments: boolean;
  notion_page_id: string | null;
  ai_summary: string | null;
  key_points: string | null;
  category: string | null;
  priority: string | null;
  action_type: string | null;
  action_required: boolean;
  sender_priority: string | null;
  language: string | null;
  urgency_reason: string | null;
  mail_actions: string[] | null;
  reply_suggestion: string | null;
  related_project: string | null;
  llm_status: string | null;
}

export interface EmailDetail extends EmailListItem {
  thread_id: string | null;
  cc_addr: string | null;
  body_html: string | null;
  body_text: string | null;
  thread_count: number;
}

export interface PagedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface EmailFilter {
  mailbox?: string;
  priority?: string;
  action_type?: string;
  category?: string;
  is_flagged?: boolean;
  pending_only?: boolean;
  search?: string;
}
