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
  ContactMailRole,
  ContactMailsResponse,
  ContactMattersResponse,
  ContactLockableField,
  ContactPatchBody,
  ContactPatchResponse,
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
  }): Promise<ContactListResponse>
  get(contactId: number): Promise<ContactDetailDto>
  listMails(
    contactId: number,
    options?: { role?: ContactMailRole; cursor?: string; limit?: number }
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
  setPrimaryEmail(contactId: number, email: string): Promise<{ primary_email: string }>
  setEmailFormer(
    contactId: number,
    email: string,
    former: boolean
  ): Promise<{ email: string; former: boolean }>
  backfillProgress(): Promise<ContactBackfillProgress>
}

// re-export 常用类型给消费方（列表/详情组件不必逐个去 types/contact 拿）。
export type {
  ContactFunction,
  ContactKind,
  ContactSeniority,
  ContactSort,
  ContactView,
  ContactMailRole,
  ContactLockableField
}

export function createContactsApi(baseUrl: string): ContactsApi {
  return {
    list(options = {}) {
      return request(baseUrl, 'GET', '/contacts', {
        query: { view: options.view, q: options.q, sort: options.sort }
      })
    },
    get(contactId) {
      return request(baseUrl, 'GET', `/contacts/${segment(contactId)}`)
    },
    listMails(contactId, options = {}) {
      return request(baseUrl, 'GET', `/contacts/${segment(contactId)}/mails`, {
        query: { role: options.role, cursor: options.cursor, limit: options.limit }
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
    backfillProgress() {
      return request(baseUrl, 'GET', '/contacts/backfill/progress')
    }
  }
}
