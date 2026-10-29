import { useMemo, useState } from "react"
import { FeedStatus } from "./components/FeedStatus"
import { MockControls } from "./components/MockControls"
import { SeatGrid } from "./components/SeatGrid"
import { Summary } from "./components/Summary"
import { countSeats, getFreshness, useNow, useSeatFeed } from "./data/feed"
import { MockSeatSource, type MockMode } from "./data/mockSeatSource"

/** Change this to try other room sizes; the layout adapts automatically. */
const INITIAL_SEAT_COUNT = 40
const ROOM_NAME = "중앙도서관 제1열람실"

export default function App() {
  // To connect real sensors, replace with: new HttpSeatSource("/api/seats")
  const source = useMemo(() => new MockSeatSource(INITIAL_SEAT_COUNT), [])
  const { seats, receivedAt, connection, changed } = useSeatFeed(source)
  const now = useNow(1000)

  const [mode, setMode] = useState<MockMode>("live")
  const [seatCount, setSeatCount] = useState(INITIAL_SEAT_COUNT)

  const counts = useMemo(() => countSeats(seats), [seats])
  const freshness = getFreshness(connection, receivedAt, now)

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <p className="brand">
            <span className="brand__name">빈자리</span>
            <span className="brand__room">{ROOM_NAME} 실시간 좌석 현황</span>
          </p>
          <span className="mock-tag" title="실제 센서 데이터가 아닙니다">
            시뮬레이션 데이터
          </span>
        </div>
      </header>

      <main className="layout">
        <div className="layout__side">
          <Summary
            counts={counts}
            freshness={freshness}
            receivedAt={receivedAt}
          />
          <FeedStatus
            freshness={freshness}
            receivedAt={receivedAt}
            now={now}
            version={changed.version}
          />
        </div>
        <SeatGrid
          seats={seats}
          freshness={freshness}
          receivedAt={receivedAt}
          changed={changed}
        />
      </main>

      <MockControls
        mode={mode}
        seatCount={seatCount}
        intervalMs={source.intervalMs}
        onMode={(m) => {
          setMode(m)
          source.setMode(m)
        }}
        onSeatCount={(n) => {
          setSeatCount(n)
          source.setSeatCount(n)
        }}
      />
    </div>
  )
}
