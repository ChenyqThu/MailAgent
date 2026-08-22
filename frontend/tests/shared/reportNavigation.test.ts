// 报告直达通道 store（通知中心 M2 批 B5，镜像 contacts/agents/matters 三处 navigation 的
// 形状）。消费方（ReportsTab 的 effect）依赖「open 落 target → 消费即 clear」这条时序契约：
// 不清就会在用户手动切走之后又被这条 intent 拽回去。

import { describe, expect, test } from 'vitest'

import { useReportNavigation } from '../../src/shared/components/agents/reportNavigation'

describe('useReportNavigation', () => {
  test('initial target is null', () => {
    expect(useReportNavigation.getState().targetReportId).toBeNull()
  })

  test('open(id) stamps the target; clear() resets', () => {
    useReportNavigation.getState().open('daily-2026-08-21')
    expect(useReportNavigation.getState().targetReportId).toBe('daily-2026-08-21')
    useReportNavigation.getState().clear()
    expect(useReportNavigation.getState().targetReportId).toBeNull()
  })

  test('successive open() calls keep the latest target', () => {
    useReportNavigation.getState().open('a')
    useReportNavigation.getState().open('b')
    expect(useReportNavigation.getState().targetReportId).toBe('b')
    useReportNavigation.getState().clear()
  })
})
