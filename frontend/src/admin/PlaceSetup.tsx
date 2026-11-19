import { useRef, type ReactNode } from "react"
import { service } from "../service"
import { timestamp } from "../domain"
import { useDataRefresh, useResource } from "../hooks"
import { ErrorNotice, Loading } from "../ui"
import { Link } from "../router"
import { PairingCodePanel, PendingCameras } from "./CameraPairing"

/**
 * Place → camera → seats setup. Every step is derived from server state, so the
 * page can be left and reopened at any point (including after a failed step).
 */
export function PlaceSetup({ placeId }: { placeId: string }) {
  const resource = useResource(
    async (signal) => {
      const [places, devices, layout] = await Promise.all([
        service.listPlaces(signal),
        service.listDevices(signal),
        service.getLayout(placeId, signal),
      ])
      return {
        places,
        place: places.find((p) => p.id === placeId) ?? null,
        devices: devices.filter((d) => d.placeId === placeId),
        layout,
      }
    },
    [placeId],
  )
  useDataRefresh(resource.reload)
  // Keep the last result while refreshing so the pairing panel stays mounted.
  const last = useRef(resource.data)
  if (resource.data) last.current = resource.data
  const data = resource.error ? null : last.current
  const provisioning = service.provisioning
  if (resource.loading && !data)
    return <Loading label="공간 설정을 불러오고 있습니다" />
  if (!data || !data.place)
    return (
      <>
        <ErrorNotice
          error={resource.error ?? new Error("공간을 찾을 수 없습니다.")}
          retry={resource.reload}
        />
        <Link className="inline-link" to="/admin/places">
          공간 목록으로
        </Link>
      </>
    )
  const { place, devices, layout } = data
  const cameraDone = devices.length > 0
  const seatsDone = layout.seats.length > 0
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{place.name} 설정</h1>
          <p>설정은 나중에 이어서 할 수 있습니다.</p>
        </div>
      </div>
      <ol className="setup-steps">
        <Step index={1} title="공간 만들기" done>
          <p>
            <strong>{place.name}</strong> · {place.slug}{" "}
            <small className="record-id">서버 발급 ID {place.id}</small>
          </p>
        </Step>
        <Step index={2} title="카메라 연결" done={cameraDone}>
          {devices.length > 0 && (
            <ul className="setup-devices">
              {devices.map((d) => (
                <li key={d.id}>
                  <strong>{d.name}</strong>{" "}
                  <span className="condition">
                    {d.status === "online"
                      ? "수신 중"
                      : d.status === "disabled"
                        ? "비활성화됨"
                        : "수신 대기"}
                  </span>{" "}
                  <small>마지막 수신 {timestamp(d.lastSeenAt)}</small>
                </li>
              ))}
            </ul>
          )}
          {provisioning ? (
            <>
              <PairingCodePanel provisioning={provisioning} />
              <PendingCameras
                provisioning={provisioning}
                places={data.places}
                placeId={place.id}
              />
            </>
          ) : (
            <p className="notice">
              카메라 자동 등록은 서버 API 모드에서 사용할 수 있습니다.{" "}
              <Link className="inline-link" to="/admin/devices">
                장치 관리
              </Link>
              에서 장치를 직접 등록하세요.
            </p>
          )}
        </Step>
        <Step index={3} title="좌석 배치 확인" done={seatsDone}>
          <p>
            {seatsDone
              ? `좌석 ${layout.seats.length}개가 있습니다. 자동 생성된 좌석은 기본 격자 위치에 놓입니다.`
              : "아직 좌석이 없습니다. 카메라를 연결하면 카메라가 보고한 번호로 좌석이 만들어집니다."}
          </p>
          <Link className="secondary-button" to={`/admin/layout/${place.id}`}>
            배치 편집
          </Link>
        </Step>
      </ol>
    </>
  )
}

function Step({
  index,
  title,
  done = false,
  children,
}: {
  index: number
  title: string
  done?: boolean
  children: ReactNode
}) {
  return (
    <li className="admin-panel setup-step">
      <div className="section-heading">
        <h2>
          {index}. {title} <span>{done ? "완료" : "진행 필요"}</span>
        </h2>
      </div>
      <div className="setup-step-body">{children}</div>
    </li>
  )
}
