// Contract between any seat data source (mock, HTTP polling, WebSocket from the
// Arduino/camera gateway) and the UI. The UI only ever consumes these types.

export type SeatStatus = "available" | "occupied" | "unknown"

export interface Seat {
  id: number
  status: SeatStatus
}

export interface SeatSnapshot {
  seats: Seat[]
  /** Time the snapshot was produced by the sensor gateway (epoch ms). */
  receivedAt: number
}

export type ConnectionState = "connecting" | "open" | "closed"

export interface SeatSourceHandlers {
  onSnapshot(snapshot: SeatSnapshot): void
  onConnection(state: ConnectionState): void
}

export interface SeatSource {
  /** Starts receiving data. Returns a function that stops the source. */
  start(handlers: SeatSourceHandlers): () => void
}
