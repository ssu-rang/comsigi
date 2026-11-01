import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyEvent,
  connectSocket,
  initialLive,
  retryDelay,
  secureSocketUrl,
  visibleSeats,
  type SocketLike,
} from "./realtime.ts"
import type { Layout, LiveEvent, LinkState } from "./domain.ts"

const snapshot: LiveEvent = {
  type: "snapshot",
  placeId: "p",
  streamId: "epoch-a",
  version: 10,
  revision: 3,
  staleAfterMs: 30000,
  seats: {
    a: { status: "available", observedAt: new Date(100000).toISOString() },
    b: { status: "occupied", observedAt: new Date(100000).toISOString() },
  },
}
test("snapshot, incremental updates, duplicate, old events, gaps and server restart", () => {
  const initial = applyEvent(initialLive(), snapshot).state
  const update: LiveEvent = {
    type: "seat_update",
    placeId: "p",
    streamId: "epoch-a",
    version: 11,
    changes: {
      a: { status: "occupied", observedAt: new Date(100001).toISOString() },
    },
  }
  const next = applyEvent(initial, update).state
  assert.equal(next.occupancy.a.status, "occupied")
  assert.equal(next.occupancy.b, initial.occupancy.b)
  assert.equal(applyEvent(next, update).state, next)
  assert.equal(applyEvent(next, { ...update, version: 9 }).state, next)
  assert.equal(applyEvent(next, { ...update, version: 13 }).resync, true)
  assert.equal(
    applyEvent(next, { ...update, streamId: "epoch-b" }).resync,
    true,
  )
  assert.equal(applyEvent(initialLive(), update).resync, true)
  assert.equal(
    applyEvent(next, {
      ...snapshot,
      streamId: "epoch-b",
      version: 0,
      seats: {},
    }).state.version,
    0,
  )
})
test("unknown is used for disconnected, stale, and never-observed seats without corrupting stored readings", () => {
  const layout: Layout = {
    placeId: "p",
    revision: 3,
    canvasWidth: 1000,
    canvasHeight: 700,
    tables: [],
    seats: ["a", "b", "c"].map((id, i) => ({
      id,
      number: i + 1,
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      rotation: 0,
      tableId: null,
    })),
  }
  const state = applyEvent(initialLive(), snapshot).state
  assert.deepEqual(
    visibleSeats(layout, state, "live", 100000).map((s) => s.status),
    ["available", "occupied", "unknown"],
  )
  assert.ok(
    visibleSeats(layout, state, "reconnecting", 100000).every(
      (s) => s.status === "unknown",
    ),
  )
  assert.ok(
    visibleSeats(layout, state, "live", 130001).every(
      (s) => s.status === "unknown",
    ),
  )
  assert.equal(state.occupancy.a.status, "available")
})
test("retry backoff is bounded and HTTPS refuses insecure sockets", () => {
  assert.equal(retryDelay(0, 0.5), 1000)
  assert.equal(retryDelay(4, 0.5), 16000)
  assert.equal(retryDelay(100, 0.5), 30000)
  assert.throws(() => secureSocketUrl("ws://localhost/ws", "https:"), /WSS/)
  assert.throws(() => secureSocketUrl("https://localhost", "https:"))
  assert.equal(
    secureSocketUrl("wss://localhost/ws", "https:"),
    "wss://localhost/ws",
  )
})
test("StrictMode cleanup cancels a pending connection, reconnect needs snapshot, cleanup closes sockets", (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 100000,
  })
  const sockets: SocketLike[] = [],
    states: LinkState[] = [],
    events: LiveEvent[] = []
  function createSocket(): SocketLike {
    const socket: SocketLike = {
      readyState: 1,
      close() {
        socket.onclose?.({} as CloseEvent)
      },
      send() {},
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
    }
    sockets.push(socket)
    return socket
  }
  const sink = {
    connection: (state: LinkState) => states.push(state),
    event: (e: LiveEvent) => events.push(e),
  }
  const options = {
    url: "ws://localhost/ws",
    decode: (d: unknown) => JSON.parse(String(d)) as LiveEvent,
    createSocket,
    random: () => 0.5,
  }
  const stopped = connectSocket("p", options, sink)
  stopped()
  t.mock.timers.tick(1)
  assert.equal(sockets.length, 0)
  const stop = connectSocket("p", options, sink)
  t.mock.timers.tick(1)
  assert.equal(sockets.length, 1)
  sockets[0].onopen?.({} as Event)
  sockets[0].onmessage?.({ data: JSON.stringify(snapshot) } as MessageEvent)
  assert.equal(states[states.length - 1], "live")
  assert.equal(events.length, 1)
  sockets[0].onmessage?.({
    data: JSON.stringify({
      type: "seat_update",
      placeId: "p",
      streamId: "epoch-a",
      version: 12,
      changes: {},
    }),
  } as MessageEvent)
  assert.equal(states[states.length - 1], "reconnecting")
  t.mock.timers.tick(999)
  assert.equal(sockets.length, 1)
  t.mock.timers.tick(1)
  assert.equal(sockets.length, 2)
  stop()
  t.mock.timers.tick(60000)
  assert.equal(sockets.length, 2)
})
