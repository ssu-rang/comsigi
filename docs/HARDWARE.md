# 하드웨어 연동 API

장치는 세션을 한 번 열고, 그 세션으로 좌석 점유 결과를 약 10초마다 보고합니다. 서버는 좌석 번호와 점유 여부(`true`/`false`)만 받습니다. 영상, 좌표, 사람 정보, 장치 시각은 보내지 않습니다.

전체 API 계약은 [API.md](API.md)를 참고하세요. 이 문서는 장치 펌웨어에 필요한 부분만 담았습니다.

## 개요

| 항목 | 값 |
| --- | --- |
| 기본 URL | `https://<서버 주소>/api/v1` (로컬 개발: `http://127.0.0.1:8000/api/v1`) |
| 형식 | JSON, `Content-Type: application/json`, 추가 필드는 거부 |
| 엔드포인트 | `POST /hardware/session`, `POST /hardware/reports` (최초 등록: `POST /provisioning/register`, `POST /provisioning/status`, `POST /hardware/registration/confirm`) |
| 인증 | `Authorization: Bearer <장치 키>` (등록 단계는 페어링 코드·등록 비밀값) |
| 본문 크기 상한 | 64 KiB (좌석 500개 보고도 32 KiB 미만) |
| 기본 만료 | 장치 30초, 좌석 30초 (실제 값은 세션 응답으로 전달) |

OpenMV가 직접 보내든 Arduino가 대신 보내든 계약은 같습니다. 장치 UID 하나에는 송신 루프를 하나만 두세요.

## 인증

장치 키를 얻는 방법은 두 가지입니다.

- **자동 등록(권장)**: 카메라가 하드웨어 식별자로 직접 등록을 요청하고, 관리자가 승인하면 서버가 장치 키를 카메라에 전달합니다. 아래 [0. 자동 등록](#0-자동-등록페어링)을 따르세요. 관리자가 UID를 찾아 입력할 필요가 없습니다.
- **수동 등록(기존 방식)**: 관리자가 `device_uid`를 입력해 장치를 만들면 장치 키가 발급됩니다. 키는 등록할 때와 재발급(`rotate-credential`)할 때 **한 번만** 표시되므로 펌웨어 설정에 바로 저장하세요.

- 모든 하드웨어 요청에 `Authorization: Bearer <장치 키>` 헤더를 붙입니다.
- 본문의 `device_uid`는 그 키로 등록된 UID와 같아야 합니다. 형식은 영문, 숫자, `_`, `-`로 1–100자입니다.
- 장소는 서버가 등록 정보로 정합니다. 요청에 `place_id`를 넣으면 422입니다.
- 키가 틀리거나 장치가 비활성이면 본문을 검사하기 전에 `401 device_unauthorized`를 반환합니다.
- 관리자가 키를 재발급하거나 장치의 장소·활성 상태를 바꾸면 기존 세션이 끊깁니다. 다음 보고는 `409 session_required`를 받습니다.

## 0. 자동 등록(페어링)

장치 키가 아직 없는 카메라가 한 번만 수행합니다. 저장된 장치 키가 있으면 건너뛰고 바로 세션을 시작합니다.

### 준비

1. 관리자가 관리자 페이지(공간 설정의 “카메라 연결” 단계 또는 장치 관리)에서 **페어링 코드**를 발급합니다. 코드는 한 번만 표시되고, 15분 뒤 만료되며, 카메라 한 대만 등록할 수 있습니다.
2. 코드를 카메라 설정 파일에 넣습니다(예: OpenMV의 `config.json`). 등록이 끝나면 지워도 됩니다.
3. `device_uid`는 펌웨어가 하드웨어에서 직접 읽습니다. 영문·숫자·`_`·`-` 1–100자로 변환하세요.

| 장치 | `device_uid` 예 |
| --- | --- |
| OpenMV (MicroPython) | `ubinascii.hexlify(machine.unique_id()).decode()` |
| ESP32 / Arduino Wi-Fi | `WiFi.macAddress()`에서 `:`를 빼고 소문자로 |
| 시뮬레이터 | 기본값: 실행 PC의 하드웨어 주소 (`uuid.getnode()`) |

### 등록 요청

```http
POST /api/v1/provisioning/register
Authorization: Bearer <페어링 코드>
Content-Type: application/json

{"device_uid":"e6614103e7a5b52b","seat_numbers":[1,2,3,4],"model":"OpenMV H7","firmware_version":"1.0"}
```

```json
{"status":"pending","registration_secret":"서버가 발급한 무작위 값","retry_after_seconds":10,"expires_at":"2026-01-02T00:00:00Z"}
```

| 요청 필드 | 규칙 |
| --- | --- |
| `device_uid` | 하드웨어 식별자. 필수 |
| `seat_numbers` | 카메라가 감지하도록 설정된 **실제 좌석 번호 목록**(권장). 0–500개, 1 이상, 중복 금지 |
| `seat_count` | 번호 목록이 없을 때만 사용. `N`이면 좌석 1…N으로 간주. `seat_numbers`와 함께 보내면 422 |
| `model`, `firmware_version` | 선택. 관리자 화면 표시용 (출력 가능한 ASCII, 100자/50자 이하) |

- `registration_secret`은 이 응답에서 **한 번만** 받습니다. 저장해 두고 상태 확인에만 사용합니다.
- 응답을 못 받았으면 **같은 페어링 코드·같은 UID로 다시 요청**하세요. 코드가 만료되기 전이고 등록이 대기 중이면 200과 새 비밀값을 받으며 이전 비밀값은 무효가 됩니다.
- 장소는 보내지 않습니다. 관리자가 승인할 때 정합니다.
- 서버는 대기 요청을 DB에 저장하므로 서버가 재시작되어도 대기 상태와 비밀값이 유지됩니다.

### 상태 확인 (REST 폴링)

`retry_after_seconds`(기본 10초) 간격으로 호출합니다. 동시에 여러 번 보내지 말고 순서대로 호출하세요.

```http
POST /api/v1/provisioning/status
Authorization: Bearer <registration_secret>
Content-Type: application/json

{"device_uid":"e6614103e7a5b52b"}
```

```json
{"status":"approved","retryable":false,"retry_after_seconds":null,"expires_at":null,"credential":"장치 키"}
```

| `status` | `retryable` | 의미와 장치 처리 |
| --- | --- | --- |
| `pending` | `true` | 관리자 승인 대기. `Retry-After` 헤더·`retry_after_seconds` 후 다시 확인 |
| `approved` | `false` | 응답의 `credential`이 장치 키. 즉시 저장하고 아래 수령 확인을 보냄 |
| `completed` | `false` | 수령 확인까지 끝남. 키는 다시 제공하지 않음 |
| `rejected` | `false` | 관리자가 거절. 새 페어링 코드가 필요 |
| `expired` | `false` | 기본 24시간 안에 승인되지 않음. 새 페어링 코드가 필요 |
| `removed` | `false` | 승인 뒤 관리자가 장치나 공간을 삭제함. 새 페어링 코드가 필요 |

- `approved` 응답은 **수령 확인 전까지 매번 새 키를 발급**하고 이전 키를 무효화합니다. 응답을 잃었으면 상태를 다시 확인해 새 키를 받으세요. 항상 마지막으로 받은 키만 사용합니다.
- 401 `registration_unauthorized`: 비밀값이 틀렸거나 재등록으로 교체됨. 다시 등록하세요.

### 키 수령 확인

받은 장치 키로 한 번 호출합니다. 이후 상태 확인은 키를 더 발급하지 않습니다. 여러 번 호출해도 결과가 같습니다.

```http
POST /api/v1/hardware/registration/confirm
Authorization: Bearer <장치 키>
Content-Type: application/json

{"device_uid":"e6614103e7a5b52b"}
```

```json
{"status":"completed"}
```

확인 응답을 못 받았으면 상태 확인을 다시 호출합니다. `completed`이면 가진 키를 그대로 쓰고, `approved`이면 새 키로 다시 확인합니다. 그다음은 기존과 같이 세션을 시작합니다.

### 좌석 자동 생성

관리자가 승인할 때 카메라가 보고한 번호 중 **해당 공간에 없는 번호만** 좌석으로 만듭니다. 장치 생성·좌석 생성·등록 상태 변경은 한 트랜잭션이라 실패하면 아무것도 남지 않고 다시 승인할 수 있습니다.

- 이미 있는 좌석의 위치·라벨·테이블·번호·점유 상태는 바꾸지 않습니다.
- 좌석은 삭제하지 않습니다. 카메라가 이전보다 적은 번호를 보고해도(축소) 남은 좌석은 그대로이며, 필요하면 관리자가 배치 편집기에서 지웁니다.
- 새 좌석은 40×40 크기로 기존 요소와 겹치지 않는 격자 위치에 놓입니다. 자리가 부족하면 캔버스 높이만 늘립니다. 관리자가 배치 편집기에서 옮길 수 있습니다.
- 같은 승인을 다시 보내도 좌석이 중복 생성되지 않습니다.
- 승인 뒤 좌석 번호를 바꾸려면 관리자 화면에서 좌석을 수정하고 펌웨어 매핑도 함께 바꿉니다. 없는 번호의 보고는 지금처럼 `422 unknown_seat_numbers`로 거부합니다.

### 등록 오류

| 상태 | `error.code` | 장치 처리 |
| --- | --- | --- |
| 401 | `pairing_unauthorized` | 코드가 틀렸거나 폐기됨. 설정 확인 |
| 401 | `pairing_code_expired` | 코드 만료(재시도 가능 기간도 끝남). 새 코드 필요 |
| 401 | `pairing_code_used` | 다른 카메라가 이미 사용함. 새 코드 필요 |
| 409 | `device_already_registered` | 이 UID의 장치가 이미 있음. 저장된 키를 쓰거나 관리자에게 키 재발급·장치 삭제 요청. 코드는 소비되지 않음 |
| 413 | `body_too_large` | 본문 64 KiB 초과 |
| 422 | `validation_error` | 필드 형식 수정 |
| 429 | `pairing_rate_limited` | 같은 주소에서 60초 동안 인증 실패 10회. `Retry-After` 후 재시도 |
| 연결 실패, 5xx | — | 같은 요청으로 backoff 재시도 |

## 1. 세션 시작

부팅 직후, 서버 재시작 뒤, `409 session_required`를 받았을 때 호출합니다.

```http
POST /api/v1/hardware/session
Authorization: Bearer <장치 키>
Content-Type: application/json

{"device_uid":"camera-1"}
```

```json
{
  "session_id": "서버가 발급한 무작위 값",
  "server_id": "서버 실행 인스턴스 UUID",
  "device_timeout_seconds": 30,
  "seat_timeout_seconds": 30
}
```

| 응답 필드 | 의미 |
| --- | --- |
| `session_id` | 이후 모든 보고에 넣는 값 |
| `server_id` | 서버 프로세스가 바뀌면 달라짐 (로그용) |
| `device_timeout_seconds` | 이 시간 동안 보고가 없으면 장치가 offline |
| `seat_timeout_seconds` | 이 시간 동안 다시 보고되지 않은 좌석은 unknown |

- 새 세션을 열면 이 장치의 이전 세션과 이전 관측값이 지워지고, 시퀀스는 0부터 다시 시작합니다.
- 보고할 때마다 세션을 새로 열지 마세요. 관측값이 계속 지워집니다.
- 세션 요청을 동시에 여러 개 보내지 마세요. 응답을 못 받았으면 순서대로 다시 요청하고, 마지막으로 받은 `session_id`만 씁니다.

## 2. 좌석 보고

```http
POST /api/v1/hardware/reports
Authorization: Bearer <장치 키>
Content-Type: application/json

{
  "device_uid": "camera-1",
  "session_id": "세션 응답에서 받은 값",
  "sequence": 0,
  "seats": [
    {"number": 1, "occupied": true},
    {"number": 2, "occupied": false}
  ]
}
```

```json
{"accepted": true, "duplicate": false, "sequence": 0, "revision": 8}
```

| 요청 필드 | 규칙 |
| --- | --- |
| `device_uid` | 세션을 연 UID |
| `session_id` | 세션 응답 값 그대로 (20–100자, 영문·숫자·`_`·`-`) |
| `sequence` | 정수, 0 이상 9007199254740991 이하. 보고마다 1씩 증가 |
| `seats` | 0–500개. 한 요청 안에서 번호 중복 금지 |
| `seats[].number` | 1 이상의 좌석 번호. 관리자 화면에 등록된 번호 |
| `seats[].occupied` | JSON `true`/`false`만 허용. `0`, `1`, `"false"`는 422 |

| 응답 필드 | 의미 |
| --- | --- |
| `accepted` | 새 보고로 반영됐으면 `true` |
| `duplicate` | 직전 보고의 재전송으로 판단됐으면 `true` |
| `sequence` | 요청한 시퀀스 |
| `revision` | 장소 상태 버전 (로그용) |

- 해당 장소에 없는 좌석 번호가 하나라도 있으면 **전체를 거부**(422)하고 시퀀스도 소비하지 않습니다.
- 일부 좌석만 보고해도 됩니다. 보고하지 않은 좌석은 수신 시각이 갱신되지 않아 만료 시간이 지나면 unknown이 됩니다.
- `seats: []`는 heartbeat입니다. 장치 online 상태만 유지하고 좌석 상태는 유지하지 않습니다.

## 시퀀스·중복·만료 규칙

| 상황 | 서버 처리 |
| --- | --- |
| 직전보다 큰 시퀀스 | 반영 (`accepted: true`) |
| 직전과 같은 시퀀스, 같은 좌석 내용 | 200, `duplicate: true`, 아무것도 갱신하지 않음 |
| 직전과 같은 시퀀스, 다른 내용 | `409 sequence_conflict` |
| 직전보다 작은 시퀀스 | `409 stale_sequence` |

- 응답을 못 받았으면 **같은 시퀀스, 같은 본문**으로 재시도합니다. 서버가 중복을 걸러 주므로 안전합니다.
- 감지 결과가 바뀌었으면 새 시퀀스로 보냅니다. 시퀀스 번호는 건너뛰어도 됩니다.
- 시퀀스가 최대값에 닿으면 새 세션을 엽니다.
- 좌석 상태를 유지하려면 바뀌지 않은 좌석도 `seat_timeout_seconds`보다 충분히 짧은 주기로 다시 보고하세요. 기본 30초에서는 10초 간격을 권장합니다.
- 장치가 `device_timeout_seconds` 동안 보고하지 않으면 offline이 되고, 그 장치의 관측값은 버려집니다. 다시 보고하면 online으로 돌아옵니다.
- 오래 끊겼다면 쌓아 둔 과거 관측을 재생하지 말고 지금 감지한 결과를 보내세요. 서버는 수신 시각을 기준으로 판단합니다.

## 오류 응답

모든 오류는 같은 형식입니다. 장치는 `error.code`로 분기하세요.

```json
{"error": {"code": "session_required", "message": "Start a new hardware session"}}
```

| 상태 | `error.code` | 장치 처리 |
| --- | --- | --- |
| 401 | `device_unauthorized` | UID·키·활성 상태 점검. 빠른 반복 재시도 금지 |
| 409 | `session_required` | 새 세션을 열고 시퀀스를 0으로, 현재 결과를 다시 감지해 보고 |
| 409 | `stale_sequence`, `sequence_conflict` | 펌웨어 버그(송신 순서, 송신 루프 중복). 수정 필요 |
| 413 | `body_too_large` | 본문 64 KiB 초과. 요청 크기 수정 |
| 422 | `validation_error`, `unknown_seat_numbers` | 필드 형식 또는 좌석 번호 매핑 수정. 같은 요청 반복 금지 |
| 연결 실패, 5xx | — | 지수 backoff로 제한된 횟수만 재시도 |

## 권장 구현 루프

```text
if 저장된 장치 키 없음:
    secret = POST /provisioning/register (페어링 코드, UID, 좌석 번호)   # 실패 시 같은 코드로 재시도
    loop:
        r = POST /provisioning/status (secret)
        pending   → retry_after_seconds 대기
        approved  → 키 저장, POST /hardware/registration/confirm (키) 성공 시 종료
        completed → 저장한 키로 종료
        그 외     → 중단, 새 페어링 코드 요청
session = None
loop:
    if session is None:
        session = POST /hardware/session      # 실패 시 5초 대기 후 재시도
        sequence = 0
    seats = 현재 감지 결과 (등록된 모든 좌석)
    result = POST /hardware/reports (session, sequence, seats)
        - 연결 오류: 즉시 1회 재연결, 이후 1초, 2초 backoff (같은 본문)
        - 409 session_required: session = None, 1초 후 continue
        - 401 / 413 / 422 / 기타 409: 중단하고 설정·펌웨어 점검
    sequence += 1
    10초 대기
```

- HTTP 연결은 재사용하세요. 서버나 프록시가 유휴 연결을 닫으면 첫 실패 때 바로 재연결하면 됩니다.
- JSON 공백은 생략해도 됩니다 (`separators=(",", ":")`).
- 좌석 번호가 바뀌면 펌웨어의 번호 매핑도 함께 바꿔야 합니다. 서버는 카메라 영역과 실제 좌석의 대응을 추론하지 않습니다.

참고 구현은 `scripts/simulate_device.py`입니다.

```sh
COMSIGI_DEVICE_CREDENTIAL=<장치 키> uv run python scripts/simulate_device.py \
  --base-url http://127.0.0.1:8000 --device-uid camera-1 --seats 1 2 3 --interval 10
```

자동 등록을 시험하려면 페어링 코드를 환경 변수로 주고 `--pair`를 붙입니다. UID를 생략하면 PC의 하드웨어 주소를 씁니다. 관리자 페이지에서 승인하면 키를 받아 수령 확인을 한 뒤 바로 보고를 시작합니다. `--credential-file`을 주면 받은 키를 그 파일(권한 600)에 저장합니다.

```sh
COMSIGI_PAIRING_CODE=<페어링 코드> uv run python scripts/simulate_device.py \
  --base-url http://127.0.0.1:8000 --pair --seats 1 2 3 --credential-file ~/.comsigi-device-key
```
