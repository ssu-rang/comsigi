import type { SeatSource, SeatStatus } from "./types"

/**
 * Example adapter for the real Arduino/camera gateway (not used by the mockup).
 * Expects GET `url` to return: { seats: [{ id: number, status: "available" | "occupied" | "unknown" }], updatedAt?: string }
 * Swap `new MockSeatSource(...)` in App.tsx for `new HttpSeatSource("/api/seats")`.
 */
export class HttpSeatSource implements SeatSource {
  constructor(
    private url: string,
    private intervalMs = 3000,
  ) {}

  start({ onSnapshot, onConnection }: Parameters<SeatSource["start"]>[0]) {
    let stopped = false
    onConnection("connecting")

    const poll = async () => {
      try {
        const res = await fetch(this.url, { cache: "no-store" })
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json()
        if (stopped) return
        onConnection("open")
        onSnapshot({
          seats: body.seats.map((s: { id: number; status: string }) => ({
            id: s.id,
            status: (["available", "occupied"].includes(s.status)
              ? s.status
              : "unknown") as SeatStatus,
          })),
          receivedAt: body.updatedAt ? Date.parse(body.updatedAt) : Date.now(),
        })
      } catch {
        if (!stopped) onConnection("closed")
      }
    }

    poll()
    const timer = setInterval(poll, this.intervalMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
