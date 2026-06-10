// src/lib/ws.test.js
//
// Tests for ws URL composition and critical RoomClient socket-handler paths.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildRoomUrl, RoomClient } from './ws.js'
import { ConnStatus, ClientFrameType, EventType, CURRENT_SCHEMA_VERSION } from './types.js'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = url
    this.sent = []
    this.readyState = FakeWebSocket.OPEN
    this.closeCalls = 0
    this.closedCode = null
    this.closedReason = null
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) return
    this.sent.push(data)
  }

  close(code = 1000, reason = 'forced') {
    this.closedCode = code
    this.closedReason = reason
    this.closeCalls += 1
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

let sockets = []
let OriginalWebSocket

function installWebSocketMock() {
  sockets = []
  OriginalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class MockWebSocket extends FakeWebSocket {
    static CONNECTING = FakeWebSocket.CONNECTING
    static OPEN = FakeWebSocket.OPEN
    static CLOSING = FakeWebSocket.CLOSING
    static CLOSED = FakeWebSocket.CLOSED

    constructor(url) {
      super(url)
      sockets.push(this)
    }
  }
}

function latestSocket() {
  return sockets.at(-1)
}

beforeEach(() => {
  installWebSocketMock()
})

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket
})

describe('buildRoomUrl', () => {
  it('appends auction + token as query params', () => {
    const url = buildRoomUrl('ws://localhost:8080', 'auc_demo', 'jwt-token')
    expect(url).toBe('ws://localhost:8080/ws?auction=auc_demo&token=jwt-token')
  })

  it('rewrites http→ws (handles VITE_WS_BASE set to an http URL)', () => {
    const url = buildRoomUrl('http://localhost:8080', 'auc1', 't1')
    expect(url.startsWith('ws://')).toBe(true)
  })

  it('rewrites https→wss', () => {
    const url = buildRoomUrl('https://api.example.com', 'auc1', 't1')
    expect(url.startsWith('wss://')).toBe(true)
  })

  it('strips trailing slashes on the base', () => {
    const url = buildRoomUrl('ws://localhost:8080///', 'auc1', 't1')
    expect(url).toBe('ws://localhost:8080/ws?auction=auc1&token=t1')
  })

  it('URL-encodes special chars in auctionId and token', () => {
    const url = buildRoomUrl('ws://localhost:8080', 'auc with space', 'tok&special')
    expect(url).toContain('auction=auc+with+space')
    expect(url).toContain('token=tok%26special')
  })

  it('handles a null token (cleared session) by sending empty string', () => {
    const url = buildRoomUrl('ws://localhost:8080', 'auc1', null)
    expect(url).toContain('token=')
  })
})

describe('RoomClient', () => {
  it('sends ROOM_JOIN on open without lastSeq when zero', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => 0,
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[0]).toMatchObject({ status: ConnStatus.CONNECTING })
    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('normalizes invalid lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => 'bad-seq',
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('normalizes numeric-string lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => '42',
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 42 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1', lastSeq: 42 })
  })

  it('rejects zero-string lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => '0',
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects negative-zero-string lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => '-0',
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('accepts bigint lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => 42n,
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 42 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1', lastSeq: 42 })
  })

  it('rejects symbol lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => Symbol('lastSeq'),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects Number object lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => new Number(42),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects String object lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => new String('42'),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects BigInt object lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => Object(42n),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects Boolean object lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => new Boolean(false),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects array lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => [42],
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects object lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => ({ value: 42 }),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects oversized bigint-unsafe numeric lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => String(Number.MAX_SAFE_INTEGER + 1),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects non-integer-like lastSeq strings before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => '12.0',
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects whitespace-trim-needed lastSeq strings before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => ' 12 ',
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects empty-string lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => '',
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('rejects null lastSeq before ROOM_JOIN', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => null,
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('falls back to 0 when getLastSeq throws', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      getLastSeq: () => {
        throw new Error('bad storage')
      },
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const env = JSON.parse(ws.sent[0])
    client.leave()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
    expect(env.data).toEqual({ auctionId: 'auc1' })
  })

  it('forwards BID_REJECTED envelopes to onReject', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        type: EventType.BID_REJECTED,
        auctionId: 'auc1',
        data: { code: 'ERR_RATE_LIMITED' },
      }),
    })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0].data.code).toBe('ERR_RATE_LIMITED')
  })

  it('ignores malformed JSON without throwing', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    expect(() => {
      ws.onmessage({ data: '{bad json' })
    }).not.toThrow()

    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    client.leave()
  })

  it('ignores non-object envelopes without throwing', () => {
    const events = []
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      onEvent: (env) => events.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    expect(() => {
      ws.onmessage({ data: '"just a string"' })
      ws.onmessage({ data: '42' })
      ws.onmessage({ data: 'null' })
    }).not.toThrow()

    expect(events).toHaveLength(0)
    expect(states[1]).toMatchObject({ status: ConnStatus.SYNCING, lastSeq: 0 })
    client.leave()
  })

  it('ignores envelopes without type', () => {
    const events = []
    const warns = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onEvent: (env) => events.push(env),
      onState: () => {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args))

    try {
      client.connect()
      const ws = latestSocket()
      ws.onopen()

      ws.onmessage({ data: JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION }) })
      ws.onmessage({ data: JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, type: null }) })
      ws.onmessage({ data: JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, type: 123 }) })

      expect(events).toHaveLength(0)
      expect(warns).toHaveLength(0)
      client.leave()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('ignores empty-string envelope type', () => {
    const events = []
    const warns = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onEvent: (env) => events.push(env),
      onState: () => {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args))

    try {
      client.connect()
      const ws = latestSocket()
      ws.onopen()

      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: '',
          auctionId: 'auc1',
        }),
      })

      expect(events).toHaveLength(0)
      expect(warns).toHaveLength(0)
      client.leave()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('ignores whitespace-only envelope type', () => {
    const events = []
    const warns = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onEvent: (env) => events.push(env),
      onState: () => {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args))

    try {
      client.connect()
      const ws = latestSocket()
      ws.onopen()

      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: '   ',
          auctionId: 'auc1',
        }),
      })

      expect(events).toHaveLength(0)
      expect(warns).toHaveLength(0)
      client.leave()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('ignores control-whitespace envelope type', () => {
    const events = []
    const warns = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onEvent: (env) => events.push(env),
      onState: () => {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args))

    try {
      client.connect()
      const ws = latestSocket()
      ws.onopen()

      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: '\t\n',
          auctionId: 'auc1',
        }),
      })

      expect(events).toHaveLength(0)
      expect(warns).toHaveLength(0)
      client.leave()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('opens connection on ROOM_STATE_PATCH while forwarding event', () => {
    const events = []
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      onEvent: (env) => events.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        type: EventType.ROOM_STATE_PATCH,
        auctionId: 'auc1',
        seq: 123,
        data: { status: 'LIVE' },
      }),
    })
    client.leave()

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe(EventType.ROOM_STATE_PATCH)
    expect(states).toContainEqual({ status: ConnStatus.OPEN })
  })

  it('forwards AI_COMMENTARY to onEvent and opens connection', () => {
    const events = []
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      onEvent: (env) => events.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        type: EventType.AI_COMMENTARY,
        auctionId: 'auc1',
        data: {
          commentary: '正在等待出价',
          trigger: 'open',
        },
      }),
    })
    client.leave()

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe(EventType.AI_COMMENTARY)
    expect(states).toContainEqual({ status: ConnStatus.OPEN })
  })

  it('does not open on PONG and keeps only syncing state', () => {
    const states = []
    const events = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      onEvent: (env) => events.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        type: EventType.PONG,
        auctionId: 'auc1',
      }),
    })
    client.leave()

    expect(events).toHaveLength(0)
    expect(states).not.toContainEqual({ status: ConnStatus.OPEN })
    expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
  })

  it('does not open on unknown event type', () => {
    const states = []
    const events = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
      onEvent: (env) => events.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        type: 'EVENT_NOT_IN_SPEC',
        auctionId: 'auc1',
      }),
    })
    client.leave()

    expect(events).toHaveLength(0)
    expect(states).not.toContainEqual({ status: ConnStatus.OPEN })
    expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
  })

  it('warns once per unknown event type', () => {
    const events = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const client = new RoomClient({
        url: 'ws://localhost:8080/ws',
        auctionId: 'auc1',
        onEvent: (env) => events.push(env),
      })

      client.connect()
      const ws = latestSocket()
      ws.onopen()

      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: 'EVENT_NOT_IN_SPEC',
          auctionId: 'auc1',
        }),
      })
      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: 'EVENT_NOT_IN_SPEC',
          auctionId: 'auc1',
        }),
      })

      client.leave()

      expect(events).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith('[RoomClient] unhandled envelope.type =', 'EVENT_NOT_IN_SPEC')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('re-logs unknown event type after reconnect', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onEvent: () => {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      client.connect()
      let ws = latestSocket()
      ws.onopen()
      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: 'EVENT_NOT_IN_SPEC',
          auctionId: 'auc1',
        }),
      })

      ws.close()
      client.connect()
      ws = latestSocket()
      ws.onopen()
      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: 'EVENT_NOT_IN_SPEC',
          auctionId: 'auc1',
        }),
      })

      client.leave()
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('converts numeric amountCents to string on BID_PLACE', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.placeBid({ amountCents: 1200, clientBidId: 'bid-1' })

    const env = JSON.parse(ws.sent[1])
    client.leave()

    expect(env.type).toBe(ClientFrameType.BID_PLACE)
    expect(env.data.amountCents).toBe('1200')
    expect(env.data.clientBidId).toBe('bid-1')
  })

  it('converts bigint amountCents to string on BID_PLACE', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.placeBid({ amountCents: 1200n, clientBidId: 'bid-2' })
    const env = JSON.parse(ws.sent[1])
    client.leave()

    expect(env.type).toBe(ClientFrameType.BID_PLACE)
    expect(env.data.amountCents).toBe('1200')
    expect(env.data.clientBidId).toBe('bid-2')
  })

  it('normalizes leading-zeros amountCents string on BID_PLACE', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.placeBid({ amountCents: '001200', clientBidId: 'bid-leading' })

    const env = JSON.parse(ws.sent[1])
    client.leave()

    expect(env.type).toBe(ClientFrameType.BID_PLACE)
    expect(env.data.amountCents).toBe('1200')
    expect(env.data.clientBidId).toBe('bid-leading')
  })

  it('normalizes plus-prefixed amountCents string on BID_PLACE', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.placeBid({ amountCents: '+1200', clientBidId: 'bid-plus' })

    const env = JSON.parse(ws.sent[1])
    client.leave()

    expect(env.type).toBe(ClientFrameType.BID_PLACE)
    expect(env.data.amountCents).toBe('1200')
    expect(env.data.clientBidId).toBe('bid-plus')
  })

  it('accepts max valid bigint amountCents on BID_PLACE', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.placeBid({ amountCents: 9_007_199_254_740_991n, clientBidId: 'bid-bigint-at-cap' })
    const env = JSON.parse(ws.sent[1])
    client.leave()

    expect(env.type).toBe(ClientFrameType.BID_PLACE)
    expect(env.data.amountCents).toBe('9007199254740991')
    expect(env.data.clientBidId).toBe('bid-bigint-at-cap')
  })

  it('rejects over-cap bigint amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.placeBid({ amountCents: 9_007_199_254_740_992n, clientBidId: 'bid-bigint-over-cap' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-bigint-over-cap',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects zero amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: 0, clientBidId: 'bid-zero-number' })
    client.placeBid({ amountCents: 0n, clientBidId: 'bid-zero-bigint' })
    client.placeBid({ amountCents: '0', clientBidId: 'bid-zero-str' })
    client.leave()

    expect(rejects).toHaveLength(3)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-zero-number',
    })
    expect(rejects[1]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-zero-bigint',
    })
    expect(rejects[2]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-zero-str',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects non-integer amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: 12.34, clientBidId: 'bid-3' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-3',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects negative amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: -100, clientBidId: 'bid-neg-1' })
    client.placeBid({ amountCents: -100n, clientBidId: 'bid-neg-2' })
    client.leave()

    expect(rejects).toHaveLength(2)
    expect(rejects.every((env) => env.type === EventType.BID_REJECTED)).toBe(true)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-neg-1',
    })
    expect(rejects[1]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-neg-2',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects unsafe integer amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({
      amountCents: Number.MAX_SAFE_INTEGER + 1,
      clientBidId: 'bid-unsafe',
    })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-unsafe',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects infinite amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: Infinity, clientBidId: 'bid-inf' })
    client.placeBid({ amountCents: -Infinity, clientBidId: 'bid-ninf' })
    client.leave()

    expect(rejects).toHaveLength(2)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-inf',
    })
    expect(rejects[1]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-ninf',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects NaN amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: NaN, clientBidId: 'bid-nan' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-nan',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects non-numeric amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: { value: '1200' }, clientBidId: 'bid-4' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-4',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects over-cap string amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: '9007199254740992', clientBidId: 'bid-over-cap' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-over-cap',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('accepts max valid string amountCents on BID_PLACE', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.placeBid({ amountCents: '9007199254740991', clientBidId: 'bid-at-cap' })
    const env = JSON.parse(ws.sent[1])
    client.leave()

    expect(env.type).toBe(ClientFrameType.BID_PLACE)
    expect(env.data.amountCents).toBe('9007199254740991')
    expect(env.data.clientBidId).toBe('bid-at-cap')
  })

  it('rejects decimal-string amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: '12.34', clientBidId: 'bid-5' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-5',
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects malformed-string amountCents on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const malformed = ['12 00', ' 1200', '1200 ', '+ 1200', '+-1200', '--1', '-', '+', '1_000', '12.34', '']
    malformed.forEach((amountCents, index) => {
      client.placeBid({ amountCents, clientBidId: `bid-mal-${index}` })
    })

    client.leave()

    expect(rejects).toHaveLength(malformed.length)
    expect(rejects.every((env) => env.type === EventType.BID_REJECTED)).toBe(true)
    expect(rejects[0]).toMatchObject({ data: { code: 'ERR_INTERNAL' } })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects non-positive textual sign patterns on BID_PLACE', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    const malformed = ['+0', '++1200', '--1200', '-1200', '000', '']
    malformed.forEach((amountCents, index) => {
      client.placeBid({ amountCents, clientBidId: `bid-sign-${index}` })
    })

    client.leave()

    expect(rejects).toHaveLength(malformed.length)
    expect(rejects.every((env) => env.type === EventType.BID_REJECTED)).toBe(true)
    expect(rejects[0]).toMatchObject({ data: { code: 'ERR_INTERNAL' }, requestId: 'bid-sign-0' })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects BID_PLACE when socket is not open', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.placeBid({ amountCents: 1200, clientBidId: 'bid-1' })

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-1',
    })
  })

  it('rejects BID_PLACE when clientBidId is missing', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: '1200' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: undefined,
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects BID_PLACE with blank clientBidId', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: '1200', clientBidId: '   ' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects BID_PLACE with whitespace in clientBidId', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: '1200', clientBidId: 'bid id with space' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects BID_PLACE with too long clientBidId', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: '1200', clientBidId: 'a'.repeat(129) })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('rejects BID_PLACE with control-whitespace clientBidId', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.placeBid({ amountCents: '1200', clientBidId: '\t\n' })
    client.leave()

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      data: { code: 'ERR_INTERNAL' },
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('accepts max-length clientBidId', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    const clientBidId = 'b'.repeat(128)
    client.placeBid({ amountCents: '1200', clientBidId })
    client.leave()

    expect(rejects).toHaveLength(0)
    expect(ws.sent).toHaveLength(2)
    expect(JSON.parse(ws.sent[1])).toMatchObject({
      type: 'BID_PLACE',
      data: {
        amountCents: '1200',
        clientBidId,
      },
    })
  })

  it('hard-stops on schema mismatch', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
        type: EventType.ROOM_SNAPSHOT,
        auctionId: 'auc1',
      }),
    })

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: CURRENT_SCHEMA_VERSION + 1,
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(states.some((s) => s.status === ConnStatus.RECONNECTING)).toBe(false)
    expect(ws.closeCalls).toBeGreaterThan(0)
    client.leave()
  })

  it('hard-stops on schema mismatch even when type is missing', () => {
    const states = []
    const warns = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args))

    try {
      client.connect()
      const ws = latestSocket()
      ws.onopen()

      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION + 1,
          auctionId: 'auc1',
        }),
      })

      expect(states).toContainEqual({
        status: ConnStatus.SCHEMA,
        server: CURRENT_SCHEMA_VERSION + 1,
        client: CURRENT_SCHEMA_VERSION,
      })
      expect(states.some((s) => s.status === ConnStatus.RECONNECTING)).toBe(false)
      expect(warns).toHaveLength(0)
      expect(ws.closeCalls).toBeGreaterThan(0)
      client.leave()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('hard-stops when schemaVersion is missing', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        type: EventType.ROOM_STATE_PATCH,
        auctionId: 'auc1',
      }),
    })

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: undefined,
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(ws.closeCalls).toBeGreaterThan(0)
  })

  it('hard-stops on non-numeric schemaVersion', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: '1',
        type: EventType.ROOM_SNAPSHOT,
        auctionId: 'auc1',
      }),
    })

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: '1',
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(ws.closeCalls).toBeGreaterThan(0)
  })

  it('hard-stops on boolean schemaVersion', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: true,
        type: EventType.ROOM_STATE_PATCH,
        auctionId: 'auc1',
      }),
    })

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: true,
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(ws.closeCalls).toBeGreaterThan(0)
  })

  it('hard-stops on negative schemaVersion', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: -1,
        type: EventType.ROOM_STATE_PATCH,
        auctionId: 'auc1',
      }),
    })

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: -1,
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(ws.closeCalls).toBeGreaterThan(0)
  })

  it('hard-stops on fractional schemaVersion', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: 1.5,
        type: EventType.ROOM_STATE_PATCH,
        auctionId: 'auc1',
      }),
    })

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: 1.5,
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(ws.closeCalls).toBeGreaterThan(0)
  })

  it('hard-stops on null schemaVersion', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: null,
        type: EventType.ROOM_SNAPSHOT,
        auctionId: 'auc1',
      }),
    })

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: null,
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(ws.closeCalls).toBeGreaterThan(0)
  })

  it('cannot reconnect manually after schema mismatch is marked dead', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
        type: EventType.ROOM_SNAPSHOT,
        auctionId: 'auc1',
      }),
    })

    const connectCalls = states.filter((s) => s.status === ConnStatus.CONNECTING).length
    client.connect()

    expect(connectCalls).toBe(1)
    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: CURRENT_SCHEMA_VERSION + 1,
      client: CURRENT_SCHEMA_VERSION,
    })
  })

  it('no-ops resync when client is dead', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
        type: EventType.ROOM_SNAPSHOT,
        auctionId: 'auc1',
      }),
    })

    client.resync()

    expect(states).toContainEqual({
      status: ConnStatus.SCHEMA,
      server: CURRENT_SCHEMA_VERSION + 1,
      client: CURRENT_SCHEMA_VERSION,
    })
    expect(latestSocket()).toBe(ws)
  })

  it('ignores follow-up messages once schema mismatch marks client dead', () => {
    const events = []
    const states = []
    const warns = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onEvent: (env) => events.push(env),
      onState: (s) => states.push(s),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args))

    try {
      client.connect()
      const ws = latestSocket()
      ws.onopen()

      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION + 1,
          type: EventType.ROOM_SNAPSHOT,
          auctionId: 'auc1',
        }),
      })
      ws.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: EventType.ROOM_STATE_PATCH,
          auctionId: 'auc1',
          data: { status: 'LIVE' },
        }),
      })

      expect(states).toContainEqual({
        status: ConnStatus.SCHEMA,
        server: CURRENT_SCHEMA_VERSION + 1,
        client: CURRENT_SCHEMA_VERSION,
      })
      expect(states).not.toContainEqual({ status: ConnStatus.OPEN })
      expect(events).toHaveLength(0)
      expect(warns).toHaveLength(0)
      expect(ws.sent).toHaveLength(1)
      client.leave()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not reconnect after leave when socket closes', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    latestSocket().onopen()
    client.leave()

    expect(states).not.toContainEqual({ status: ConnStatus.RECONNECTING })
  })

  it('does not create a new socket after leave', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.leave()

    client.connect()
    expect(latestSocket()).toBe(ws)
  })

  it('does not report CONNECTING after leave', () => {
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: (s) => states.push(s),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.leave()

    const before = states.length
    client.connect()
    expect(states).toHaveLength(before)
    expect(latestSocket()).toBe(ws)
  })

  it('does not reconnect when resync is called after leave', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.leave()
    client.resync()

    expect(latestSocket()).toBe(ws)
  })

  it('does not create a new socket when leave and resync overlap', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onState: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()

    client.resync()
    client.leave()
    client.resync()
    client.connect()

    expect(latestSocket()).toBe(ws)
  })

  it('rejects BID_PLACE after leave', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.leave()
    client.placeBid({ amountCents: '1200', clientBidId: 'bid-after-leave' })

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
      requestId: 'bid-after-leave',
    })
  })

  it('does not call ws.send for BID_PLACE after leave', () => {
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: () => {},
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    client.leave()
    client.placeBid({ amountCents: '1200', clientBidId: 'bid-after-leave-2' })

    expect(ws.sent).toHaveLength(1)
  })

  it('does not send BID_PLACE after schema mismatch hard-stop', () => {
    const rejects = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      onReject: (env) => rejects.push(env),
    })

    client.connect()
    const ws = latestSocket()
    ws.onopen()
    ws.onmessage({
      data: JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
        type: EventType.ROOM_SNAPSHOT,
        auctionId: 'auc1',
      }),
    })
    client.placeBid({ amountCents: '1200', clientBidId: 'bid-after-schema-mismatch' })

    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toMatchObject({
      type: EventType.BID_REJECTED,
      data: { code: 'ERR_INTERNAL' },
    })
    expect(ws.sent).toHaveLength(1)
  })

  it('reconnects with latest lastSeq after resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      const ws1 = latestSocket()
      ws1.onopen()
      expect(states).toContainEqual(expect.objectContaining({ status: ConnStatus.CONNECTING }))
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = 42
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      expect(ws2).not.toBe(ws1)
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1', lastSeq: 42 })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 42 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it.each([
    ['number', 42, 42],
    ['numeric string', '42', 42],
    ['leading-zero numeric string', '007', 7],
    ['bigint', 42n, 42],
    ['zero bigint', 0n, 0],
    ['plus numeric string', '+42', 0],
    ['scientific numeric string', '1e3', 0],
    ['negative numeric string', '-1', 0],
    ['infinity', Infinity, 0],
    ['negative infinity', -Infinity, 0],
    ['infinity string', 'Infinity', 0],
    ['negative infinity string', '-Infinity', 0],
    ['NaN string', 'NaN', 0],
    ['symbol', Symbol('lastSeq'), 0],
    ['zero string', '0', 0],
    ['overflow numeric string', String(Number.MAX_SAFE_INTEGER + 1), 0],
    ['non-integer numeric string', '12.0', 0],
    ['blank string', '  12 ', 0],
    ['negative bigint', -1n, 0],
    ['overflow bigint', BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0],
    ['null', null, 0],
    ['NaN', Number.NaN, 0],
    ['number object', new Number(42), 0],
    ['string object', new String('42'), 0],
    ['bigint object', Object(42n), 0],
    ['boolean object', new Boolean(false), 0],
    ['object', { value: 42 }, 0],
    ['array', [42], 0],
  ])('normalizes lastSeq %s consistently for ROOM_JOIN and resync', (_, value, expectedLastSeq) => {
    vi.useFakeTimers()

    const states = []
    const getLastSeq = () => value
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      const ws1 = latestSocket()
      ws1.onopen()

      const env1 = JSON.parse(ws1.sent[0])
      expect(env1.type).toBe(ClientFrameType.ROOM_JOIN)
      if (expectedLastSeq > 0) {
        expect(env1.data).toEqual({ auctionId: 'auc1', lastSeq: expectedLastSeq })
      } else {
        expect(env1.data).toEqual({ auctionId: 'auc1' })
      }
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: expectedLastSeq })

      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env2 = JSON.parse(ws2.sent[0])
      expect(env2.type).toBe(ClientFrameType.ROOM_JOIN)
      if (expectedLastSeq > 0) {
        expect(env2.data).toEqual({ auctionId: 'auc1', lastSeq: expectedLastSeq })
      } else {
        expect(env2.data).toEqual({ auctionId: 'auc1' })
      }
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: expectedLastSeq })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('recovers to valid lastSeq if value changes after an invalid resync input', () => {
    vi.useFakeTimers()

    let lastSeq = new Number(12)
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(200)
      lastSeq = 99

      vi.advanceTimersByTime(900)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1', lastSeq: 99 })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 99 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('recovers from transient getLastSeq error on reconnect', () => {
    vi.useFakeTimers()

    let first = true
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => {
        if (first) {
          first = false
          throw new Error('transient read')
        }
        return 77
      },
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      const ws1 = latestSocket()
      ws1.onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1', lastSeq: 77 })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 77 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes invalid lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = '12.0'
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes null lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = null
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes whitespace-only lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = '   '
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes zero-string lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = '0'
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes symbol lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = Symbol('resyncLastSeq')
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes array lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = [42]
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes object lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = { value: 42 }
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes Number object lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = new Number(42)
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes String object lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = new String('42')
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes BigInt object lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = Object(42n)
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes Boolean object lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = new Boolean(true)
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes undefined lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('normalizes NaN lastSeq when reconnecting through resync', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      lastSeq = Number.NaN
      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('fallbacks lastSeq to 0 on resync when getLastSeq throws', () => {
    vi.useFakeTimers()

    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => {
        throw new Error('getLastSeq failed')
      },
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      const ws1 = latestSocket()
      ws1.onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })

      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })
      vi.advanceTimersByTime(1100)

      const ws2 = latestSocket()
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1' })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 0 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it.each([
    ['fractional', 1.5],
    ['negative', -1],
    ['zero', 0],
    ['string', '1'],
    ['boolean', true],
    ['null', null],
  ])('enters schema-stop state if resynced connection receives %s schemaVersion', (_, schemaVersion) => {
    vi.useFakeTimers()

    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => 42,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()

      client.resync()
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 1000 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      expect(states).toContainEqual(expect.objectContaining({ status: ConnStatus.CONNECTING }))
      ws2.onopen()
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 42 })
      ws2.onmessage({
        data: JSON.stringify({
          schemaVersion,
          type: EventType.ROOM_STATE_PATCH,
          auctionId: 'auc1',
        }),
      })

      expect(states).toContainEqual({
        status: ConnStatus.SCHEMA,
        server: schemaVersion,
        client: CURRENT_SCHEMA_VERSION,
      })
      expect(states).toContainEqual(expect.objectContaining({ status: ConnStatus.SYNCING, lastSeq: 42 }))
      expect(ws2.closeCalls).toBeGreaterThan(0)
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('enters schema-stop state if resynced connection has missing schemaVersion', () => {
    vi.useFakeTimers()

    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => 42,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      client.resync()
      vi.advanceTimersByTime(1100)

      const ws2 = latestSocket()
      ws2.onopen()
      ws2.onmessage({
        data: JSON.stringify({
          type: EventType.ROOM_STATE_PATCH,
          auctionId: 'auc1',
        }),
      })

      expect(states).toContainEqual({
        status: ConnStatus.SCHEMA,
        server: undefined,
        client: CURRENT_SCHEMA_VERSION,
      })
      expect(ws2.closeCalls).toBeGreaterThan(0)
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })

  it('enters schema-stop state if resynced connection has empty-string schemaVersion', () => {
    vi.useFakeTimers()

    const states = []
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => 42,
      onState: (s) => states.push(s),
    })

    try {
      client.connect()
      latestSocket().onopen()
      client.resync()
      vi.advanceTimersByTime(1100)

      const ws2 = latestSocket()
      ws2.onopen()
      ws2.onmessage({
        data: JSON.stringify({
          schemaVersion: '',
          type: EventType.ROOM_STATE_PATCH,
          auctionId: 'auc1',
        }),
      })

      expect(states).toContainEqual({
        status: ConnStatus.SCHEMA,
        server: '',
        client: CURRENT_SCHEMA_VERSION,
      })
      expect(ws2.closeCalls).toBeGreaterThan(0)
    } finally {
      client.leave()
      vi.useRealTimers()
    }
  })
})
