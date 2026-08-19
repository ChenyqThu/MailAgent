// SortableBoard 的纯落位逻辑（与 React / dnd-kit 解耦，可直测）。
// 文件名与组件 `SortableBoard.tsx` 有意只差一个词而不是只差大小写 —— macOS 的
// 大小写不敏感文件系统会把 `sortableBoard.ts` 与 `SortableBoard.tsx` 当成同一个。
//
// 「板」= 若干**有序分组**，每组一串 item。拖拽可以在组内重排，也可以跨组搬运。
// 这份逻辑只认 id 与分组结构，不认业务字段 —— 干系人的 core/normal、未来看板的列，
// 用的都是同一套。
//
// 🔴 落位是这块最容易出错的部分：跨组时「插到第几位」有三种来源（悬停在某张卡上 /
//    悬停在组容器上 / 悬停在折叠标题上），错一种就会出现「拖过去掉到末尾」「拖到自己
//    身上把自己删了」这类只有真拖才发现的 bug。所以它在这里单独成文并直测。

/** 一组：稳定 id + 有序 item id 列表。 */
export interface BoardGroupOrder {
  id: string
  itemIds: readonly string[]
}

/** dnd-kit 的 active/over 里真正用到的那点信息 —— 只依赖形状，单测可喂假事件。 */
export interface BoardDragEvent {
  active: { id: string | number }
  over?: { id: string | number } | null
}

/** 组容器 droppable id 前缀。空组也要能接落点 —— 否则最后一个 item 拖出去就回不来了。 */
export const BOARD_GROUP_DROPPABLE_PREFIX = 'board:group:'
/** 折叠组标题 droppable id 前缀。悬停到它上面 → 请求展开（数据不动）。 */
export const BOARD_HEADER_DROPPABLE_PREFIX = 'board:header:'

export const groupDroppableId = (groupId: string): string =>
  `${BOARD_GROUP_DROPPABLE_PREFIX}${groupId}`
export const headerDroppableId = (groupId: string): string =>
  `${BOARD_HEADER_DROPPABLE_PREFIX}${groupId}`

/** droppable id → 组 id；不是组容器返回 null。 */
export function groupIdOfContainer(id: string | number): string | null {
  const raw = String(id)
  return raw.startsWith(BOARD_GROUP_DROPPABLE_PREFIX)
    ? raw.slice(BOARD_GROUP_DROPPABLE_PREFIX.length)
    : null
}

/** droppable id → 折叠标题所属的组 id；不是标题返回 null。 */
export function groupIdOfHeader(id: string | number): string | null {
  const raw = String(id)
  return raw.startsWith(BOARD_HEADER_DROPPABLE_PREFIX)
    ? raw.slice(BOARD_HEADER_DROPPABLE_PREFIX.length)
    : null
}

/**
 * 把一次拖拽（悬停中或落下）应用到分组上，返回新的分组顺序。
 *
 * 三种落点：
 * 1. 悬停在**另一个 item** 上 → 插到它的位置（同组内是重排，跨组是插入）
 * 2. 悬停在**组容器**上（空组，或 item 之间的空白）→ 追加到该组末尾
 * 3. 悬停在**折叠标题**上 → 数据不动（调用方负责展开；展开后走 1/2）
 *
 * 🔴 无变化时返回**同一个数组引用**：`onDragOver` 每帧都会调，每次造新对象会让
 * React 每帧重渲整块板。
 */
export function applyBoardDrag(
  groups: readonly BoardGroupOrder[],
  event: BoardDragEvent
): readonly BoardGroupOrder[] {
  const overId = event.over?.id
  if (overId == null) return groups
  // 折叠标题：数据不动（展开由调用方做）。⚠️ 这一行是**可读性**短路 —— 删了行为也对
  // （header id 不属于任何组，下面找 targetGroupId 会落空并原样返回）。别把它当唯一防线。
  if (groupIdOfHeader(overId) != null) return groups

  const activeId = String(event.active.id)
  if (String(overId) === activeId) return groups

  const fromGroup = groups.find((group) => group.itemIds.includes(activeId))
  if (!fromGroup) return groups

  const containerGroupId = groupIdOfContainer(overId)
  const targetGroupId =
    containerGroupId ?? groups.find((group) => group.itemIds.includes(String(overId)))?.id
  if (targetGroupId == null) return groups

  // 🔴 同组重排与跨组搬运的下标语义**不同**，分开算：
  //  · 同组 = arrayMove：新位置按 over 在**原数组**里的下标（先移除自己再找会差一位，
  //    向后拖时表现为「拖了等于没拖」）。
  //  · 跨组 = 移除后插入：over 在**目标数组**里的下标就是插入点。
  const next = groups.map((group) => ({ id: group.id, itemIds: [...group.itemIds] }))
  const target = next.find((group) => group.id === targetGroupId)
  if (!target) return groups

  if (fromGroup.id === targetGroupId && containerGroupId == null) {
    const from = target.itemIds.indexOf(activeId)
    const to = target.itemIds.indexOf(String(overId))
    if (from < 0 || to < 0) return groups
    target.itemIds.splice(from, 1)
    target.itemIds.splice(to, 0, activeId)
  } else {
    for (const group of next) group.itemIds = group.itemIds.filter((id) => id !== activeId)
    const index =
      containerGroupId != null ? target.itemIds.length : target.itemIds.indexOf(String(overId))
    target.itemIds.splice(index < 0 ? target.itemIds.length : index, 0, activeId)
  }

  return sameBoardOrder(next, groups) ? groups : next
}

/** 两份分组的「谁在哪一组的第几位」是否完全一致。用于「拖起来又放回原位 → 不提交」。 */
export function sameBoardOrder(
  a: readonly BoardGroupOrder[],
  b: readonly BoardGroupOrder[]
): boolean {
  const key = (groups: readonly BoardGroupOrder[]): string =>
    groups.map((group) => `${group.id}:${group.itemIds.join(',')}`).join('|')
  return key(a) === key(b)
}
