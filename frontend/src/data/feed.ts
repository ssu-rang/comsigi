import { useEffect, useRef, useState } from "react"
import type { ConnectionState, Seat, SeatSource } from "./types"

/** Data older than this is shown as delayed (≈3 missed updates at 3 s). */
export const STALE_AFTER_MS = 10_000

export type Freshness = "connecting" | "live" | "stale" | "offline"

export interface SeatCounts {
  total: number
  available: number
  occupied: number
  unknown: number
  /** occupied ÷ seats with a reliable reading; null if none are readable. */
  utilization: number | null
}

export function countSeats(seats: Seat[]): SeatCounts {
  let available = 0
  let occupied = 0
  let unknown = 0
  for (const s of seats) {
    if (s.status === "available") available++
    else if (s.status === "occupied") occupied++
    else unknown++
  }
  const known = available + occupied
  return {
    total: seats.length,
    available,
    occupied,
    unknown,
    utilization: known ? Math.round((occupied / known) * 100) : null,
  }
}

export function getFreshness(
  connection: ConnectionState,
  receivedAt: number | null,
  now: number,
): Freshness {
  if (connection === "closed") return "offline"
  if (receivedAt === null) return "connecting"
  if (now - receivedAt > STALE_AFTER_MS) return "stale"
  return "live"
}

export function useSeatFeed(source: SeatSource) {
  const [seats, setSeats] = useState<Seat[]>([])
  const [receivedAt, setReceivedAt] = useState<number | null>(null)
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const [changed, setChanged] = useState<{ ids: Set<number>; version: number }>({
    ids: new Set(),
    version: 0,
  })
  const prev = useRef<Map<number, Seat["status"]>>(new Map())

  useEffect(() => {
    return source.start({
      onConnection: setConnection,
      onSnapshot: (snap) => {
        const ids = new Set<number>()
        // Only highlight changes when the seat set itself is the same.
        if (prev.current.size === snap.seats.length) {
          for (const s of snap.seats)
            if (prev.current.get(s.id) !== s.status) ids.add(s.id)
        }
        prev.current = new Map(snap.seats.map((s) => [s.id, s.status]))
        setSeats(snap.seats)
        setReceivedAt(snap.receivedAt)
        setChanged((c) => ({ ids, version: c.version + 1 }))
      },
    })
  }, [source])

  return { seats, receivedAt, connection, changed }
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function formatClock(ms: number) {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":")
}

export function formatAge(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 5) return "방금"
  if (s < 60) return `${s}초 전`
  const m = Math.floor(s / 60)
  return `${m}분 ${s % 60}초 전`
}
