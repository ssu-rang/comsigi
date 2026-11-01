# 백엔드 통합 상태

2026-11-01 조사 기준. 사용자 지시에 따라 백엔드 파일은 수정하지 않았습니다.

## 실제로 확인한 계약

`app/main.py`는 FastAPI 앱에 `app/api/router.py`를 `/api/v1` 접두사로 등록합니다.

| 경로 | 실제 동작 |
| --- | --- |
| `GET /api/v1/health` | `{ "status": "ok" }` |
| `GET /api/v1/seats` | `{ "seats": [] }`; 모델은 양의 정수 `id`와 `available / occupied / unknown` 상태 |

장소, 배치, 인증, 관리자 권한, 장치, WebSocket 구현 및 계약은 현재 없습니다.
요청에 포함된 `/api/places`, `/ws/places/{placeId}` 등은 구현된 경로로 간주하지 않았습니다.
기본 앱은 이 경로들에 요청하지 않으며, 가상 장소로 대체하지 않습니다.
기존에 검증된 두 경로의 HTTP 함수만 `src/api.ts`에 남겨 두었습니다.

## 현재 프론트엔드 경계

- `src/domain.ts`: 화면에서 필요한 내부 모델과 `SeatService` 인터페이스. 서버 스키마가 아닙니다.
- `src/backend.ts`: 아직 연결되지 않은 운영 어댑터. 미지원 작업은 명시적인 오류로 종료합니다.
- `src/service.ts`: 기본은 운영 어댑터. **개발 서버 + 명시적인 환경 변수**일 때만 개발 저장소를 동적 로드합니다.
- `src/dev/service.ts`: 브라우저 저장소를 사용하는 UI 검증 시뮬레이터. 실제 API·인증 서버·장치 수신 서버가 아닙니다.
- `src/realtime.ts`: 검증된 endpoint와 decoder가 주입되어야 사용할 수 있는 WebSocket 전송 로직. 기본 앱은 WebSocket을 열지 않습니다.

개발 로그인, localStorage 저장, 토큰 해시, 장치 데이터 입력은 개발 모드 전용입니다.
브라우저 저장소로 서버 인증이나 접근 제어를 대신했다고 간주하면 안 됩니다.
운영 빌드에서는 개발 모듈·계정·장소·시뮬레이터가 제거됩니다. URL이나 localStorage 값으로 활성화할 수 없습니다.

## 실제 계약을 받은 뒤 연결할 항목

1. 실제 OpenAPI 및 라우터에서 장소·배치·장치 요청/응답을 확인하고 `backend.ts`의 메서드를 구현합니다. 응답을 내부 모델로 명시적으로 변환하고 런타임 검증을 추가합니다.
2. 로그인, 세션 확인, 로그아웃과 관리자 권한을 확인합니다. Cookie/CSRF 또는 bearer 방식에 맞게 `requestJson` 옵션을 지정합니다. 현재 구현은 어떤 방식을 가정해 토큰을 저장하지 않습니다.
3. 좌표 원점, 회전 중심, 단위, ID/번호 구분, 허용 형태, 캔버스 축소 및 삭제 정책을 매핑합니다. UI의 좌표는 좌상단 x/y, 요소 중심 회전, 논리 좌표 단위입니다.
4. 배치 revision의 충돌 응답을 `ApiError(…, 409)`로, 인증 만료를 401로 매핑합니다. 저장 응답은 서버가 확정한 전체 배치여야 합니다. 임시 UUID가 서버 ID로 치환되는 경우 테이블/장치 연결까지 매핑합니다.
5. 실제 WebSocket 메시지의 decoder를 구현한 뒤 `connectSocket`을 사용합니다. 클라이언트에 맞춰 서버 프로토콜을 임의로 바꾸지 않습니다.
6. 감지 시각과 유효 기간을 서버 기준으로 매핑합니다. transport 연결과 sensor freshness를 분리합니다. 현재 내부 이용률은 `occupied / (available + occupied)`의 정수 백분율이며, 알려진 좌석이 없으면 `null`입니다. 서버 계산 기준이 다르면 한 곳에서 일치시켜야 합니다.
7. 장소 삭제의 좌석·테이블·장치 영향, 담당 좌석 중복 검증, 토큰 재발급 정책을 실제 서버와 맞추고 사용자 설명도 갱신합니다.
8. 동일 출처 reverse proxy 또는 CORS 설정을 확인합니다. HTTPS 사이트의 소켓에는 WSS를 사용합니다. 인증 정보를 URL에 넣지 않습니다.

### 내부 실시간 이벤트

이 이벤트는 **서버의 JSON 계약이 아니라 어댑터의 출력 타입**입니다.

- snapshot: 장소 ID, 재시작을 구분할 stream ID, 버전, 배치 revision, 좌석별 상태/감지 시각, 서버 기준 유효 기간.
- seat_update: 장소/stream ID, 연속 버전, 변경된 좌석들의 상태/감지 시각.
- layout_updated: 장소 ID와 새 배치 revision.
- place_deleted: 장소 ID.

중복/과거 이벤트는 무시하고 누락·stream 변경 시 재연결 후 snapshot을 요구합니다.
재시도는 1초부터 지수 증가하고 최대 기본 30초에 jitter를 적용합니다. snapshot 대기 시간은 10초입니다.
heartbeat/ping payload와 silence timeout은 확인된 프로토콜이 지원할 때만 설정합니다.
StrictMode 첫 setup/cleanup은 연결 전에 취소됩니다. 전환·언마운트 시 타이머와 소켓을 정리합니다.
재연결 snapshot의 revision도 REST 배치와 비교하므로 놓친 배치 변경을 다시 조회합니다.

## 아직 실제 API로 검증하지 않은 항목

전체 장소 CRUD, 관리자 인증/접근 제어, 배치 저장/충돌, 장치 토큰/담당 좌석,
네트워크 WebSocket, 하드웨어 입력, 실제 서버 재시작 후 데이터 영속성과 unknown 초기화.
현재 완료한 테스트는 프론트엔드 단위 테스트와 개발 시뮬레이터를 사용하는 실제 브라우저 테스트입니다.
개발 도구의 ‘감지 정보 초기화’는 실제 서버 재시작 테스트가 아닙니다.

## 디자인 적용

기존 taste-skill 방향 `Achromatic ledger` (seed `341211071`)와 IBM Plex Sans KR,
녹색 좌석 상태, 8px 패널/6px 컨트롤, 공간 목록 및 좌석 요약 구성을 유지했습니다. 새 추첨이나 스타일 변경은 하지 않았습니다.
사용자 화면의 질문은 ‘어느 공간에 빈 좌석이 있는가’, 관리자는 ‘공간 배치가 올바른가’, 장치는 ‘어떤 좌석을 감지하는가’입니다.

- [NN/g 사용성 휴리스틱](https://www.nngroup.com/articles/ten-usability-heuristics/): 연결·저장 상태 가시화, 실행 취소, 삭제 확인, 복구 가능한 오류.
- [Fitts의 법칙](https://lawsofux.com/fittss-law/): 모바일 제어 버튼의 터치 영역, 배치도 확대 및 별도 번호순 좌석 보기.
- [근접성 원칙](https://lawsofux.com/law-of-proximity/): 배치 도구·캔버스·선택 요소 속성의 기능별 묶음.
- [Carbon 빈 상태](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states): 데이터 부재, 검색 결과 없음, 연결 준비 상태를 구분하고 가능한 다음 동작 표시.
- Material 3 웹페이지는 JavaScript 요구 화면만 반환하여 본문을 확인하지 못했습니다. 확인한 원칙의 근거로 사용하지 않았습니다.

제품 화면에 새로운 이미지나 장식, 외부 컴포넌트 라이브러리를 추가하지 않았습니다.
