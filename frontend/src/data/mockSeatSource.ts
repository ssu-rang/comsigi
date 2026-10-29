import type { Seat, SeatSource, SeatSourceHandlers, SeatStatus } from "./types"

/**
 * Simulated sensor feed for the mockup.
 * - live:    emits a snapshot every `intervalMs` with a few seats changed
 * - stalled: connection stays open but no new data arrives (gateway hang)
 * - offline: connection is closed
 */
export type MockMode = "live" | "stalled" | "offline"

const TARGET_OCCUPANCY = 0.55

function createSeats(count: number): Seat[] {
  return Array.from({ length: count }, (_, i) => {
    const r = Math.random()
    const status: SeatStatus =
      r < 0.04
        ? "unknown"
        : r < 0.04 + TARGET_OCCUPANCY
          ? "occupied"
          : "available"
    return { id: i + 1, status }
  })
}

export class MockSeatSource implements SeatSource {
  private seats: Seat[]
  private mode: MockMode = "live"
  private handlers: SeatSourceHandlers | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    seatCount: number,
    readonly intervalMs = 3000,
  ) {
    this.seats = createSeats(seatCount)
  }

  start(handlers: SeatSourceHandlers) {
    this.handlers = handlers
    this.connect()
    this.tickTimer = setInterval(() => this.tick(), this.intervalMs)
    return () => {
      if (this.tickTimer) clearInterval(this.tickTimer)
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.handlers = null
    }
  }

  setMode(mode: MockMode) {
    const prev = this.mode
    this.mode = mode
    if (mode === "offline") this.handlers?.onConnection("closed")
    else if (prev === "offline") this.connect()
    else if (mode === "live") this.emit()
  }

  setSeatCount(count: number) {
    this.seats = createSeats(count)
    if (this.mode === "live") this.emit()
  }

  private connect() {
    this.handlers?.onConnection("connecting")
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => {
      if (this.mode === "offline") return
      this.handlers?.onConnection("open")
      if (this.mode === "live") this.emit()
    }, 700)
  }

  private tick() {
    if (this.mode !== "live") return
    this.mutate()
    this.emit()
  }

  private mutate() {
    const changes = 1 + Math.floor(Math.random() * 3)
    const occupied = this.seats.filter((s) => s.status === "occupied").length
    // Drift back toward the target occupancy so the demo stays realistic.
    const pOccupy = Math.min(
      0.9,
      Math.max(0.1, 0.5 + (TARGET_OCCUPANCY - occupied / this.seats.length)),
    )
    for (let n = 0; n < changes; n++) {
      const seat = this.seats[Math.floor(Math.random() * this.seats.length)]
      if (Math.random() < 0.04) {
        seat.status = "unknown"
      } else if (seat.status === "unknown") {
        seat.status = Math.random() < pOccupy ? "occupied" : "available"
      } else if (seat.status === "available" && Math.random() < pOccupy) {
        seat.status = "occupied"
      } else if (seat.status === "occupied" && Math.random() > pOccupy) {
        seat.status = "available"
      }
    }
  }

  private emit() {
    this.handlers?.onSnapshot({
      seats: this.seats.map((s) => ({ ...s })),
      receivedAt: Date.now(),
    })
  }
}
