export interface Person {
  id: string
  name: string
  org: string
  role: string
  waiting?: boolean
  tier: 'core' | 'normal'
  lastContact?: string
}

/** 取自 owner 截图的真实一屏（8 人，全在「其他」组，核心组为空）。 */
export const PEOPLE: Person[] = [
  { id: '1', name: '唐铭阳', org: '商用产品研发处-测试部-解决方案测试课', role: '发起/汇总人', tier: 'normal' },
  { id: '2', name: 'Lucien Chen（陈源泉）', org: 'ENBU / Omada', role: '产品负责人（Omada/Guard）', tier: 'normal' },
  { id: '3', name: '孙晓宇', org: 'ENBU', role: 'Controller 平台整体负责人', waiting: true, tier: 'normal' },
  { id: '4', name: '郭诗力', org: 'ENBU', role: 'Controller 管理端负责人', waiting: true, tier: 'normal' },
  { id: '5', name: '聂磊', org: 'ENBU', role: 'Gateway 负责人', waiting: true, tier: 'normal' },
  { id: '6', name: 'Echo Liu', org: 'TP-Link', role: '需求落地负责人', tier: 'normal', lastContact: '3 天前' },
  { id: '7', name: '曾东彪', org: 'TP-Link', role: '研发落地负责人', tier: 'normal' },
  { id: '8', name: '赖涵', org: 'ENBU', role: 'Guard 负责人', waiting: true, tier: 'normal' }
]

/** 头像底色：按 id 稳定取色，与通讯录 Monogram 同口径（不随顺序变）。 */
export const HUES = ['#e06c5a', '#3f9b6d', '#4a7fd4', '#c8863a', '#9b6bc4', '#4aa3a3', '#c25f8a', '#6b8f3a']
