import { useState } from "react"
import { devControls } from "./service"
import { useAuth } from "../auth"
import { ErrorNotice } from "../ui"
import { Link, navigate } from "../router"
import type { SeatStatus } from "../seats"

export default function DevPanel() {
  const auth = useAuth(),
    [message, setMessage] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false)
  async function run(action: () => Promise<unknown> | void, success: string) {
    setError(null)
    setBusy(true)
    try {
      await action()
      setMessage(success)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="dev-panel">
      <summary>개발 검증 도구</summary>
      <p>
        이 도구는 개발 모드에서만 표시됩니다. 네트워크 API나 실제 하드웨어에
        요청하지 않습니다.
      </p>
      {!auth.session ? (
        <Link className="inline-link" to="/admin/login">
          개발 계정으로 로그인: admin / dev-only
        </Link>
      ) : (
        <>
          <div className="row-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const place = await devControls.seed()
                  navigate(`/places/${place.id}`)
                }, "검증용 공간을 생성했습니다. 감지 전 좌석은 모두 확인 불가입니다.")
              }
            >
              검증용 공간 만들기
            </button>
            <button
              className="secondary-button"
              onClick={() =>
                run(
                  devControls.failNextSave,
                  "다음 배치 저장 요청을 한 번 실패시킵니다.",
                )
              }
            >
              다음 저장 실패
            </button>
            <button
              className="secondary-button"
              onClick={() =>
                run(devControls.expire, "개발 세션을 만료했습니다.")
              }
            >
              인증 만료
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                run(
                  devControls.resetReadings,
                  "감지 정보를 초기화했습니다. 배치는 유지됩니다.",
                )
              }
            >
              감지 정보 초기화
            </button>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              onChange={(e) => devControls.disconnect(e.target.checked)}
            />
            이 탭의 실시간 연결 끊기
          </label>
          <form
            className="simulator-form"
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void run(
                () =>
                  devControls.ingest(
                    String(f.get("identifier")),
                    String(f.get("token")),
                    String(f.get("numbers"))
                      .split(",")
                      .map((n) => ({
                        number: Number(n.trim()),
                        status: String(f.get("status")) as SeatStatus,
                      })),
                  ),
                "검증용 감지 이벤트를 전달했습니다. 30초 후에는 오래된 정보로 처리합니다.",
              )
            }}
          >
            <h3>장치 감지 시뮬레이션</h3>
            <label className="field">
              장치 식별자
              <input name="identifier" required />
            </label>
            <label className="field">
              발급받은 개발 토큰
              <input name="token" type="password" autoComplete="off" required />
            </label>
            <label className="field">
              좌석 번호
              <input name="numbers" placeholder="1,2,3" required />
            </label>
            <label className="field">
              감지 상태
              <select name="status">
                <option value="available">이용 가능</option>
                <option value="occupied">사용 중</option>
                <option value="unknown">확인 불가</option>
              </select>
            </label>
            <button className="secondary-button" disabled={busy}>
              감지 이벤트 보내기
            </button>
          </form>
        </>
      )}
      {message && <p role="status">{message}</p>}
      <ErrorNotice error={error} />
    </details>
  )
}
