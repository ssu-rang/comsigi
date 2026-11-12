import { useCallback, useEffect, useRef, useState } from "react"
import type {
  ApprovalResult,
  CameraRegistration,
  PairingCode,
  Place,
  ProvisioningFailure,
  ProvisioningService,
  RegistrationStatus,
} from "../domain"
import { timestamp } from "../domain"
import { notifyDataChanged } from "../hooks"
import { EmptyState, ErrorNotice, Loading, Modal } from "../ui"

export const POLL_INTERVAL_MS = 5000

export const REGISTRATION_LABEL: Record<RegistrationStatus, string> = {
  pending: "등록 대기",
  approved: "키 전달 대기",
  completed: "연결됨",
  rejected: "거절됨",
  expired: "만료됨",
  removed: "장치 삭제됨",
}
const FAILURE_LABEL: Record<string, string> = {
  pairing_unauthorized: "잘못되었거나 폐기된 페어링 코드",
  pairing_code_expired: "만료된 페어링 코드",
  pairing_code_used: "이미 사용된 페어링 코드",
  device_already_registered: "이미 등록된 장치",
  registration_unauthorized: "등록 비밀값 불일치",
}

/** REST polling that keeps the last data while refreshing and pauses in hidden tabs. */
export function usePolling<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  intervalMs = POLL_INTERVAL_MS,
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const running = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    if (running.current) return
    const controller = new AbortController()
    running.current = controller
    try {
      const next = await loaderRef.current(controller.signal)
      if (controller.signal.aborted) return
      setData(next)
      setError(null)
      setCheckedAt(new Date().toISOString())
    } catch (e) {
      if (!controller.signal.aborted) setError(e)
    } finally {
      if (running.current === controller) running.current = null
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, intervalMs)
    return () => {
      clearInterval(timer)
      running.current?.abort()
      running.current = null
    }
  }, [refresh, intervalMs])
  return { data, error, loading, checkedAt, refresh }
}

export function PairingCodePanel({
  provisioning,
}: {
  provisioning: ProvisioningService
}) {
  const [issued, setIssued] = useState<PairingCode | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [copied, setCopied] = useState(false)
  return (
    <div className="pairing-code">
      <p className="field-help">
        카메라 설정 파일에 페어링 코드를 입력하면 카메라가 하드웨어 식별자로 등록을
        요청합니다. 코드는 한 대의 카메라에만, 발급 후 15분 동안 사용할 수
        있습니다.
      </p>
      <ErrorNotice error={error} />
      {issued ? (
        <div className="notice">
          <p>
            <strong>이 코드는 지금 한 번만 표시됩니다.</strong> 만료{" "}
            {timestamp(issued.expiresAt)}
          </p>
          <label className="field">
            페어링 코드
            <input
              className="token-value"
              value={issued.code}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <div className="row-actions">
            <button
              className="secondary-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued.code)
                  setCopied(true)
                } catch {
                  setError(
                    new Error("복사하지 못했습니다. 코드를 직접 선택해 복사해 주세요."),
                  )
                }
              }}
            >
              {copied ? "복사됨" : "코드 복사"}
            </button>
            <button
              onClick={() => {
                setIssued(null)
                setCopied(false)
              }}
            >
              코드 숨기기
            </button>
          </div>
        </div>
      ) : (
        <button
          className="primary-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              setIssued(await provisioning.issuePairingCode())
              setCopied(false)
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? "발급 중…" : "페어링 코드 발급"}
        </button>
      )}
    </div>
  )
}

/**
 * Registration requests, refreshed by REST polling. With `placeId` the approval is
 * fixed to that place (setup flow); otherwise the administrator picks a place.
 */
export function PendingCameras({
  provisioning,
  places,
  placeId,
  onApproved,
}: {
  provisioning: ProvisioningService
  places: Place[]
  placeId?: string
  onApproved?: (result: ApprovalResult) => void
}) {
  const poll = usePolling(async (signal) => {
    const [registrations, failures] = await Promise.all([
      provisioning.listRegistrations(signal),
      provisioning.listFailures(signal),
    ])
    return { registrations, failures }
  })
  const [approving, setApproving] = useState<CameraRegistration | null>(null)
  const [result, setResult] = useState<ApprovalResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const registrations = poll.data?.registrations ?? []
  const visible = registrations.filter(
    (r) =>
      r.status === "pending" ||
      r.status === "expired" ||
      (placeId ? r.placeId === placeId : r.status !== "removed"),
  )
  const pending = visible.filter((r) => r.status === "pending")
  const placeName = (id: string | null) =>
    places.find((p) => p.id === id)?.name ?? "공간 없음"
  return (
    <div className="pending-cameras">
      <div className="section-heading">
        <h3>
          등록 요청 카메라 <span>대기 {pending.length}대</span>
        </h3>
        <span className="condition" role="status">
          {poll.loading
            ? "확인 중"
            : poll.error
              ? "갱신 실패"
              : `5초마다 갱신 · ${timestamp(poll.checkedAt)}`}
        </span>
      </div>
      <ErrorNotice error={poll.error || error} retry={poll.refresh} />
      {result && (
        <div className="notice" role="status">
          <p>
            <strong>{result.device.name}</strong>을(를) 연결했습니다. 좌석{" "}
            {result.seatsCreated.length}개를 새로 만들었고
            {result.seatsExisting.length
              ? ` 기존 좌석 ${result.seatsExisting.length}개는 그대로 두었습니다.`
              : "."}
          </p>
          <p>
            카메라가 다음 상태 확인에서 장치 키를 받습니다. 상태가 “연결됨”으로
            바뀌면 수신 준비가 끝난 것입니다.
          </p>
        </div>
      )}
      {poll.loading && !poll.data ? (
        <Loading label="등록 요청을 확인하고 있습니다" />
      ) : visible.length ? (
        <div
          className="table-scroll"
          tabIndex={0}
          aria-label="카메라 등록 요청 목록. 표가 화면보다 넓으면 가로로 스크롤할 수 있습니다."
        >
          <table className="data-table">
            <thead>
              <tr>
                <th>카메라</th>
                <th>상태</th>
                <th className="num">보고한 좌석</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td data-label="카메라">
                    <strong className="token-value">{r.identifier}</strong>
                    {(r.model || r.firmwareVersion) && (
                      <small>
                        {[r.model, r.firmwareVersion].filter(Boolean).join(" · ")}
                      </small>
                    )}
                    <small>요청 {timestamp(r.requestedAt)}</small>
                  </td>
                  <td data-label="상태">
                    <span className={`condition registration-${r.status}`}>
                      {REGISTRATION_LABEL[r.status]}
                    </span>
                    {r.status === "pending" && (
                      <small>승인 기한 {timestamp(r.expiresAt)}</small>
                    )}
                    {r.status === "expired" && (
                      <small>카메라에 새 페어링 코드가 필요합니다</small>
                    )}
                    {(r.status === "approved" || r.status === "completed") && (
                      <small>{placeName(r.placeId)}</small>
                    )}
                  </td>
                  <td className="num" data-label="보고한 좌석">
                    {r.seatNumbers.length
                      ? `${r.seatNumbers.length}석 (${summarize(r.seatNumbers)})`
                      : "없음"}
                  </td>
                  <td data-label="관리">
                    {r.status === "pending" ? (
                      <div className="row-actions">
                        <button
                          className="secondary-button"
                          disabled={!places.length}
                          onClick={() => {
                            setError(null)
                            setResult(null)
                            setApproving(r)
                          }}
                        >
                          연결
                        </button>
                        <button
                          className="danger-text"
                          onClick={async () => {
                            setError(null)
                            try {
                              await provisioning.reject(r.id)
                              await poll.refresh()
                            } catch (e) {
                              setError(e)
                            }
                          }}
                        >
                          거절
                        </button>
                      </div>
                    ) : (
                      <small>—</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !poll.error && (
          <EmptyState title="등록 요청한 카메라가 없습니다">
            페어링 코드를 카메라에 입력하고 전원을 켜면 이 목록에 나타납니다.
          </EmptyState>
        )
      )}
      <FailureList failures={poll.data?.failures ?? []} />
      {approving && (
        <ApproveDialog
          provisioning={provisioning}
          registration={approving}
          places={places}
          placeId={placeId}
          onClose={() => setApproving(null)}
          onApproved={async (approved) => {
            setApproving(null)
            setResult(approved)
            notifyDataChanged()
            onApproved?.(approved)
            await poll.refresh()
          }}
        />
      )}
    </div>
  )
}

function FailureList({ failures }: { failures: ProvisioningFailure[] }) {
  if (!failures.length) return null
  return (
    <details className="failure-list">
      <summary>최근 인증 실패 {failures.length}건 (서버 재시작 시 초기화)</summary>
      <ul>
        {failures.slice(0, 10).map((f, index) => (
          <li key={`${f.at}-${index}`}>
            <span className="condition registration-failed">
              {FAILURE_LABEL[f.reason] ?? f.reason}
            </span>{" "}
            {f.identifier ?? "식별자 없음"} · {timestamp(f.at)}
          </li>
        ))}
      </ul>
    </details>
  )
}

function ApproveDialog({
  provisioning,
  registration,
  places,
  placeId,
  onClose,
  onApproved,
}: {
  provisioning: ProvisioningService
  registration: CameraRegistration
  places: Place[]
  placeId?: string
  onClose: () => void
  onApproved: (result: ApprovalResult) => void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null)
  return (
    <Modal
      title="카메라 연결"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          const f = new FormData(e.currentTarget)
          setBusy(true)
          setError(null)
          try {
            onApproved(
              await provisioning.approve(registration.id, {
                placeId: placeId ?? String(f.get("placeId")),
                name: String(f.get("name")).trim(),
                createSeats: f.get("createSeats") === "on",
              }),
            )
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <fieldset disabled={busy}>
          <p className="field-help">
            하드웨어 식별자 <strong className="token-value">{registration.identifier}</strong>
          </p>
          <label className="field">
            장치 이름
            <input
              name="name"
              required
              maxLength={100}
              autoFocus
              defaultValue={`카메라 ${registration.identifier.slice(-6)}`}
            />
          </label>
          {placeId ? (
            <p className="field-help">
              연결할 공간: {places.find((p) => p.id === placeId)?.name ?? placeId}
            </p>
          ) : (
            <label className="field">
              연결할 공간
              <select name="placeId" defaultValue={places[0]?.id}>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="checkbox-label">
            <input
              name="createSeats"
              type="checkbox"
              defaultChecked
              disabled={!registration.seatNumbers.length}
            />
            보고한 좌석 {registration.seatNumbers.length}개 중 없는 번호를 자동 생성
          </label>
          <p className="field-help">
            이미 있는 좌석 번호는 위치·이름·상태를 바꾸지 않습니다. 새 좌석은 빈 자리에
            격자로 배치되며 배치 편집에서 옮길 수 있습니다. 좌석은 삭제되지 않습니다.
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
          <button className="primary-button" disabled={busy}>
            {busy ? "연결 중…" : "승인하고 연결"}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** "1–3, 7" style range summary for reported seat numbers. */
export function summarize(numbers: number[]) {
  const sorted = [...numbers].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`)
    i = j + 1
  }
  return parts.join(", ")
}
