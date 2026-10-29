import { type Freshness, type SeatCounts } from "../data/feed"
import { Swatch } from "./Swatch"

interface Props {
  counts: SeatCounts
  freshness: Freshness
  receivedAt: number | null
}

export function Summary({ counts, freshness, receivedAt }: Props) {
  const hasData = receivedAt !== null
  const label =
    freshness === "offline"
      ? "현재 이용 가능 좌석 알 수 없음"
      : freshness === "stale"
        ? "이용 가능 좌석 (갱신 지연)"
        : counts.available === 0 && hasData
          ? "지금은 빈 좌석이 없습니다"
          : "지금 이용 가능한 좌석"

  return (
    <section
      className={`summary summary--${freshness}`}
      aria-labelledby="summary-label"
    >
      <p className="summary__label" id="summary-label">
        <Swatch status="available" />
        {label}
      </p>

      <p className="summary__hero">
        <span className="summary__num">{hasData ? counts.available : "–"}</span>
        <span className="summary__of">
          / {hasData ? counts.total : "–"}석
          <span className="sr-only"> 중 이용 가능</span>
        </span>
      </p>
      {freshness === "offline" && receivedAt !== null && (
        <p className="summary__past">마지막 수신값 · 현재 상태 아님</p>
      )}

      <dl className="summary__stats">
        <div>
          <dt>
            <Swatch status="occupied" />
            사용 중
          </dt>
          <dd>{hasData ? counts.occupied : "–"}</dd>
        </div>
        <div>
          <dt>
            <Swatch status="unknown" />
            확인 불가
          </dt>
          <dd>{hasData ? counts.unknown : "–"}</dd>
        </div>
        <div>
          <dt>이용률</dt>
          <dd>
            {hasData && counts.utilization !== null ? counts.utilization : "–"}
            <small>%</small>
          </dd>
        </div>
      </dl>
      {hasData && counts.unknown > 0 && (
        <p className="summary__note">
          이용률은 확인 불가 좌석을 제외하고 계산합니다.
        </p>
      )}
    </section>
  )
}
