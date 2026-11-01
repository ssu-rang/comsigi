import { ApiError } from "./api.ts"
import type {
  Device,
  Geometry,
  Layout,
  LiveEvent,
  Occupancy,
  Place,
} from "./domain.ts"

// Decode at the network boundary. Seat and table primary keys have independent
// sequences in SQLite, so they must be namespaced in the editor.
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid()
  return value as unknown[]
}
export function string(value: unknown): string {
  if (typeof value !== "string") invalid()
  return value as string
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid()
  return value as number
}
function integer(value: unknown, min = 0): number {
  const n = number(value)
  if (!Number.isSafeInteger(n) || n < min) invalid()
  return n
}
export const id = (value: unknown) => String(integer(value, 1))
const date = (value: unknown): string | null => {
  if (value === null) return null
  const text = string(value)
  if (!Number.isFinite(Date.parse(text))) invalid()
  return text
}
function invalid(): never {
  throw new ApiError("서버 응답 형식이 올바르지 않습니다.")
}
export const geometry = (value: Geometry): Geometry => ({
  x: value.x,
  y: value.y,
  width: value.width,
  height: value.height,
  rotation: value.rotation,
})
function decodeGeometry(o: Record<string, unknown>): Geometry {
  return {
    x: number(o.x),
    y: number(o.y),
    width: number(o.width),
    height: number(o.height),
    rotation: number(o.rotation),
  }
}
export function decodePlace(value: unknown, state?: unknown): Place {
  const p = object(value)
  const s = state === undefined ? null : object(state)
  const counts = s ? object(s.summary) : null
  const summary = counts
    ? {
        total: integer(counts.total),
        available: integer(counts.available),
        occupied: integer(counts.occupied),
        unknown: integer(counts.unknown),
      }
    : { total: 0, available: 0, occupied: 0, unknown: 0 }
  const devices = s ? array(s.devices).map(object) : []
  return {
    id: id(p.id),
    name: string(p.name),
    slug: string(p.slug),
    description: string(p.description),
    canvasWidth: number(p.canvas_width),
    canvasHeight: number(p.canvas_height),
    revision: integer(p.layout_version, 1),
    updatedAt: date(p.updated_at)!,
    summaryAt: new Date().toISOString(),
    deviceStatus: devices.some((d) => d.status === "online")
      ? "online"
      : devices.length
        ? "offline"
        : "none",
    summary: {
      ...summary,
      utilization:
        summary.available + summary.occupied
          ? Math.round(
              (summary.occupied / (summary.available + summary.occupied)) * 100,
            )
          : null,
    },
  }
}
export function decodeLayout(value: unknown): Layout {
  const data = object(value),
    p = decodePlace(data.place)
  return {
    placeId: p.id,
    revision: p.revision,
    canvasWidth: p.canvasWidth,
    canvasHeight: p.canvasHeight,
    seats: array(data.seats).map((value) => {
      const s = object(value)
      return {
        ...decodeGeometry(s),
        id: `seat:${id(s.id)}`,
        number: integer(s.number, 1),
        tableId: s.table_id === null ? null : `table:${id(s.table_id)}`,
      }
    }),
    tables: array(data.tables).map((value) => {
      const t = object(value)
      if (t.shape !== "rectangle" && t.shape !== "circle") invalid()
      return {
        ...decodeGeometry(t),
        id: `table:${id(t.id)}`,
        number: integer(t.number, 1),
        shape: t.shape === "circle" ? "ellipse" : "rectangle",
      }
    }),
  }
}
export function decodeReadings(value: unknown): Occupancy {
  return Object.fromEntries(
    array(value).map((value) => {
      const s = object(value)
      if (!["available", "occupied", "unknown"].includes(string(s.status)))
        invalid()
      return [
        `seat:${id(s.id)}`,
        { status: s.status, observedAt: date(s.last_received_at) },
      ]
    }),
  ) as Occupancy
}
export function decodeDevice(value: unknown): Device {
  const d = object(value)
  if (typeof d.enabled !== "boolean") invalid()
  const status = d.status ?? (d.enabled ? "offline" : "disabled")
  if (!["online", "offline", "disabled"].includes(string(status))) invalid()
  return {
    id: id(d.id),
    identifier: string(d.device_uid),
    name: string(d.name),
    placeId: id(d.place_id),
    enabled: d.enabled as boolean,
    seatIds: [],
    revision: 0, // The server has no per-device seat ACL or version.
    status: status as Device["status"],
    lastSeenAt: date(d.last_seen_at ?? null),
  }
}
export function decodeEvent(raw: unknown): LiveEvent | "heartbeat" | null {
  const e = object(typeof raw === "string" ? JSON.parse(raw) : raw)
  if (e.type === "ping" || e.type === "pong") return "heartbeat"
  const placeId = id(e.place_id),
    streamId = string(e.server_id),
    version = integer(e.revision)
  if (e.type === "snapshot" || e.type === "layout_changed") {
    const state = object(e.state),
      layout = decodeLayout(e.layout)
    if (
      layout.placeId !== placeId ||
      id(state.place_id) !== placeId ||
      state.server_id !== streamId ||
      state.revision !== version ||
      state.layout_version !== layout.revision
    )
      invalid()
    return {
      type: "snapshot",
      placeId,
      streamId,
      version,
      revision: layout.revision,
      seats: decodeReadings(state.seats),
      staleAfterMs: Infinity,
      layout,
      // layout_changed is a full replacement but still participates in sequence checks.
      incremental: e.type === "layout_changed",
    }
  }
  if (e.type === "state_changed")
    return {
      type: "seat_update",
      placeId,
      streamId,
      version,
      changes: decodeReadings(e.seats),
    }
  if (e.type === "place_deleted")
    return { type: "place_deleted", placeId, streamId, version }
  invalid()
}

export function serverId(value: string, kind?: "seat" | "table"): number {
  const raw = kind
    ? value.startsWith(`${kind}:`)
      ? value.slice(kind.length + 1)
      : ""
    : value
  if (!/^[1-9]\d*$/.test(raw))
    throw new ApiError("저장된 요소 식별자가 올바르지 않습니다.", 422)
  return integer(Number(raw), 1)
}
