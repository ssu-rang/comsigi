# 하드웨어 연동 API

장치는 세션을 한 번 열고, 그 세션으로 좌석 점유 결과를 약 10초마다 보고합니다. 서버는 좌석 번호와 점유 여부(`true`/`false`)만 받습니다. 영상, 좌표, 사람 정보, 장치 시각은 보내지 않습니다.

전체 API 계약은 [API.md](API.md)를 참고하세요. 이 문서는 장치 펌웨어에 필요한 부분만 담았습니다.

## 개요

| 항목 | 값 |
| --- | --- |
| 기본 URL | `https://<서버 주소>/api/v1` (로컬 개발: `http://127.0.0.1:8000/api/v1`) |
| 형식 | JSON, `Content-Type: application/json`, 추가 필드는 거부 |
| 엔드포인트 | `POST /hardware/session`, `POST /hardware/reports` |
| 인증 | `Authorization: Bearer <장치 키>` |
| 본문 크기 상한 | 64 KiB (좌석 500개 보고도 32 KiB 미만) |
| 기본 만료 | 장치 30초, 좌석 30초 (실제 값은 세션 응답으로 전달) |

OpenMV가 직접 보내든 Arduino가 대신 보내든 계약은 같습니다. 장치 UID 하나에는 송신 루프를 하나만 두세요.

## 인증

관리자가 장치를 등록하면 `device_uid`와 장치 키가 발급됩니다. 키는 등록할 때와 재발급(`rotate-credential`)할 때 **한 번만** 표시되므로 펌웨어 설정에 바로 저장하세요.

- 모든 하드웨어 요청에 `Authorization: Bearer <장치 키>` 헤더를 붙입니다.
- 본문의 `device_uid`는 그 키로 등록된 UID와 같아야 합니다. 형식은 영문, 숫자, `_`, `-`로 1–100자입니다.
- 장소는 서버가 등록 정보로 정합니다. 요청에 `place_id`를 넣으면 422입니다.
- 키가 틀리거나 장치가 비활성이면 본문을 검사하기 전에 `401 device_unauthorized`를 반환합니다.
- 관리자가 키를 재발급하거나 장치의 장소·활성 상태를 바꾸면 기존 세션이 끊깁니다. 다음 보고는 `409 session_required`를 받습니다.

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
