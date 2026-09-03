// task 09-02 — GET /api/ai/generated/:fileId: the read-only route over the generate_image store.
// Serves exactly the files the tool wrote (validated id + path pinned under the root), answers 404
// for everything else (bad id / traversal attempt / missing file / cfg without a store), and 404
// too on a cfg that never registered the store.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
)
const FILE_ID = '42-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'

const handles: AiGatewayHandle[] = []
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imagegen-route-'))
  await mkdir(join(dir, '42'), { recursive: true })
  await writeFile(join(dir, '42', FILE_ID.slice(3)), PNG)
})
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
  await rm(dir, { recursive: true, force: true })
})

async function start(over: Partial<AiGatewayConfig> = {}): Promise<string> {
  const h = await startAiGatewayServer({
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    generatedImagesDir: dir,
    ...over
  })
  handles.push(h)
  return `http://127.0.0.1:${h.port}`
}

describe('GET /api/ai/generated/:fileId', () => {
  test('serves the stored file with its mime + immutable cache header', async () => {
    const base = await start()
    const res = await fetch(`${base}/api/ai/generated/${FILE_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  test.each([
    '42-aaaaaaaa-bbbb-cccc-dddd-ffffffffffff.png', // valid shape, no such file
    '43-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png', // other session
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png', // no session prefix
    '42-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.txt', // not an image extension
    '..%2F..%2Fetc%2Fpasswd', // encoded traversal
    '42' // bare session
  ])('404 for %s', async (id) => {
    const base = await start()
    const res = await fetch(`${base}/api/ai/generated/${id}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'E_IMAGE_NOT_FOUND' })
  })

  test('a literal traversal path never reaches the store (404, no file read)', async () => {
    const base = await start()
    // node:http normalizes nothing here — the raw path arrives as-is and the id regex refuses it.
    const res = await fetch(`${base}/api/ai/generated/42/../42/${FILE_ID.slice(3)}`)
    expect(res.status).toBe(404)
  })

  test('cfg without generatedImagesDir → 404 (route inert, like an unknown path)', async () => {
    const base = await start({ generatedImagesDir: undefined })
    const res = await fetch(`${base}/api/ai/generated/${FILE_ID}`)
    expect(res.status).toBe(404)
  })

  test('POST is not the route (falls through to the generic 404)', async () => {
    const base = await start()
    const res = await fetch(`${base}/api/ai/generated/${FILE_ID}`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'not_found' })
  })
})
