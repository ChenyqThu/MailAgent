import { AssistantChatDock } from '@shared/assistant/modal/AssistantChatDock'

import { PageFrame } from './PageFrame'
import { ContactsWorkspace } from '../contacts/ContactsWorkspace'

export function ContactsLayout(): React.ReactElement {
  return (
    // rightDock —— 照 MattersLayout：这条路由自己持一份 AI dock 宿主（sidebar 模式
    // 靠 flex 兄弟位挤压正文），否则从通讯录页发起的 AI 对话没有落点。
    <PageFrame
      ariaLabel="contacts"
      mainClassName="flex-1 min-w-0 overflow-hidden"
      rightDock={<AssistantChatDock />}
    >
      <ContactsWorkspace />
    </PageFrame>
  )
}
