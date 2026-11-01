# 빈자리 프론트엔드

React·Vite·Tailwind 화면을 FastAPI 백엔드의 `/api/v1` 계약에 연결했습니다. 기본 실행과 배포 빌드 모두 실제 API를 사용합니다. 연결 실패 시 개발 데이터로 전환하지 않습니다.

## 실행

프로젝트 루트에서 백엔드를 준비합니다(Python 3.12+, uv).

```sh
uv sync --locked
uv run alembic upgrade head
uv run comsigi create-admin --username admin
uv run comsigi serve --host 127.0.0.1 --port 8000
```

별도 터미널에서 프론트를 실행합니다(Node 22 이상).

```sh
cd frontend
npm install
npm run dev
```

Windows 실행 정책에 걸리면 `npm.cmd`를 사용하세요. http://localhost:8443 에서 접속합니다. `/api`의 HTTP와 WebSocket은 기본적으로 `http://127.0.0.1:8000`으로 프록시됩니다. 다른 백엔드를 연결하려면 Vite 실행 전 `API_PROXY_TARGET` 환경 변수를 지정합니다.

관리자 화면에서 CLI로 만든 계정으로 로그인하고 공간 → 배치 → 장치 순으로 등록합니다. 기본 계정과 비밀번호는 없습니다. 관리자 토큰은 메모리에만 보관하므로 페이지를 새로고침하면 다시 로그인해야 합니다. 편집 초안은 sessionStorage에 보존됩니다.

장치에서 보고하기 전 좌석은 ‘확인 불가’, 장치는 ‘수신 대기’입니다. 발급한 장치 키를 사용해 루트의 `scripts/simulate_device.py` 또는 실제 하드웨어로 보고할 수 있습니다. 자세한 계약은 [API 문서](../docs/API.md)를 확인하세요.

## 기능

| 경로 | 기능 |
| --- | --- |
| `#/`, `#/favorites` | 실제 공간 목록·좌석 요약·검색·즐겨찾기 |
| `#/places/{id}` | WebSocket 좌석 현황, 지도·번호순 보기, 연결 상태·재연결 |
| `#/admin/login` | 관리자 Bearer 로그인·만료 처리 |
| `#/admin/places` | 공간 생성·수정·삭제 |
| `#/admin/layout/{id}` | 좌석·테이블 추가/삭제·번호·연결·드래그·크기·회전·저장·초안 복원 |
| `#/admin/devices` | 장치 등록·이름·공간·활성화·키 재발급 |

장치는 소속 공간의 모든 좌석 번호를 보고할 수 있습니다. 장치별 담당 좌석 제한은 없으며 여러 장치가 같은 좌석을 보고할 수 있습니다. UI에서 실제로 저장되지 않는 담당 좌석 선택을 제공하지 않습니다.

배치 위치·크기·회전은 버전을 검사하는 PUT으로 저장합니다. 추가·삭제·번호·테이블 연결·형태 변경은 백엔드의 개별 CRUD 후 PUT을 수행하므로 **전체 편집 저장이 하나의 트랜잭션은 아닙니다**. 오류가 나면 일부 반영되었을 수 있으며 초안을 유지하고 최신 배치 비교/다시 시작을 제공합니다. 동시 구조 편집은 피하세요. 상세 내용은 [INTEGRATION.md](INTEGRATION.md)에 있습니다.

편집기 단축키: Delete, Escape, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+S. 테이블 이동은 좌석을 함께 이동시키지 않으며 테이블 삭제 시 연결만 해제합니다.

## 검증과 배포

```sh
npm run check
npm test
npm run build
npm run preview
```

Preview는 http://localhost:4173 이며 HTTP·WebSocket 프록시를 포함합니다. `build`는 타입 검사와 개발 데이터 제거 검증을 수행합니다.

루트에서 실행하는 다음 테스트는 임시 SQLite DB와 실제 Uvicorn 서버를 만들어 프론트 어댑터를 검증합니다. Vite 의존성이 있으면 HTTP·WebSocket 프록시와 Origin 검사도 실행합니다.

```sh
uv run pytest -q tests/test_frontend.py
```

Railway에서는 루트의 `railway.toml`과 `railpack.json`으로 프론트엔드와 백엔드를 함께 빌드·배포합니다. Vite 빌드 결과 `frontend/dist`를 FastAPI가 `/`에서 제공하고 API·WebSocket도 같은 도메인을 사용합니다. 관리자 로그인은 `/#/admin/login`입니다. Railway 빌드는 `VITE_API_BASE_URL`을 비우며, `COMSIGI_CORS_ORIGINS`에는 현재 Railway/커스텀 도메인의 HTTPS Origin을 등록합니다. 별도 프론트엔드 서비스나 reverse proxy 설정은 필요하지 않습니다. 전체 설정은 [루트 README](../README.md#railway-배포)를 확인하세요.

다른 환경에 프론트엔드를 별도로 배포할 때는 `dist`를 정적 호스팅하고 `/api`를 백엔드로 reverse proxy하세요(WebSocket Upgrade 포함). 다른 API 호스트는 빌드 시 `VITE_API_BASE_URL=https://api.example.com`으로 지정합니다. 같은 API 주소에서 WS/WSS를 도출합니다. HTTPS에서는 WSS를 사용합니다. `COMSIGI_CORS_ORIGINS`에 실제 프론트 Origin을 등록하세요. Vite preview는 로컬 검증용입니다.

## 개발 시뮬레이터

개발 서버에서만 `VITE_ENABLE_DEV_DATA=true`로 별도 활성화할 수 있습니다. 계정은 `admin` / `dev-only`이며 브라우저 저장소만 사용합니다. 이 모드의 장치 담당 좌석 기능은 시뮬레이터 전용으로 서버 계약과 다릅니다. 운영 빌드에서 개발 모듈·계정·fixture는 제거됩니다.

기존 `scripts/browser-check.mjs`는 **시뮬레이터 전용** 브라우저 테스트입니다. 실제 백엔드 통합 근거로 사용하지 않습니다.
