// Frontend domain model. This is NOT a claim about an implemented backend schema.
// A future backend adapter must explicitly map its verified contract to these types.
import type { SeatStatus } from "./seats"

export type Id = string
export type Geometry = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}
export type LayoutSeat = Geometry & {
  id: Id
  number: number
  tableId: Id | null
}
export type LayoutTable = Geometry & {
  id: Id
  number: number
  shape: "rectangle" | "ellipse"
}
export type Layout = {
  placeId: Id
  revision: number
  canvasWidth: number
  canvasHeight: number
  seats: LayoutSeat[]
  tables: LayoutTable[]
}
export type Reading = {
  status: SeatStatus
  observedAt: string | null
}
export type Occupancy = Record<Id, Reading>
export type Summary = {
  total: number
  available: number
  occupied: number
  unknown: number
  utilization: number | null
}
export type PlaceInput = {
  name: string
  slug: string
  description: string
  canvasWidth: number
  canvasHeight: number
}
export type Place = PlaceInput & {
  id: Id
  revision: number
  summary: Summary
  updatedAt: string
  deviceStatus: "online" | "offline" | "none"
  summaryAt: string
}
export type DeviceInput = {
  identifier: string
  name: string
  placeId: Id
  enabled: boolean
  seatIds: Id[]
}
export type Device = DeviceInput & {
  id: Id
  lastSeenAt: string | null
  status: "online" | "offline" | "disabled"
  revision: number
}
export type Session = {
  name: string
  role: "admin"
  expiresAt: string
}
export type LinkState = "connecting" | "syncing" | "live" | "reconnecting" | "offline" | "unsupported"
export type LiveEvent = {
  type: "snapshot"
  placeId: Id
  streamId: string
  version: number
  revision: number
  seats: Occupancy
  staleAfterMs: number
} | {
  type: "seat_update"
  placeId: Id
  streamId: string
  version: number
  changes: Occupancy
} | {
  type: "layout_updated"
  placeId: Id
  revision: number
} | {
  type: "place_deleted"
  placeId: Id
}
export type LiveSink = {
  event: (event: LiveEvent) => void
  connection: (state: LinkState) => void
}

export interface SeatService {
  mode: "unconfigured" | "development" | "api"
  listPlaces(signal?: AbortSignal): Promise<Place[]>
  getPlace(id: Id, signal?: AbortSignal): Promise<Place>
  getLayout(id: Id, signal?: AbortSignal): Promise<Layout>
  session(): Promise<Session | null>
  login(username: string, password: string): Promise<Session>
  logout(): Promise<void>
  createPlace(input: PlaceInput): Promise<Place>
  updatePlace(id: Id, input: PlaceInput, revision: number): Promise<Place>
  deletePlace(id: Id, revision: number): Promise<void>
  saveLayout(layout: Layout): Promise<Layout>
  listDevices(signal?: AbortSignal): Promise<Device[]>
  createDevice(input: DeviceInput): Promise<{
    device: Device
    token: string
  }>
  updateDevice(id: Id, input: DeviceInput, revision: number): Promise<Device>
  rotateToken(id: Id): Promise<string>
  subscribe(id: Id, sink: LiveSink): () => void
}

export const STATUS_LABEL = {
  available: "이용 가능",
  occupied: "사용 중",
  unknown: "확인 불가",
}
export const EMPTY_SUMMARY: Summary = {
  total: 0,
  available: 0,
  occupied: 0,
  unknown: 0,
  utilization: null,
}
export function timestamp(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString("ko-KR", { hour12: false })
    : "수신 기록 없음"
}
