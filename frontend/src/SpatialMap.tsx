import { memo, useState, type CSSProperties, type ReactNode } from "react"
import type { Geometry, Layout, LayoutSeat } from "./domain"
import { SeatButton } from "./ui"
import type { SeatStatus } from "./seats"

export function elementStyle(element: Geometry, layout: Layout): CSSProperties {
  return {
    left: `${(element.x / layout.canvasWidth) * 100}%`,
    top: `${(element.y / layout.canvasHeight) * 100}%`,
    width: `${(element.width / layout.canvasWidth) * 100}%`,
    height: `${(element.height / layout.canvasHeight) * 100}%`,
    transform: `rotate(${element.rotation}deg)`,
    "--label-rotation": `${-element.rotation}deg`,
  } as CSSProperties
}
const MappedSeat = memo(function MappedSeat({
  seat,
  status,
  layout,
  selected,
  dimmed,
  onSelect,
}: {
  seat: LayoutSeat
  status: SeatStatus
  layout: Layout
  selected: boolean
  dimmed: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div className="spatial-seat" style={elementStyle(seat, layout)}>
      <SeatButton
        seat={{ id: seat.id, number: seat.number, status }}
        selected={selected}
        dimmed={dimmed}
        onSelect={onSelect}
      />
    </div>
  )
})
export function ZoomControls({
  zoom,
  setZoom,
}: {
  zoom: number
  setZoom: (value: number) => void
}) {
  return (
    <div className="zoom-controls" aria-label="배치도 확대 축소">
      <button
        aria-label="축소"
        onClick={() => setZoom(Math.max(1, zoom - 0.25))}
        disabled={zoom <= 1}
      >
        −
      </button>
      <button onClick={() => setZoom(1)} aria-label="화면에 맞추기">
        {Math.round(zoom * 100)}%
      </button>
      <button
        aria-label="확대"
        onClick={() => setZoom(Math.min(3, zoom + 0.25))}
        disabled={zoom >= 3}
      >
        +
      </button>
    </div>
  )
}
export function SpatialMap({
  layout,
  statuses = {},
  selected,
  onSelect = () => {},
  availableOnly = false,
  controls = true,
  children,
}: {
  layout: Layout
  statuses?: Record<string, SeatStatus>
  selected?: string | null
  onSelect?: (id: string) => void
  availableOnly?: boolean
  controls?: boolean
  children?: ReactNode
}) {
  const [zoom, setZoom] = useState(1)
  return (
    <div className="spatial-view">
      {controls && (
        <div className="spatial-tools">
          <ZoomControls zoom={zoom} setZoom={setZoom} />
        </div>
      )}
      <div
        className="canvas-scroll"
        tabIndex={0}
        aria-label="좌석 배치도. 확대 후 스크롤하거나 방향키로 이동할 수 있습니다."
      >
        <div
          className="spatial-canvas"
          style={{
            width: `${zoom * 100}%`,
            aspectRatio: `${layout.canvasWidth} / ${layout.canvasHeight}`,
          }}
        >
          {layout.tables.map((table) => (
            <div
              key={table.id}
              className={`spatial-table table-${table.shape}`}
              style={elementStyle(table, layout)}
              aria-label={`${table.number}번 테이블`}
            >
              <span>T{table.number}</span>
            </div>
          ))}
          {layout.seats.map((seat) => (
            <MappedSeat
              key={seat.id}
              seat={seat}
              status={statuses[seat.id] ?? "unknown"}
              layout={layout}
              selected={selected === seat.id}
              dimmed={availableOnly && statuses[seat.id] !== "available"}
              onSelect={onSelect}
            />
          ))}
          {children}
        </div>
      </div>
      {controls && (
        <p className="spatial-hint">
          좌석 번호가 안 보이면 확대하세요.
        </p>
      )}
    </div>
  )
}
