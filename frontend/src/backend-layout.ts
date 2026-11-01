import type { Layout, LayoutSeat, LayoutTable } from "./domain.ts"
import type { Request } from "./backend.ts"
import { ApiError, messageOf } from "./api.ts"
import {
  decodeLayout,
  geometry,
  id,
  object,
  serverId,
} from "./backend-contract.ts"
import { validateLayout } from "./layout.ts"

// Membership/metadata use CRUD; geometry uses versioned PUT. A CRUD sequence
// is not a transaction. Never silently retry after potentially partial writes.
export async function saveBackendLayout(
  draft: Layout,
  request: Request,
): Promise<Layout> {
  const errors = validateLayout(draft)
  if (errors.length) throw new ApiError(errors.join(" "), 422)
  const path = `/api/v1/admin/places/${serverId(draft.placeId)}`
  let current = decodeLayout(await request(`${path}/layout`))
  if (current.revision !== draft.revision)
    throw new ApiError("배치가 변경되었습니다. 최신 배치를 확인해 주세요.", 409)
  const target = structuredClone(draft)
  for (const key of ["seats", "tables"] as const) {
    const kind = key === "seats" ? "seat" : "table"
    for (const item of target[key]) {
      if (
        item.id.startsWith(`${kind}:`) &&
        !current[key].some((e) => e.id === item.id)
      )
        throw new ApiError(
          "삭제된 요소가 포함되어 있습니다. 최신 배치를 확인해 주세요.",
          409,
        )
    }
  }
  let attempted = false
  const mutate = async (suffix: string, method: string, value?: unknown) => {
    attempted = true
    const result = await request(path + suffix, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    })
    const next = decodeLayout(await request(`${path}/layout`))
    if (next.revision !== current.revision + 1)
      throw new ApiError("저장 도중 다른 배치 변경이 발생했습니다.", 409)
    current = next
    return result
  }
  const positions = (
    items: (LayoutSeat | LayoutTable)[],
    kind: "seat" | "table",
  ) => items.map((e) => ({ id: serverId(e.id, kind), ...geometry(e) }))
  const put = (layout: Layout) =>
    mutate("/layout", "PUT", {
      expected_version: current.revision,
      canvas_width: layout.canvasWidth,
      canvas_height: layout.canvasHeight,
      seats: positions(layout.seats, "seat"),
      tables: positions(layout.tables, "table"),
    })
  try {
    if (
      target.canvasWidth > current.canvasWidth ||
      target.canvasHeight > current.canvasHeight
    )
      await put({
        ...current,
        canvasWidth: Math.max(target.canvasWidth, current.canvasWidth),
        canvasHeight: Math.max(target.canvasHeight, current.canvasHeight),
      })
    for (const key of ["seats", "tables"] as const) {
      const kind = key === "seats" ? "seat" : "table"
      for (const item of [...current[key]])
        if (!target[key].some((e) => e.id === item.id))
          await mutate(`/${key}/${serverId(item.id, kind)}`, "DELETE")
      // Free changed numbers first, including swaps.
      const used = new Set(
        [...current[key], ...target[key]].map((e) => e.number),
      )
      let temporary = 2147483647
      for (const item of [...current[key]]) {
        const desired = target[key].find((e) => e.id === item.id)
        if (desired && desired.number !== item.number) {
          while (used.has(temporary)) temporary--
          used.add(temporary)
          await mutate(`/${key}/${serverId(item.id, kind)}`, "PATCH", {
            number: temporary--,
          })
        }
      }
    }
    for (const table of target.tables) {
      const old = current.tables.find((e) => e.id === table.id)
      if (!old) {
        const result = object(
          await mutate("/tables", "POST", {
            ...geometry(table),
            number: table.number,
            shape: table.shape === "ellipse" ? "circle" : "rectangle",
          }),
        )
        const temporaryId = table.id
        table.id = `table:${id(result.id)}`
        target.seats.forEach((s) => {
          if (s.tableId === temporaryId) s.tableId = table.id
        })
      } else if (old.number !== table.number || old.shape !== table.shape)
        await mutate(`/tables/${serverId(table.id, "table")}`, "PATCH", {
          number: table.number,
          shape: table.shape === "ellipse" ? "circle" : "rectangle",
        })
    }
    for (const seat of target.seats) {
      const old = current.seats.find((e) => e.id === seat.id)
      const metadata = {
        number: seat.number,
        table_id: seat.tableId ? serverId(seat.tableId, "table") : null,
      }
      if (!old) {
        const result = object(
          await mutate("/seats", "POST", { ...geometry(seat), ...metadata }),
        )
        seat.id = `seat:${id(result.id)}`
      } else if (old.number !== seat.number || old.tableId !== seat.tableId)
        await mutate(`/seats/${serverId(seat.id, "seat")}`, "PATCH", metadata)
    }
    await put(target)
    return current
  } catch (error) {
    if (!attempted) throw error
    throw new ApiError(
      `저장을 완료하지 못했습니다. 일부 변경이 서버에 반영되었을 수 있습니다. 초안을 내려받고 최신 배치를 확인해 주세요. ${messageOf(error)}`,
      error instanceof ApiError && error.status === 401 ? 401 : 409,
    )
  }
}
