// 身份字段 → i18n 标签键的单源。
//
// 三处消费：档案页的字段行、`contacts.toast.locked`「{field} 已保存并锁定」、WP7 治理建议卡
// 的结论句（「给 X 补上**部门**「Y」」）。手抄第二份 = 同一个字段在两处叫两个名字。
//
// 落在独立模块而不是 `ContactDetail.tsx` 里：那是组件文件，从它导出常量会触发
// `react-refresh/only-export-components`（并且真的会让那个文件的热更新退化成整页刷新）。

import type { ContactLockableField } from '@shared/api/types/contact'

export const FIELD_LABEL_KEY: Record<ContactLockableField, string> = {
  display_name: 'contacts.field.name',
  formal_name: 'contacts.field.formalName',
  organization: 'contacts.field.org',
  department: 'contacts.field.dept',
  role_title: 'contacts.field.role',
  phone: 'contacts.field.phone',
  function: 'contacts.field.fn',
  seniority: 'contacts.field.level'
}
