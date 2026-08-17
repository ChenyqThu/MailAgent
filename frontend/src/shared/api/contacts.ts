// 通讯录 REST client（task 08-13 WP2）。照 api/matters.ts 的工厂形状：
// `createContactsApi(baseUrl)`，请求走 shared/api/http_client 的 envelope 解包。
// 🔴 刻意比 matters 薄：contacts 写面无 version CAS / mutation 幂等信封（主 session
// 裁决），body 就是各端点的字面形状。

import { request } from './http_client'
import type {
  ContactBackfillProgress,
  ContactDetailDto,
  ContactFunction,
  ContactKind,
  ContactListResponse,
  ContactMailDirection,
  ContactMailsResponse,
  ContactMattersResponse,
  ContactLockableField,
  ContactMergeBody,
  ContactPatchBody,
  ContactPatchResponse,
  ContactResolveResponse,
  ContactSeniority,
  ContactSort,
  ContactView
} from './types/contact'

function segment(value: string | number): string {
  return encodeURIComponent(String(value))
}

export interface ContactsApi {
  list(options?: {
    view?: ContactView
    q?: string
    sort?: ContactSort
    /** WP4 (⌘K「人」组): 排序后截断 items; total 仍为全量命中数（「+n more」）。 */
    limit?: number
  }): Promise<ContactListResponse>
  get(contactId: number): Promise<ContactDetailDto>
  /** WP4 互链: 批量精确解析（键 = 原输入串, null = 不在库）。上限 100。 */
  resolve(emails: string[]): Promise<ContactResolveResponse>
  listMails(
    contactId: number,
    options?: { direction?: ContactMailDirection; cursor?: string; limit?: number }
  ): Promise<ContactMailsResponse>
  listMatters(contactId: number): Promise<ContactMattersResponse>
  patch(contactId: number, body: ContactPatchBody): Promise<ContactPatchResponse>
  setLock(
    contactId: number,
    field: ContactLockableField,
    locked: boolean
  ): Promise<{ locks: Partial<Record<ContactLockableField, number>> }>
  hide(contactId: number, hidden: boolean): Promise<{ hidden: boolean }>
  setKind(contactId: number, kind: ContactKind): Promise<{ kind: ContactKind }>
  setSelf(contactId: number, isSelf: boolean): Promise<{ is_self: boolean }>
  /** WP5 组织关系: 指定/解除上级 (null = 解除)。🔒 只存一侧 —— 「添加下级」=
   *  对下级那行调本方法。src 恒 'manual' (服务端钉死)。成功返回本人详情。 */
  setManager(contactId: number, managerContactId: number | null): Promise<ContactDetailDto>
  setPrimaryEmail(contactId: number, email: string): Promise<{ primary_email: string }>
  setEmailFormer(
    contactId: number,
    email: string,
    former: boolean
  ): Promise<{ email: string; former: boolean }>
  /** 人级合并 (WP3)：contactId = winner (保留方)。成功返回 winner 详情。 */
  merge(contactId: number, body: ContactMergeBody): Promise<ContactDetailDto>
  backfillProgress(): Promise<ContactBackfillProgress>
}

// re-export 常用类型给消费方（列表/详情组件不必逐个去 types/contact 拿）。
export type {
  ContactFunction,
  ContactKind,
  ContactSeniority,
  ContactSort,
  ContactView,
  ContactMailDirection,
  ContactLockableField
}

export function createContactsApi(baseUrl: string): ContactsApi {
  return {
    list(options = {}) {
      return request(baseUrl, 'GET', '/contacts', {
        query: { view: options.view, q: options.q, sort: options.sort, limit: options.limit }
      })
    },
    get(contactId) {
      return request(baseUrl, 'GET', `/contacts/${segment(contactId)}`)
    },
    resolve(emails) {
      return request(baseUrl, 'POST', '/contacts/resolve', { body: { emails } })
    },
    listMails(contactId, options = {}) {
      return request(baseUrl, 'GET', `/contacts/${segment(contactId)}/mails`, {
        query: { direction: options.direction, cursor: options.cursor, limit: options.limit }
      })
    },
    listMatters(contactId) {
      return request(baseUrl, 'GET', `/contacts/${segment(contactId)}/matters`)
    },
    patch(contactId, body) {
      return request(baseUrl, 'PATCH', `/contacts/${segment(contactId)}`, { body })
    },
    setLock(contactId, field, locked) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/locks`, {
        body: { field, locked }
      })
    },
    hide(contactId, hidden) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/hide`, {
        body: { hidden }
      })
    },
    setKind(contactId, kind) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/kind`, {
        body: { kind }
      })
    },
    setSelf(contactId, isSelf) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/self`, {
        body: { is_self: isSelf }
      })
    },
    setManager(contactId, managerContactId) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/manager`, {
        body: { manager_contact_id: managerContactId }
      })
    },
    setPrimaryEmail(contactId, email) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/emails/primary`, {
        body: { email }
      })
    },
    setEmailFormer(contactId, email, former) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/emails/former`, {
        body: { email, former }
      })
    },
    merge(contactId, body) {
      return request(baseUrl, 'POST', `/contacts/${segment(contactId)}/merge`, { body })
    },
    backfillProgress() {
      return request(baseUrl, 'GET', '/contacts/backfill/progress')
    }
  }
}
