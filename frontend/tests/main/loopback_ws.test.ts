// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'

import {
  isAllowedLoopbackHost,
  upgradeLoopbackWebSocket,
  type LoopbackWebSocket
} from '../../src/electron/main/loopback_ws'

const serversToClose: Array<{ server: Server; sockets: LoopbackWebSocket[] }> = []

afterEach(async () => {
  while (serversToClose.length > 0) {
    const entry = serversToClose.pop()!
    for (const ws of entry.sockets) ws.close()
    entry.server.closeAllConnections?.()
    await new Promise<void>((resolve) => entry.server.close(() => resolve()))
  }
})

async function startWsEchoServer(): Promise<{ port: number; sockets: LoopbackWebSocket[] }> {
  const sockets: LoopbackWebSocket[] = []
  const server = createServer((_req, res) => {
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    const ws = upgradeLoopbackWebSocket(req, socket, head)
    if (!ws) return
    sockets.push(ws)
    ws.on('message', (txt: string) => {
      ws.send(`echo:${txt}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  serversToClose.push({ server, sockets })
  const addr = server.address() as { port: number }
  return { port: addr.port, sockets }
}

describe('loopback_ws', () => {
  test('validates loopback host header strictly against bound port', () => {
    expect(isAllowedLoopbackHost('127.0.0.1:9123', 9123)).toBe(true)
    expect(isAllowedLoopbackHost('localhost:9123', 9123)).toBe(true)
    expect(isAllowedLoopbackHost('[::1]:9123', 9123)).toBe(true)
    expect(isAllowedLoopbackHost('127.0.0.1:9999', 9123)).toBe(false)
    expect(isAllowedLoopbackHost('evil.example:9123', 9123)).toBe(false)
    expect(isAllowedLoopbackHost(undefined, 9123)).toBe(false)
  })

  test('completes RFC 6455 handshake, handles small and >65KB messages, and closes cleanly', async () => {
    const { port, sockets } = await startWsEchoServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp/test`)

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('WS open failed')), { once: true })
    })

    // Small payload + CJK UTF-8
    const smallReply = new Promise<string>((resolve) => {
      ws.addEventListener('message', (evt) => resolve(String(evt.data)), { once: true })
    })
    ws.send('hello 世界')
    expect(await smallReply).toBe('echo:hello 世界')

    // Large payload (> 65535 bytes -> 64-bit length frame in both directions)
    const largeText = 'A'.repeat(70_000)
    const largeReply = new Promise<string>((resolve) => {
      ws.addEventListener('message', (evt) => resolve(String(evt.data)), { once: true })
    })
    ws.send(largeText)
    expect(await largeReply).toBe(`echo:${largeText}`)

    const serverClosed = new Promise<void>((resolve) => {
      sockets[0].once('close', () => resolve())
    })
    ws.close(1000, 'bye')
    await serverClosed
  })

  test('handles fragmented continuation frames and Ping -> Pong frames', async () => {
    const { port } = await startWsEchoServer()
    const sock = createConnection({ host: '127.0.0.1', port })

    await new Promise<void>((resolve) => sock.once('connect', () => resolve()))
    sock.write(
      [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n')
    )

    const recvChunks: Buffer[] = []
    sock.on('data', (d) => recvChunks.push(d))
    await new Promise<void>((resolve) => setTimeout(resolve, 40))

    // Masked fragmented text ("hi" + "!")
    const mask = Buffer.from([1, 2, 3, 4])
    const makeMaskedFrame = (fin: boolean, opcode: number, payload: Buffer): Buffer => {
      const hdr = Buffer.from([
        (fin ? 0x80 : 0x00) | opcode,
        0x80 | payload.length
      ])
      const masked = Buffer.allocUnsafe(payload.length)
      for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
      return Buffer.concat([hdr, mask, masked])
    }

    sock.write(makeMaskedFrame(false, 0x1, Buffer.from('hi')))
    sock.write(makeMaskedFrame(true, 0x0, Buffer.from('!')))
    // Ping frame
    sock.write(makeMaskedFrame(true, 0x9, Buffer.from('pk')))

    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const all = Buffer.concat(recvChunks)
    expect(all.toString('utf8')).toContain('echo:hi!')
    // Pong frame byte: 0x8a 0x02 'pk'
    const pongIdx = all.indexOf(Buffer.from([0x8a, 0x02, 0x70, 0x6b]))
    expect(pongIdx).toBeGreaterThan(-1)
    sock.destroy()
  })
})
