import { countSeats, useSeats, type Seat, type SeatStatus } from "./seats"

const ROOM_NAME = "중앙도서관 제1열람실"
const STATUS_LABEL: Record<SeatStatus, string> = {
  available: "이용 가능",
  occupied: "사용 중",
  unknown: "확인 불가",
}

export default function App() {
  const { seats, status } = useSeats()
  const statusLabel = status === "loading" ? "불러오는 중" : status === "error" ? "연결 실패" : "연결됨"
  const message = status === "loading"
    ? "좌석 정보를 불러오고 있습니다."
    : status === "error"
      ? "좌석 정보를 가져오지 못했습니다. 잠시 후 자동으로 다시 시도합니다."
      : seats?.length === 0 ? "등록된 좌석이 없습니다." : "좌석 상태는 3초 간격으로 자동 갱신됩니다."

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <p className="brand">
            <span className="brand__name">빈자리</span>
            <span className="brand__room">{ROOM_NAME} 좌석 현황</span>
          </p>
          <span className="mock-tag">{statusLabel}</span>
        </div>
      </header>

      <main className="layout">
        <div className="layout__side">
          <Summary seats={seats} />
          <p className="preview-note" role="status">{message}</p>
        </div>
        <SeatGrid seats={seats ?? []} />
      </main>
    </div>
  )
}

function Summary({ seats }: { seats: Seat[] | null }) {
  const seatCounts = seats === null ? null : countSeats(seats)
  return (
    <section className="summary" aria-labelledby="summary-label">
      <p className="summary__label" id="summary-label">
        <Swatch status="available" />
        이용 가능한 좌석
      </p>

      <p className="summary__hero">
        <span className="summary__num">{seatCounts?.available ?? "–"}</span>
        <span className="summary__of">
          / {seatCounts?.total ?? "–"}석
          <span className="sr-only"> 중 이용 가능</span>
        </span>
      </p>

      <dl className="summary__stats">
        <div>
          <dt>
            <Swatch status="occupied" />
            {STATUS_LABEL.occupied}
          </dt>
          <dd>{seatCounts?.occupied ?? "–"}</dd>
        </div>
        <div>
          <dt>
            <Swatch status="unknown" />
            {STATUS_LABEL.unknown}
          </dt>
          <dd>{seatCounts?.unknown ?? "–"}</dd>
        </div>
        <div>
          <dt>이용률</dt>
          <dd>
            {seatCounts?.utilization ?? "–"}<small>%</small>
          </dd>
        </div>
      </dl>
      <p className="summary__note">
        이용률은 확인 불가 좌석을 제외하고 계산합니다.
      </p>
    </section>
  )
}

function SeatGrid({ seats }: { seats: Seat[] }) {
  return (
    <section className="seats" aria-labelledby="seats-title">
      <header className="seats__head">
        <h2 id="seats-title">좌석별 상태</h2>
        <p>번호순 정렬 · 실제 좌석 배치와 다름</p>
      </header>

      <ol className="seats__grid">
        {seats.map(({ id, status }) => (
          <li
            key={id}
            className={`seat seat--${status}`}
            aria-label={`${id}번 좌석, ${STATUS_LABEL[status]}`}
            title={`${id}번 · ${STATUS_LABEL[status]}`}
          >
            <span className="seat__num">{id}</span>
            {status === "unknown" && (
              <span className="seat__mark" aria-hidden="true">
                ?
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

function Swatch({ status }: { status: SeatStatus }) {
  return <span className={`swatch swatch--${status}`} aria-hidden="true" />
}
