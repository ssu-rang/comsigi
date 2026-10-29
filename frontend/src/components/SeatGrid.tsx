import { formatClock, type Freshness } from "../data/feed"
import type { Seat } from "../data/types"

const STATUS_LABEL: Record<Seat["status"], string> = {
  available: "이용 가능",
  occupied: "사용 중",
  unknown: "확인 불가",
}

interface Props {
  seats: Seat[]
  freshness: Freshness
  receivedAt: number | null
  changed: { ids: Set<number>; version: number }
}

export function SeatGrid({ seats, freshness, receivedAt, changed }: Props) {
  const outdated = freshness === "offline" || freshness === "stale"

  return (
    <section className="seats" aria-labelledby="seats-title">
      <header className="seats__head">
        <h2 id="seats-title">좌석별 상태</h2>
        <p>번호순 정렬 · 실제 좌석 배치와 다름</p>
      </header>

      {outdated && receivedAt !== null && (
        <p className="seats__outdated">
          {formatClock(receivedAt)} 시점의 상태입니다
          {freshness === "offline" ? " — 현재 상태가 아닙니다." : "."}
        </p>
      )}

      {seats.length === 0 ? (
        <p className="seats__empty">좌석 데이터를 기다리는 중…</p>
      ) : (
        <ol
          className={`seats__grid${
            freshness === "offline" ? " seats__grid--offline" : ""
          }`}
        >
          {seats.map((seat) => {
            const isChanged = changed.ids.has(seat.id)
            return (
              <li
                key={isChanged ? `${seat.id}-${changed.version}` : seat.id}
                className={`seat seat--${seat.status}${
                  isChanged ? " seat--changed" : ""
                }`}
                aria-label={`${seat.id}번 좌석, ${STATUS_LABEL[seat.status]}`}
                title={`${seat.id}번 · ${STATUS_LABEL[seat.status]}`}
              >
                <span className="seat__num">{seat.id}</span>
                {seat.status === "unknown" && (
                  <span className="seat__mark" aria-hidden="true">
                    ?
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
