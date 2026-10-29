import type { MockMode } from "../data/mockSeatSource"

interface Props {
  mode: MockMode
  seatCount: number
  intervalMs: number
  onMode(mode: MockMode): void
  onSeatCount(count: number): void
}

const MODES: { value: MockMode; label: string }[] = [
  { value: "live", label: "정상 수신" },
  { value: "stalled", label: "수신 지연" },
  { value: "offline", label: "연결 끊김" },
]

const COUNTS = [24, 40, 80, 120]

export function MockControls({
  mode,
  seatCount,
  intervalMs,
  onMode,
  onSeatCount,
}: Props) {
  return (
    <aside className="mock" aria-labelledby="mock-title">
      <div className="mock__inner">
        <div className="mock__intro">
          <h2 id="mock-title">목업 시연 도구</h2>
          <p>
            실제 센서가 아닌 시뮬레이션 데이터입니다. 정상 수신 시{" "}
            {intervalMs / 1000}초마다 일부 좌석이 무작위로 바뀝니다. 실제
            서비스에는 이 영역이 표시되지 않습니다.
          </p>
        </div>

        <fieldset className="mock__group">
          <legend>데이터 상태</legend>
          <div className="segmented">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                aria-pressed={mode === m.value}
                onClick={() => onMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="mock__group">
          <legend>좌석 수</legend>
          <div className="segmented">
            {COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={seatCount === n}
                onClick={() => onSeatCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </aside>
  )
}
