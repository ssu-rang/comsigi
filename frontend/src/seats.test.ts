import assert from "node:assert/strict"
import { test } from "node:test"
import { countSeats, fetchSeats } from "./seats.ts"

test("API seats preserve IDs, sort numerically, and normalize unknown readings", async (t) => {
  const signal = new AbortController().signal
  const request = t.mock.method(globalThis, "fetch", async () => Response.json({ seats: [
    { id: 12, status: "occupied" },
    { id: 2, status: "available" },
    { id: 9, status: "sensor-error" },
  ] }))
  const seats = await fetchSeats("/api/v1/seats", signal)
  assert.deepEqual(seats, [
    { id: 2, status: "available" },
    { id: 9, status: "unknown" },
    { id: 12, status: "occupied" },
  ])
  assert.deepEqual(request.mock.calls[0].arguments, [
    "/api/v1/seats", { signal, cache: "no-store" },
  ])
  assert.deepEqual(countSeats(seats), {
    available: 1, occupied: 1, unknown: 1, total: 3, utilization: 50,
  })
})

test("empty and unreadable seats do not produce a utilization percentage", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ seats: [] }))
  assert.deepEqual(await fetchSeats("/seats", new AbortController().signal), [])
  assert.deepEqual(countSeats([]), {
    available: 0, occupied: 0, unknown: 0, total: 0, utilization: null,
  })
  assert.equal(countSeats([{ id: 1, status: "unknown" }]).utilization, null)
})

test("malformed responses and duplicate IDs are rejected", async (t) => {
  const request = t.mock.method(globalThis, "fetch")
  for (const body of [null, {}, { seats: null }, { seats: [null] },
    { seats: [{ id: "1" }] }, { seats: [{ id: -1 }] },
    { seats: [{ id: 1 }, { id: 1 }] }]) {
    request.mock.mockImplementation(async () => Response.json(body))
    await assert.rejects(fetchSeats("/seats", new AbortController().signal))
  }
})

test("HTTP and network failures propagate instead of returning an empty room", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }))
  await assert.rejects(fetchSeats("/seats", new AbortController().signal), /503/)
  request.mock.mockImplementation(async () => { throw new TypeError("Network error") })
  await assert.rejects(fetchSeats("/seats", new AbortController().signal), /Network error/)
})
