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

  it('forwards ROOM_STATE_PATCH envelopes to onEvent', () => {
    const events = []
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
        type: EventType.ROOM_STATE_PATCH,
        auctionId: 'auc1',
        seq: 12,
        serverTimeMs: Date.now(),
        data: { currentPriceCents: '12000000', winnerId: 'u2' },
      }),
    })
    client.leave()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: EventType.ROOM_STATE_PATCH, seq: 12 })
  })

  it('uses ROOM_STATE_PATCH seq as the reconnect high-watermark', () => {
    vi.useFakeTimers()

    let lastSeq = 0
    const client = new RoomClient({
      url: 'ws://localhost:8080/ws',
      auctionId: 'auc1',
      getLastSeq: () => lastSeq,
      onEvent: (env) => { if (env.seq != null) lastSeq = Math.max(lastSeq, env.seq) },
    })

    try {
      client.connect()
      const ws1 = latestSocket()
      ws1.onopen()

      ws1.onmessage({
        data: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          type: EventType.ROOM_STATE_PATCH,
          auctionId: 'auc1',
          seq: 100,
          serverTimeMs: Date.now(),
          data: { fromSeq: 1, currentPriceCents: '12000000', bidCountTotal: 100 },
        }),
      })
      ws1.onclose({ code: 1006, reason: 'drop' })
      vi.advanceTimersByTime(1100)

      const ws2 = latestSocket()
      expect(ws2).not.toBe(ws1)
      ws2.onopen()
      const join = JSON.parse(ws2.sent[0])
      expect(join.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(join.data).toEqual({ auctionId: 'auc1', lastSeq: 100 })
    } finally {
      client.leave()
      vi.useRealTimers()
    }
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
    expect(ws.closeCalls).toBeGreaterThan(0)
    client.leave()
  })

  it('reconnects with latest lastSeq after resync', () => {
    vi.useFakeTimers()
    // Backoff is full-jitter (delay = round(random() * cap)); pin random so the
    // asserted backoff is deterministic. attempts=1 -> cap=min(8000,500*2)=1000,
    // delay=round(0.5*1000)=500.
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)

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
      expect(states).toContainEqual({ status: ConnStatus.RECONNECTING, attempts: 1, backoff: 500 })

      vi.advanceTimersByTime(1100)
      const ws2 = latestSocket()
      expect(ws2).not.toBe(ws1)
      ws2.onopen()

      const env = JSON.parse(ws2.sent[0])
      expect(env.type).toBe(ClientFrameType.ROOM_JOIN)
      expect(env.data).toEqual({ auctionId: 'auc1', lastSeq: 42 })
      expect(states).toContainEqual({ status: ConnStatus.SYNCING, lastSeq: 42 })
    } finally {
      randSpy.mockRestore()
      client.leave()
      vi.useRealTimers()
    }
  })

  it('full-jitter backoff stays within [0, cap] and spreads (anti thundering-herd)', () => {
    vi.useFakeTimers()
    try {
      // attempts=1 -> cap=1000. Random at the extremes must clamp to [0, cap];
      // distinct random draws must yield distinct delays (i.e. it is jittered,
      // not a constant) so a mass reconnect does not arrive in one lockstep wave.
      const delays = new Set()
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const randSpy = vi.spyOn(Math, 'random').mockReturnValue(r)
        const states = []
        const client = new RoomClient({
          url: 'ws://localhost:8080/ws',
          auctionId: 'aucJ',
          getLastSeq: () => 0,
          onState: (s) => states.push(s),
        })
        client.connect()
        latestSocket().onopen()
        client.resync()
        const rc = states.find((s) => s.status === ConnStatus.RECONNECTING)
        expect(rc.backoff).toBeGreaterThanOrEqual(0)
        expect(rc.backoff).toBeLessThanOrEqual(1000)
        delays.add(rc.backoff)
        client.leave()
        randSpy.mockRestore()
      }
      expect(delays.size).toBeGreaterThan(1) // jittered, not a fixed value
    } finally {
      vi.useRealTimers()
    }
  })
})
