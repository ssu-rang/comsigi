// Development-only local simulator. Never imported by a production build.
// These rules model UI scenarios, NOT the still-unimplemented backend contract.
import type {
  Device,
  DeviceInput,
  Layout,
  LiveSink,
  Occupancy,
  Place,
  PlaceInput,
  SeatService,
  Session,
} from "../domain"
import { ApiError } from "../api"
import { countSeats } from "../seats"
import { validateLayout } from "../layout"
import { makeDemoRooms } from "../demo-data"

const KEY = "binjari-development-v2"
const AUTH = "binjari-development-session"
const TTL = 30000
type StoredDevice = Device & { tokenHash: string }
type Database = {
  places: Place[]
  layouts: Record<string, Layout>
  devices: StoredDevice[]
  live: Record<string, {
    version: number
    streamId: string
    seats: Occupancy
  }>
}
const empty = (): Database => ({
  places: [],
  layouts: {},
  devices: [],
  live: {},
})
const emit = () => {
  // A window event also reaches subscribers across Vite's hot-reloaded module
  // instances. localStorage's native storage event never fires in the writer tab.
  window.dispatchEvent(new Event("binjari-dev-store"))
  window.dispatchEvent(new Event("data-changed"))
}
window.addEventListener("storage", (e) => {
  if (e.key === KEY) emit()
})
function read(): Database {
  const value = localStorage.getItem(KEY)
  if (!value) return empty()
  try {
    const parsed = JSON.parse(value)
    if (
      !Array.isArray(parsed.places) ||
      !parsed.layouts ||
      !Array.isArray(parsed.devices) ||
      !parsed.live
    )
      throw 0
    return parsed
  } catch {
    throw new ApiError(
      "개발 데이터가 손상되었습니다. 개발 도구에서 초기화해 주세요.",
    )
  }
}
const session = (): Session | null => {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(AUTH) ?? "null",
    ) as Session | null
    return value && Date.parse(value.expiresAt) > Date.now() ? value : null
  } catch {
    return null
  }
}
function auth() {
  if (!session()) {
    window.dispatchEvent(new Event("auth-expired"))
    throw new ApiError(
      "인증이 만료되었습니다. 다시 로그인해 주세요. 편집 초안은 보관됩니다.",
      401,
    )
  }
}
function findPlace(db: Database, id: string) {
  const place = db.places.find((p) => p.id === id)
  if (!place)
    throw new ApiError("공간을 찾을 수 없습니다. 삭제되었을 수 있습니다.", 404)
  return place
}
function placeView(db: Database, place: Place): Place {
  const seats = db.layouts[place.id].seats.map((s) => {
    const reading = db.live[place.id]?.seats[s.id]
    return {
      id: 1,
      status:
        reading?.observedAt && Date.now() - Date.parse(reading.observedAt) < TTL
          ? reading.status
          : "unknown" as const,
    }
  })
  const devices = db.devices.filter((d) => d.placeId === place.id)
  return {
    ...place,
    summary: countSeats(seats),
    summaryAt: new Date().toISOString(),
    deviceStatus: !devices.length
      ? "none"
      : devices.some((d) => deviceView(d).status === "online")
        ? "online"
        : "offline",
  }
}
function deviceView({ tokenHash: _secret, ...d }: StoredDevice): Device {
  return {
    ...d,
    status: !d.enabled
      ? "disabled"
      : d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < TTL
        ? "online"
        : "offline",
  }
}
async function mutate<T>(
  fn: (db: Database) => T | Promise<T>,
  secured = true,
): Promise<T> {
  if (secured) auth()
  if (!navigator.locks)
    throw new ApiError("개발 저장 기능에는 localhost 또는 HTTPS가 필요합니다.")
  const result = await navigator.locks.request(KEY, async () => {
    if (secured) auth()
    const db = read()
    const value = await fn(db)
    localStorage.setItem(KEY, JSON.stringify(db))
    return value
  })
  emit()
  return result
}
function validatePlace(db: Database, p: PlaceInput, id?: string) {
  if (!p.name.trim() || p.name.trim().length > 100)
    throw new ApiError("공간 이름을 1~100자로 입력해 주세요.", 422)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug))
    throw new ApiError(
      "URL 식별자는 소문자, 숫자, 하이픈으로 입력해 주세요.",
      422,
    )
  if (db.places.some((v) => v.id !== id && v.slug === p.slug))
    throw new ApiError("이미 사용 중인 URL 식별자입니다.", 409)
  if (
    ![p.canvasWidth, p.canvasHeight].every(
      (v) => Number.isInteger(v) && v >= 100 && v <= 10000,
    )
  )
    throw new ApiError("캔버스 크기는 100~10,000 사이의 정수여야 합니다.", 422)
}
function validateDevice(db: Database, d: DeviceInput, id?: string) {
  findPlace(db, d.placeId)
  if (!d.identifier.trim() || !d.name.trim())
    throw new ApiError("장치 식별자와 이름을 입력해 주세요.", 422)
  if (db.devices.some((v) => v.id !== id && v.identifier === d.identifier))
    throw new ApiError("이미 등록된 장치 식별자입니다.", 409)
  const seats = db.layouts[d.placeId].seats
  if (
    new Set(d.seatIds).size !== d.seatIds.length ||
    d.seatIds.some((id) => !seats.some((s) => s.id === id))
  )
    throw new ApiError(
      "선택한 공간에 없는 좌석입니다. 좌석 목록을 새로고침해 주세요.",
      422,
    )
  if (
    db.devices.some(
      (v) => v.id !== id && v.seatIds.some((s) => d.seatIds.includes(s)),
    )
  )
    throw new ApiError(
      "다른 장치가 담당하는 좌석이 포함되어 있습니다. 담당 좌석을 다시 선택해 주세요.",
      409,
    )
}
async function hash(token: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
}
function token() {
  return "dev_" + crypto.randomUUID() + crypto.randomUUID()
}
function resetSeats(db: Database, placeId: string, ids: string[]) {
  const live = db.live[placeId]
  if (!live) return
  live.version++
  for (const id of ids) live.seats[id] = { status: "unknown", observedAt: null }
}
function addPlace(db: Database, input: PlaceInput) {
  validatePlace(db, input)
  const id = crypto.randomUUID()
  const place: Place = {
    ...input,
    name: input.name.trim(),
    id,
    revision: 1,
    updatedAt: new Date().toISOString(),
    summaryAt: new Date().toISOString(),
    deviceStatus: "none",
    summary: countSeats([]),
  }
  db.places.push(place)
  db.layouts[id] = {
    placeId: id,
    revision: 1,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    seats: [],
    tables: [],
  }
  db.live[id] = { streamId: crypto.randomUUID(), version: 0, seats: {} }
  return place
}
export const devService: SeatService = {
  mode: "development",
  listPlaces: async () => {
    const db = read()
    return db.places.map((p) => placeView(db, p))
  },
  getPlace: async (id) => {
    const db = read()
    return placeView(db, findPlace(db, id))
  },
  getLayout: async (id) => {
    const db = read()
    findPlace(db, id)
    return db.layouts[id]
  },
  session: async () => session(),
  login: async (username, password) => {
    if (username !== "admin" || password !== "dev-only")
      throw new ApiError("관리자 이름 또는 비밀번호가 올바르지 않습니다.", 401)
    const next: Session = {
      name: "개발 관리자",
      role: "admin",
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    }
    sessionStorage.setItem(AUTH, JSON.stringify(next))
    return next
  },
  logout: async () => {
    sessionStorage.removeItem(AUTH)
  },
  createPlace: (input) => mutate((db) => addPlace(db, input)),
  updatePlace: (id, input, revision) =>
    mutate((db) => {
      const place = findPlace(db, id)
      if (place.revision !== revision)
        throw new ApiError(
          "다른 창에서 공간이 변경되었습니다. 새로고침 후 다시 수정해 주세요.",
          409,
        )
      validatePlace(db, input, id)
      const layout = db.layouts[id]
      const errors = validateLayout({
        ...layout,
        canvasWidth: input.canvasWidth,
        canvasHeight: input.canvasHeight,
      })
      if (errors.length)
        throw new ApiError(
          "기존 요소가 새 캔버스를 벗어납니다. 배치 편집기에서 요소를 먼저 이동해 주세요.",
          422,
        )
      if (
        layout.canvasWidth !== input.canvasWidth ||
        layout.canvasHeight !== input.canvasHeight
      ) {
        layout.canvasWidth = input.canvasWidth
        layout.canvasHeight = input.canvasHeight
        layout.revision++
      }
      Object.assign(place, input, {
        revision: place.revision + 1,
        updatedAt: new Date().toISOString(),
      })
      return placeView(db, place)
    }),
  deletePlace: (id, revision) =>
    mutate((db) => {
      if (findPlace(db, id).revision !== revision)
        throw new ApiError(
          "공간이 변경되었습니다. 목록을 새로고침해 주세요.",
          409,
        )
      db.places = db.places.filter((p) => p.id !== id)
      delete db.layouts[id]
      delete db.live[id]
      db.devices = db.devices.filter((d) => d.placeId !== id)
    }),
  saveLayout: (layout) =>
    mutate((db) => {
      if (sessionStorage.getItem("dev-fail-save") === "yes") {
        sessionStorage.removeItem("dev-fail-save")
        throw new ApiError(
          "개발 검증: 저장 요청에 실패했습니다. 편집 내용은 유지됩니다.",
          503,
        )
      }
      const place = findPlace(db, layout.placeId)
      const saved = db.layouts[layout.placeId]
      if (saved.revision !== layout.revision)
        throw new ApiError(
          "다른 관리자가 배치를 먼저 저장했습니다. 최신 배치를 확인한 뒤 다시 편집해 주세요.",
          409,
        )
      const errors = validateLayout(layout)
      if (errors.length) throw new ApiError(errors.join(" "), 422)
      if (
        saved.canvasWidth !== layout.canvasWidth ||
        saved.canvasHeight !== layout.canvasHeight
      )
        throw new ApiError("캔버스 크기는 공간 설정에서 변경해 주세요.", 422)
      const next = { ...layout, revision: saved.revision + 1 }
      db.layouts[layout.placeId] = next
      for (const device of db.devices.filter(
        (d) => d.placeId === layout.placeId,
      )) {
        const remaining = device.seatIds.filter((id) =>
          next.seats.some((s) => s.id === id),
        )
        if (remaining.length !== device.seatIds.length) {
          device.seatIds = remaining
          device.revision++
        }
      }
      const removedOrRenumbered = saved.seats
        .filter(
          (s) =>
            !next.seats.some((n) => n.id === s.id && n.number === s.number),
        )
        .map((s) => s.id)
      resetSeats(db, layout.placeId, removedOrRenumbered)
      place.revision++
      place.updatedAt = new Date().toISOString()
      return next
    }),
  listDevices: async () => {
    auth()
    return read().devices.map(deviceView)
  },
  createDevice: (input) =>
    mutate(async (db) => {
      validateDevice(db, input)
      const raw = token()
      const device: StoredDevice = {
        ...input,
        id: crypto.randomUUID(),
        revision: 1,
        lastSeenAt: null,
        status: "offline",
        tokenHash: await hash(raw),
      }
      db.devices.push(device)
      resetSeats(db, input.placeId, input.seatIds)
      return { device: deviceView(device), token: raw }
    }),
  updateDevice: (id, input, revision) =>
    mutate((db) => {
      const device = db.devices.find((d) => d.id === id)
      if (!device) throw new ApiError("장치를 찾을 수 없습니다.", 404)
      if (device.revision !== revision)
        throw new ApiError(
          "장치 설정이 변경되었습니다. 새로고침해 주세요.",
          409,
        )
      validateDevice(db, input, id)
      resetSeats(db, device.placeId, device.seatIds)
      resetSeats(db, input.placeId, input.seatIds)
      Object.assign(device, input, { revision: revision + 1, lastSeenAt: null })
      return deviceView(device)
    }),
  rotateToken: (id) =>
    mutate(async (db) => {
      const device = db.devices.find((d) => d.id === id)
      if (!device) throw new ApiError("장치를 찾을 수 없습니다.", 404)
      const raw = token()
      device.tokenHash = await hash(raw)
      device.revision++
      return raw
    }),
  subscribe: (id, sink) => subscribe(id, sink),
}
function subscribe(id: string, sink: LiveSink) {
  let prior: Database["live"][string] | null = null,
    revision = -1,
    stopped = false
  const refresh = () => {
    if (stopped) return
    if (sessionStorage.getItem("dev-disconnected") === "yes") {
      prior = null
      sink.connection("offline")
      return
    }
    const db = read(),
      layout = db.layouts[id],
      live = db.live[id]
    if (!layout || !live) {
      sink.event({ type: "place_deleted", placeId: id })
      return
    }
    if (revision >= 0 && layout.revision !== revision)
      sink.event({
        type: "layout_updated",
        placeId: id,
        revision: layout.revision,
      })
    revision = layout.revision
    if (
      !prior ||
      prior.streamId !== live.streamId ||
      live.version > prior.version + 1
    ) {
      sink.event({
        type: "snapshot",
        placeId: id,
        streamId: live.streamId,
        version: live.version,
        revision,
        seats: live.seats,
        staleAfterMs: TTL,
      })
      sink.connection("live")
    } else if (live.version !== prior.version) {
      const changes = Object.fromEntries(
        Object.entries(live.seats).filter(
          ([key, reading]) =>
            JSON.stringify(reading) !== JSON.stringify(prior?.seats[key]),
        ),
      )
      sink.event({
        type: "seat_update",
        placeId: id,
        streamId: live.streamId,
        version: live.version,
        changes,
      })
    }
    prior = live
  }
  sink.connection("connecting")
  const timer = setTimeout(refresh, 30)
  window.addEventListener("binjari-dev-store", refresh)
  return () => {
    stopped = true
    clearTimeout(timer)
    window.removeEventListener("binjari-dev-store", refresh)
  }
}

export const devControls = {
  async seed() {
    return mutate((db) => {
      const room = makeDemoRooms()[0]
      const p = addPlace(db, {
        name: `${room.name} · 개발용`,
        slug: `preview-${Date.now()}`,
        description: "브라우저에만 저장되는 검증용 공간",
        canvasWidth: 1000,
        canvasHeight: 700,
      })
      const layout = db.layouts[p.id]
      for (let i = 0; i < 6; i++) {
        const tableId = crypto.randomUUID(),
          x = 80 + (i % 3) * 300,
          y = 120 + Math.floor(i / 3) * 300
        layout.tables.push({
          id: tableId,
          number: i + 1,
          x,
          y,
          width: 220,
          height: 70,
          rotation: 0,
          shape: "rectangle",
        })
        for (let j = 0; j < 8; j++)
          layout.seats.push({
            id: crypto.randomUUID(),
            number: i * 8 + j + 1,
            tableId,
            x: x + 10 + (j % 4) * 52,
            y: j < 4 ? y - 60 : y + 90,
            width: 40,
            height: 40,
            rotation: j < 4 ? 0 : 180,
          })
      }
      return p
    })
  },
  failNextSave() {
    sessionStorage.setItem("dev-fail-save", "yes")
  },
  expire() {
    sessionStorage.removeItem(AUTH)
    window.dispatchEvent(new Event("auth-expired"))
  },
  disconnect(value: boolean) {
    sessionStorage.setItem("dev-disconnected", value ? "yes" : "no")
    emit()
  },
  resetReadings: () =>
    mutate((db) => {
      for (const live of Object.values(db.live)) {
        live.seats = {}
        live.streamId = crypto.randomUUID()
        live.version = 0
      }
    }),
  async ingest(
    identifier: string,
    rawToken: string,
    readings: {
      number: number
      status: "available" | "occupied" | "unknown"
    }[],
  ) {
    const tokenHash = await hash(rawToken)
    return mutate((db) => {
      const device = db.devices.find(
        (d) =>
          d.identifier === identifier && d.tokenHash === tokenHash && d.enabled,
      )
      if (!device)
        throw new ApiError(
          "개발 장치 인증에 실패했습니다. 식별자, 토큰, 활성화 상태를 확인해 주세요.",
          401,
        )
      const layout = db.layouts[device.placeId],
        changes: Occupancy = {},
        now = new Date().toISOString()
      if (
        !readings.length ||
        new Set(readings.map((r) => r.number)).size !== readings.length
      )
        throw new ApiError("중복 없는 좌석 번호를 입력해 주세요.", 422)
      for (const reading of readings) {
        const seat = layout.seats.find(
          (s) => s.number === reading.number && device.seatIds.includes(s.id),
        )
        if (
          !seat ||
          !["available", "occupied", "unknown"].includes(reading.status)
        )
          throw new ApiError(
            `${reading.number}번은 이 장치의 담당 좌석이 아니거나 올바르지 않은 상태입니다.`,
            422,
          )
        changes[seat.id] = { status: reading.status, observedAt: now }
      }
      device.lastSeenAt = now
      Object.assign(db.live[device.placeId].seats, changes)
      db.live[device.placeId].version++
    }, false)
  },
}
