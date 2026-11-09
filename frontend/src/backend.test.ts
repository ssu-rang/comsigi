import assert from "node:assert/strict"
import { test } from "node:test"
import { ApiError, requestJson } from "./api.ts"
import { decodeEvent, decodeLayout } from "./backend-contract.ts"
import { saveBackendLayout } from "./backend-layout.ts"
import { applyEvent, initialLive, visibleSeats } from "./realtime.ts"
import type { Request } from "./backend.ts"

const rawLayout = {
  place: {
    id: 1,
    name: "Room",
    slug: "room",
    description: "",
    layout_version: 1,
    canvas_width: 500,
    canvas_height: 500,
    updated_at: "2026-01-01T00:00:00Z",
  },
  seats: [
    {
      id: 1,
      number: 1,
      table_id: 1,
      x: 1,
      y: 1,
      width: 40,
      height: 40,
      rotation: 0,
    },
  ],
  tables: [
    {
      id: 1,
      number: 1,
      shape: "circle",
      x: 50,
      y: 50,
      width: 40,
      height: 40,
      rotation: 0,
    },
  ],
}
const event = (type = "snapshot", revision = 1) => ({
  type,
  server_id: "server",
  place_id: 1,
  revision,
  state: {
    server_id: "server",
    place_id: 1,
    revision,
    layout_version: 1,
    seats: [
      {
        id: 1,
        number: 1,
        status: "available",
        last_received_at: "2026-01-01T00:00:00Z",
      },
    ],
  },
})
test("wire IDs are namespaced and backend circle maps to the existing renderer", () => {
  const layout = decodeLayout(rawLayout)
  assert.notEqual(layout.seats[0].id, layout.tables[0].id)
  assert.equal(layout.seats[0].tableId, layout.tables[0].id)
  assert.equal(layout.tables[0].shape, "ellipse")
  assert.throws(
    () => decodeLayout({ ...rawLayout, seats: [{ id: "1" }] }),
    ApiError,
  )
})
test("state-only snapshots use HTTP geometry; resets require consecutive revisions", () => {
  const snapshot = decodeEvent(event())
  assert.ok(snapshot && snapshot !== "heartbeat")
  const live = applyEvent(initialLive(), snapshot).state
  const layout = decodeLayout(rawLayout)
  assert.equal("layout" in live, false)
  assert.equal(
    visibleSeats(layout, live, "live", Date.now())[0].status,
    "available",
  )
  assert.equal(
    visibleSeats(layout, live, "reconnecting", Date.now())[0].status,
    "unknown",
  )
  const update = decodeEvent(event("state_reset", 2))
  assert.ok(update && update !== "heartbeat")
  assert.equal(applyEvent(live, update).resync, false)
  const gap = decodeEvent(event("state_reset", 3))
  assert.ok(gap && gap !== "heartbeat")
  assert.equal(applyEvent(live, gap).resync, true)
  assert.equal(applyEvent(initialLive(), update).resync, true)
  assert.throws(() =>
    decodeEvent({ ...event(), state: { ...event().state, place_id: 2 } }),
  )
  const newLayout = { ...layout, revision: 2 }
  assert.equal(
    visibleSeats(newLayout, live, "live", Date.now())[0].status,
    "unknown",
  )
  const reset = event("state_reset", 2)
  reset.state.layout_version = 2
  reset.state.seats = []
  const decoded = decodeEvent(reset)
  assert.ok(decoded && decoded !== "heartbeat")
  const next = applyEvent(live, decoded).state
  assert.equal(next.revision, 2)
  assert.deepEqual(next.occupancy, {})
})
test("a stale editor cannot perform any CRUD writes", async () => {
  const calls: string[] = []
  const request = (async (_path, options) => {
    calls.push(options?.method ?? "GET")
    return rawLayout
  }) as Request
  await assert.rejects(
    saveBackendLayout({ ...decodeLayout(rawLayout), revision: 0 }, request),
    (e: ApiError) => e.status === 409,
  )
  assert.deepEqual(calls, ["GET"])
})
test("partial layout save failures preserve the draft and require reload without retry", async () => {
  const draft = decodeLayout(rawLayout)
  draft.seats = []
  let deletes = 0
  const request = (async (_path, options) => {
    if (options?.method === "DELETE") {
      deletes++
      throw new ApiError("connection lost")
    }
    return rawLayout
  }) as Request
  await assert.rejects(
    saveBackendLayout(draft, request),
    (e: ApiError) => e.status === 409 && e.message.includes("일부 변경"),
  )
  assert.equal(deletes, 1)
  assert.equal(draft.revision, 1)
  assert.equal(draft.tables[0].id, "table:1")
})
test("API error envelope and Pydantic details reach the form", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "validation_error",
            message: "Invalid request",
            details: [{ loc: ["body", "name"], msg: "required" }],
          },
        }),
        { status: 422 },
      )
    await assert.rejects(
      requestJson("/test"),
      (e: ApiError) => e.status === 422 && e.fields.name === "required",
    )
    globalThis.fetch = async () => new Response(null, { status: 204 })
    assert.equal(await requestJson("/test"), null)
  } finally {
    globalThis.fetch = original
  }
})
