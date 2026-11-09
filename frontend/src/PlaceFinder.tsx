import { useCallback, useEffect, useMemo, useState } from "react"
import { countSeats } from "./seats"
import type { Summary } from "./domain"
import { STATUS_LABEL, timestamp } from "./domain"
import { service } from "./service"
import { useDataRefresh, useLive, useResource } from "./hooks"
import { visibleSeats } from "./realtime"
import { Link, navigate } from "./router"
import {
  EmptyState,
  ErrorNotice,
  Icon,
  Loading,
  SeatButton,
  Swatch,
} from "./ui"
import { SpatialMap } from "./SpatialMap"

export function PlaceFinder({
  placeId,
  favoritesOnly,
}: {
  placeId?: string
  favoritesOnly: boolean
}) {
  const places = useResource((signal) => service.listPlaces(signal))
  useDataRefresh(places.reload)
  const [query, setQuery] = useState(""),
    [placesOpen, setPlacesOpen] = useState(false)
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("binjari-favorites") ?? "[]",
      )
      return Array.isArray(saved)
        ? saved.filter((x) => typeof x === "string")
        : []
    } catch {
      return []
    }
  })
  const [liveSummary, setLiveSummary] = useState<{
    id: string
    counts: Summary
  } | null>(null)
  const updateSummary = useCallback(
    (id: string, counts: Summary) => setLiveSummary({ id, counts }),
    [],
  )
  const selected = places.data?.find((p) => p.id === placeId)
  const shown =
    places.data?.filter(
      (p) =>
        (!favoritesOnly || favorites.includes(p.id)) &&
        `${p.name} ${p.slug} ${p.description}`.includes(query.trim()),
    ) ?? []
  useEffect(() => {
    try {
      localStorage.setItem("binjari-favorites", JSON.stringify(favorites))
    } catch {}
  }, [favorites])
  useEffect(() => {
    setPlacesOpen(favoritesOnly || !placeId)
  }, [favoritesOnly, placeId])
  const toggleFavorite = () => {
    if (placeId)
      setFavorites((ids) =>
        ids.includes(placeId)
          ? ids.filter((id) => id !== placeId)
          : [...ids, placeId],
      )
  }
  return (
    <>
      <div className="page-heading flex items-end justify-between gap-4">
        <div>
          <h1>캠퍼스의 빈자리</h1>
          <p>찾아가기 전에, 빈자리부터 확인하세요.</p>
        </div>
        <button
          className="secondary-button"
          onClick={places.reload}
          disabled={places.loading}
        >
          <Icon name="refresh" size={15} />
          목록 새로고침
        </button>
      </div>
      <div className="workspace">
        <aside
          className={`places-panel ${placesOpen ? "is-open" : ""}`}
          aria-label="공간 선택"
        >
          <button
            className="mobile-place-toggle"
            aria-expanded={placesOpen}
            aria-controls="places-content"
            onClick={() => setPlacesOpen((v) => !v)}
          >
            <span>{selected?.name ?? "공간 찾기"}</span>
            <span>
              공간 변경
              <Icon name="chevron" size={14} />
            </span>
          </button>
          <div id="places-content" className="places-content">
            <div className="places-heading flex items-center justify-between">
              <h2>
                공간 찾기 <span>{places.data?.length ?? "–"}</span>
              </h2>
              <Icon name="pin" size={16} />
            </div>
            <label className="search-field flex items-center gap-2">
              <Icon name="search" size={16} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="공간 이름 검색"
                aria-label="공간 검색"
              />
            </label>
            <div className="place-filters flex">
              <button
                className={!favoritesOnly ? "selected" : ""}
                aria-pressed={!favoritesOnly}
                onClick={() => navigate("/")}
              >
                전체 공간
              </button>
              <button
                className={favoritesOnly ? "selected" : ""}
                aria-pressed={favoritesOnly}
                onClick={() => navigate("/favorites")}
              >
                <Icon name="star" size={14} />
                즐겨찾기
              </button>
            </div>
            {places.loading ? (
              <Loading label="공간 목록을 불러오고 있습니다" />
            ) : places.error ? (
              <div className="empty-places">
                <p>공간 목록을 표시할 수 없습니다.</p>
                <span>공간 현황 안내를 확인해 주세요.</span>
              </div>
            ) : (
              <div className="room-list">
                {shown.map((place) => {
                  const total =
                    liveSummary?.id === place.id && place.id === placeId
                      ? liveSummary.counts
                      : place.summary
                  return (
                    <Link
                      key={place.id}
                      to={`/places/${place.id}`}
                      className={`room-item ${
                        place.id === placeId ? "selected" : ""
                      }`}
                      aria-current={place.id === placeId ? "page" : undefined}
                      onClick={() => setPlacesOpen(false)}
                    >
                      <span className="room-meta">
                        {place.slug}
                        {favorites.includes(place.id) && (
                          <Icon name="star" size={12} />
                        )}
                      </span>
                      <span className="room-name-row">
                        <span>{place.name}</span>
                        <Icon name="chevron" size={14} />
                      </span>
                      <span className="room-count-row">
                        <span className="condition">
                          {total.unknown === total.total
                            ? "확인 불가"
                            : "이용 가능"}
                        </span>
                        <span>
                          <b>{total.available}</b> / {total.total}석
                        </span>
                      </span>
                    </Link>
                  )
                })}
                {!shown.length && (
                  <div className="empty-places">
                    <p>
                      {places.data?.length
                        ? favoritesOnly
                          ? "저장한 공간이 없습니다."
                          : "검색 결과가 없습니다."
                        : "등록된 공간이 없습니다."}
                    </p>
                    {query && (
                      <button
                        className="text-button"
                        onClick={() => setQuery("")}
                      >
                        검색 지우기
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {!places.error && (
              <div className="campus-total">
                <span>선택한 공간은 실시간으로 갱신됩니다.</span>
                <p className="list-freshness">
                  나머지 공간은 목록 조회 시점 기준입니다.
                </p>
              </div>
            )}
          </div>
        </aside>
        <section className="room-panel" aria-label="공간 좌석 현황">
          {places.error ? (
            <>
              <div className="room-header">
                <h2>공간 현황</h2>
              </div>
              <ErrorNotice error={places.error} retry={places.reload} />
            </>
          ) : placeId ? (
            <PlaceDetail
              key={placeId}
              id={placeId}
              favorite={favorites.includes(placeId)}
              toggleFavorite={toggleFavorite}
              onSummary={updateSummary}
              onChange={places.reload}
            />
          ) : places.loading ? (
            <Loading />
          ) : (
            <EmptyState
              title={
                places.data?.length
                  ? "공간을 선택해 주세요"
                  : "등록된 공간이 없습니다"
              }
            >
              {places.data?.length
                ? "공간 목록에서 좌석 현황을 확인할 장소를 선택하세요."
                : "공간이 등록되면 좌석 배치와 이용 현황이 표시됩니다."}
            </EmptyState>
          )}
        </section>
      </div>
    </>
  )
}
function PlaceDetail({
  id,
  favorite,
  toggleFavorite,
  onSummary,
  onChange,
}: {
  id: string
  favorite: boolean
  toggleFavorite: () => void
  onSummary: (id: string, counts: Summary) => void
  onChange: () => void
}) {
  const resource = useResource(
    async (signal) => {
      const [place, layout] = await Promise.all([
        service.getPlace(id, signal),
        service.getLayout(id, signal),
      ])
      return { place, layout }
    },
    [id],
  )
  const { live, connection, deleted, now, reconnect } = useLive(
    id,
    resource.reload,
    resource.data?.layout.revision,
  )
  const [selected, setSelected] = useState<string | null>(null),
    [availableOnly, setAvailableOnly] = useState(false),
    [view, setView] = useState<"map" | "list">("map")
  const seats = useMemo(
    () =>
      resource.data
        ? visibleSeats(
            resource.data.layout,
            live,
            connection,
            now,
          )
        : [],
    [resource.data, live, connection, now],
  )
  const counts = useMemo(
    () => countSeats(seats.map((s) => ({ id: 0, status: s.status }))),
    [seats],
  )
  useEffect(() => {
    if (resource.data) onSummary(id, counts)
  }, [id, resource.data, counts, onSummary])
  useEffect(() => {
    if (deleted) onChange()
  }, [deleted, onChange])
  const onSelect = useCallback((id: string) => setSelected(id), [])
  if (deleted)
    return (
      <EmptyState
        title="삭제된 공간입니다"
        action={
          <Link className="primary-button" to="/">
            공간 목록으로
          </Link>
        }
      >
        다른 공간을 선택해 주세요.
      </EmptyState>
    )
  if (resource.loading)
    return <Loading label="공간과 배치를 불러오고 있습니다" />
  if (resource.error)
    return <ErrorNotice error={resource.error} retry={resource.reload} />
  if (!resource.data) return null
  const { place } = resource.data
  const layout = resource.data.layout
  const chosen = seats.find((s) => s.id === selected)
  const times = Object.values(live.occupancy)
    .map((r) => r.observedAt)
    .filter((t): t is string => !!t)
    .sort()
  const observed = times[times.length - 1]
  const online = connection === "live",
    stale = seats.some((s) => s.status === "unknown")
  return (
    <>
      <header className="room-header">
        <div>
          <p className="room-location">{place.slug}</p>
          <div className="flex items-center gap-3">
            <h2 id="room-title">{place.name}</h2>
            <button
              className={`favorite-button ${favorite ? "is-saved" : ""}`}
              aria-label={`${place.name} 즐겨찾기 ${
                favorite ? "해제" : "추가"
              }`}
              aria-pressed={favorite}
              onClick={toggleFavorite}
            >
              <Icon name="star" size={20} />
            </button>
          </div>
          <p className="room-description">{place.description}</p>
        </div>
        <div className="room-freshness">
          <span className="freshness-label">
            <span className={`status-dot ${online ? "" : "offline"}`} />
            {online
              ? import.meta.env.DEV && service.mode === "development"
                ? "개발 연결됨"
                : "서버 연결됨"
              : connection === "reconnecting"
                ? "재연결 중"
                : connection === "syncing"
                  ? "상태 동기화 중"
                  : connection === "unsupported"
                    ? "연결 준비 중"
                    : "연결 대기"}
          </span>
          <button
            className="refresh-button flex items-center gap-1.5"
            onClick={() => {
              resource.reload()
              reconnect()
              onChange()
            }}
          >
            새로고침
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </header>
      <div className="seat-summary" aria-label="선택한 공간의 좌석 수">
        <div className="available-stat">
          <span className="stat-label">
            <Swatch status="available" />
            이용 가능한 좌석
          </span>
          <p>
            <b>{counts.available}</b>
            <span> / {counts.total}석</span>
          </p>
        </div>
        <div className="secondary-stat">
          <span className="stat-label">
            <Swatch status="occupied" />
            사용 중
          </span>
          <p>
            {counts.occupied}
            <small>석</small>
          </p>
        </div>
        <div className="secondary-stat">
          <span className="stat-label">
            <Swatch status="unknown" />
            확인 불가
          </span>
          <p>
            {counts.unknown}
            <small>석</small>
          </p>
        </div>
        <div className="availability-note">
          <span>이용률</span>
          <p>{counts.utilization === null ? "–" : `${counts.utilization}%`}</p>
        </div>
      </div>
      <div className="freshness-note" role="status">
        <span>마지막 감지: {timestamp(observed)}</span>
        <span>
          {!online
            ? "연결 중단 · 현재 점유 상태를 확인할 수 없습니다."
            : stale
              ? "미수신 또는 오래된 좌석 정보는 확인 불가로 표시합니다."
              : "최근 감지 정보가 표시됩니다."}
        </span>
        <span>
          이용률 {counts.utilization === null ? "–" : `${counts.utilization}%`}{" "}
          · 확인된 좌석 기준
        </span>
      </div>
      <div className="map-toolbar flex items-center justify-between gap-3">
        <div className="view-switch flex" aria-label="좌석 보기 방식">
          <button
            aria-pressed={view === "map"}
            className={view === "map" ? "active" : ""}
            onClick={() => setView("map")}
          >
            좌석 배치도
          </button>
          <button
            aria-pressed={view === "list"}
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
          >
            번호순 보기
          </button>
        </div>
        <label className="available-filter flex items-center gap-2">
          <input
            type="checkbox"
            checked={availableOnly}
            onChange={(e) => setAvailableOnly(e.target.checked)}
          />
          빈자리만 보기
        </label>
      </div>
      {!layout.seats.length && !layout.tables.length ? (
        <EmptyState title="등록된 배치가 없습니다">
          관리자가 좌석과 테이블을 배치하면 여기에 표시됩니다.
        </EmptyState>
      ) : view === "map" ? (
        <SpatialMap
          layout={layout}
          statuses={Object.fromEntries(seats.map((s) => [s.id, s.status]))}
          selected={selected}
          onSelect={onSelect}
          availableOnly={availableOnly}
        />
      ) : (
        <div className="number-view" aria-label="번호순 좌석 목록">
          {seats
            .filter((s) => !availableOnly || s.status === "available")
            .sort((a, b) => a.number - b.number)
            .map((seat) => (
              <SeatButton
                key={seat.id}
                seat={seat}
                selected={seat.id === selected}
                onSelect={onSelect}
              />
            ))}
          {!seats.some((s) => !availableOnly || s.status === "available") && (
            <p className="no-seats">
              {seats.length
                ? "이용 가능한 좌석이 없습니다."
                : "등록된 좌석이 없습니다."}
            </p>
          )}
        </div>
      )}
      <div className="seat-detail" role="status">
        {chosen ? (
          <>
            <span className="flex items-center gap-2">
              <Icon name="chair" size={17} />
              <b>{chosen.number}번 좌석</b>
              <Swatch status={chosen.status} />
              <span>{STATUS_LABEL[chosen.status]}</span>
            </span>
            <span className="detail-description">
              {chosen.tableId
                ? `테이블 ${layout.tables.find((t) => t.id === chosen.tableId)?.number ?? "–"}`
                : "연결된 테이블 없음"}
            </span>
            <button
              className="close-detail"
              aria-label="좌석 선택 해제"
              onClick={() => setSelected(null)}
            >
              <Icon name="close" size={16} />
            </button>
          </>
        ) : (
          <span>좌석을 선택하면 상태를 확인할 수 있어요.</span>
        )}
      </div>
      <div className="room-facts">
        <span>
          전체 {layout.seats.length}석 · 테이블 {layout.tables.length}개
        </span>
        <span>저장된 배치 버전 {layout.revision}</span>
      </div>
    </>
  )
}
