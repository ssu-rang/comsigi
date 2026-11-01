import type { Geometry, Layout, LayoutSeat, LayoutTable } from "./domain"

export type Selection = {
  kind: "seat" | "table"
  id: string
}
export const cloneLayout = (layout: Layout): Layout => structuredClone(layout)
export const sameLayout = (a: Layout, b: Layout) =>
  JSON.stringify(a) === JSON.stringify(b)
export const nextNumber = (items: { number: number }[]) => {
  const used = new Set(items.map((item) => item.number))
  let n = 1
  while (used.has(n)) n++
  return n
}
export function bounds(element: Geometry) {
  const a = (element.rotation * Math.PI) / 180
  const halfWidth =
    (Math.abs(Math.cos(a)) * element.width +
      Math.abs(Math.sin(a)) * element.height) /
    2
  const halfHeight =
    (Math.abs(Math.sin(a)) * element.width +
      Math.abs(Math.cos(a)) * element.height) /
    2
  return {
    halfWidth,
    halfHeight,
    cx: element.x + element.width / 2,
    cy: element.y + element.height / 2,
  }
}
export function constrain<T extends Geometry>(
  element: T,
  width: number,
  height: number,
): T {
  let e = {
    ...element,
    width: Math.min(width, Math.max(20, element.width)),
    height: Math.min(height, Math.max(20, element.height)),
    rotation: ((element.rotation % 360) + 360) % 360,
  }
  let b = bounds(e)
  const ratio = Math.min(
    1,
    width / (2 * b.halfWidth),
    height / (2 * b.halfHeight),
  )
  if (ratio < 1) {
    e = { ...e, width: e.width * ratio, height: e.height * ratio }
    b = bounds(e)
  }
  const cx = Math.min(width - b.halfWidth, Math.max(b.halfWidth, b.cx))
  const cy = Math.min(height - b.halfHeight, Math.max(b.halfHeight, b.cy))
  return { ...e, x: cx - e.width / 2, y: cy - e.height / 2 }
}
export function validateLayout(layout: Layout): string[] {
  const errors: string[] = []
  if (
    ![layout.canvasWidth, layout.canvasHeight].every(
      (n) => Number.isFinite(n) && n >= 100 && n <= 10000,
    )
  )
    errors.push("캔버스 크기는 100~10,000 사이여야 합니다.")
  const ids = new Set<string>()
  for (const [kind, items] of [
    ["좌석", layout.seats],
    ["테이블", layout.tables],
  ] as const) {
    const numbers = new Set<number>()
    for (const e of items) {
      if (!e.id || ids.has(e.id)) errors.push("요소 식별자가 중복되었습니다.")
      ids.add(e.id)
      if (
        !Number.isSafeInteger(e.number) ||
        e.number < 1 ||
        numbers.has(e.number)
      )
        errors.push(`${kind} 번호는 중복 없는 양의 정수여야 합니다.`)
      numbers.add(e.number)
      if (
        ![e.x, e.y, e.width, e.height, e.rotation].every(Number.isFinite) ||
        e.width < 20 ||
        e.height < 20 ||
        e.rotation < 0 ||
        e.rotation >= 360
      )
        errors.push(
          `${kind} ${e.number}: 크기는 20 이상, 회전각은 0~359여야 합니다.`,
        )
      const b = bounds(e),
        tolerance = 0.01
      if (
        b.cx - b.halfWidth < -tolerance ||
        b.cy - b.halfHeight < -tolerance ||
        b.cx + b.halfWidth > layout.canvasWidth + tolerance ||
        b.cy + b.halfHeight > layout.canvasHeight + tolerance
      )
        errors.push(`${kind} ${e.number}: 캔버스 범위를 벗어났습니다.`)
    }
  }
  for (const seat of layout.seats)
    if (seat.tableId && !layout.tables.some((t) => t.id === seat.tableId))
      errors.push(`좌석 ${seat.number}: 연결된 테이블이 없습니다.`)
  return [...new Set(errors)]
}
export function updateElement(
  layout: Layout,
  selection: Selection,
  patch: Partial<LayoutSeat & LayoutTable>,
): Layout {
  const key = selection.kind === "seat" ? "seats" : "tables"
  return {
    ...layout,
    [key]: layout[key].map((e) =>
      e.id === selection.id ? { ...e, ...patch } : e,
    ),
  }
}
export function removeElement(layout: Layout, selection: Selection): Layout {
  return selection.kind === "seat"
    ? { ...layout, seats: layout.seats.filter((s) => s.id !== selection.id) }
    : {
        ...layout,
        tables: layout.tables.filter((t) => t.id !== selection.id),
        seats: layout.seats.map((s) =>
          s.tableId === selection.id ? { ...s, tableId: null } : s,
        ),
      }
}
export type History = {
  past: Layout[]
  present: Layout
  future: Layout[]
}
export function commit(history: History, next: Layout): History {
  return sameLayout(history.present, next)
    ? history
    : {
        past: [...history.past.slice(-99), history.present],
        present: next,
        future: [],
      }
}
export function undo(history: History): History {
  const last = history.past.at(-1)
  return last
    ? {
        past: history.past.slice(0, -1),
        present: last,
        future: [history.present, ...history.future],
      }
    : history
}
export function redo(history: History): History {
  const next = history.future[0]
  return next
    ? {
        past: [...history.past, history.present],
        present: next,
        future: history.future.slice(1),
      }
    : history
}
