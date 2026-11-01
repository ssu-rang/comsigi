import assert from "node:assert/strict"
import { test } from "node:test"
import {
  bounds,
  commit,
  constrain,
  nextNumber,
  redo,
  removeElement,
  undo,
  updateElement,
  validateLayout,
  type History,
} from "./layout.ts"
import type { Layout } from "./domain.ts"

const layout = (): Layout => ({
  placeId: "p",
  revision: 4,
  canvasWidth: 1000,
  canvasHeight: 700,
  seats: [
    {
      id: "s",
      number: 1,
      x: 50,
      y: 50,
      width: 40,
      height: 40,
      rotation: 0,
      tableId: "t",
    },
  ],
  tables: [
    {
      id: "t",
      number: 1,
      x: 100,
      y: 100,
      width: 150,
      height: 80,
      rotation: 0,
      shape: "rectangle",
    },
  ],
})
test("each completed edit is one undo step; redo clears after a new edit", () => {
  const start = layout()
  let h: History = { past: [], present: start, future: [] }
  const next = updateElement(start, { kind: "seat", id: "s" }, {
    x: 200,
    y: 300,
  })
  h = commit(h, next)
  assert.equal(h.past.length, 1)
  assert.equal(h.present.seats[0].x, 200)
  assert.deepEqual(undo(h).present, start)
  assert.deepEqual(redo(undo(h)).present, next)
  assert.equal(
    commit(
      undo(h),
      updateElement(start, { kind: "seat", id: "s" }, { number: 2 }),
    ).future.length,
    0,
  )
  assert.equal(commit(h, structuredClone(h.present)), h)
})
test("deleting a table preserves chairs and unlinks them; undo restores the link", () => {
  const start = layout(),
    removed = removeElement(start, { kind: "table", id: "t" })
  assert.equal(removed.tables.length, 0)
  assert.equal(removed.seats.length, 1)
  assert.equal(removed.seats[0].tableId, null)
  assert.equal(
    undo(commit({ past: [], present: start, future: [] }, removed)).present
      .seats[0].tableId,
    "t",
  )
})
test("geometry, duplicate number, dangling table, and non-finite input validation", () => {
  assert.deepEqual(validateLayout(layout()), [])
  for (const patch of [
    { width: -1 },
    { height: 0 },
    { x: NaN },
    { x: 1000 },
    { rotation: 360 },
    { number: 0 },
    { number: 1.2 },
    { tableId: "missing" },
  ]) {
    assert.ok(
      validateLayout(updateElement(layout(), { kind: "seat", id: "s" }, patch))
        .length,
      JSON.stringify(patch),
    )
  }
  const duplicate = layout()
  duplicate.seats.push({ ...duplicate.seats[0], id: "s2" })
  assert.match(validateLayout(duplicate).join(), /중복/)
  assert.equal(nextNumber([{ number: 1 }, { number: 3 }]), 2)
})
test("drag bounds include the rotated footprint at every canvas edge", () => {
  for (const rotation of [0, 15, 45, 90, 135, 315]) {
    const element = constrain(
      { x: -100, y: 1000, width: 200, height: 60, rotation },
      1000,
      700,
    )
    const b = bounds(element)
    assert.ok(b.cx - b.halfWidth >= -0.001)
    assert.ok(b.cy + b.halfHeight <= 700.001)
  }
  const small = { ...layout(), canvasWidth: 100, canvasHeight: 100 }
  assert.ok(validateLayout(small).length)
})
