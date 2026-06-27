// Authored preview — Tabs (Radix tabs; renders inline, active panel shown).
import { Tabs, TabsList, TabsTrigger, TabsContent } from 'mailagent-frontend'

export const Basic = () => (
  <div style={{ padding: 24, background: 'rgb(var(--ink-1))', width: 440 }}>
    <Tabs defaultValue="general">
      <TabsList>
        <TabsTrigger value="general">通用</TabsTrigger>
        <TabsTrigger value="accounts">账户</TabsTrigger>
        <TabsTrigger value="ai">AI</TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <div style={{ padding: '16px 2px', color: 'rgb(var(--ink-fg-2))', fontSize: 14, lineHeight: 1.6 }}>
          语言、主题与启动行为。默认账户与同步频率在这里配置。
        </div>
      </TabsContent>
      <TabsContent value="accounts">
        <div style={{ padding: '16px 2px', color: 'rgb(var(--ink-fg-2))', fontSize: 14 }}>账户管理</div>
      </TabsContent>
      <TabsContent value="ai">
        <div style={{ padding: '16px 2px', color: 'rgb(var(--ink-fg-2))', fontSize: 14 }}>AI 分类与模型设置</div>
      </TabsContent>
    </Tabs>
  </div>
)
