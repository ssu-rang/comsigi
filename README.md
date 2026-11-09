# Comsigi — 실시간 좌석 점유 백엔드

Python 3.12+, FastAPI, SQLAlchemy 2.x, SQLite, Alembic, Uvicorn으로 구현한 단일 프로세스 서버입니다. OpenMV 또는 Arduino가 분석한 **장치 UID·좌석 번호·점유 여부**를 HTTP로 받고, 장소별 상태를 메모리에 관리하며 WebSocket으로 변경 사항을 전송합니다. 이미지 분석이나 영상 수신, 점유 이력 저장은 하지 않습니다.

## 실행

Windows에서는 Python 3.12+, Node.js 22.12+, uv를 설치한 뒤 프로젝트 루트에서 명령 하나로 실행할 수 있습니다.

```powershell
.\dev.cmd
```

Python·프론트엔드 의존성 설치와 DB 마이그레이션을 처리한 뒤 백엔드와 프론트엔드를 함께 실행합니다. 최초 실행 시 `admin` 계정의 비밀번호(12자 이상)를 입력하며, 기존 계정은 그대로 사용합니다. 웹 화면은 http://localhost:8443, 관리자 로그인은 http://localhost:8443/#/admin/login 입니다. 터미널에서 Ctrl+C를 누르면 두 서버가 함께 종료됩니다. 8000·8443 포트는 비어 있어야 합니다.

스크립트는 PATH의 `uv`를 사용하며, 없다면 이미 설치된 `.venv`를 재사용하거나 `py -m uv`를 사용합니다. 새 환경에 `uv`가 없다면 Windows Python 런처로 `py -m pip install uv`를 실행하세요. 기존 `.venv`를 재사용할 때 Python 의존성 갱신은 `uv sync --locked`로 진행합니다. 아래는 각 서버를 개별 실행하는 방법입니다.

프로젝트 루트에서 실행합니다. [uv 설치 안내](https://docs.astral.sh/uv/getting-started/installation/)에 따라 uv를 설치하세요. `uv` 명령을 찾지 못하면 `python -m pip install uv` 이후 아래 명령의 `uv`를 `python -m uv`로 바꿀 수 있습니다.

```shell
uv sync --locked
uv run alembic upgrade head
uv run comsigi create-admin --username admin
uv run comsigi serve --host 0.0.0.0 --port 8000
```

관리자 비밀번호는 최소 12자, 최대 1024자입니다. `create-admin`과 `set-password`는 `COMSIGI_ADMIN_PASSWORD` 환경 변수 또는 `.env` 값을 사용하며, 설정하지 않으면 터미널에서 숨김 입력합니다. 기본 계정·기본 비밀번호는 없습니다. `.python-version`은 재현 가능한 개발 환경을 위해 Python 3.12를 지정합니다.

설정을 변경하려면 `.env.example`을 `.env`로 복사하여 수정합니다. 기본 설정만 쓸 때는 복사하지 않아도 됩니다. `.env`는 자동으로 읽고 실제 환경 변수가 우선합니다. SQLite 경로는 **실행 디렉터리 기준**입니다. 운영 환경에서는 절대 경로를 사용하세요.

- API 문서: `http://127.0.0.1:8000/docs`
- OpenAPI: `http://127.0.0.1:8000/openapi.json`
- 프로세스 확인: `GET /api/v1/health`
- DB·만료 작업 확인: `GET /api/v1/ready`
- 전체 연동 계약: [docs/API.md](docs/API.md)
- 보안 점검 결과와 수정 우선순위: [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)

개발 시 `uv run comsigi serve --reload`를 사용합니다. reload도 서버 재시작이므로 점유 상태·장치 세션·관리자 로그인 세션이 초기화됩니다. 비밀번호 변경은 `uv run comsigi set-password --username admin`이며, 기존 로그인 토큰은 다음 요청부터 거부됩니다.

## Railway 배포

루트의 [railway.toml](railway.toml)에 빌드와 시작 명령이 들어 있습니다. [railpack.json](railpack.json)은 Python 빌드에 Node.js 22를 추가합니다. Railway가 배포할 때 백엔드 의존성 설치 → 프론트엔드 의존성 설치·운영 빌드 → DB 마이그레이션 → 관리자 계정 최초 생성 → 서버 실행을 자동으로 처리하므로 터미널에 명령을 입력할 필요가 없습니다. 관리자 이름은 `admin`이며, 기존 계정의 비밀번호는 그대로 유지합니다.

배포한 Railway 도메인의 `/`에서 웹 화면, `/#/admin/login`에서 관리자 로그인, `/api/v1/*`에서 API·WebSocket을 제공합니다. 프론트엔드를 별도 서비스에 올릴 필요가 없습니다. Railway 빌드는 `VITE_API_BASE_URL`을 비워서 화면과 API가 같은 주소를 사용하게 합니다.

Railway 화면에서 최초 한 번 설정합니다.

1. GitHub 저장소를 서비스에 연결합니다. 서비스의 Root Directory는 프로젝트 루트(`/`)로 두고, Config File은 `/railway.toml`을 사용합니다.
2. 서비스에 Volume을 연결하고 Mount Path를 `/data`로 지정합니다.
3. 서비스의 Variables에 아래 값을 등록합니다.
4. Settings → Networking에서 Generate Domain으로 사이트 주소를 만들고 배포합니다. Build/Start Command는 파일에서 적용되므로 직접 입력하지 않습니다. Pre-deploy Command는 비워 둡니다.

| 환경 변수 | 값 |
| --- | --- |
| `COMSIGI_ADMIN_PASSWORD` | 직접 정한 12–1024자 비밀번호 |
| `COMSIGI_DATABASE_URL` | `sqlite+aiosqlite:////data/comsigi.db` |
| `COMSIGI_CORS_ORIGINS` | `["https://실제-Railway-도메인"]` |

`COMSIGI_CORS_ORIGINS`에는 접속할 Railway 또는 커스텀 도메인의 Origin(프로토콜·호스트·필요한 경우 포트, 경로·끝 슬래시 제외)을 JSON 배열로 입력합니다. 같은 주소에서 제공하더라도 WebSocket Origin 검사에 필요합니다. 예전에 별도 프론트엔드 주소를 설정했다면 현재 사이트 주소로 변경합니다.

Volume은 관리자 계정·공간·배치·장치 설정을 재배포 후에도 유지합니다. DB 초기화가 실패하면 서버를 시작하지 않으며, Railway는 `/api/v1/ready`가 성공한 뒤 배포를 활성화합니다. 시작 명령은 Railway가 제공한 `PORT`를 사용하고, 서버는 단일 프로세스·replica 1개로 실행됩니다.

Railway의 [설정 파일](https://docs.railway.com/config-as-code), [Volume](https://docs.railway.com/volumes), [시작 명령](https://docs.railway.com/deployments/start-command) 문서를 참고하세요. Volume은 Pre-deploy Command 컨테이너에 연결되지 않으므로 SQLite 초기화를 그곳으로 옮기지 않습니다.

로컬에서 운영 화면을 확인하려면 `frontend` 폴더에서 `npm ci --include=dev`와 `npm run build`를 실행한 다음 백엔드를 시작합니다. 빌드 결과 `frontend/dist`가 있으면 백엔드가 자동으로 제공하며, 빌드 결과가 없으면 API만 제공합니다. 별도 빌드 경로는 `COMSIGI_FRONTEND_DIST`로 지정할 수 있습니다. 화면은 해시 라우팅을 사용하므로 관리자 페이지도 `/admin/login` 대신 `/#/admin/login`으로 접속합니다.

### 직접 서버를 실행할 때

서버의 비밀 환경 변수에 `COMSIGI_ADMIN_PASSWORD`를 설정합니다. `COMSIGI_DATABASE_URL`은 영구 저장소의 SQLite 절대 경로, `COMSIGI_CORS_ORIGINS`는 실제 프론트엔드 Origin의 JSON 배열로 설정합니다. 비밀번호를 명령행 인자, 프론트엔드 `VITE_*` 변수, 저장소 파일에 넣지 않습니다.

프로젝트 루트에서 다음 순서로 실행합니다. `prepare-deploy`가 성공한 뒤 `serve`를 실행합니다. 영구 볼륨을 쓰는 환경에서는 볼륨이 연결된 같은 컨테이너에서 두 명령을 실행합니다.

```shell
uv sync --locked
uv run comsigi prepare-deploy --username admin
uv run comsigi serve --host 0.0.0.0 --port 8000
```

`prepare-deploy`는 먼저 `alembic upgrade head`를 실행하고, 지정한 이름의 관리자 계정이 없을 때만 생성합니다. 최초 생성 시 비밀번호가 없거나 길이가 맞지 않으면 입력을 기다리지 않고 실패합니다. 이미 계정이 있으면 비밀번호 환경 변수가 바뀌거나 제거되어도 기존 비밀번호·활성화 상태를 그대로 유지하며 성공합니다. 재배포·재시작 때마다 실행해도 되지만, 같은 영구 DB를 사용해야 합니다.

최초 생성 후에는 `COMSIGI_ADMIN_PASSWORD`를 제거해도 됩니다. 비밀번호를 변경하려면 새 값을 설정한 상태에서 `uv run comsigi set-password --username admin`을 명시적으로 실행하거나, 환경 변수를 제거하고 숨김 입력을 사용합니다. `serve`는 계정을 생성하거나 비밀번호를 변경하지 않습니다.

## 구현 범위

| 영역 | 제공 기능 |
| --- | --- |
| 관리자 | 로그인·로그아웃·만료, 장소/좌석/테이블/장치 CRUD, 장치 키 발급·교체·비활성화 |
| 배치 | 위치·크기·회전·테이블 연결, 캔버스 크기, 전체 배치의 원자적 저장, 버전 충돌 검사 |
| 하드웨어 | Bearer 장치 인증, 장소 자동 결정, 세션·시퀀스 검증, 최대 500개 좌석 일괄 수신, heartbeat |
| 상태 | `available / occupied / unknown`, 통신 만료, 좌석별 데이터 만료, 여러 장치의 보고 결합 |
| WebSocket | 최초 스냅샷, 변경 이벤트, 배치 변경, 장소 삭제, ping/pong, 느린 소비자 연결 종료 |
| 운영 | 마이그레이션 검사, CORS·WS Origin 제한, 준비 상태 검사, 로그인 속도 제한, 단일 프로세스 실행 명령 |

공개 조회 API와 WebSocket에는 인증이 필요하지 않습니다. 관리자 API는 관리자 토큰, 하드웨어 API는 해당 장치 키만 받습니다. 장치 키는 생성·교체 응답에서 한 번만 제공됩니다.

## 데이터와 동작 원칙

SQLite에는 장소, 좌석, 테이블, 배치, 장치 연결·인증 해시, 관리자 인증 해시만 저장합니다. `layout_version`은 배치 편집 충돌을 감지하는 영구 설정 버전입니다. 장치 키는 256비트 무작위 값을 SHA-256으로 해시하고, 관리자 비밀번호는 Argon2id로 해시합니다.

점유 상태, 수신 시각, 장치 온라인 상태, 마지막 순서 번호, 장치 세션, WebSocket 연결, 관리자 로그인 세션은 메모리에만 존재합니다. **하드웨어 보고 처리 경로는 DB SELECT/INSERT/UPDATE를 실행하지 않습니다.** 서버 재시작 후 모든 좌석은 `unknown`, 모든 활성 장치는 `offline`에서 시작합니다.

기본적으로 장치가 30초 동안 새 메시지를 보내지 않으면 offline이며, 좌석도 마지막 보고 후 30초가 지나면 unknown입니다. 만료 검사는 1초마다 실행됩니다. heartbeat는 장치 연결만 유지하므로, 상태가 바뀌지 않은 좌석도 10초 정도 간격으로 다시 보고해야 합니다. unknown은 빈 좌석 수에 포함하지 않습니다.

여러 장치가 같은 좌석을 보고하면 **온라인 장치의 만료되지 않은 보고 중 하나라도 occupied이면 occupied**, 모두 비점유이면 available, 유효한 보고가 없으면 unknown입니다. 장치별 담당 좌석 ACL은 없으며 해당 장소의 모든 좌석을 보고할 수 있습니다.

좌석 생성·삭제·번호 변경은 해당 장소의 장치 세션과 관측값을 초기화합니다. 장치는 `409 session_required`를 받으면 새 세션을 열고 현재 감지 결과를 전송해야 합니다. 이는 배치 변경 전 지연 패킷이 새 번호 매핑에 적용되는 것을 막습니다. 단순한 이동·크기·라벨 변경에는 점유 상태가 유지됩니다. 장치 이동·비활성화·키 교체·삭제도 해당 장치의 관측값과 세션을 제거합니다.

장소 삭제 시 좌석·테이블·장치를 함께 삭제합니다. 테이블만 삭제하면 좌석은 유지하고 `table_id`만 null로 변경합니다. 삭제된 내부 ID는 재사용하지 않습니다. 다른 장소의 테이블에 좌석을 연결할 수 없습니다.

## 프론트엔드 연결

`GET /api/v1/places`로 장소를 선택하고 `/api/v1/places/{slug}/layout`으로 배치를 조회합니다. WebSocket `/api/v1/places/{slug}/ws`는 점유 상태만 전달합니다. 첫 `snapshot`은 전체 상태, 이후 `state_changed`는 일부 변경 항목, 설정 변경 시 `state_reset`은 전체 상태를 담습니다. 상태의 `layout_version`이 HTTP 배치 버전과 다르면 배치를 다시 조회하며, 배치 데이터는 WebSocket으로 보내지 않습니다. 재연결 시 새 상태 스냅샷으로 교체합니다. 상세한 순서·연결 복구 규칙과 JavaScript 예제는 [API 문서](docs/API.md#websocket)를 참고하세요.

기존 저장소 프론트엔드의 `GET /api/v1/seats`는 유지합니다. 장소가 하나이면 그 장소의 좌석을 반환하고, 여러 장소이면 `?place_slug=library`를 지정해야 합니다. 이 호환 경로의 `id`는 내부 ID이며 좌석 표시 번호가 아닙니다. 새 프론트엔드는 장소별 계약을 사용하세요. 현재 프론트엔드는 장소별 API·관리자 인증·배치 저장·장치 관리·WebSocket에 연결되어 있습니다. 실행 방법은 [frontend/README.md](frontend/README.md), 저장 보장과 검증 범위는 [frontend/INTEGRATION.md](frontend/INTEGRATION.md)를 확인하세요.

## 하드웨어 없이 연동 검증

Swagger에서 로그인하고 장소·좌석·장치를 생성한 후, 발급된 키를 환경 변수로 설정합니다. 시뮬레이터는 실제 서버의 인증·세션·HTTP 계약을 그대로 사용하며, 입력한 좌석들의 점유 여부를 주기적으로 바꿉니다.

```powershell
$env:COMSIGI_DEVICE_CREDENTIAL = "발급받은 장치 키"
uv run python scripts/simulate_device.py --device-uid camera-1 --seats 1 2 --interval 10
```

macOS/Linux에서는 `export COMSIGI_DEVICE_CREDENTIAL='발급받은 장치 키'`로 설정합니다. 키를 명령행 인자로 전달하거나 커밋하지 않습니다. 실제 OpenMV 네트워크 모델/Arduino Ethernet·Wi-Fi 라이브러리의 선택은 펌웨어 측에서 하되 JSON과 Bearer 헤더는 동일하게 사용합니다.

## 구성

```text
app/
  main.py          앱 팩토리, lifespan, 오류 응답, CORS
  config.py        환경 설정
  db.py            비동기 SQLite 세션, 외래 키/WAL
  models.py        영구 데이터 모델
  schemas.py       HTTP 입출력 검증
  security.py      관리자 세션, 비밀번호·장치 키 검증
  realtime.py      메모리 상태, 순서·만료 처리, 구독 큐
  cli.py           배포 초기화, 관리자 생성·비밀번호 변경, 단일 프로세스 실행
  api/
    admin.py       관리 CRUD와 원자적 배치 저장
    auth.py        관리자 로그인·로그아웃
    hardware.py    HTTP를 상태 처리기에 연결
    router.py      공개 조회, WebSocket, 상태 검사, 호환 API
alembic/           초기 스키마와 이후 마이그레이션
tests/             API·DB·WebSocket·실제 TCP 통합 테스트
scripts/           HTTP 장치 시뮬레이터
docs/API.md        하드웨어와 프론트엔드 계약
```

단순 CRUD는 라우트에서 SQLAlchemy를 직접 사용합니다. `Runtime.ingest()`는 HTTP/소켓 객체를 받지 않으므로 나중에 다른 수신 방식에서도 재사용할 수 있습니다. 상태·구독·설정 변경은 하나의 `asyncio.Lock`으로 순서를 보장하고, 네트워크 송신은 연결별 제한된 큐에서 별도로 수행합니다. DB 변경은 후보 설정을 검증한 뒤 커밋하고, I/O 없이 메모리에 적용하므로 실패한 저장이 실시간 상태에 먼저 반영되지 않습니다.

추가 라이브러리는 다음 용도로만 사용합니다.

| 라이브러리 | 도입 근거 |
| --- | --- |
| aiosqlite + SQLAlchemy asyncio extra | SQLite 작업으로 WebSocket 이벤트 루프가 막히지 않도록 함 |
| pydantic-settings | 환경 변수·`.env`를 타입 검증과 함께 읽음 |
| pwdlib[argon2] | 관리자 비밀번호용 표준 Argon2id 구현 사용 |
| uvicorn[standard] | WebSocket 전송 및 개발 reload 지원 |
| Ruff (개발) | 정적 오류·스타일 검사와 포맷 통일 |

## 테스트와 스키마 변경

```shell
uv run pytest -q
uv run ruff check app tests scripts alembic
uv run ruff format --check app tests scripts alembic
uv run alembic check
```

각 테스트는 임시 SQLite DB에 **실제 Alembic 마이그레이션**을 실행합니다. 수신 경로의 SQL 미실행, 동시 순서 처리, 잘못된 배치의 롤백, 재시작, 인증·키 교체, 만료, 재연결, 장소 격리, 실제 Uvicorn TCP HTTP→WebSocket 전달을 검증합니다.

Windows 사용자 공용 임시 폴더의 접근 권한 때문에 pytest가 시작되지 않을 때만 작업 공간에 임시 폴더를 지정하세요. 매 실행마다 새 경로를 사용하면 기존 디렉터리를 지울 필요가 없습니다.

```powershell
New-Item -ItemType Directory -Force .test-tmp | Out-Null
uv run pytest -q --basetemp=".test-tmp/run-$([guid]::NewGuid().ToString('N'))"
```

새 모델 변경은 `uv run alembic revision --autogenerate -m "설명"`으로 만들고 검토합니다. `app/main.py`의 `SCHEMA_REVISION`을 새 head로 갱신하고 마이그레이션 테스트를 실행합니다. 서버는 미적용/불일치 스키마에서 시작하지 않습니다. SQLite batch migration이 필요한 변경은 서버를 중지하고 백업한 뒤 적용하세요.

## 운영

- **Uvicorn worker는 반드시 1개**, 서버 replica도 1개입니다. 별도 프로세스·다중 컨테이너 간 메모리를 공유하지 않으며 다중 실행을 자동으로 막지는 않습니다. 제공한 `comsigi serve`는 workers=1로 실행합니다.
- 운영에서는 HTTPS/WSS를 제공하는 역방향 프록시 뒤에서 실행하고 WebSocket Upgrade를 전달합니다. 프록시의 유휴 제한은 heartbeat보다 길게, 요청 본문 제한은 예를 들어 1 MiB로 설정합니다. `--reload`는 사용하지 않습니다.
- `COMSIGI_CORS_ORIGINS`에 실제 프론트엔드 Origin(프로토콜·호스트·포트)을 명시합니다. 같은 도메인에서 제공해도 브라우저 WebSocket Origin을 등록해야 합니다. `*`는 허용하지 않습니다. Origin 없는 비브라우저 WebSocket 클라이언트는 허용합니다.
- 프록시에서 전달하는 IP는 신뢰할 프록시만 설정합니다. 로그인은 클라이언트 IP당 60초에 10회로 제한되며, 프록시 설정이 없으면 프록시 IP를 공유합니다. 관리자 토큰 수와 WS 연결 수에도 상한이 있습니다.
- SQLite 파일이 있는 디렉터리에 쓰기 권한을 부여하고 영구 볼륨을 사용합니다. WAL 모드의 실행 중 DB를 `.db` 파일만 복사해 백업하지 말고 SQLite backup API를 쓰거나 서버를 정상 종료한 뒤 백업합니다.
- 설정은 관리 API를 통해 수정합니다. 실행 중 직접 SQL로 설정을 바꾸면 메모리 캐시에 반영되지 않습니다. CLI 비밀번호 변경은 예외로, 매 관리자 요청에서 DB 해시를 확인하므로 즉시 세션이 무효화됩니다.
- 장치 장애는 마지막 상태를 available로 간주하지 않고 unknown으로 알립니다. 프론트엔드는 WebSocket 단절도 별도로 표시해야 합니다. 실물 카메라/Arduino의 네트워크·센서 정확도와 배포 프록시 설정은 해당 환경에서 검증해야 합니다.

구현에서 참고한 공식 문서: [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [SQLAlchemy SQLite](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html), [uv 잠금·동기화](https://docs.astral.sh/uv/concepts/projects/sync/).
