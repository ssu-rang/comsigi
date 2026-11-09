import type {
  Id,
  Layout,
  LinkState,
  LiveEvent,
  LiveSink,
  Occupancy,
} from "./domain"

export type LiveState = {
  streamId: string | null
  version: number
  revision: number
  occupancy: Occupancy
  staleAfterMs: number
  synced: boolean
}
export const initialLive = (): LiveState => ({
  streamId: null,
  version: -1,
  revision: -1,
  occupancy: {},
  staleAfterMs: 0,
  synced: false,
})
export function applyEvent(
  state: LiveState,
  event: LiveEvent,
): {
  state: LiveState
  resync: boolean
} {
  if (event.type === "snapshot") {
    if (
      event.incremental &&
      (!state.synced ||
        state.streamId !== event.streamId ||
        event.version > state.version + 1)
    )
      return { state, resync: true }
    if (state.streamId === event.streamId && event.version < state.version)
      return { state, resync: false }
    if (
      !Number.isSafeInteger(event.version) ||
      event.version < 0 ||
      event.staleAfterMs <= 0
    )
      return { state, resync: true }
    return {
      state: {
        streamId: event.streamId,
        version: event.version,
        revision: event.revision,
        occupancy: event.seats,
        staleAfterMs: event.staleAfterMs,
        synced: true,
      },
      resync: false,
    }
  }
  if (event.type === "place_deleted" && event.streamId !== undefined)
    return {
      state,
      resync:
        !state.synced ||
        event.streamId !== state.streamId ||
        event.version !== state.version + 1,
    }
  if (event.type !== "seat_update") return { state, resync: false }
  if (!state.synced || event.streamId !== state.streamId)
    return { state, resync: true }
  if (event.version <= state.version) return { state, resync: false }
  if (event.version !== state.version + 1)
    return { state: { ...state, synced: false }, resync: true }
  return {
    state: {
      ...state,
      version: event.version,
      revision: event.revision ?? state.revision,
      occupancy: { ...state.occupancy, ...event.changes },
    },
    resync: false,
  }
}
export function visibleSeats(
  layout: Layout,
  live: LiveState,
  connection: LinkState,
  now: number,
) {
  return layout.seats.map((seat) => {
    const reading = live.occupancy[seat.id]
    const time = reading?.observedAt ? Date.parse(reading.observedAt) : NaN
    const fresh =
      connection === "live" &&
      live.synced &&
      live.revision === layout.revision &&
      !!reading &&
      (live.staleAfterMs === Infinity ||
        (Number.isFinite(time) && now - time <= live.staleAfterMs))
    return {
      ...seat,
      status: fresh ? reading.status : "unknown" as const,
      observedAt: reading?.observedAt ?? null,
      fresh,
    }
  })
}

export type SocketLike = {
  readyState: number
  close: () => void
  send: (data: string) => void
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
}
export type SocketContract = {
  url: string | (() => Promise<string | null>)
  // REQUIRED verified backend decoder. We do not assume the example JSON protocol.
  decode: (data: unknown) => LiveEvent | "heartbeat" | null
  createSocket?: (url: string) => SocketLike
  heartbeat?: {
    intervalMs: number
    payload: string
  }
  silenceTimeoutMs?: number
  random?: () => number
}
export function secureSocketUrl(url: string, pageProtocol: string): string {
  const parsed = new URL(url)
  if (!["ws:", "wss:"].includes(parsed.protocol))
    throw new Error("WebSocket URL must use ws or wss.")
  if (pageProtocol === "https:" && parsed.protocol !== "wss:")
    throw new Error("HTTPS에서는 WSS 연결이 필요합니다.")
  return parsed.href
}
export const retryDelay = (attempt: number, random = Math.random()) =>
  Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + random * 0.4)
// Every reconnect requires a full snapshot before any incremental events.
export function connectSocket(
  placeId: Id,
  contract: SocketContract,
  sink: LiveSink,
): () => void {
  let stopped = false,
    attempt = 0,
    socket: SocketLike | null = null
  let state = initialLive(),
    generation = 0,
    lastMessage = Date.now()
  let retry: ReturnType<typeof setTimeout>,
    watchdog: ReturnType<typeof setInterval> | undefined
  const clearWatchdog = () => {
    if (watchdog) clearInterval(watchdog)
  }
  const schedule = () => {
    clearWatchdog()
    if (stopped) return
    sink.connection("reconnecting")
    retry = setTimeout(start, retryDelay(attempt++, contract.random?.()))
  }
  const start = async () => {
    if (stopped) return
    const current = ++generation
    state = initialLive()
    lastMessage = Date.now()
    sink.connection(attempt ? "reconnecting" : "connecting")
    try {
      const url =
        typeof contract.url === "function" ? await contract.url() : contract.url
      if (stopped || current !== generation) return
      if (url === null) {
        stopped = true
        sink.event({ type: "place_deleted", placeId })
        sink.connection("offline")
        return
      }
      socket = (contract.createSocket ?? ((url) => new WebSocket(url)))(
        secureSocketUrl(url, globalThis.location?.protocol ?? "http:"),
      )
    } catch {
      if (stopped || current !== generation) return
      schedule()
      return
    }
    const active = socket
    const fail = () => {
      if (current !== generation || stopped) return
      ++generation
      active.close()
      schedule()
    }
    active.onopen = () => {
      if (current === generation && !stopped) sink.connection("syncing")
    }
    active.onmessage = (message) => {
      if (stopped || current !== generation) return
      try {
        const event = contract.decode(message.data)
        if (!event) return
        lastMessage = Date.now()
        if (event === "heartbeat") return
        if (event.placeId !== placeId) return
        const result = applyEvent(state, event)
        if (result.resync) {
          fail()
          return
        }
        if (
          result.state === state &&
          (event.type === "seat_update" || event.type === "snapshot")
        )
          return
        state = result.state
        sink.event(event)
        if (event.type === "place_deleted") {
          stopped = true
          ++generation
          clearWatchdog()
          active.close()
          sink.connection("offline")
          return
        }
        if (event.type === "snapshot") {
          attempt = 0
          sink.connection("live")
        }
      } catch {
        fail()
      }
    }
    active.onclose = fail
    active.onerror = fail
    const started = Date.now()
    let lastPing = started
    watchdog = setInterval(() => {
      if (!state.synced && Date.now() - started > 10000) {
        fail()
        return
      }
      if (
        contract.silenceTimeoutMs &&
        Date.now() - lastMessage > contract.silenceTimeoutMs
      ) {
        fail()
        return
      }
      if (
        contract.heartbeat &&
        active.readyState === 1 &&
        Date.now() - lastPing >= contract.heartbeat.intervalMs
      ) {
        try {
          active.send(contract.heartbeat.payload)
          lastPing = Date.now()
        } catch {
          fail()
        }
      }
    }, 1000)
  }
  // Deferred start means StrictMode's first setup/cleanup never opens a socket.
  retry = setTimeout(start, 0)
  return () => {
    stopped = true
    ++generation
    clearTimeout(retry)
    clearWatchdog()
    socket?.close()
  }
}
