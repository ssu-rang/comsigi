import { useEffect, useState } from "react"

export type SeatStatus = "available" | "occupied" | "unknown"
export interface Seat {
  id: number
  status: SeatStatus
}

const SEATS_URL = import.meta.env?.VITE_SEATS_API_URL || "/api/v1/seats"
const POLL_INTERVAL_MS = 3000
const REQUEST_TIMEOUT_MS = 10000

export async function fetchSeats(url: string, signal: AbortSignal): Promise<Seat[]> {
  const response = await fetch(url, { signal, cache: "no-store" })
  if (!response.ok) throw new Error(`Seat request failed: ${response.status}`)

  const body: unknown = await response.json()
  if (!body || typeof body !== "object" || !("seats" in body) || !Array.isArray(body.seats)) {
    throw new Error("Invalid seat response")
  }

  const ids = new Set<number>()
  const seats = body.seats.map((value: unknown): Seat => {
    if (!value || typeof value !== "object" || !("id" in value)
      || typeof value.id !== "number" || !Number.isSafeInteger(value.id)
      || value.id <= 0 || ids.has(value.id)) {
      throw new Error("Invalid or duplicate seat ID")
    }
    ids.add(value.id)
    const status = "status" in value ? value.status : undefined
    return {
      id: value.id,
      status: status === "available" || status === "occupied" ? status : "unknown",
    }
  })
  return seats.sort((a, b) => a.id - b.id)
}

export function countSeats(seats: readonly Seat[]) {
  const counts = { available: 0, occupied: 0, unknown: 0 }
  for (const seat of seats) counts[seat.status] += 1
  const knownSeats = counts.available + counts.occupied
  return {
    ...counts,
    total: seats.length,
    utilization: knownSeats > 0 ? Math.round((counts.occupied / knownSeats) * 100) : null,
  }
}

export function useSeats(url = SEATS_URL) {
  const [seats, setSeats] = useState<Seat[] | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    setSeats(null)
    setStatus("loading")

    async function poll() {
      controller = new AbortController()
      const request = controller
      const timeout = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS)
      try {
        const nextSeats = await fetchSeats(url, request.signal)
        if (stopped) return
        setSeats(nextSeats)
        setStatus("ready")
      } catch {
        if (stopped) return
        // A failed refresh must not leave old availability on screen.
        setSeats(null)
        setStatus("error")
      } finally {
        clearTimeout(timeout)
        if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      controller?.abort()
    }
  }, [url])

  return { seats, status }
}
