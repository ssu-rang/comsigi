import { useState } from "react"
import type { Place, PlaceInput } from "../domain"
import { timestamp } from "../domain"
import { service } from "../service"
import { useDataRefresh, useResource, notifyDataChanged } from "../hooks"
import { EmptyState, ErrorNotice, Loading, Modal } from "../ui"
import { Link, navigate } from "../router"

export function PlacesAdmin() {
  const places = useResource((signal) => service.listPlaces(signal))
  useDataRefresh(places.reload)
  const [editing, setEditing] = useState<Place | "new" | null>(null)
  const [deleting, setDeleting] = useState<Place | null>(null)
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false)
  return (
    <>
      <div className="page-heading flex items-end justify-between gap-4">
        <h1>공간 관리</h1>
        <button className="primary-button" onClick={() => setEditing("new")}>
          공간 만들기
        </button>
      </div>
      <ErrorNotice error={places.error || error} retry={places.reload} />
      <section className="admin-panel" aria-label="등록된 공간">
        <div className="section-heading">
          <h2>
            등록된 공간 <span>{places.data?.length ?? "–"}</span>
          </h2>
          <button
            className="secondary-button"
            onClick={places.reload}
            disabled={places.loading}
          >
            새로고침
          </button>
        </div>
        {places.loading ? (
          <Loading />
        ) : places.data?.length ? (
          <div className="table-scroll" tabIndex={0} aria-label="공간 목록. 표가 화면보다 넓으면 가로로 스크롤할 수 있습니다.">
            <table className="data-table places-table">
              <thead>
                <tr>
                  <th>공간</th>
                  <th className="num">전체 / 이용 가능</th>
                  <th>장치 상태</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {places.data.map((place) => (
                  <tr key={place.id}>
                    <td data-label="공간">
                      <Link
                        className="identity-link"
                        to={`/places/${place.id}`}
                      >
                        {place.name}
                      </Link>
                      <small>{place.slug}</small>
                      <small className="record-id" title={place.id}>
                        ID {place.id}
                      </small>
                    </td>
                    <td className="num" data-label="전체 / 이용 가능">
                      {place.summary.total} / {place.summary.available}석
                      <small>조회 {timestamp(place.summaryAt)}</small>
                    </td>
                    <td data-label="장치 상태">
                      <span className="condition">
                        {place.deviceStatus === "none"
                          ? "등록된 장치 없음"
                          : place.deviceStatus === "online"
                            ? "수신 중"
                            : "수신 대기"}
                      </span>
                    </td>
                    <td data-label="관리">
                      <div className="row-actions">
                        <Link
                          className="secondary-button"
                          to={`/admin/layout/${place.id}`}
                        >
                          배치 편집
                        </Link>
                        {service.provisioning && (
                          <Link
                            className="secondary-button"
                            to={`/admin/setup/${place.id}`}
                          >
                            카메라 연결
                          </Link>
                        )}
                        <button onClick={() => setEditing(place)}>설정</button>
                        <button
                          className="danger-text"
                          onClick={() => setDeleting(place)}
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !places.error && (
            <EmptyState
              title="등록된 공간이 없습니다"
              action={
                <button
                  className="primary-button"
                  onClick={() => setEditing("new")}
                >
                  첫 공간 만들기
                </button>
              }
            >
              공간을 만든 다음 좌석과 테이블을 배치하세요.
            </EmptyState>
          )
        )}
      </section>
      {editing && (
        <PlaceForm
          place={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(place) => {
            const creating = editing === "new"
            setEditing(null)
            places.reload()
            notifyDataChanged()
            // The server issues the place ID; continue in the resumable setup flow.
            if (creating)
              navigate(
                service.provisioning
                  ? `/admin/setup/${place.id}`
                  : `/admin/layout/${place.id}`,
              )
          }}
        />
      )}
      {deleting && (
        <Modal
          title="공간 삭제"
          onClose={() => {
            if (!busy) setDeleting(null)
          }}
        >
          <p>
            <strong>{deleting.name}</strong> 공간을 삭제하시겠습니까?
          </p>
          <p className="notice">
            {service.mode === "development"
              ? "개발 데이터의 좌석, 테이블, 연결된 장치 설정도 함께 삭제됩니다. 삭제한 공간은 복원할 수 없습니다."
              : "삭제 영향과 정책은 서버 계약 확인 후 연결됩니다."}
          </p>
          <ErrorNotice error={error} />
          <div className="form-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              취소
            </button>
            <button
              className="primary-button danger-button"
              disabled={busy}
              onClick={async () => {
                if (busy) return
                setBusy(true)
                setError(null)
                try {
                  await service.deletePlace(deleting.id, deleting.revision)
                  setDeleting(null)
                  places.reload()
                  notifyDataChanged()
                } catch (e) {
                  setError(e)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? "삭제 중…" : "공간 삭제"}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
function PlaceForm({
  place,
  onClose,
  onSaved,
}: {
  place: Place | null
  onClose: () => void
  onSaved: (place: Place) => void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null)
  return (
    <Modal
      title={place ? "공간 설정" : "공간 만들기"}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          const f = new FormData(e.currentTarget)
          const input: PlaceInput = {
            name: String(f.get("name")).trim(),
            slug: String(f.get("slug")).trim(),
            description: String(f.get("description")).trim(),
            canvasWidth: Number(f.get("canvasWidth")),
            canvasHeight: Number(f.get("canvasHeight")),
          }
          setBusy(true)
          setError(null)
          try {
            onSaved(
              place
                ? await service.updatePlace(place.id, input, place.revision)
                : await service.createPlace(input),
            )
          } catch (error) {
            setError(error)
          } finally {
            setBusy(false)
          }
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            공간 이름
            <input
              name="name"
              defaultValue={place?.name}
              required
              maxLength={100}
              autoFocus
            />
          </label>
          <label className="field">
            URL 식별자
            <input
              name="slug"
              defaultValue={place?.slug}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              aria-describedby="slug-hint"
            />
            <small id="slug-hint">
              영문 소문자, 숫자, 하이픈을 사용하세요. 예: reading-room
            </small>
          </label>
          <label className="field">
            설명
            <textarea
              name="description"
              defaultValue={place?.description}
              rows={3}
              maxLength={1000}
            />
          </label>
          <div className="field-pair">
            <label className="field">
              캔버스 너비
              <input
                name="canvasWidth"
                type="number"
                min={100}
                max={10000}
                step={1}
                required
                defaultValue={place?.canvasWidth ?? 1000}
              />
            </label>
            <label className="field">
              캔버스 높이
              <input
                name="canvasHeight"
                type="number"
                min={100}
                max={10000}
                step={1}
                required
                defaultValue={place?.canvasHeight ?? 700}
              />
            </label>
          </div>
          <p className="field-help">
            논리 좌표 단위입니다. 크기를 바꾸어도 요소는 자동 확대·축소되지
            않습니다. 기존 요소가 범위를 벗어나면 저장할 수 없습니다.
          </p>
        </fieldset>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            취소
          </button>
          <button className="primary-button" disabled={busy}>
            {busy
              ? "저장 중…"
              : place
                ? "변경사항 저장"
                : service.provisioning
                  ? "만들고 카메라 연결하기"
                  : "만들고 배치하기"}
          </button>
        </div>
      </form>
    </Modal>
  )
}
