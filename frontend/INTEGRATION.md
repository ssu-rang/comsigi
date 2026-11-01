# 백엔드 통합

2026-11-01. 현재 구현된 `app/api/*`, `app/schemas.py`, [docs/API.md](../docs/API.md)를 기준으로 연결했습니다. 백엔드 API 스키마는 유지했습니다. 개발/preview 포트의 Origin 허용과 취소 중에도 WebSocket 구독 해제를 완료하는 정리 처리를 보완했습니다.

## 연결 구조

- `api.ts`: 요청 timeout/취소, 204, `error.code/message/details`와 FastAPI `detail` 해석.
- `backend-contract.ts`: 응답 검증, snake_case와 화면 모델 변환, WS 디코딩.
- `backend.ts`: 실제 공개 API·관리 API·메모리 Bearer 세션·WS 연결.
- `backend-layout.ts`: 기존 CRUD 및 버전 기반 PUT을 이용한 편집 저장.
- `realtime.ts`: 전체 스냅샷, 연속 revision 검사, 지수 backoff, 단절 표시·정리.
- `service.ts`: 기본 실제 API. 명시적인 개발 환경에서만 시뮬레이터 로드.

| 화면 작업 | 백엔드 계약 |
| --- | --- |
| 목록·상세 | `GET /places`, `GET /places/{slug}/snapshot` |
| 로그인·확인·로그아웃 | `POST /auth/token`, `GET /auth/me`, `DELETE /auth/token` |
| 공간 관리 | `/admin/places` POST, `/{id}` PATCH/DELETE |
| 배치 저장 | `/admin/places/{id}/seats`, `/tables` CRUD 후 `/layout` PUT |
| 장치 관리 | `/admin/devices`, `/{id}`, `/{id}/rotate-credential` |
| 실시간 | `/places/{slug}/ws` |

위 경로의 공통 접두사는 `/api/v1`입니다. UI 경로는 안정적인 장소 ID를 유지하고 공개 조회 및 WS 연결에서 slug를 해석합니다. 재연결 때 slug를 다시 찾아 이름 변경 이후에도 복구합니다. 삭제된 장소는 종료 상태로 전환하고 재시도를 중단합니다.

## 데이터 의미

- 좌석 ID와 테이블 ID는 서로 다른 DB 시퀀스입니다. 화면에서는 `seat:1`, `table:1`로 분리하고 저장할 때 정수로 변환합니다. 새 요소의 UUID는 생성 응답의 ID로 바꾸고 테이블 연결을 함께 갱신합니다.
- `circle`은 기존 화면의 `ellipse` 렌더러에 매핑합니다. 좌표는 좌상단 원점, 중심 회전이며 API의 회전 전 경계 검증을 따릅니다. 테이블/좌석 label은 편집 UI에 노출하지 않고 기존 값을 유지합니다.
- summary는 snapshot에서 가져오며 이용률은 `occupied / (available + occupied)`입니다. unknown은 이용 가능으로 계산하지 않습니다.
- 장치는 소속 장소 전체를 보고할 수 있습니다. 담당 좌석 ACL·장치 revision은 백엔드에 없으므로 요청에 보내지 않으며 운영 UI에서 좌석 선택을 제공하지 않습니다.
- 관리자 토큰은 localStorage/sessionStorage/URL에 저장하지 않습니다. 관리자 요청의 401은 메모리 세션과 화면 인증을 해제합니다. 로그인 실패나 공개 API 실패는 관리자 만료로 오인하지 않습니다.

## 실시간

`snapshot`과 `layout_changed`의 배치·상태를 함께 화면에 반영합니다. `state_changed`는 ID별로 병합합니다. `layout_changed`도 revision 연속성 검사에 포함하며 누락·server_id 변경 시 새 연결의 snapshot을 요구합니다. 장치만 바뀐 이벤트도 revision을 소비합니다. `place_deleted`는 연결 종료 후 재연결하지 않습니다.

서버는 같은 상태를 반복 보고받으면 이벤트를 생략할 수 있으므로, 클라이언트가 수신 시각에서 임의로 30초 만료를 계산하지 않습니다. unknown 판정은 서버 이벤트를 따르고 연결 단절 중에는 모든 좌석을 unknown으로 표시합니다. 표시된 수신 시각은 마지막 전달된 상태에 포함된 값이며 매 보고마다 갱신되는 값은 아닙니다.

15초마다 애플리케이션 ping을 보내고 45초 침묵 또는 10초 snapshot 지연 시 재연결합니다. 초기 실행/종료 및 비동기 URL 해석 중 취소를 처리합니다. 개발/preview 프록시는 `ws: true`이며 운영에서도 Upgrade 전달과 명시적인 Origin 등록이 필요합니다.

## 저장 보장과 제한

좌표만 변경한 저장은 서버의 `expected_version` PUT으로 원자적 충돌 검사를 받습니다. 서버는 기존 모든 ID를 요구하므로 구조 변경을 PUT에 임의로 넣지 않습니다.

구조 변경은 사전 버전 확인 → 필요 시 캔버스 확장 → 삭제 → 번호 교환을 위한 임시 번호 → 테이블 생성/변경 → 좌석 생성/연결 → 최종 좌표 PUT 순으로 처리합니다. 각 쓰기 후 layout_version 증가를 확인합니다. 오류나 응답 유실 시 자동 재시도하지 않고 초안을 유지하며 일부 저장 가능성을 알립니다. 최신 배치를 내려받아 확인 후 다시 시작할 수 있습니다.

**개별 CRUD는 서버에서 버전 조건을 받지 않습니다.** 전체 구조 변경의 원자성이나 동시 편집 방지는 보장할 수 없습니다. 사전/사후 검사는 경쟁 조건 자체를 제거하지 못합니다. 같은 공간의 구조 편집을 동시에 하지 마세요. 번호 변경은 장치 세션을 초기화하므로 저장 후 펌웨어 번호 매핑도 확인해야 합니다. 공간 PATCH/DELETE와 장치 PATCH도 서버 계약대로 버전 조건 없이 수행합니다.

## 검증

- 프론트 단위 테스트: 기존 테스트 및 ID 변환·응답 오류·상태 freshness·배치 이벤트 누락·부분 저장 실패·오래된 초안 거부.
- `tests/test_frontend.py`: 실제 Uvicorn + 임시 SQLite + production 어댑터로 인증, 공간 CRUD, 좌석/테이블 생성·번호 교환·연결·삭제, 배치 충돌, 장치 등록·활성화·키 교체, 하드웨어 보고·만료, WS 갱신, slug 변경 후 재연결, 장소 삭제·로그아웃을 검증합니다. 직접 연결과 Vite 프록시 경유를 모두 검사합니다.
- 브라우저 Origin을 포함한 실제 WebSocket handshake도 프록시 경유로 확인합니다.
- TypeScript 검사·운영 빌드 및 개발 fixture 제거 검사 통과.
- 전체 회귀 검증에서 발견한 ASGI 취소 시 구독 잔류를 수정하고 명시적인 취소 회귀 테스트를 추가했습니다.
- 이번 작업의 브라우저 화면 조작 검증은 브라우저 제어 호스트 연결 불가로 완료하지 못했습니다. 기존 시뮬레이터 화면 검증과 구분합니다.
