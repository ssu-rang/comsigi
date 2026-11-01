import { countSeats, type Seat } from "./seats"

export interface Room {
  id: string
  name: string
  building: string
  floor: string
  description: string
  hours: string
  amenities: string[]
  seats: Seat[]
}

// Design fixtures only. Counts are always derived from these individual seats.
// The second snapshot is used only when the preview's refresh button is pressed.
const definitions = [
  {
    id: "reading-1",
    name: "제1열람실",
    building: "중앙도서관",
    floor: "2층",
    total: 48,
    available: [
      2, 3, 7, 8, 10, 13, 16, 17, 21, 24, 26, 29, 33, 35, 38, 41, 44, 47,
    ],
    unknown: [31, 32],
    description: "조용히, 깊이 집중하는 공간",
    hours: "06:00–24:00",
    amenities: ["콘센트", "정숙 공간", "와이파이"],
  },
  {
    id: "reading-2",
    name: "제2열람실",
    building: "중앙도서관",
    floor: "3층",
    total: 36,
    available: [3, 7, 12, 18, 25, 30, 34],
    unknown: [36],
    description: "개인 학습을 위한 독립형 좌석",
    hours: "06:00–24:00",
    amenities: ["콘센트", "정숙 공간", "와이파이"],
  },
  {
    id: "lounge",
    name: "스터디 라운지",
    building: "학생회관",
    floor: "1층",
    total: 24,
    available: [1, 2, 4, 7, 8, 10, 13, 15, 16, 19, 21, 24],
    unknown: [],
    description: "함께 이야기하고 공부하는 공간",
    hours: "08:00–22:00",
    amenities: ["콘센트", "대화 가능", "와이파이"],
  },
  {
    id: "study",
    name: "자율학습실",
    building: "공학관",
    floor: "2층",
    total: 60,
    available: [14, 37, 58],
    unknown: [59, 60],
    description: "수업 사이 잠깐 머물기 좋은 공간",
    hours: "07:00–23:00",
    amenities: ["콘센트", "정숙 공간", "와이파이"],
  },
  {
    id: "commons",
    name: "커먼스",
    building: "인문관",
    floor: "1층",
    total: 32,
    available: [
      1, 2, 3, 5, 6, 7, 9, 10, 11, 12, 14, 15, 17, 18, 19, 21, 22, 24, 25, 27,
      29, 32,
    ],
    unknown: [],
    description: "열린 테이블에서 자유롭게 머무는 공간",
    hours: "08:00–21:00",
    amenities: ["대화 가능", "와이파이"],
  },
]

export function makeDemoRooms(snapshot = 0): Room[] {
  return definitions.map(({ total, available, unknown, ...room }) => {
    const seats: Seat[] = Array.from({ length: total }, (_, index) => {
      const id = index + 1
      let status: Seat["status"] = unknown.includes(id)
        ? "unknown"
        : available.includes(id)
          ? "available"
          : "occupied"
      if (
        snapshot % 2 === 1 &&
        (id === 1 || id === 4) &&
        room.id === "reading-1"
      )
        status = "available"
      return { id, status }
    })
    const counts = countSeats(seats)
    console.assert(
      counts.available + counts.occupied + counts.unknown === total,
      "Room seat totals must agree",
    )
    return { ...room, seats }
  })
}

export const STATUS_LABEL = {
  available: "이용 가능",
  occupied: "사용 중",
  unknown: "확인 중",
} as const

export function roomCondition(seats: Seat[]) {
  const { available, total } = countSeats(seats)
  if (!total) return "미등록"
  if (!available) return "만석"
  return available / total >= 0.3
    ? "여유"
    : available / total >= 0.15
      ? "보통"
      : "혼잡"
}
