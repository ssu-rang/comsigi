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
| `/admin/pairing-codes` | GET, POST | 카메라 페어링 코드 목록(코드 값 제외)·발급(201, 코드는 이 응답에서만) |
| `/admin/pairing-codes/{code_id}` | DELETE | 페어링 코드 폐기 |
| `/admin/device-registrations` | GET | 카메라 등록 요청 목록; `?status=pending` 등 필터 지원 |
| `/admin/device-registrations/{id}/approve` | POST | 공간을 지정해 승인, 장치·좌석 생성(200) |
| `/admin/device-registrations/{id}/reject` | POST | 등록 요청 거절(200) |
| `/admin/provisioning-failures` | GET | 최근 페어링 인증 실패(서버 메모리, 재시작 시 초기화) |

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

## 카메라 자동 등록

관리자가 UID를 입력하지 않고 카메라를 공간에 연결하는 흐름입니다. 카메라 쪽 요청·응답·재시도 규칙은 [HARDWARE.md](HARDWARE.md#0-자동-등록페어링)에 있습니다.

1. 관리자: `POST /admin/places`로 공간을 만듭니다. `place_id`는 서버가 발급하며 응답의 `id`를 이후 요청에 씁니다.
2. 관리자: `POST /admin/pairing-codes`로 페어링 코드를 받아 카메라 설정에 넣습니다.
3. 카메라: `POST /provisioning/register`(Bearer 페어링 코드)로 하드웨어 UID와 좌석 번호를 보내고 등록 비밀값을 받습니다. 요청은 `pending`으로 DB에 저장됩니다.
4. 관리자: `GET /admin/device-registrations?status=pending`을 주기적으로 조회(REST 폴링, 관리자 화면은 5초)합니다.
5. 관리자: `POST /admin/device-registrations/{id}/approve`로 공간을 지정합니다. 장치와 없는 번호의 좌석을 한 트랜잭션으로 만듭니다.
6. 카메라: `POST /provisioning/status`(Bearer 등록 비밀값)로 장치 키를 받고, `POST /hardware/registration/confirm`(Bearer 장치 키)으로 수령을 확인합니다.

```http
POST /api/v1/admin/pairing-codes
Authorization: Bearer <admin-token>
```

```json
{"id":3,"status":"active","created_at":"2026-01-01T00:00:00Z","expires_at":"2026-01-01T00:15:00Z","used_at":null,"revoked_at":null,"code":"한 번만 표시되는 코드"}
```

```http
POST /api/v1/admin/device-registrations/7/approve
Authorization: Bearer <admin-token>
Content-Type: application/json

{"place_id":1,"name":"입구 카메라","create_seats":true}
```

```json
{
  "registration":{"id":7,"device_uid":"e6614103e7a5b52b","status":"approved","model":"OpenMV H7","firmware_version":"1.0","seat_numbers":[1,2,3],"requested_at":"...","expires_at":"...","decided_at":"...","place_id":1,"device_id":4},
  "device":{"id":4,"device_uid":"e6614103e7a5b52b","name":"입구 카메라","place_id":1,"enabled":true,"created_at":"...","status":"offline","last_seen_at":null},
  "seats_created":[1,3],
  "seats_existing":[2]
}
```

등록 상태(`status`)는 다음과 같습니다.

| 값 | 의미 |
| --- | --- |
| `pending` | 승인 대기 (기본 24시간 후 `expired`) |
| `approved` | 승인됨, 카메라가 장치 키를 아직 수령 확인하지 않음 |
| `completed` | 카메라가 장치 키로 수령을 확인함 |
| `rejected` | 관리자가 거절 |
| `expired` | 승인 기한이 지남. 승인하면 `409 registration_expired` |
| `removed` | 승인 후 장치·공간이 삭제됨 |

- 승인은 멱등입니다. 같은 공간으로 다시 승인하면 아무것도 만들지 않고 현재 결과(`seats_created: []`)를 반환합니다. 다른 공간이면 `409 registration_already_approved`입니다. 장소 변경은 기존 `PATCH /admin/devices/{id}`로 합니다.
- 좌석은 보고된 번호 중 없는 번호만 만들고, 기존 좌석을 수정·삭제하지 않습니다. 새 좌석은 겹치지 않는 40×40 격자에 놓이며 필요하면 캔버스 높이만 늘어나고 `layout_version`이 증가합니다. 캔버스 너비가 좌석보다 좁으면 `422 canvas_too_small`이고 아무것도 저장하지 않습니다.
- 대기·만료·거절 요청만 거절할 수 있습니다. 승인된 장치를 끊으려면 장치를 삭제합니다(등록은 `removed`).
- 응답과 목록에는 페어링 코드·등록 비밀값·장치 키·해시가 없습니다. 장치 키는 카메라에만 한 번씩 전달되고, 관리자 응답에는 포함되지 않습니다. 관리자가 키를 직접 받아야 하면 기존 `rotate-credential`을 사용합니다.
- 관리자 토큰으로는 카메라 엔드포인트를, 페어링 코드·등록 비밀값·장치 키로는 관리자 API를 호출할 수 없습니다. 공개 조회 API와 WebSocket에는 등록 정보와 UID가 나오지 않습니다.
- 대기 요청·페어링 코드는 SQLite에 저장되어 서버 재시작 뒤에도 유지됩니다. 인증 실패 기록(`/admin/provisioning-failures`)과 실패 횟수 제한만 메모리에 있습니다.

설정 환경 변수(기본값): `COMSIGI_PAIRING_CODE_TTL_SECONDS`(900), `COMSIGI_REGISTRATION_TTL_SECONDS`(86400), `COMSIGI_REGISTRATION_POLL_SECONDS`(10), `COMSIGI_MAX_ACTIVE_PAIRING_CODES`(50, 넘으면 `409 too_many_pairing_codes`).

### 하위 호환성과 전환

- 기존 API·하드웨어 계약은 바뀌지 않았습니다. 수동 장치 등록(`POST /admin/devices`)과 기존 장치 키는 그대로 동작합니다.
- 마이그레이션 `0002_device_provisioning`은 `pairing_tokens`, `device_registrations` 테이블만 추가합니다. 배포 시 기존처럼 `alembic upgrade head`(또는 `comsigi prepare-deploy`)를 실행하면 됩니다. 서버는 스키마가 최신이 아니면 시작하지 않습니다. 되돌리려면 이전 코드로 돌아가기 전에 `alembic downgrade 0001_initial`을 실행합니다(등록 요청 기록만 삭제).
- 기존 장치를 자동 등록으로 옮길 필요는 없습니다. 이미 있는 UID로 등록을 요청하면 `409 device_already_registered`입니다.

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

전송 효율을 위해 여러 좌석을 한 요청에 묶고, HTTP 클라이언트는 연결을 재사용하세요. `scripts/simulate_device.py`는 HTTP(S) 연결을 재사용하고 불필요한 JSON 공백을 생략합니다. 서버나 프록시가 유휴 연결을 닫으면 다시 연결해 같은 본문·시퀀스로 제한된 재시도를 합니다. 세션은 보고마다 생성하지 않고 재사용하며, `session_id`는 이전 실행의 지연 보고를 차단하기 위해 유지합니다. 실제 펌웨어가 감지 주기와 전송 주기를 분리할 때에는 변경 시 부분 보고와 주기적인 전체 보고를 함께 사용하세요. 전체 보고 주기는 좌석 만료 시간보다 충분히 짧아야 하며, 빈 heartbeat만으로 좌석 상태를 유지할 수는 없습니다.

응답 유실 시 같은 시퀀스·같은 내용으로 제한된 재시도를 합니다. 감지 결과가 바뀌면 새 시퀀스로 보냅니다. 장시간 단절 중의 과거 관측을 쌓아 두었다가 재생하지 말고 현재 감지 결과를 보내세요. 서버가 이미지나 장치의 감지 시각을 받지 않으므로 수신 시점의 최신 결과를 보내는 것은 펌웨어의 책임입니다.

| 응답 | 하드웨어 처리 |
| --- | --- |
| 200 | 수락 또는 마지막 메시지 중복 확인; 다음 시퀀스로 진행 |
| 401 | UID·키·활성 상태 점검; 무한 고속 재시도 금지 (본문 검증보다 먼저 판정) |
| 409 `session_required` | 새 세션을 열고 시퀀스를 0으로 초기화, 현재 결과를 다시 감지 |
| 409 `stale_sequence` / `sequence_conflict` | 송신 순서·다중 송신 루프 오류 수정 |
| 413 `body_too_large` | 본문 64 KiB 초과; 요청 크기 수정 |
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

배치(좌표·크기·테이블·장소 정보)는 `GET /places/{slug}/layout`으로 조회합니다. WebSocket은 점유 상태만 전달하며 배치 본문을 포함하지 않습니다. `snapshot`, `state_changed`, `state_reset`, `place_deleted`는 공통으로 `type`, `server_id`, `place_id`, `revision`, `sent_at`을 갖습니다.

| type | 추가 필드 | 처리 |
| --- | --- | --- |
| `snapshot` | `state` | 첫 메시지. 전체 점유·장치 상태를 교체 |
| `state_changed` | `layout_version`, `seats`, `devices`, `summary` | 변경된 좌석·장치만 ID로 병합. summary는 전체 값으로 교체 |
| `state_reset` | `state` | 설정 변경 후 전체 상태 교체. 삭제된 좌석의 상태도 제거. 장치 등록/수정도 발생시킬 수 있음 |
| `place_deleted` | 없음 | 장소 종료 화면으로 전환. 이어서 연결 종료 |
| `ping` | `server_id`, `sent_at` | 서버 heartbeat. `{"type":"pong"}`으로 응답 가능 |
| `pong` | `sent_at` | 클라이언트가 보낸 `{"type":"ping"}`에 대한 응답 |

`snapshot` 예제(`state_reset`도 같은 구조이며 연속된 revision 검사가 필요):

```json
{
  "type":"snapshot",
  "server_id":"server-uuid",
  "place_id":1,
  "revision":8,
  "sent_at":"2026-01-01T00:00:00Z",
  "state":{
    "server_id":"server-uuid","place_id":1,"revision":8,"layout_version":3,
    "seats":[{"id":1,"number":1,"status":"occupied","last_received_at":"2026-01-01T00:00:00Z"}],
    "devices":[{"id":1,"status":"online","last_seen_at":"2026-01-01T00:00:00Z"}],
    "summary":{"total":1,"available":0,"occupied":1,"unknown":0}
  }
}
```

연결과 최초 상태 스냅샷 큐 등록은 상태 변경과 같은 잠금 안에서 수행합니다. 따라서 스냅샷 직후 변경도 같은 연결에서 순서대로 도착합니다. 점유 상태는 WS 첫 스냅샷을 기준으로 삼고, 배치는 별도로 HTTP 조회합니다. HTTP와 WS의 도착 순서는 무관합니다. `state.layout_version`(변경 이벤트는 `layout_version`)이 배치의 `place.layout_version`보다 높으면 HTTP로 배치를 다시 조회합니다. 조회 중 새 상태가 오면 계속 반영하며, 상태와 배치의 버전이 일치하기 전에는 해당 배치의 좌석을 unknown으로 표시합니다. 배치 저장 후에는 HTTP 응답 또는 재조회로 화면을 갱신합니다.

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
  if (event.type === "snapshot" || event.type === "state_reset") {
    current = event.state;
  } else if (event.type === "state_changed") {
    const changedSeats = new Map(event.seats.map(s => [s.id, s]));
    const changedDevices = new Map(event.devices.map(d => [d.id, d]));
    current.seats = current.seats.map(s => changedSeats.get(s.id) ?? s);
    current.devices = current.devices.map(d => changedDevices.get(d.id) ?? d);
    current.summary = event.summary;
    current.revision = event.revision;
    current.layout_version = event.layout_version;
  }
  serverId = event.server_id;
  revision = event.revision;
  // 별도로 HTTP 조회한 배치와 current.layout_version을 비교한다.
  // 배치 버전이 낮으면 HTTP로 재조회하고, 버전이 같을 때 seat.id로 결합한다.
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
| 401 | 관리자/장치/페어링 코드/등록 비밀값 인증 실패; `WWW-Authenticate: Bearer` 포함 |
| 404 | 장소·좌석·테이블·장치가 없거나 다른 장소의 객체 |
| 409 | 중복 slug/번호/UID, 배치 버전 충돌, 장치 세션/순서 오류, 카메라 등록 상태 충돌 |
| 413 | 하드웨어·카메라 등록 요청 본문 64 KiB 초과 |
| 422 | JSON·필드·좌표·배치 ID·하드웨어 좌석 번호 오류 |
| 429 | 로그인 빈도/관리자 세션 상한/페어링 인증 실패 횟수; `Retry-After: 60` |
| 503 | DB 장애 또는 만료 작업 비정상 (`/ready`) |

정의되지 않은 경로·메서드 등 프레임워크 기본 오류(404/405)는 FastAPI의 `detail` 형태일 수 있습니다.
