import { AssistantChatDock } from '@shared/assistant/modal/AssistantChatDock'

import { PageFrame } from './PageFrame'
import { MattersWorkspace } from '../matters/MattersWorkspace'

export function MattersLayout(): React.ReactElement {
  return (
    // rightDock —— 事项详情的「事项对话」写的是 AI dock 的 store（openMatterChat），这条路由
    // 必须自己有一份 dock 宿主，否则状态写下去这一屏没人读 = 点了没反应（0812 dogfood P0）。
    // 放在 <main> 的兄弟位: dock 的 sidebar 模式靠这个 flex 位置挤压正文。
    <PageFrame
      ariaLabel="matters"
      mainClassName="flex-1 min-w-0 overflow-hidden"
      rightDock={<AssistantChatDock />}
    >
      <MattersWorkspace />
    </PageFrame>
  )
}
