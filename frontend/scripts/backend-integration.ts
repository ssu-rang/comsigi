import assert from "node:assert/strict"
import { createBackend } from "../src/backend.ts"
import { ApiError, requestJson } from "../src/api.ts"
import { applyEvent, initialLive, visibleSeats } from "../src/realtime.ts"
import type { LiveEvent } from "../src/domain.ts"

// Run only against the disposable database/server provided by pytest.
const origin = process.env.COMSIGI_TEST_ORIGIN!
assert.ok(origin)
Object.defineProperty(globalThis, "location", { value: new URL(origin) })
const nativeFetch = globalThis.fetch
const requests: string[] = []
globalThis.fetch = (input, init) => {
  requests.push(String(input))
  return nativeFetch(new URL(String(input), origin), init)
}
const api = createBackend()
assert.equal(await api.session(), null)
await assert.rejects(
  api.login("admin", "wrong"),
  (e: ApiError) => e.status === 401,
)
assert.equal(
  (await api.login("admin", process.env.COMSIGI_TEST_PASSWORD!)).role,
  "admin",
)
const p = await api.createPlace({
  name: "통합 테스트",
  slug: "integration",
  description: "실제 서버",
  canvasWidth: 600,
  canvasHeight: 400,
})
assert.equal((await api.listPlaces())[0].id, p.id)
let layout = await api.getLayout(p.id)
const g = { x: 30, y: 30, width: 40, height: 40, rotation: 0 }
layout.tables.push({ ...g, id: "new-table", number: 1, shape: "ellipse" })
layout.seats.push({ ...g, id: "new-a", number: 1, tableId: "new-table" }, {
  ...g,
  id: "new-b",
  x: 120,
  number: 2,
  tableId: null,
})
layout = await api.saveLayout(layout)
assert.equal(layout.tables[0].id, "table:1")
assert.equal(layout.seats[0].id, "seat:1")
assert.equal(layout.seats[0].tableId, layout.tables[0].id)
assert.equal(layout.tables[0].shape, "ellipse")
const old = structuredClone(layout)
layout.seats = layout.seats.map((s) => ({
  ...s,
  number: 3 - s.number,
  x: s.x + 20,
}))
layout = await api.saveLayout(layout)
assert.equal(layout.seats.find((s) => s.id === "seat:1")!.number, 2)
await assert.rejects(api.saveLayout(old), (e: ApiError) => e.status === 409)

const events: LiveEvent[] = []
let live = initialLive(),
  state = "connecting"
const waitFor = async (test: () => boolean) => {
  const deadline = Date.now() + 8000
  while (!test()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${state}, ${JSON.stringify(events)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const subscribe = () =>
  api.subscribe(p.id, {
    connection: (s) => {
      state = s
    },
    event: (event) => {
      events.push(event)
      const result = applyEvent(live, event)
      assert.equal(result.resync, false)
      live = result.state
    },
  })
let stop = subscribe()
try {
  await waitFor(() => state === "live")
  assert.equal("layout" in live, false)
  assert.equal((await api.getLayout(p.id)).seats.length, 2)
  const d = await api.createDevice({
    identifier: "integration-camera",
    name: "카메라",
    placeId: p.id,
    enabled: true,
    seatIds: [],
  })
  assert.ok(d.token)
  assert.equal((await api.listDevices())[0].identifier, "integration-camera")
  const hardware = async (path: string, data: unknown, token = d.token) =>
    requestJson<any>(`/api/v1/hardware/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    })
  const session = await hardware("session", { device_uid: d.device.identifier })
  await hardware("reports", {
    device_uid: d.device.identifier,
    session_id: session.session_id,
    sequence: 0,
    seats: [
      { number: 1, occupied: true },
      { number: 2, occupied: false },
    ],
  })
  await waitFor(() => live.occupancy["seat:2"]?.status === "occupied")
  assert.equal(live.occupancy["seat:1"].status, "available")
  // Unchanged sensor reports need not generate events. Never expire readings on the client.
  assert.equal(
    visibleSeats(layout, live, "live", Date.now() + 120000)[0].status,
    live.occupancy[layout.seats[0].id].status,
  )
  assert.ok(
    visibleSeats(layout, live, "offline", Date.now()).every(
      (s) => s.status === "unknown",
    ),
  )
  const summary = (await api.listPlaces())[0].summary
  assert.equal(summary.occupied, 1)
  await waitFor(() =>
    Object.values(live.occupancy).every((r) => r.status === "unknown"),
  )

  const token2 = await api.rotateToken(d.device.id)
  assert.notEqual(d.token, token2)
  await assert.rejects(
    hardware("session", { device_uid: d.device.identifier }),
    (e: ApiError) => e.status === 401,
  )
  await api.updateDevice(d.device.id, { ...d.device, enabled: false }, 0)
  assert.equal((await api.listDevices())[0].status, "disabled")
  await api.updateDevice(d.device.id, { ...d.device, enabled: true }, 0)
  layout.tables = []
  layout.seats = layout.seats.slice(0, 1).map((s) => ({ ...s, tableId: null }))
  layout = await api.saveLayout(layout)
  await waitFor(() => live.revision === layout.revision)
  const refreshed = await api.getLayout(p.id)
  assert.equal(refreshed.tables.length, 0)
  assert.equal(refreshed.seats.length, 1)
  assert.deepEqual(
    Object.keys(live.occupancy),
    refreshed.seats.map((s) => s.id),
  )

  await api.updatePlace(
    p.id,
    { ...p, slug: "renamed", name: "변경된 공간" },
    p.revision,
  )
  stop()
  live = initialLive()
  state = "connecting"
  stop = subscribe()
  await waitFor(() => state === "live")
  assert.equal((await api.getPlace(p.id)).slug, "renamed")
  await api.deletePlace(p.id, 0)
  await waitFor(() => events.some((e) => e.type === "place_deleted"))
  assert.equal(state, "offline")
  assert.equal((await api.listDevices()).length, 0)
  assert.equal((await api.listPlaces()).length, 0)
  await api.logout()
  await assert.rejects(api.listDevices(), (e: ApiError) => e.status === 401)
  assert.equal(await api.session(), null)
  assert.ok(!requests.some((path) => /token=|credential=/.test(path)))
  console.log(
    "PASS real frontend adapter: auth, CRUD, ID mapping, layout swaps/conflicts, hardware, expiry, WebSocket, slug reconnect, deletion, logout",
  )
} finally {
  stop()
}
