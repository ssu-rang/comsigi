# API 및 실시간 연동 계약

HTTP 접두사는 `/api/v1`입니다. 모든 시각은 서버 수신 기준 UTC ISO 8601이며, 만료 판정은 시스템 시각 보정의 영향을 받지 않는 monotonic clock을 사용합니다. JSON의 추가 필드는 거부합니다. REST 스키마·필수 필드·범위는 `/docs`와 `/openapi.json`에서도 확인할 수 있습니다.

## 관리자 인증

`POST /auth/token`

```json
{"username":"admin","password":"관리자 비밀번호"}
```

성공 응답:

```json
{"access_token":"무작위 토큰","token_type":"bearer","expires_in":28800}
```

관리 API 요청에 `Authorization: Bearer <access_token>`을 보냅니다. `GET /auth/me`는 현재 계정, `DELETE /auth/token`은 현재 토큰을 폐기하고 204를 반환합니다. 토큰은 기본 8시간 동안 유효하며 서버 재시작·비밀번호 변경 시 무효화됩니다. 쿠키와 refresh token은 사용하지 않습니다. 브라우저에서는 토큰을 메모리에 보관하고 401이면 다시 로그인하세요. 모든 HTTP 응답은 `Cache-Control: no-store`입니다.

## 관리 API

다음 경로에는 모두 관리자 토큰이 필요합니다. POST 생성 성공은 201, GET/PATCH/PUT은 200, DELETE 성공은 204입니다. 장치 키 교체 POST는 200입니다. PATCH는 명시한 필드만 변경하며 빈 객체와 null은 거부합니다. `Seat.table_id`는 null로 연결을 해제할 수 있습니다.

| 경로 | 메서드 | 설명 |
| --- | --- | --- |
| `/admin/places` | GET, POST | 장소 목록·생성 |
| `/admin/places/{id}` | GET, PATCH, DELETE | 장소 조회·수정·전체 삭제 |
| `/admin/places/{id}/seats` | GET, POST | 좌석 목록·생성 |
| `/admin/places/{id}/seats/{seat_id}` | GET, PATCH, DELETE | 좌석 조회·수정·삭제 |
| `/admin/places/{id}/tables` | GET, POST | 테이블 목록·생성 |
| `/admin/places/{id}/tables/{table_id}` | GET, PATCH, DELETE | 테이블 조회·수정·삭제 |
| `/admin/places/{id}/layout` | GET, PUT | 전체 배치 조회·원자적 저장 |
| `/admin/devices` | GET, POST | 장치 목록·등록; GET은 `?place_id=` 필터 지원 |
| `/admin/devices/{device_id}` | GET, PATCH, DELETE | 장치 조회·수정·삭제 |
| `/admin/devices/{device_id}/rotate-credential` | POST | 새 장치 키 발급 및 기존 키·세션 무효화 |

목록은 JSON 배열입니다. 장치 조회에는 `status: online/offline/disabled`, `last_seen_at`이 포함되며 키나 해시가 포함되지 않습니다. 장소 삭제는 하위 장치도 삭제합니다.

생성 예제(응답의 실제 ID를 다음 요청에 사용):

```http
POST /api/v1/admin/places
Authorization: Bearer <admin-token>
Content-Type: application/json

{"name":"중앙도서관","slug":"library-1","description":"1층","canvas_width":1200,"canvas_height":800}
```

```http
POST /api/v1/admin/places/1/tables
Authorization: Bearer <admin-token>
Content-Type: application/json

{"number":1,"label":"A 테이블","x":200,"y":200,"width":200,"height":100,"rotation":0,"shape":"rectangle"}
```

```http
POST /api/v1/admin/places/1/seats
Authorization: Bearer <admin-token>
Content-Type: application/json

{"number":1,"label":"창가","x":200,"y":150,"width":40,"height":40,"rotation":0,"table_id":1}
```

`id`는 백엔드의 불변 내부 식별자, `number`는 장소 안에서 유일한 양의 정수이며 하드웨어가 보내는 번호입니다. 좌석 번호와 테이블 번호는 별개의 번호 체계입니다. 테이블 형태는 `rectangle` 또는 `circle`이고 점유 상태를 갖지 않습니다. 장치 UID는 전역 고유하며 영문자·숫자·`_`·`-`만 사용하고 변경할 수 없습니다.

```http
POST /api/v1/admin/devices
Authorization: Bearer <admin-token>
Content-Type: application/json

{"device_uid":"camera-1","name":"입구 카메라","place_id":1,"enabled":true}
```

응답은 `{"device":{...},"credential":"..."}`입니다. credential은 하드웨어에 저장합니다. 분실 시 조회할 수 없고 재발급해야 합니다. PATCH로 장치 이름·장소·활성 여부를 변경할 수 있습니다. 장치의 인증으로 관리자 API에 접근할 수 없습니다.

## 배치 저장

좌표는 캔버스 좌상단을 원점으로 한 논리 단위입니다. x는 오른쪽, y는 아래쪽으로 증가하며, width/height도 같은 단위입니다. 회전은 요소 중심 기준 시계 방향의 도 단위 `[0, 360)`입니다. 좌표는 0 이상, 크기는 0 초과여야 합니다. 회전 전 사각 영역이 캔버스를 벗어나면 거부합니다. 회전 후 시각적 돌출·요소 간 겹침은 편집기에서 처리합니다. 원형 테이블을 정확한 원으로 표시하려면 width와 height를 동일하게 저장하세요.

테이블 이동이 연결 좌석의 좌표를 변경하지 않습니다. 함께 이동하려면 프론트엔드에서 좌석 좌표도 계산하여 아래 요청에 포함합니다.

`PUT /admin/places/1/layout`

```json
{
  "expected_version": 3,
  "canvas_width": 1200,
  "canvas_height": 800,
  "seats": [
    {"id": 1, "x": 300, "y": 150, "width": 40, "height": 40, "rotation": 0}
  ],
  "tables": [
    {"id": 1, "x": 300, "y": 200, "width": 200, "height": 100, "rotation": 0}
  ]
}
```

`expected_version`에는 가장 최근 GET의 `place.layout_version`을 넣습니다. 해당 장소의 **기존 좌석·테이블 ID 전부를 정확히 한 번씩** 포함해야 합니다. 생성·삭제·번호 변경은 개별 CRUD API를 이용합니다. ID 누락/중복/다른 장소 ID/잘못된 크기는 422이며 전체 요청이 취소됩니다. 버전 불일치는 `409 layout_version_conflict`입니다. 성공 시 버전이 증가하고 전체 배치를 반환합니다. 장소·좌석·테이블 CRUD도 버전을 증가시키므로 오래된 편집 화면으로 덮어쓰지 못합니다. 개별 PATCH는 버전 검사를 하지 않으므로 드래그 편집 저장에는 PUT을 사용하세요.

## 하드웨어

하드웨어 API에는 `Authorization: Bearer <device-credential>`을 사용합니다. 서버는 `device_uid`와 키를 검증하고 등록된 `place_id`를 사용합니다. 요청에서 장소·좌표·영상·사람 정보 등을 받지 않습니다. OpenMV 직접 전송과 Arduino 대행 전송은 동일한 계약입니다. 하나의 장치 UID에는 하나의 송신 루프만 사용하세요.

### 1. 세션 시작

부팅·서버 재시작·`session_required` 응답 후 호출합니다.

```http
POST /api/v1/hardware/session
Authorization: Bearer <device-credential>
Content-Type: application/json

{"device_uid":"camera-1"}
```

```json
{
  "session_id":"서버가 발급한 무작위 값",
  "server_id":"서버 실행 인스턴스 UUID",
  "device_timeout_seconds":30,
  "seat_timeout_seconds":30
}
```

새 세션은 기존 세션과 해당 장치의 이전 관측값을 폐기하고 장치를 online으로 만듭니다. 장치의 시퀀스를 0부터 다시 시작합니다. 세션 시작 요청 자체는 매번 새 세션을 발급하므로 여러 세션 요청을 동시에 보내지 마세요. 응답을 잃었다면 순차적으로 다시 요청하고 마지막으로 받은 세션만 사용합니다. 정상 보고마다 새 세션을 열면 이전 관측이 지워지므로 세션을 재사용하세요.

### 2. 상태 보고

```http
POST /api/v1/hardware/reports
Authorization: Bearer <device-credential>
Content-Type: application/json

{
  "device_uid":"camera-1",
  "session_id":"세션 응답에서 받은 값",
  "sequence":0,
  "seats":[{"number":1,"occupied":true},{"number":2,"occupied":false}]
}
```

```json
{"accepted":true,"duplicate":false,"sequence":0,"revision":8}
```

- `sequence`: 세션 안에서 엄격하게 증가하는 정수, 0 이상 `9007199254740991` 이하. 매번 1씩 증가시키면 됩니다. 누락된 번호는 허용하며 최대값 이후에는 새 세션을 엽니다.
- `seats`: 0–500개. 한 요청 안에서 번호 중복은 금지합니다. 하나라도 해당 장소에 없는 좌석이면 **전체를 거부**하며 시퀀스도 소비하지 않습니다. 부분 보고는 허용하지만 보고하지 않은 좌석의 수신 시각은 갱신하지 않습니다.
- `occupied`: JSON `true`/`false`만 허용합니다. `0`, `1`, `"false"` 등은 422입니다.
- 동일한 마지막 시퀀스와 동일한 좌석 내용(배열 순서는 무관)을 재전송하면 `accepted:false, duplicate:true`와 200을 반환합니다. 상태·수신 시각·장치 시각·revision을 갱신하지 않습니다. 시간 만료에 따른 별도 이벤트는 발생할 수 있습니다.
- 마지막 시퀀스보다 작으면 `409 stale_sequence`, 같은 시퀀스에 다른 내용이면 `409 sequence_conflict`입니다. 오래된 과거 메시지의 이력은 보관하지 않습니다.
- `seats: []`는 heartbeat입니다. 시퀀스를 증가시켜 전송하며 **장치 시각만 갱신**합니다. 현재 점유를 유지하려면 변하지 않은 좌석도 주기적으로 보고해야 합니다.
- 기본 만료 30초에서는 10초 정도 간격의 감지·보고를 권장합니다. 서버가 제공한 타임아웃보다 충분히 짧은 주기를 선택하세요.

응답 유실 시 같은 시퀀스·같은 내용으로 제한된 재시도를 합니다. 감지 결과가 바뀌면 새 시퀀스로 보냅니다. 장시간 단절 중의 과거 관측을 쌓아 두었다가 재생하지 말고 현재 감지 결과를 보내세요. 서버가 이미지나 장치의 감지 시각을 받지 않으므로 수신 시점의 최신 결과를 보내는 것은 펌웨어의 책임입니다.

| 응답 | 하드웨어 처리 |
| --- | --- |
| 200 | 수락 또는 마지막 메시지 중복 확인; 다음 시퀀스로 진행 |
| 401 | UID·키·활성 상태 점검; 무한 고속 재시도 금지 |
| 409 `session_required` | 새 세션을 열고 시퀀스를 0으로 초기화, 현재 결과를 다시 감지 |
| 409 `stale_sequence` / `sequence_conflict` | 송신 순서·다중 송신 루프 오류 수정 |
| 422 | 좌석 번호/JSON 계약 수정; 같은 잘못된 요청 반복 금지 |
| 연결 실패 / 5xx | 지수 backoff와 제한된 재시도, 오래된 관측은 버리고 현재 결과로 복구 |

좌석 번호 변경 후 펌웨어의 번호 매핑도 갱신해야 합니다. 이 서버는 어떤 카메라 영역이 어느 물리적 좌석인지 추론하지 않습니다.

## 공개 HTTP 조회

| 경로 | 결과 |
| --- | --- |
| `GET /places` | 장소 배열 |
| `GET /places/{slug}/layout` | `{place, seats, tables}` |
| `GET /places/{slug}/state` | `{server_id, place_id, revision, layout_version, seats, devices, summary}` |
| `GET /places/{slug}/snapshot` | 원자적으로 읽은 `{layout, state}` |

상태 항목은 다음 형태입니다.

```json
{
  "server_id":"server-uuid",
  "place_id":1,
  "revision":8,
  "layout_version":3,
  "seats":[{"id":1,"number":1,"status":"occupied","last_received_at":"2026-01-01T00:00:00Z"}],
  "devices":[{"id":1,"status":"online","last_seen_at":"2026-01-01T00:00:00Z"}],
  "summary":{"total":1,"available":0,"occupied":1,"unknown":0}
}
```

장치 공개 상태에는 내부 ID, 연결 상태, 수신 시각만 포함합니다. 키·UID·관리자 정보는 공개하지 않습니다. 수신 시각은 상태가 unknown이 된 뒤에도 마지막 실제 수신 시각으로 남을 수 있으므로 freshness를 직접 계산해 상태를 덮어쓰지 마세요. 재시작/새 좌석에는 null입니다.

## WebSocket

`ws://host:8000/api/v1/places/{slug}/ws` 또는 HTTPS 환경의 `wss://host/api/v1/places/{slug}/ws`에 연결합니다. 일반 JSON WebSocket이며 Socket.IO 프로토콜이 아닙니다. 공개 읽기 전용이고 이 연결을 통해 상태를 수정할 수 없습니다.

`snapshot`, `state_changed`, `layout_changed`, `place_deleted`는 공통으로 `type`, `server_id`, `place_id`, `revision`, `sent_at`을 갖습니다.

| type | 추가 필드 | 처리 |
| --- | --- | --- |
| `snapshot` | `layout`, `state` | 첫 메시지. 화면의 전체 데이터를 교체 |
| `state_changed` | `layout_version`, `seats`, `devices`, `summary` | 변경된 좌석·장치만 ID로 병합. summary는 전체 값으로 교체 |
| `layout_changed` | `layout`, `state` | 전체 교체. 장치 등록/수정도 이 이벤트를 발생시킬 수 있음 |
| `place_deleted` | 없음 | 장소 종료 화면으로 전환. 이어서 연결 종료 |
| `ping` | `server_id`, `sent_at` | 서버 heartbeat. `{"type":"pong"}`으로 응답 가능 |
| `pong` | `sent_at` | 클라이언트가 보낸 `{"type":"ping"}`에 대한 응답 |

`snapshot` 예제(배치 객체의 필드 정의는 HTTP layout과 동일):

```json
{
  "type":"snapshot",
  "server_id":"server-uuid",
  "place_id":1,
  "revision":8,
  "sent_at":"2026-01-01T00:00:00Z",
  "layout":{
    "place":{"id":1,"name":"도서관","slug":"library-1","description":"","canvas_width":1200,"canvas_height":800,"layout_version":3,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},
    "seats":[{"id":1,"place_id":1,"number":1,"label":"","x":0,"y":0,"width":40,"height":40,"rotation":0,"table_id":null}],
    "tables":[]
  },
  "state":{
    "server_id":"server-uuid","place_id":1,"revision":8,"layout_version":3,
    "seats":[{"id":1,"number":1,"status":"occupied","last_received_at":"2026-01-01T00:00:00Z"}],
    "devices":[{"id":1,"status":"online","last_seen_at":"2026-01-01T00:00:00Z"}],
    "summary":{"total":1,"available":0,"occupied":1,"unknown":0}
  }
}
```

연결과 최초 스냅샷 큐 등록은 상태 변경과 같은 잠금 안에서 수행합니다. 따라서 스냅샷 직후 변경도 같은 연결에서 순서대로 도착합니다. 먼저 HTTP를 읽고 나중에 WS 변경만 적용하는 방식으로 연결 공백을 만들지 말고, WS 첫 스냅샷을 기준으로 삼으세요.

`revision`은 **서버 실행 인스턴스·장소별** 단조 증가 번호이고 DB에 저장하지 않습니다. 상태가 실제로 바뀌거나 설정 이벤트가 발생할 때 증가합니다. `server_id`는 서버 재시작마다 달라집니다. 동일 상태 보고와 heartbeat로 수신 시각만 갱신되면 변경 이벤트는 보내지 않습니다. 정확한 최신 수신 시각이 필요한 관리자 화면은 `/state` 또는 `/admin/devices`를 조회하세요.

연결 중 revision이 누락되거나 예상하지 못한 server_id가 보이면 연결을 다시 열고 스냅샷으로 전체를 교체합니다. 서버는 과거 이벤트 재생·resume 토큰을 제공하지 않습니다. `ping/pong`은 revision 검사 대상이 아닙니다.

프론트엔드 수신 처리의 최소 예제:

```javascript
let current = null;
let revision = -1;
let serverId = null;
const slug = "library-1";
const scheme = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${scheme}://${location.host}/api/v1/places/${slug}/ws`);

ws.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }
  if (event.type === "pong") return;
  if (event.type !== "snapshot" &&
      (event.server_id !== serverId || event.revision !== revision + 1)) {
    ws.close(); // onclose에서 지수 backoff로 재연결하고 새 snapshot을 기다린다.
    return;
  }
  if (event.type === "place_deleted") {
    current = null;
    ws.close(); // 이 경우는 장소가 삭제되었으므로 재연결하지 않는다.
    return;
  }
  if (event.type === "snapshot" || event.type === "layout_changed") {
    current = { layout: event.layout, state: event.state };
  } else if (event.type === "state_changed") {
    const changedSeats = new Map(event.seats.map(s => [s.id, s]));
    const changedDevices = new Map(event.devices.map(d => [d.id, d]));
    current.state.seats = current.state.seats.map(s => changedSeats.get(s.id) ?? s);
    current.state.devices = current.state.devices.map(d => changedDevices.get(d.id) ?? d);
    current.state.summary = event.summary;
    current.state.revision = event.revision;
  }
  serverId = event.server_id;
  revision = event.revision;
  // current.layout.seats와 current.state.seats를 id로 결합하여 렌더링한다.
};
```

실제 UI에는 `connecting / connected / disconnected`를 표시하고, 끊겼을 때 마지막 데이터를 최신으로 표시하지 마세요. `onclose`에서 최대 30초 정도로 제한한 지수 backoff+jitter를 적용해 재연결합니다. Uvicorn은 프로토콜 ping/pong으로 끊어진 연결을 감지하며, 애플리케이션 ping은 기본 15초 유휴 시 송신합니다. 상태 이벤트가 계속 오면 그것으로 연결 생존을 확인할 수 있습니다.

느린 소비자는 큐가 기본 64개를 넘으면 1013으로 종료합니다. 송신 대기 제한은 기본 5초이고 전체 WS 연결 상한은 기본 1000개입니다. 존재하지 않는 장소·허용되지 않은 Origin·연결 상한 초과는 handshake 단계에서 거절됩니다(네트워크에서는 보통 HTTP 403). 이미 연결된 상태의 잘못된 클라이언트 메시지/장소 삭제는 1008, 바이너리 또는 1024자를 넘는 입력은 1009입니다. 연결 해제 시 구독은 제거됩니다.

## 오류

업무 오류는 다음 형태입니다.

```json
{"error":{"code":"unknown_seat_numbers","message":"Unknown seat numbers: [99]"}}
```

Pydantic 검증 오류는 `422 validation_error`이며 `error.details`에 필드 위치·유형·메시지가 추가됩니다. 비밀번호·장치 키·원본 입력은 오류 응답에 포함하지 않습니다.

| 상태 | 의미 |
| --- | --- |
| 400 | 호환 좌석 API에 장소 지정 필요 |
| 401 | 관리자/장치 인증 실패; `WWW-Authenticate: Bearer` 포함 |
| 404 | 장소·좌석·테이블·장치가 없거나 다른 장소의 객체 |
| 409 | 중복 slug/번호/UID, 배치 버전 충돌, 장치 세션/순서 오류 |
| 422 | JSON·필드·좌표·배치 ID·하드웨어 좌석 번호 오류 |
| 429 | 로그인 빈도/관리자 세션 상한; `Retry-After: 60` |
| 503 | DB 장애 또는 만료 작업 비정상 (`/ready`) |

정의되지 않은 경로·메서드 등 프레임워크 기본 오류(404/405)는 FastAPI의 `detail` 형태일 수 있습니다.
