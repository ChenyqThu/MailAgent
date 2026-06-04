// C2 — local_token 单测: per-session ephemeral token 单例 + 常量名契约。
// local_token.ts 只 import 'crypto', 不碰 electron → 无须 mock。

import { afterEach, describe, expect, test } from 'vitest'

import {
  _resetLocalApiTokenForTests,
  getLocalApiToken,
  LOCAL_TOKEN_ENV,
  LOCAL_TOKEN_HEADER
} from '../../src/electron/main/local_token'

afterEach(() => _resetLocalApiTokenForTests())

describe('local_token — per-session ephemeral token', () => {
  test('单例: 同进程多次取用返回同一 token (注入后端 + events_bridge header 同值的基础)', () => {
    expect(getLocalApiToken()).toBe(getLocalApiToken())
  })

  test('256-bit hex (randomBytes(32).toString(hex) = 64 hex 字符)', () => {
    expect(getLocalApiToken()).toMatch(/^[0-9a-f]{64}$/)
  })

  test('reset 后生成新 token (模拟新 app 会话 = 一把新 token)', () => {
    const a = getLocalApiToken()
    _resetLocalApiTokenForTests()
    const b = getLocalApiToken()
    expect(b).not.toBe(a)
    expect(b).toMatch(/^[0-9a-f]{64}$/)
  })

  test('env / header 名常量 = Python auth.py / sse_server.py 约定字面量 (防三处手抄漂移)', () => {
    expect(LOCAL_TOKEN_ENV).toBe('MAILAGENT_LOCAL_API_TOKEN')
    expect(LOCAL_TOKEN_HEADER).toBe('X-MailAgent-Local-Token')
  })
})
