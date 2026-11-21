// Zero-dependency RFC 6455 loopback WebSocket helper for Electron main's
// target-isolated CDP bridge.

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024

export function isAllowedLoopbackHost(
  hostHeader: string | undefined,
  expectedPort: number
): boolean {
  if (!hostHeader || expectedPort <= 0) return false
  const normalized = hostHeader.trim().toLowerCase()
  return (
    normalized === `127.0.0.1:${expectedPort}` ||
    normalized === `localhost:${expectedPort}` ||
    normalized === `[::1]:${expectedPort}`
  )
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeUInt32BE(Math.floor(len / 0x1_0000_0000), 2)
    header.writeUInt32BE(len >>> 0, 6)
  }
  return Buffer.concat([header, payload])
}

export class LoopbackWebSocket extends EventEmitter {
  private readonly socket: Duplex
  private buffer: Buffer = Buffer.alloc(0)
  private fragmentChunks: Buffer[] = []
  private fragmentSize = 0
  private fragmentOpcode: number | null = null
  private closed = false

  constructor(socket: Duplex, initialHead?: Buffer) {
    super()
    this.socket = socket
    if (typeof (socket as unknown as { setNoDelay?: (b: boolean) => void }).setNoDelay === 'function') {
      ;(socket as unknown as { setNoDelay: (b: boolean) => void }).setNoDelay(true)
    }

    socket.on('data', (chunk: Buffer) => {
      if (this.closed) return
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.drainFrames()
    })
    socket.on('close', () => {
      this.finalizeClose(1006, '')
    })
    socket.on('error', (err: Error) => {
      if (!this.closed) {
        this.emit('error', err)
      }
      this.finalizeClose(1006, '')
    })

    if (initialHead && initialHead.length > 0) {
      this.buffer = Buffer.from(initialHead)
      queueMicrotask(() => {
        if (!this.closed) this.drainFrames()
      })
    }
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed
  }

  send(text: string): void {
    if (!this.isOpen) return
    const payload = Buffer.from(text, 'utf8')
    this.socket.write(encodeWsFrame(0x1, payload))
  }

  ping(payload: Buffer = Buffer.alloc(0)): void {
    if (!this.isOpen) return
    this.socket.write(encodeWsFrame(0x9, payload))
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    const reasonBuf = Buffer.from(reason, 'utf8')
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    try {
      if (!this.socket.destroyed) {
        this.socket.write(encodeWsFrame(0x8, payload))
        this.socket.end()
      }
    } catch {
      /* ignore write-after-close */
    }
    this.finalizeClose(code, reason)
  }

  private finalizeClose(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.buffer = Buffer.alloc(0)
    this.fragmentChunks = []
    this.fragmentSize = 0
    this.fragmentOpcode = null
    this.emit('close', code, reason)
  }

  private drainFrames(): void {
    while (!this.closed && this.buffer.length >= 2) {
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2

      if (payloadLen === 126) {
        if (this.buffer.length < offset + 2) return
        payloadLen = this.buffer.readUInt16BE(offset)
        offset += 2
      } else if (payloadLen === 127) {
        if (this.buffer.length < offset + 8) return
        const hi = this.buffer.readUInt32BE(offset)
        const lo = this.buffer.readUInt32BE(offset + 4)
        payloadLen = hi * 0x1_0000_0000 + lo
        offset += 8
      }

      if (!masked || !Number.isSafeInteger(payloadLen) || payloadLen > MAX_WS_PAYLOAD_BYTES) {
        this.close(payloadLen > MAX_WS_PAYLOAD_BYTES ? 1009 : 1002, 'Invalid frame')
        return
      }

      const headerTotal = offset + 4
      if (this.buffer.length < headerTotal + payloadLen) return

      const maskKey = this.buffer.subarray(offset, headerTotal)
      const payload = Buffer.allocUnsafe(payloadLen)
      for (let i = 0; i < payloadLen; i += 1) {
        payload[i] = this.buffer[headerTotal + i] ^ maskKey[i & 3]
      }
      this.buffer = this.buffer.subarray(headerTotal + payloadLen)

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        this.close(code, reason)
        return
      }
      if (opcode === 0x9) {
        if (this.isOpen) {
          this.socket.write(encodeWsFrame(0xa, payload))
        }
        continue
      }
      if (opcode === 0xa) {
        continue
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.emit('message', payload.toString('utf8'))
        } else {
          this.fragmentOpcode = opcode
          this.fragmentChunks = [payload]
          this.fragmentSize = payload.length
        }
        continue
      }

      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) {
          this.close(1002, 'Unexpected continuation frame')
          return
        }
        this.fragmentSize += payload.length
        if (this.fragmentSize > MAX_WS_PAYLOAD_BYTES) {
          this.close(1009, 'Fragmented message too large')
          return
        }
        this.fragmentChunks.push(payload)
        if (fin) {
          const full = Buffer.concat(this.fragmentChunks, this.fragmentSize)
          this.fragmentChunks = []
          this.fragmentSize = 0
          this.fragmentOpcode = null
          this.emit('message', full.toString('utf8'))
        }
        continue
      }

      this.close(1003, 'Unsupported opcode')
      return
    }
  }
}

export function upgradeLoopbackWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head?: Buffer
): LoopbackWebSocket | null {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
  const key = req.headers['sec-websocket-key']
  if (upgrade !== 'websocket' || typeof key !== 'string' || !key.trim()) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(`${key.trim()}${WS_MAGIC_GUID}`).digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n')
  )
  return new LoopbackWebSocket(socket, head)
}
