import { useState } from "react"
import type { Device, DeviceInput, Place } from "../domain"
import { timestamp } from "../domain"
import { service } from "../service"
import { notifyDataChanged, useDataRefresh, useResource } from "../hooks"
import { EmptyState, ErrorNotice, Loading, Modal } from "../ui"
import { Link } from "../router"

export function DevicesAdmin() {
  const resource = useResource(async (signal) => {
    const [devices, places] = await Promise.all([
      service.listDevices(signal),
      service.listPlaces(signal),
    ])
    return { devices, places }
  })
  useDataRefresh(resource.reload)
  const [editing, setEditing] = useState<Device | "new" | null>(null),
    [token, setToken] = useState<string | null>(null)
  const [rotating, setRotating] = useState<Device | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null)
  return (
    <>
      <div className="page-heading flex items-end justify-between gap-4">
        <div>
          <h1>장치 관리</h1>
          <p>감지 장치와 공간의 좌석 번호를 연결합니다.</p>
        </div>
        <button
          className="primary-button"
          disabled={!resource.data?.places.length}
          onClick={() => setEditing("new")}
        >
          장치 등록
        </button>
      </div>
      <ErrorNotice error={resource.error || error} retry={resource.reload} />
      <section className="admin-panel">
        <div className="section-heading">
          <h2>
            감지 장치 <span>{resource.data?.devices.length ?? "–"}</span>
          </h2>
          <button
            className="secondary-button"
            onClick={resource.reload}
            disabled={resource.loading}
          >
            새로고침
          </button>
        </div>
        {resource.loading ? (
          <Loading />
        ) : resource.data?.devices.length ? (
          <div className="table-scroll" tabIndex={0} aria-label="장치 목록. 표가 화면보다 넓으면 가로로 스크롤할 수 있습니다.">
            <table className="data-table">
              <thead>
                <tr>
                  <th>장치</th>
                  <th>연결된 공간</th>
                  <th>통신 상태</th>
                  <th className="num">담당 좌석</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.devices.map((device) => (
                  <tr key={device.id}>
                    <td data-label="장치">
                      <strong>{device.name}</strong>
                      <small>{device.identifier}</small>
                      <small>{device.enabled ? "활성화" : "비활성화"}</small>
                    </td>
                    <td data-label="연결된 공간">
                      {resource.data?.places.find(
                        (p) => p.id === device.placeId,
                      )?.name ?? "공간 없음"}
                      <small>
                        <Link
                          className="inline-link"
                          to={`/admin/layout/${device.placeId}`}
                        >
                          배치에서 번호 확인
                        </Link>
                      </small>
                    </td>
                    <td data-label="통신 상태">
                      <span className="condition">
                        {device.status === "online"
                          ? "수신 중"
                          : device.status === "disabled"
                            ? "비활성화됨"
                            : "수신 대기"}
                      </span>
                      <small>마지막 수신 {timestamp(device.lastSeenAt)}</small>
                    </td>
                    <td className="num" data-label="담당 좌석">{device.seatIds.length}석</td>
                    <td data-label="관리">
                      <div className="row-actions">
                        <button
                          className="secondary-button"
                          onClick={() => setEditing(device)}
                        >
                          장치 설정
                        </button>
                        <button
                          onClick={() => {
                            setError(null)
                            setRotating(device)
                          }}
                        >
                          토큰 재발급
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !resource.error && (
            <EmptyState
              title="등록된 장치가 없습니다"
              action={
                resource.data?.places.length ? (
                  <button
                    className="primary-button"
                    onClick={() => setEditing("new")}
                  >
                    장치 등록
                  </button>
                ) : (
                  <Link to="/admin/places" className="primary-button">
                    공간 먼저 만들기
                  </Link>
                )
              }
            >
              공간에 배치된 좌석을 감지 장치에 연결하세요.
            </EmptyState>
          )
        )}
      </section>
      {editing && resource.data && (
        <DeviceForm
          device={editing === "new" ? null : editing}
          devices={resource.data.devices}
          places={resource.data.places}
          onClose={() => setEditing(null)}
          onSaved={(raw) => {
            setEditing(null)
            if (raw) setToken(raw)
            resource.reload()
            notifyDataChanged()
          }}
        />
      )}
      {rotating && (
        <Modal
          title="장치 토큰 재발급"
          onClose={() => {
            if (!busy) setRotating(null)
          }}
        >
          <p>
            {rotating.name}의 기존 토큰이 즉시 무효화됩니다. 새 토큰을 장치에
            적용하기 전까지 수신이 중단됩니다.
          </p>
          <ErrorNotice error={error} />
          <div className="form-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setRotating(null)}
            >
              취소
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  setToken(await service.rotateToken(rotating.id))
                  setRotating(null)
                  resource.reload()
                } catch (e) {
                  setError(e)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? "재발급 중…" : "재발급"}
            </button>
          </div>
        </Modal>
      )}
      {token && <TokenDialog token={token} onClose={() => setToken(null)} />}
    </>
  )
}
function TokenDialog({
  token,
  onClose,
}: {
  token: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState<unknown>(null)
  return (
    <Modal title="장치 토큰이 발급되었습니다" onClose={onClose}>
      <p>
        이 토큰은 지금 한 번만 표시됩니다. 안전하게 보관하고 장치에 설정하세요.
      </p>
      <label className="field">
        장치 인증 토큰
        <textarea
          className="token-value"
          value={token}
          readOnly
          rows={3}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      <ErrorNotice error={error} />
      <div className="form-actions">
        <button
          className="secondary-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(token)
              setCopied(true)
            } catch {
              setError(
                new Error(
                  "복사하지 못했습니다. 토큰을 직접 선택해 복사해 주세요.",
                ),
              )
            }
          }}
        >
          {copied ? "복사됨" : "토큰 복사"}
        </button>
        <button className="primary-button" onClick={onClose}>
          보관했어요
        </button>
      </div>
    </Modal>
  )
}
function DeviceForm({
  device,
  devices,
  places,
  onClose,
  onSaved,
}: {
  device: Device | null
  devices: Device[]
  places: Place[]
  onClose: () => void
  onSaved: (token?: string) => void
}) {
  const [placeId, setPlaceId] = useState(device?.placeId ?? places[0]?.id ?? "")
  const layout = useResource(
    (signal) => service.getLayout(placeId, signal),
    [placeId],
  )
  const [seatIds, setSeatIds] = useState(device?.seatIds ?? []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null)
  const reserved = new Set(
    devices.filter((d) => d.id !== device?.id).flatMap((d) => d.seatIds),
  )
  return (
    <Modal
      title={device ? "장치 설정" : "장치 등록"}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy || !layout.data) return
          const f = new FormData(e.currentTarget)
          const input: DeviceInput = {
            identifier: String(f.get("identifier")).trim(),
            name: String(f.get("name")).trim(),
            placeId,
            enabled: f.get("enabled") === "on",
            seatIds,
          }
          setBusy(true)
          setError(null)
          try {
            if (device) {
              await service.updateDevice(device.id, input, device.revision)
              onSaved()
            } else onSaved((await service.createDevice(input)).token)
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            장치 이름
            <input
              name="name"
              defaultValue={device?.name}
              required
              maxLength={100}
              autoFocus
            />
          </label>
          <label className="field">
            장치 식별자
            <input
              name="identifier"
              defaultValue={device?.identifier}
              required
              maxLength={100}
              readOnly={!!device}
            />
          </label>
          <label className="field">
            연결할 공간
            <select
              value={placeId}
              onChange={(e) => {
                setPlaceId(e.target.value)
                setSeatIds([])
              }}
            >
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={device?.enabled ?? true}
            />
            장치 활성화
          </label>
          <div className="section-heading">
            <h3>
              담당 좌석 <span>{seatIds.length}석</span>
            </h3>
            <Link
              className="inline-link"
              to={`/admin/layout/${placeId}`}
              target="_blank"
            >
              배치 확인 ↗
            </Link>
          </div>
          <ErrorNotice error={layout.error} retry={layout.reload} />
          {layout.loading ? (
            <Loading label="좌석을 확인하고 있습니다" />
          ) : (
            <>
              <div className="row-actions">
                <button
                  type="button"
                  onClick={() =>
                    setSeatIds(
                      layout.data?.seats
                        .filter((s) => !reserved.has(s.id))
                        .map((s) => s.id) ?? [],
                    )
                  }
                >
                  선택 가능한 좌석 전체
                </button>
                <button type="button" onClick={() => setSeatIds([])}>
                  선택 해제
                </button>
              </div>
              <div className="assignment-grid">
                {layout.data?.seats
                  .slice()
                  .sort((a, b) => a.number - b.number)
                  .map((seat) => (
                    <label
                      key={seat.id}
                      className={reserved.has(seat.id) ? "reserved" : ""}
                    >
                      <input
                        type="checkbox"
                        checked={seatIds.includes(seat.id)}
                        disabled={reserved.has(seat.id)}
                        onChange={(e) =>
                          setSeatIds((ids) =>
                            e.target.checked
                              ? [...ids, seat.id]
                              : ids.filter((id) => id !== seat.id),
                          )
                        }
                      />
                      <span>
                        {seat.number}번
                        {reserved.has(seat.id) && <small>다른 장치</small>}
                      </span>
                    </label>
                  ))}
              </div>
              {!layout.data?.seats.length && (
                <p className="notice">
                  배치 편집기에서 좌석을 먼저 추가하고 저장해 주세요.
                </p>
              )}
            </>
          )}
          <p className="field-help">
            표시된 번호가 장치가 전송하는 좌석 번호입니다. 공간을 변경하면 담당
            좌석 선택이 초기화됩니다.
          </p>
        </fieldset>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            취소
          </button>
          <button className="primary-button" disabled={busy || !layout.data}>
            {busy ? "저장 중…" : device ? "설정 저장" : "등록하고 토큰 발급"}
          </button>
        </div>
      </form>
    </Modal>
  )
}
