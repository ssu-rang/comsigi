import {
  formatAge,
  formatClock,
  STALE_AFTER_MS,
  type Freshness,
} from "../data/feed"

interface Props {
  freshness: Freshness
  receivedAt: number | null
  now: number
  version: number
}

export function FeedStatus({ freshness, receivedAt, now, version }: Props) {
  const time = receivedAt !== null ? formatClock(receivedAt) : null
  const age = receivedAt !== null ? formatAge(now - receivedAt) : null

  const title = {
    connecting: "센서 서버에 연결하는 중",
    live: "실시간 수신 중",
    stale: "데이터 갱신 지연",
    offline: "연결 끊김",
  }[freshness]

  const detail =
    freshness === "stale"
      ? `${STALE_AFTER_MS / 1000}초 넘게 새 데이터가 없습니다. 좌석 상태가 실제와 다를 수 있습니다.`
      : freshness === "offline"
        ? time
          ? `센서 서버와 연결이 끊겼습니다. ${time} 이후의 변화는 반영되지 않았습니다.`
          : "센서 서버와 연결할 수 없습니다."
        : null

  return (
    <div className={`feed feed--${freshness}`} role="status" aria-live="polite">
      <p className="feed__line">
        <span className="feed__dot" aria-hidden="true" />
        <strong>{title}</strong>
        {time && (
          <span className="feed__time">
            {/* key restarts the flash so each arrival is visible */}
            <span
              key={version}
              className={freshness === "live" ? "feed__flash" : undefined}
            >
              {freshness === "live" ? `${time} 갱신` : `마지막 수신 ${time}`}
            </span>
            <span className="feed__age"> · {age}</span>
          </span>
        )}
      </p>
      {detail && <p className="feed__detail">{detail}</p>}
    </div>
  )
}
