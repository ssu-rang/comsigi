import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import type {
  Geometry,
  Layout,
  LayoutSeat,
  LayoutTable,
  Place,
} from "../domain"
import { ApiError } from "../api"
import { service } from "../service"
import { notifyDataChanged, useResource } from "../hooks"
import {
  cloneLayout,
  commit,
  constrain,
  nextNumber,
  redo,
  removeElement,
  sameLayout,
  undo,
  updateElement,
  validateLayout,
  type History,
  type Selection,
} from "../layout"
import { Link, useUnsavedChanges } from "../router"
import { EmptyState, ErrorNotice, Loading, Modal } from "../ui"
import { elementStyle, SpatialMap, ZoomControls } from "../SpatialMap"

export function LayoutEditor({ placeId }: { placeId: string }) {
  const resource = useResource(
    async (signal) => {
      const [place, layout] = await Promise.all([
        service.getPlace(placeId, signal),
        service.getLayout(placeId, signal),
      ])
      return { place, layout }
    },
    [placeId],
  )
  if (resource.loading)
    return (
      <>
        <h1 className="screen-title">배치 편집</h1>
        <Loading label="저장된 배치를 불러오고 있습니다" />
      </>
    )
  if (resource.error)
    return (
      <>
        <h1 className="screen-title">배치 편집</h1>
        <ErrorNotice error={resource.error} retry={resource.reload} />
      </>
    )
  return (
    resource.data && (
      <Editor place={resource.data.place} original={resource.data.layout} />
    )
  )
}
type Gesture = {
  kind: "move" | "resize" | "rotate"
  selection: Selection
  layout: Layout
  element: Geometry
  x: number
  y: number
  angle: number
  pointerId: number
}
function Editor({
  place,
  original,
}: {
  place: Place
  original: Layout
}) {
  const draftKey = `binjari-draft:${service.mode}:${place.id}`
  const [baseline, setBaseline] = useState(original)
  const [restored, setRestored] = useState(false)
  const [history, setHistory] = useState<History>(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(draftKey) ?? "null",
      ) as Layout | null
      if (saved && saved.placeId === place.id && !validateLayout(saved).length)
        return { past: [], present: saved, future: [] }
    } catch {}
    return { past: [], present: cloneLayout(original), future: [] }
  })
  const [selection, setSelection] = useState<Selection | null>(null),
    [tool, setTool] = useState<"select" | "seat" | "table">("select")
  const [preview, setPreview] = useState(false),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false),
    [savedAt, setSavedAt] = useState<string | null>(null),
    [invalidProperty, setInvalidProperty] = useState(false)
  const [remoteChanged, setRemoteChanged] = useState(
    history.present.revision !== original.revision,
  )
  const [comparison, setComparison] = useState<Layout | null>(null),
    [checking, setChecking] = useState(false)
  const [dragPreview, setDragPreview] = useState<Layout | null>(null)
  const canvas = useRef<HTMLDivElement>(null),
    gesture = useRef<Gesture | null>(null),
    dragValue = useRef<Layout | null>(null)
  const historyRef = useRef(history)
  historyRef.current = history
  const busy = useRef(false)
  const layout = dragPreview ?? history.present
  const dirty = !sameLayout(history.present, baseline)
  useUnsavedChanges(dirty)
  useEffect(() => {
    setRestored(!sameLayout(history.present, original))
  }, [])
  useEffect(() => {
    try {
      if (dirty)
        sessionStorage.setItem(draftKey, JSON.stringify(history.present))
      else sessionStorage.removeItem(draftKey)
    } catch {
      /* in-memory draft is still retained */
    }
  }, [dirty, history.present, draftKey])
  useEffect(() => {
    return service.subscribe(place.id, {
      connection: () => {},
      event: (event) => {
        if (event.type === "place_deleted")
          setError(
            new ApiError(
              "이 공간이 삭제되었습니다. 편집 초안을 내려받을 수 있습니다.",
              404,
            ),
          )
        if (
          (event.type === "layout_updated" || event.type === "snapshot") &&
          event.revision > historyRef.current.present.revision &&
          !busy.current
        )
          setRemoteChanged(true)
      },
    })
  }, [place.id])
  const edit = (next: Layout) => {
    if (!busy.current) {
      setHistory((h) => commit(h, next))
      setSavedAt(null)
      setError(null)
    }
  }
  const deleteSelected = () => {
    if (selection && !preview && !busy.current) {
      edit(removeElement(historyRef.current.present, selection))
      setSelection(null)
    }
  }
  async function save() {
    if (busy.current || invalidProperty) return
    const current = historyRef.current.present,
      errors = validateLayout(current)
    if (errors.length) {
      setError(new ApiError(errors.join(" "), 422))
      return
    }
    if (sameLayout(current, baseline)) return
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = await service.saveLayout(cloneLayout(current))
      setBaseline(saved)
      setHistory({ past: [], present: saved, future: [] })
      setSavedAt(new Date().toLocaleTimeString("ko-KR"))
      setRemoteChanged(false)
      setRestored(false)
      sessionStorage.removeItem(draftKey)
      notifyDataChanged()
    } catch (e) {
      setError(e)
      if (e instanceof ApiError && e.status === 409) setRemoteChanged(true)
    } finally {
      busy.current = false
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const input =
        e.target instanceof HTMLElement &&
        e.target.closest(
          'input, textarea, select, [contenteditable="true"], dialog',
        )
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        ;(e.target as HTMLElement)?.blur?.()
        // Blur commits a pending numeric property through React. Save after that
        // render, so Ctrl+S includes the value currently being edited.
        setTimeout(() => void saveRef.current(), 0)
        return
      }
      if (input || busy.current) return
      if (e.key === "Escape") {
        gesture.current = null
        dragValue.current = null
        setDragPreview(null)
        setSelection(null)
        setTool("select")
      }
      if (preview) return
      if (e.key === "Delete") {
        e.preventDefault()
        deleteSelected()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)))
        setError(null)
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [selection, preview])
  function point(clientX: number, clientY: number) {
    const rect = canvas.current!.getBoundingClientRect()
    return {
      x: ((clientX - rect.left) / rect.width) * layout.canvasWidth,
      y: ((clientY - rect.top) / rect.height) * layout.canvasHeight,
    }
  }
  function begin(
    e: ReactPointerEvent<HTMLElement>,
    kind: Gesture["kind"],
    selected: Selection,
  ) {
    if (busy.current || preview || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.focus()
    setSelection(selected)
    setTool("select")
    const current = historyRef.current.present
    const element = (selected.kind === "seat" ? current.seats : current.tables)
      .find((x) => x.id === selected.id)!
    const p = point(e.clientX, e.clientY)
    gesture.current = {
      kind,
      selection: selected,
      layout: current,
      element,
      ...p,
      pointerId: e.pointerId,
      angle: Math.atan2(
        p.y - element.y - element.height / 2,
        p.x - element.x - element.width / 2,
      ),
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function move(e: ReactPointerEvent) {
    const g = gesture.current
    if (!g || e.pointerId !== g.pointerId || !canvas.current) return
    const p = point(e.clientX, e.clientY),
      dx = p.x - g.x,
      dy = p.y - g.y
    let next: Geometry = { ...g.element }
    if (g.kind === "move") {
      next.x += dx
      next.y += dy
    }
    if (g.kind === "resize") {
      const angle = (g.element.rotation * Math.PI) / 180
      next.width += dx * Math.cos(angle) + dy * Math.sin(angle)
      next.height += -dx * Math.sin(angle) + dy * Math.cos(angle)
    }
    if (g.kind === "rotate") {
      const angle = Math.atan2(
        p.y - g.element.y - g.element.height / 2,
        p.x - g.element.x - g.element.width / 2,
      )
      next.rotation += ((angle - g.angle) * 180) / Math.PI
      if (e.shiftKey) next.rotation = Math.round(next.rotation / 15) * 15
    }
    next = constrain(next, layout.canvasWidth, layout.canvasHeight)
    const changed = updateElement(g.layout, g.selection, next)
    dragValue.current = changed
    setDragPreview(changed)
  }
  function end(e: ReactPointerEvent, cancel = false) {
    if (!gesture.current || gesture.current.pointerId !== e.pointerId) return
    if (!cancel && dragValue.current) edit(dragValue.current)
    gesture.current = null
    dragValue.current = null
    setDragPreview(null)
  }
  function add(x: number, y: number) {
    if (tool === "select" || busy.current || preview) {
      setSelection(null)
      return
    }
    const current = historyRef.current.present,
      id = crypto.randomUUID()
    const geometry = constrain(
      {
        x,
        y,
        width: tool === "seat" ? 44 : 160,
        height: tool === "seat" ? 44 : 90,
        rotation: 0,
      },
      layout.canvasWidth,
      layout.canvasHeight,
    )
    edit(
      tool === "seat"
        ? {
            ...current,
            seats: [
              ...current.seats,
              {
                ...geometry,
                id,
                number: nextNumber(current.seats),
                tableId: null,
              },
            ],
          }
        : {
            ...current,
            tables: [
              ...current.tables,
              {
                ...geometry,
                id,
                number: nextNumber(current.tables),
                shape: "rectangle",
              },
            ],
          },
    )
    setSelection({ kind: tool, id })
    setTool("select")
  }
  function exportDraft() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(historyRef.current.present, null, 2)], {
        type: "application/json",
      }),
    )
    const a = document.createElement("a")
    a.href = url
    a.download = `${place.slug}-draft.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const selectedElement = selection
    ? (selection.kind === "seat" ? layout.seats : layout.tables).find(
        (e) => e.id === selection.id,
      )
    : null
  return (
    <>
      <div className="page-heading editor-heading">
        <div>
          <h1>{place.name} 배치</h1>
          <p role="status">
            {saving
              ? "저장 중…"
              : dirty
                ? "저장하지 않은 변경사항"
                : savedAt
                  ? `${savedAt} 저장됨`
                  : "모든 변경사항 저장됨"}{" "}
            · 버전 {history.present.revision}
          </p>
        </div>
        <div className="row-actions">
          <Link
            className="secondary-button"
            to={`/places/${place.id}`}
            target="_blank"
          >
            사용자 화면 ↗
          </Link>
          <button
            className="primary-button"
            disabled={saving || !dirty || invalidProperty || !!gesture.current}
            onClick={() => void save()}
          >
            배치 저장
          </button>
        </div>
      </div>
      <ErrorNotice error={error} />
      {restored && (
        <div className="notice" role="status">
          이 탭에 보관된 편집 초안을 복원했습니다.
        </div>
      )}
      {remoteChanged && (
        <div className="notice conflict-notice" role="alert">
          <p>서버의 최신 배치를 확인해야 합니다. 현재 초안은 유지됩니다.</p>
          <div className="row-actions">
            <button
              className="secondary-button"
              disabled={checking}
              onClick={async () => {
                setChecking(true)
                try {
                  setComparison(await service.getLayout(place.id))
                } catch (e) {
                  setError(e)
                } finally {
                  setChecking(false)
                }
              }}
            >
              최신 배치 확인
            </button>
            <button className="secondary-button" onClick={exportDraft}>
              내 초안 내려받기
            </button>
          </div>
        </div>
      )}
      <div className="mobile-editor-notice notice">
        배치 편집은 넓은 화면과 마우스 사용을 권장합니다. 숫자 속성으로도 모든
        요소를 수정할 수 있습니다.
      </div>
      <div className="editor-toolbar">
        <div className="row-actions">
          <button
            className="secondary-button"
            disabled={!history.past.length || saving || preview}
            onClick={() => setHistory(undo)}
          >
            실행 취소
          </button>
          <button
            className="secondary-button"
            disabled={!history.future.length || saving || preview}
            onClick={() => setHistory(redo)}
          >
            다시 실행
          </button>
          <button
            className="secondary-button"
            aria-pressed={preview}
            disabled={saving}
            onClick={() => {
              setPreview((v) => !v)
              setSelection(null)
              setTool("select")
            }}
          >
            {preview ? "편집으로 돌아가기" : "미리보기"}
          </button>
        </div>
        <ZoomControls zoom={zoom} setZoom={setZoom} />
      </div>
      {preview ? (
        <section className="admin-panel editor-preview">
          <h2>저장 전 배치 미리보기</h2>
          <p>
            좌석 상태는 표시하지 않습니다. 실제 현황은 저장 후 사용자 화면에서
            확인하세요.
          </p>
          <SpatialMap layout={layout} />
        </section>
      ) : (
        <div className="editor-workspace">
          <aside className="editor-palette">
            <h2>배치 도구</h2>
            <div className="tool-buttons">
              {(["select", "seat", "table"] as const).map((t) => (
                <button
                  key={t}
                  className="secondary-button"
                  aria-pressed={tool === t}
                  disabled={saving}
                  onClick={() => {
                    setTool(t)
                    setSelection(null)
                  }}
                >
                  {t === "select"
                    ? "선택"
                    : t === "seat"
                      ? "+ 좌석 추가"
                      : "+ 테이블 추가"}
                </button>
              ))}
              <button
                className="secondary-button danger-text"
                disabled={!selectedElement || saving}
                onClick={deleteSelected}
              >
                선택 요소 삭제
              </button>
            </div>
            <h2>
              요소 <span>{layout.seats.length + layout.tables.length}</span>
            </h2>
            <div className="element-list">
              {layout.tables.map((e) => (
                <button
                  key={e.id}
                  aria-pressed={selection?.id === e.id}
                  onClick={() => {
                    setSelection({ kind: "table", id: e.id })
                    setTool("select")
                  }}
                >
                  테이블 {e.number}
                </button>
              ))}
              {layout.seats
                .slice()
                .sort((a, b) => a.number - b.number)
                .map((e) => (
                  <button
                    key={e.id}
                    aria-pressed={selection?.id === e.id}
                    onClick={() => {
                      setSelection({ kind: "seat", id: e.id })
                      setTool("select")
                    }}
                  >
                    좌석 {e.number}
                  </button>
                ))}
            </div>
          </aside>
          <section className="editor-stage" aria-label="배치 편집 캔버스">
            <div className="canvas-heading">
              <h2>
                {tool === "seat"
                  ? "좌석을 놓을 위치 선택"
                  : tool === "table"
                    ? "테이블을 놓을 위치 선택"
                    : "공간 배치"}
              </h2>
              <span>
                {layout.canvasWidth} × {layout.canvasHeight}
              </span>
            </div>
            <div className="canvas-scroll editor-scroll">
              <div
                ref={canvas}
                className={`spatial-canvas editable-canvas tool-${tool}`}
                style={{
                  width: `${zoom * 100}%`,
                  aspectRatio: `${layout.canvasWidth} / ${layout.canvasHeight}`,
                }}
                tabIndex={0}
                aria-label="배치 편집 영역. 추가 도구 선택 후 클릭하거나 Enter로 중앙에 추가합니다."
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    const p = point(e.clientX, e.clientY)
                    add(p.x, p.y)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && e.key === "Enter") {
                    e.preventDefault()
                    add(layout.canvasWidth / 2, layout.canvasHeight / 2)
                  }
                }}
              >
                {[
                  ...layout.tables.map((element) => ({
                    element,
                    kind: "table" as const,
                  })),
                  ...layout.seats.map((element) => ({
                    element,
                    kind: "seat" as const,
                  })),
                ].map(({ element, kind }) => {
                  const active =
                    selection?.id === element.id && selection.kind === kind
                  const selected: Selection = { kind, id: element.id }
                  return (
                    <div
                      key={element.id}
                      role="button"
                      tabIndex={saving ? -1 : 0}
                      aria-label={`${
                        kind === "seat" ? "좌석" : "테이블"
                      } ${element.number} 선택`}
                      aria-pressed={active}
                      className={`editor-element ${
                        kind === "seat"
                          ? "editor-seat"
                          : `editor-table table-${(element as LayoutTable).shape}`
                      } ${active ? "selected-element" : ""}`}
                      style={elementStyle(element, layout)}
                      data-element-id={element.id}
                      onPointerDown={(e) => begin(e, "move", selected)}
                      onPointerMove={move}
                      onPointerUp={(e) => end(e)}
                      onPointerCancel={(e) => end(e, true)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          setSelection(selected)
                        }
                      }}
                    >
                      <span>
                        {kind === "table" ? "T" : ""}
                        {element.number}
                      </span>
                      {active && (
                        <>
                          <button
                            className="resize-handle"
                            aria-label="크기 변경 핸들. 숫자 속성으로도 변경 가능"
                            onPointerDown={(e) => begin(e, "resize", selected)}
                            onPointerMove={move}
                            onPointerUp={(e) => end(e)}
                            onPointerCancel={(e) => end(e, true)}
                          />
                          <button
                            className="rotate-handle"
                            aria-label="회전 핸들. Shift로 15도 단위 회전"
                            onPointerDown={(e) => begin(e, "rotate", selected)}
                            onPointerMove={move}
                            onPointerUp={(e) => end(e)}
                            onPointerCancel={(e) => end(e, true)}
                          >
                            ↻
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
                {!layout.seats.length && !layout.tables.length && (
                  <p className="canvas-empty">
                    좌석 또는 테이블 추가를 선택한 뒤<br />
                    배치도에서 놓을 위치를 클릭하세요.
                  </p>
                )}
              </div>
            </div>
            <p className="editor-caption">
              좌석 {layout.seats.length}개 · 테이블 {layout.tables.length}개{" "}
              <span>
                Delete 삭제 · Ctrl+Z 취소 · Ctrl+Shift+Z 다시 실행 · Ctrl+S 저장
              </span>
            </p>
          </section>
          <aside className="property-panel">
            <h2>요소 속성</h2>
            {selectedElement && selection ? (
              <Properties
                key={`${selection.kind}-${selection.id}`}
                element={selectedElement}
                selection={selection}
                layout={layout}
                disabled={saving || !!gesture.current}
                onValid={setInvalidProperty}
                onCommit={(patch) =>
                  edit(
                    updateElement(historyRef.current.present, selection, patch),
                  )
                }
              />
            ) : (
              <div className="property-empty">
                <p>요소를 선택하세요.</p>
                <span>
                  배치도 또는 요소 목록에서 선택하면 번호, 좌표, 크기와 회전각을
                  수정할 수 있습니다.
                </span>
              </div>
            )}
            <Link className="inline-link" to="/admin/devices">
              장치와 담당 좌석 관리 →
            </Link>
          </aside>
        </div>
      )}
      {comparison && (
        <Modal title="최신 배치 확인" onClose={() => setComparison(null)}>
          <p>
            내 초안: 버전 {history.present.revision} · 좌석{" "}
            {history.present.seats.length}개<br />
            최신 저장: 버전 {comparison.revision} · 좌석{" "}
            {comparison.seats.length}개
          </p>
          <SpatialMap layout={comparison} />
          <p className="notice">
            최신 배치로 다시 시작하면 현재 초안이 교체됩니다. 필요한 경우 먼저
            내려받으세요.
          </p>
          <div className="form-actions">
            <button className="secondary-button" onClick={exportDraft}>
              초안 내려받기
            </button>
            <button
              className="secondary-button"
              onClick={() => setComparison(null)}
            >
              계속 편집
            </button>
            <button
              className="primary-button"
              onClick={() => {
                if (
                  !window.confirm(
                    "현재 초안을 최신 저장 배치로 교체하시겠습니까?",
                  )
                )
                  return
                setHistory({ past: [], present: comparison, future: [] })
                setBaseline(comparison)
                setComparison(null)
                setSelection(null)
                setRemoteChanged(false)
                setRestored(false)
                setError(null)
              }}
            >
              최신 배치로 다시 시작
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function Properties({
  element,
  selection,
  layout,
  disabled,
  onCommit,
  onValid,
}: {
  element: LayoutSeat | LayoutTable
  selection: Selection
  layout: Layout
  disabled: boolean
  onCommit: (patch: Partial<LayoutSeat & LayoutTable>) => void
  onValid: (invalid: boolean) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({}),
    [errors, setErrors] = useState<string[]>([])
  useEffect(() => {
    setValues(
      Object.fromEntries(
        ["number", "x", "y", "width", "height", "rotation"].map((key) => [
          key,
          String(
            Math.round(Number(element[(key as keyof typeof element)]) * 100) /
              100,
          ),
        ]),
      ),
    )
    setErrors([])
    onValid(false)
  }, [element])
  useEffect(() => () => onValid(false), [])
  const numericPatch = (next: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(next).map(([k, v]) => [
        k,
        v.trim() === "" ? NaN : Number(v),
      ]),
    )
  function validate(next: Record<string, string>) {
    const errors = validateLayout(
      updateElement(layout, selection, numericPatch(next)),
    )
    setErrors(errors)
    onValid(errors.length > 0)
    return errors
  }
  return (
    <fieldset disabled={disabled} className="properties">
      <p className="selected-caption">
        {selection.kind === "seat" ? "좌석" : "테이블"} {element.number}
      </p>
      {(["number", "x", "y", "width", "height", "rotation"] as const).map(
        (key) => (
          <label className="field" key={key}>
            {
              {
                number: "번호",
                x: "X 좌표",
                y: "Y 좌표",
                width: "너비",
                height: "높이",
                rotation: "회전각 (°)",
              }[key]
            }
            <input
              data-property={key}
              type="number"
              value={values[key] ?? ""}
              min={
                key === "number"
                  ? 1
                  : key === "width" || key === "height"
                    ? 20
                    : undefined
              }
              max={key === "rotation" ? 359.99 : undefined}
              step={key === "number" ? 1 : 0.01}
              aria-invalid={errors.length > 0}
              aria-describedby={errors.length ? "property-errors" : undefined}
              onChange={(e) => {
                const next = { ...values, [key]: e.target.value }
                setValues(next)
                validate(next)
              }}
              onBlur={() => {
                if (!validate(values).length) onCommit(numericPatch(values))
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
              }}
            />
          </label>
        ),
      )}
      {selection.kind === "table" ? (
        <label className="field wide-field">
          테이블 형태
          <select
            value={(element as LayoutTable).shape}
            onChange={(e) =>
              onCommit({ shape: e.target.value as LayoutTable["shape"] })
            }
          >
            <option value="rectangle">직사각형</option>
            <option value="ellipse">타원</option>
          </select>
        </label>
      ) : (
        <label className="field wide-field">
          연결된 테이블
          <select
            value={(element as LayoutSeat).tableId ?? ""}
            onChange={(e) => onCommit({ tableId: e.target.value || null })}
          >
            <option value="">연결 안 함</option>
            {layout.tables.map((t) => (
              <option key={t.id} value={t.id}>
                테이블 {t.number}
              </option>
            ))}
          </select>
        </label>
      )}
      {errors.length > 0 && (
        <div id="property-errors" className="property-errors" role="alert">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      <p className="field-help wide-field">
        테이블을 이동해도 연결된 좌석은 이동하지 않습니다. 테이블을 삭제하면
        좌석의 연결만 해제됩니다.
      </p>
    </fieldset>
  )
}
