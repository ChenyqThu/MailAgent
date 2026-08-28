// 事项的双身份索引（task 08-27 P2 Lane W）。
//
// 标签 store 的 targetId 是 number（TabDescriptor 契约），而事项域全线用 public_id
//（string）做选中键 —— 两边都不改：这里维护一份运行时 id ↔ public_id 双向索引，
// 由数据边缘（MattersWorkspace 的列表行 / MatterDetail 的详情响应）注册。
//
// 索引未命中（极少：深链目标在列表落地前）时选中照常走本地 selectedId，只是不落
// 标签 —— 详情数据到位后 MatterDetail 会补注册 + 回填标题，自愈。

const idToPublic = new Map<number, string>()
const publicToId = new Map<string, number>()

export function registerMatterIdentity(id: number, publicId: string): void {
  if (!Number.isInteger(id) || publicId === '') return
  const prevPublic = idToPublic.get(id)
  if (prevPublic !== undefined && prevPublic !== publicId) publicToId.delete(prevPublic)
  idToPublic.set(id, publicId)
  publicToId.set(publicId, id)
}

export function matterNumericId(publicId: string | null): number | null {
  if (publicId === null) return null
  return publicToId.get(publicId) ?? null
}

export function matterPublicIdOf(id: number | null): string | null {
  if (id === null) return null
  return idToPublic.get(id) ?? null
}

/** 测试用复位 —— 模块级 Map 跨用例存活。 */
export function _resetMatterIdentityForTest(): void {
  idToPublic.clear()
  publicToId.clear()
}
